/**
 * ACP 本地 agent 后端（04 §5 / M7 F7.4）。
 *
 * 把 ACP 子进程包成 `ReasoningBackend`，对 Wiki Core 完全透明。
 * 第二刀定位：**纯补全器** —— `tools` 非空直接拒绝（I2），不接 host 工具回路，
 * 不碰文件（写入走 Vault）。agent 只当「另一个模型」用（本地模型/超长上下文场景）。
 */

import type { ChildProcess } from 'node:child_process';

import type { AgentCapabilityFlags, ReasoningBackend, ReasoningRequest, ReasoningResult } from '../backend';
import type { ChatMessage } from '../types';
import { ConfigError } from '../../errors';

import type { ACPAgentCapabilities } from './capabilities';
import { toACPRequestError } from './errors';
import type { ACPProvider } from './registry';
import { initializeTransport, spawnTransport, type SpawnedAgent } from './transport';

export interface ACPAgentBackendOptions {
  /** initialize 握手超时 ms（默认 30_000） */
  initializeTimeoutMs?: number;
  /** session/new 的 cwd（默认 process.cwd()） */
  cwd?: string;
  /** 畸形行 / 警告回调（默认静默） */
  onWarn?: (msg: string) => void;
}

export class ACPAgentBackend implements ReasoningBackend {
  readonly kind = 'acp-agent' as const;

  private spawned: SpawnedAgent | null = null;
  private sessionId: string | null = null;
  private rawCaps: ACPAgentCapabilities | null = null;
  private readonly onWarn: (msg: string) => void;

  constructor(
    private readonly provider: ACPProvider,
    private readonly opts: ACPAgentBackendOptions = {},
  ) {
    this.onWarn = opts.onWarn ?? (() => {});
  }

  /** lazy connect：首次调用时 spawn + initialize 一次 */
  private async connect(): Promise<SpawnedAgent> {
    if (this.spawned) return this.spawned;
    const env = { ...process.env, ...(this.provider.env ?? {}) } as Record<string, string>;
    const t = spawnTransport(this.provider.command, this.provider.args, env, this.onWarn);
    try {
      const init = await initializeTransport(t, this.opts.initializeTimeoutMs);
      this.rawCaps = init.agentCapabilities ?? {};
      this.spawned = t;
      return t;
    } catch (e) {
      // 握手失败 → 清理已拉起的子进程，避免孤儿（I5 兜底）
      try {
        await t.connection.terminate(2_000);
      } catch {
        /* 忽略清理错误 */
      }
      throw toACPRequestError(e);
    }
  }

  /** 确保拿到一个 session（复用：不重新 initialize） */
  private async ensureSession(): Promise<SpawnedAgent> {
    const t = await this.connect();
    if (this.sessionId) return t;
    try {
      // 真实 ACP（opencode 1.18.23）要求 session/new 带 cwd + mcpServers；
      // mcpServers 必须是**数组**（实测空对象 {} 报 Invalid params: expected array,
      // received object），否则握手失败（F9.2）。
      const s = await t.connection.request<{ sessionId: string }>('session/new', {
        cwd: this.opts.cwd ?? process.cwd(),
        mcpServers: [],
      });
      this.sessionId = s.sessionId;
      return t;
    } catch (e) {
      throw toACPRequestError(e);
    }
  }

  async complete(req: ReasoningRequest): Promise<ReasoningResult> {
    // I2：纯补全器，工具调用显式拒绝（不忽略不降级）
    if (req.tools && req.tools.length > 0) {
      throw new ConfigError(
        'ACP_TOOLS_UNSUPPORTED',
        '第二刀 ACP 为纯补全器，不支持工具调用（见 04 §5 定位说明）',
      );
    }
    const t = await this.ensureSession();
    // ACP 的 session/prompt 无 system 字段：把 system（6 条硬规则 + JSON 格式要求）并入 prompt，
    // 并改发 ContentBlock[]（真实 ACP 要求，opencode 实测）。（F9.2）
    const prompt = buildPrompt(req);
    // 发 prompt 前清空流式缓冲：session/update 通知不带请求 id，上一次请求的尾部 chunk
    // 若晚于其响应到达会滞留，被本次 takeStreamedText() 取走 → 回稿拼接畸形
    // （实测曾致骨架回稿 JSON 在 5268 字节处断裂、触发 CITED_FALLBACK、facts 全丢）。
    t.connection.resetStreamedText();
    let res: { content?: string; usage?: { inputTokens?: number; outputTokens?: number } };
    try {
      res = await t.connection.request<{
        content?: string;
        usage?: { inputTokens?: number; outputTokens?: number };
      }>('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
    } catch (e) {
      throw toACPRequestError(e);
    }
    const usage = res.usage ?? { inputTokens: 0, outputTokens: 0 };
    // 真实 ACP（opencode）正文经无 id 的 session/update 通知推送，response.content 可能为空；
    // 优先取通知累积正文，回退 response.content（F9.1/F9.2）。
    const text = (t.connection.takeStreamedText() || res.content || '').trim();
    return {
      text,
      blocks: text ? [{ type: 'text', text }] : [],
      stopReason: 'end',
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: this.provider.id,
      providerId: this.provider.id,
    };
  }

  async chat(req: ReasoningRequest): Promise<ReasoningResult> {
    return this.complete(req);
  }

  /** 已拉起的子进程（只读，运维/测试用）；未连接时为 null */
  get process(): ChildProcess | null {
    return this.spawned?.child ?? null;
  }

  /** 运行时探测到的能力（由 initialize 返回映射；I3） */
  capabilities(): AgentCapabilityFlags {
    return {
      streaming: !!this.rawCaps?.supportsStreaming,
      tools: false, // I2：本产品不执行工具
      sessionPersistence: !!this.rawCaps?.supportsSessionPersistence,
      embeddings: false,
    };
  }

  async dispose(): Promise<void> {
    if (this.spawned) {
      await this.spawned.connection.terminate(2_000);
      this.spawned = null;
    }
    this.sessionId = null;
    this.rawCaps = null;
  }
}

/** 取最后一条 user 消息的纯文本（多轮收敛为单轮，T7.4-03） */
function lastUserMessage(messages?: ChatMessage[]): string {
  if (!messages || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const c = messages[i].content;
      if (typeof c === 'string') return c;
      const textBlock = c.find((b) => b.type === 'text');
      return textBlock && textBlock.type === 'text' ? textBlock.text : '';
    }
  }
  return '';
}

/**
 * 构造发给 ACP 的 prompt 文本。
 * ACP 的 `session/prompt` 没有 system 字段（真实 ACP 把 system 放进 session 配置或首条内容块），
 * 而 synthesize 的 6 条硬规则 + JSON 格式要求全在 system 里 —— 必须并入 prompt，否则被静默丢弃（F9.2）。
 */
function buildPrompt(req: ReasoningRequest): string {
  const user = req.prompt ?? lastUserMessage(req.messages);
  if (!req.system) return user;
  return `${req.system}\n\n---\n\n${user}`;
}
