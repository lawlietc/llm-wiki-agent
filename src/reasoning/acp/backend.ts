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
      const s = await t.connection.request<{ sessionId: string }>('session/new', {});
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
    const prompt = req.prompt ?? lastUserMessage(req.messages);
    let res: { content?: string; usage?: { inputTokens?: number; outputTokens?: number } };
    try {
      res = await t.connection.request<{
        content?: string;
        usage?: { inputTokens?: number; outputTokens?: number };
      }>('session/prompt', { sessionId: this.sessionId, prompt });
    } catch (e) {
      throw toACPRequestError(e);
    }
    const usage = res.usage ?? { inputTokens: 0, outputTokens: 0 };
    const text = res.content ?? '';
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
