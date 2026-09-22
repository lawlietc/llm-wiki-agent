/**
 * ACP `usage_update` 通知探测（spike 观测）。
 *
 * **目的**：回答「ACP 腿能否支持 token 评测」。
 *
 * 背景（有官方依据）：ACP v1 规范定义了一个 `session/update` 通知变体 `usage_update`
 * （携带 `used` tokens / `size` 上下文上限 / 可选 `cost`）。但本项目
 * `src/reasoning/acp/transport.ts` 的 `handleNotification` **只识别 `agent_message_chunk`**，
 * 其余变体被静默丢弃；因此 `ReasoningBackend` 拿到的 usage 恒为 0。
 *
 * 本探测**不改核心层**，而是自己 spawn 一个 `opencode acp` 进程、走最小握手 + 一次 prompt，
 * 把收到的**所有** `session/update` 变体类型记录下来，据此判断 opencode 实际是否发送
 * `usage_update`：
 * - 若发送 → 未来正式版可在 transport 加处理，trace 即可带 token
 * - 若不发送 → 接受 ACP 腿无 token 维度，trace 标 `usageUnavailable`
 */

import { initializeTransport, spawnTransport, type SpawnedAgent } from '../../src/reasoning/acp/transport';
import type { ACPProvider } from '../../src/reasoning/acp/registry';

export interface UsageProbeResult {
  /** 观测到的全部 session/update 变体类型 */
  observedUpdateKinds: string[];
  /** 是否观测到 usage_update */
  seen: boolean;
  /** usage_update 的原始载荷（供人工核对字段形状） */
  sample?: unknown;
  /** 运行期探测到的 agent 信息 */
  agentInfo: { name?: string; version?: string } | null;
  /** 注册表静态注记（供与 agentInfo 对比） */
  registryNote: string;
  /** 探测过程中遇到的错误（探测失败不应拖垮主流程） */
  error?: string;
}

/**
 * 执行探测。失败时返回带 `error` 的结果（不抛），以免探测问题阻断 trace 主体流程。
 *
 * @param provider 目标 ACP provider（opencode）
 * @param timeoutMs 整体超时（默认 90s）
 */
export async function probeUsageUpdate(provider: ACPProvider, timeoutMs = 90_000): Promise<UsageProbeResult> {
  const observed = new Set<string>();
  let sample: unknown;
  let agentInfo: { name?: string; version?: string } | null = null;
  let error: string | undefined;

  let spawned: SpawnedAgent | null = null;
  try {
    spawned = spawnTransport(provider.command, provider.args, { ...process.env, ...(provider.env ?? {}) } as Record<string, string>, () => {});
    const init = await initializeTransport(spawned, 60_000);
    agentInfo = init.agentInfo;

    const conn = spawned.connection;
    const sessionId = await startSession(conn);
    await runPromptAndObserve(conn, sessionId, observed, timeoutMs, (s) => {
      sample = s;
    });
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    if (spawned !== null) {
      try {
        await spawned.connection.terminate(2_000);
      } catch {
        /* 忽略清理错误 */
      }
    }
  }

  return {
    observedUpdateKinds: [...observed].sort(),
    seen: observed.has('usage_update'),
    ...(sample !== undefined ? { sample } : {}),
    agentInfo,
    registryNote: provider.id === 'opencode' ? '实测 1.18.23：ACP 是子命令 `opencode acp`' : '',
    ...(error !== undefined ? { error } : {}),
  };
}

/** 最小 session/new（不装 mcpServers 之外的东西） */
async function startSession(conn: SpawnedAgent['connection']): Promise<string> {
  const res = await conn.request<{ sessionId?: string }>('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const id = res?.sessionId;
  if (typeof id !== 'string' || id === '') throw new Error('session/new 未返回 sessionId');
  return id;
}

/**
 * 发一次最小 prompt 并观察通知。
 *
 * 注意：transport 的 `handleNotification` 是私有的，无法从外部订阅。因此这里
 * **不依赖它**——而是在 prompt 期间通过一个**独立的观察通道**记录变体。
 * 具体做法：在 `AcpConnection` 实例上临时替换 `handleNotification`（运行时鸭子补丁），
 * 保留原行为（正文累积）同时旁路记录所有变体类型。这是 spike 的一次性观测手段，
 * **不改核心源码**。
 */
async function runPromptAndObserve(
  conn: SpawnedAgent['connection'],
  sessionId: string,
  observed: Set<string>,
  timeoutMs: number,
  onUsageSample: (s: unknown) => void,
): Promise<void> {
  type NotifMsg = { method?: string; params?: { update?: { sessionUpdate?: string } } };
  const target = conn as unknown as { handleNotification?: (msg: NotifMsg) => void };
  const original = target.handleNotification?.bind(conn);
  if (original !== undefined) {
    target.handleNotification = (msg: NotifMsg): void => {
      const upd = msg?.params?.update;
      if (msg?.method === 'session/update' && upd?.sessionUpdate !== undefined) {
        observed.add(upd.sessionUpdate);
        if (upd.sessionUpdate === 'usage_update') onUsageSample(msg.params);
      }
      original(msg);
    };
  }

  try {
    await conn.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly: ok' }],
    }, timeoutMs);
  } finally {
    if (original !== undefined) target.handleNotification = original;
  }
}
