/**
 * LLM 调用采集装饰器（spike 观测）。
 *
 * 包住任意 `ReasoningBackend` 实现（网关腿或 ACP 腿），在每次 `complete`/`chat`
 * 前后采集请求文本、回稿、耗时、token 用量与失败信息。接口的其余成员
 * （`kind` / `capabilities` / `dispose`）原样透传。
 *
 * 为什么用装饰器而非扩大既有的 `BudgetTracker` 钩子：后者只有 `{model, usage}`、
 * 缺请求/回稿/耗时；且它只在网关腿的模块级函数里被读取，**ACP 腿零接入**
 * （`src/reasoning/gateway-backend.ts` 的 `getCurrentBudgetTracker` 在 acp 目录下无引用）。
 * 装饰器包在两条腿外面，通吃且零核心依赖。
 *
 * **请求文本同构性**：`buildAcpRequestText` 复刻 ACP 后端 `buildPrompt` 的合并语义
 * （system 并入 prompt，`\n\n---\n\n` 分隔），使 trace 记录的内容与 ACP 实际发送一致。
 */

import type {
  AgentCapabilityFlags,
  ReasoningBackend,
  ReasoningRequest,
  ReasoningResult,
} from '../../src/reasoning/backend';
import type { ChatMessage } from '../../src/reasoning/types';
import type { LlmPayload } from './schema';

/** 采集回调的载荷：LLM 负载 + 该次调用的时间边界（时间不进 JSON 的 llm 字段，由 sink 转成 span 时间） */
export interface LlmCallRecord {
  payload: LlmPayload;
  startTime: string;
  durationMs: number;
}

/** 采集回调：每次 LLM 调用一次（成功或失败都调） */
export type LlmRecorder = (record: LlmCallRecord) => void;

/**
 * 复刻 `src/reasoning/acp/backend.ts` 的 `buildPrompt`（逐字对齐）。
 *
 * ACP 的 `session/prompt` 没有 system 字段，故 system 与 user 文本按
 * `${system}\n\n---\n\n${user}` 合并后作为单块 text 发送。
 */
export function buildAcpRequestText(req: ReasoningRequest): string {
  const user = req.prompt ?? lastUserMessage(req.messages);
  if (!req.system) return user;
  return `${req.system}\n\n---\n\n${user}`;
}

/** 复刻 `src/reasoning/acp/backend.ts` 的 `lastUserMessage`（逐字对齐） */
function lastUserMessage(messages?: ChatMessage[]): string {
  if (!messages || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      const c = m.content;
      if (typeof c === 'string') return c;
      const textBlock = c.find((b) => b.type === 'text');
      return textBlock && textBlock.type === 'text' ? textBlock.text : '';
    }
  }
  return '';
}

/**
 * 从请求内容推断子步骤名（spike 兜底）。
 *
 * 为什么需要：核心层未暴露子步骤边界（I-W1' 只加了一个观测开关），若只靠
 * `pushPhase` 标签，LLM span 会被标成笼统的阶段名。请求文本里的**系统指令特征**
 * 是可靠的判据（三个调用点的 system 指令互不相同）。
 */
function inferPhase(req: ReasoningRequest): string {
  const probe = `${req.system ?? ''}\n${req.prompt ?? ''}`;
  if (probe.includes('wiki 整理助手')) return 'summarize';
  if (probe.includes('实体抽取助手')) return 'extract';
  if (probe.includes('实体骨架识别助手')) return 'extract.skeleton';
  if (probe.includes('片段引用助手')) return 'extract.cite';
  if (probe.includes('矛盾检测助手')) return 'contradiction';
  return 'llm';
}

/** 用于注入子步骤标签（'summarize' / 'extract' / 'contradiction:<slug>' …）的栈 */
export class TracingBackend implements ReasoningBackend {
  readonly kind: ReasoningBackend['kind'];
  private readonly phaseStack: string[] = [];

  constructor(
    private readonly inner: ReasoningBackend,
    private readonly collect: LlmRecorder,
  ) {
    this.kind = inner.kind;
  }

  /**
   * 进入一个子步骤：此后发生的 LLM 调用其 `phase` 都标为此标签（可嵌套）。
   * 注意：真实归属由**时间区间**在渲染时计算（阶段 span 的 [start,end] 包含 LLM span 的 start），
   * 此处标签仅作提示——因为 `attachContradictions` 是循环调用，标签栈可能不如区间精确。
   */
  pushPhase(phase: string): void {
    this.phaseStack.push(phase);
  }

  /** 退出当前子步骤 */
  popPhase(): void {
    this.phaseStack.pop();
  }

  async complete(req: ReasoningRequest): Promise<ReasoningResult> {
    return this.wrap(req);
  }

  async chat(req: ReasoningRequest): Promise<ReasoningResult> {
    return this.wrap(req);
  }

  capabilities(): AgentCapabilityFlags {
    return this.inner.capabilities();
  }

  async dispose(): Promise<void> {
    return this.inner.dispose();
  }

  /** 计时 → 调用 → 记录（成功/失败两条路径都记录，失败原样抛出） */
  private async wrap(req: ReasoningRequest): Promise<ReasoningResult> {
    const startedAt = new Date();
    const t0 = performance.now();
    const phase = this.phaseStack.at(-1) ?? inferPhase(req);
    // 该 backend 是否认 system 字段：ACP 腿把它并入 prompt，网关腿分离传递
    const acpMerged = this.inner.kind === 'acp-agent';
    const requestText = acpMerged ? buildAcpRequestText(req) : (req.prompt ?? lastUserMessage(req.messages));

    try {
      const res = await this.inner.complete(req);
      const responseEmpty = res.text.trim() === '';
      // usage 判据：**有真实非零用量才写 usage**。
      // opencode 1.18.27 实测确实在 `session/prompt` 响应里回传了 inputTokens/outputTokens
      // （虽然协议把用量放在 `usage_update` 通知里，opencode 额外在响应体也带了），
      // 故此处以「是否真的拿到非零值」为准，而不是按腿一刀切。
      const hasUsage =
        res.usage !== undefined &&
        (res.usage.inputTokens > 0 || res.usage.outputTokens > 0 || res.usage.cacheReadTokens > 0 || res.usage.cacheWriteTokens > 0);
      this.collect({
        payload: {
          phase,
          requestText,
          requestForm: acpMerged ? 'acp-merged' : 'gateway-split',
          ...(acpMerged || req.system === undefined ? {} : { system: req.system }),
          responseText: res.text,
          model: res.model,
          providerId: res.providerId,
          stopReason: res.stopReason,
          // 有真实用量 → 写 usage；否则不写（缺省即「不可得」，语义清晰，不误读为 0）
          ...(hasUsage ? { usage: res.usage } : { usageUnavailable: true }),
          ...(responseEmpty ? { responseEmpty: true } : {}),
        },
        startTime: startedAt.toISOString(),
        durationMs: performance.now() - t0,
      });
      return res;
    } catch (e) {
      this.collect({
        payload: {
          phase,
          requestText,
          requestForm: acpMerged ? 'acp-merged' : 'gateway-split',
          ...(acpMerged || req.system === undefined ? {} : { system: req.system }),
          responseText: '',
          model: req.model ?? '',
          providerId: this.inner.kind,
          stopReason: 'error',
          usageUnavailable: true,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        },
        startTime: startedAt.toISOString(),
        durationMs: performance.now() - t0,
      });
      throw e;
    }
  }
}
