/**
 * FakeGateway —— ReasoningBackend 的测试替身（SPEC-0 §2.5 接缝表）。
 *
 * 规格来自 M4 §4：构造参数为 `Map<关键词, 预制回稿>` + 调用日志。
 * 单测永不触碰真实 LLM，M4/M5/M6 全部经它注入固定回稿。
 *
 * 当前为可用骨架：按 prompt 关键词匹配回稿 + 记录全部请求。
 * M3 若需要 embed/expand 的假实现，在此扩（不影响 ReasoningBackend 契约）。
 */

import type { AgentCapabilityFlags, ReasoningBackend, ReasoningRequest, ReasoningResult } from '../../src/reasoning/backend';

export type ReplyTable = Map<string, string>;

export interface FakeGatewayOptions {
  /** 关键词 → 预制回稿。命中第一个包含该关键词的请求 */
  replies?: ReplyTable;
  /** 无关键词命中时的回稿，默认空串 */
  defaultReply?: string;
  /** 覆写 capabilities() 返回值 */
  capabilities?: Partial<AgentCapabilityFlags>;
}

/** 把一次请求摊平成可匹配/可断言的纯文本（system + prompt + 所有 message 内容） */
export function flattenRequest(req: ReasoningRequest): string {
  const parts: string[] = [];
  if (req.system) parts.push(String(req.system));
  if (req.prompt) parts.push(req.prompt);
  for (const m of req.messages ?? []) {
    if (typeof m.content === 'string') parts.push(m.content);
    else for (const b of m.content) if (b.type === 'text') parts.push(b.text);
  }
  return parts.join('\n');
}

export class FakeGateway implements ReasoningBackend {
  readonly kind = 'gateway' as const;
  /** 每次调用按序记录，供断言（M4 的 T4.3-02 要断言指令位不含注入语句） */
  readonly calls: ReasoningRequest[] = [];
  /** 每次调用摊平后的文本，断言更方便 */
  readonly prompts: string[] = [];
  private readonly replies: ReplyTable;
  private readonly defaultReply: string;
  private readonly caps: AgentCapabilityFlags;

  constructor(opts: FakeGatewayOptions = {}) {
    this.replies = opts.replies ?? new Map();
    this.defaultReply = opts.defaultReply ?? '';
    this.caps = {
      streaming: false,
      tools: false,
      sessionPersistence: false,
      embeddings: false,
      ...opts.capabilities,
    };
  }

  async complete(req: ReasoningRequest): Promise<ReasoningResult> {
    return this.respond(req);
  }

  async chat(req: ReasoningRequest): Promise<ReasoningResult> {
    return this.respond(req);
  }

  capabilities(): AgentCapabilityFlags {
    return { ...this.caps };
  }

  async dispose(): Promise<void> {
    /* 无资源可释放 */
  }

  /** 取最后一次调用（断言用） */
  get lastCall(): ReasoningRequest | undefined {
    return this.calls[this.calls.length - 1];
  }

  /** 取最后一次调用摊平文本（断言用） */
  get lastPrompt(): string {
    return this.prompts[this.prompts.length - 1] ?? '';
  }

  private respond(req: ReasoningRequest): ReasoningResult {
    this.calls.push(req);
    const flat = flattenRequest(req);
    this.prompts.push(flat);

    let text = this.defaultReply;
    for (const [keyword, reply] of this.replies) {
      if (flat.includes(keyword)) {
        text = reply;
        break;
      }
    }

    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'fake:fake-model',
      providerId: 'fake',
    };
  }
}
