/**
 * 全产品共享推理层消息类型（00 §4.1，逐字采用，全文档族唯一定义处）。
 *
 * 形状参照 gbrain `src/core/ai/gateway.ts` 的 `ChatResult` 与 `normalizeSdkUsage`。
 * `ReasoningRequest` / `ReasoningResult` 定义在 `./backend.ts`（含接口本体），
 * 其别名 `ChatOpts` / `ChatResult` 在此导出，供 03/06 引用。
 */

import type { ReasoningRequest, ReasoningResult } from './backend';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** 多轮消息：content 为纯文本或块数组（assistant 的工具调用轮为块数组） */
export interface ChatMessage {
  role: ChatRole;
  content: string | ChatBlock[];
}

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown };

export interface ChatToolDef {
  name: string;
  description: string;
  /** JSON Schema（工具入参） */
  inputSchema: Record<string, unknown>;
}

/** 03 的 ChatOpts = ReasoningRequest 别名；ChatResult = ReasoningResult 别名 */
export type ChatOpts = ReasoningRequest;
export type ChatResult = ReasoningResult;

/** 03 embed() 的选项 */
export interface EmbedOpts {
  model?: string; // "provider:model"，缺省走配置 embedding_model
  abortSignal?: AbortSignal;
}

/** 检索结果条目（06 检索层与索引层共用；id = 引用锚点，见 06 §2.3） */
export interface Ranked {
  id: string; // "slug#chunk-NNN" 或 "slug"
  slug: string; // wiki 页 slug（相对 wiki/ 的去扩展名路径）
  score: number; // 融合后的排序分
  cosine?: number; // 向量余弦相似度（MVP BM25-only 时缺省）
  chunkIndex?: number; // 页内 chunk 序号（引用锚点用）
  confidence?: string; // 页面 frontmatter confidence（重排加权用）
  snippet?: string; // 命中片段（综合层引用展示用）
}
