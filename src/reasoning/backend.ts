/**
 * 推理层统一契约（00 §4，逐字采用）。
 *
 * Wiki Core 不关心底下是直连 API 还是本地 agent —— 二者实现同一个接口。
 * 两个实现：
 * - `GatewayBackend`（03，默认腿，直连 @ai-sdk）
 * - `ACPAgentBackend`（04，第二刀可选，本地 agent 子进程 + ACP JSON-RPC，纯补全器）
 *
 * 能力不透明：上层必须先查 `capabilities()` 再用（运行时探测而非胖接口）。
 */

import type { ChatBlock, ChatMessage, ChatToolDef } from './types';

export interface ReasoningRequest {
  /** 单轮 prompt（complete 用）；多轮走 messages */
  prompt?: string;
  /** 多轮消息（chat 用），与 prompt 二选一 */
  messages?: ChatMessage[];
  system?: string;
  model?: string; // "provider:model"，缺省走 backend 默认
  maxTokens?: number;
  tools?: ChatToolDef[];
  abortSignal?: AbortSignal;
  /** 透传给具体 backend 的 provider 专属选项 */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface ReasoningResult {
  text: string;
  blocks: ChatBlock[]; // 文本块 + 工具调用块，原始留存
  stopReason: 'end' | 'tool_calls' | 'length' | 'refusal' | 'content_filter' | 'other';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  model: string; // 实际应答的 "provider:model"
  providerId: string;
}

/**
 * 运行时探测到的能力位（00 §4 的 `capabilities()` 返回值）。
 *
 * 00 只给出「流式 / 工具 / 会话持久化…」的语义描述，未逐字定义字段名；
 * 此处按该语义落成四项，`embeddings` 一项为 03 的 `embed()` 分腿预留。
 * M7 若需更多位（如 ACP 的 fs/terminal 能力）在此扩，不动签名。
 */
export interface AgentCapabilityFlags {
  streaming: boolean;
  tools: boolean;
  sessionPersistence: boolean;
  embeddings: boolean;
}

export interface ReasoningBackend {
  readonly kind: 'gateway' | 'acp-agent';
  /** 单轮："给 prompt，回结果" */
  complete(req: ReasoningRequest): Promise<ReasoningResult>;
  /** 多轮：传 messages 数组 */
  chat(req: ReasoningRequest): Promise<ReasoningResult>;
  /** 探测能力（流式 / 工具 / 会话持久化…），运行时决定能力而非胖接口 */
  capabilities(): AgentCapabilityFlags;
  /** 关闭底层资源（ACP 子进程 / 连接） */
  dispose(): Promise<void>;
}
