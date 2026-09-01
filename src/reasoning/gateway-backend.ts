/**
 * LLM 推理网关默认腿（03 §4–§10 / M3 §2）。实现 00 的 `GatewayBackend`。
 *
 * 不变量 I1（env 隔离）：本文件**任何位置都不读取环境变量** —— 超时来自
 * `defaultTimeoutMs()`（走 `AIGatewayConfig`），密钥走 `configureGateway` 注入的配置对象。
 * 调用点也不读 env（见 T3.2-03 静态检查）。
 *
 * 不变量 I4（全链路超时）：每次 provider 调用包 `withDefaultTimeout`。
 * 不变量 I5（错误归一化）：401/403/400→ConfigError；429/408/5xx/AbortError/网络→TransientError。
 *
 * 测试接缝：chat/embed 经模块级 `_chatTransport`/`_embedTransport` 注入假响应，
 * 单测零真实网络（SPEC-0 §2.5）。
 *
 * 字段映射铁律（P0-6）：下方 usage/缓存/stopReason 映射已对照锁定版本
 * `ai@6.0.273` + `@ai-sdk/*` 的 `.d.ts` 复核——v6 的 `LanguageModelUsage` 用
 * `inputTokens`/`outputTokens`，缓存令牌在 `inputTokenDetails.cacheReadTokens`/
 * `cacheWriteTokens`（非旧文档假设的 `usage.cachedInputTokens`）。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { embedMany, generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { ConfigError, TransientError } from '../errors';
import type { ChatBlock, EmbedOpts } from './types';
import type { ReasoningBackend, ReasoningRequest, ReasoningResult } from './backend';
import {
  defaultTimeoutMs,
  getConfig,
  type ProviderRecipe,
} from './gateway-config';
import {
  assertTouchpoint,
  embeddingDimsForModel,
  resolveRecipe,
  type ParsedModel,
} from './model-resolver';

// ---------------------------------------------------------------------------
// 测试接缝（SPEC-0 §2.5 / 03 §10）
// ---------------------------------------------------------------------------

type ChatTransport = (req: ReasoningRequest) => Promise<ReasoningResult>;
type EmbedTransport = (texts: string[], opts?: EmbedOpts) => Promise<Float32Array[]>;

let _chatTransport: ChatTransport | null = null;
let _embedTransport: EmbedTransport | null = null;

/** 注入假 chat 响应（测试用），传 null 复位为真实路径 */
export function __setChatTransportForTests(fn: ChatTransport | null): void {
  _chatTransport = fn;
}

/** 注入假 embed 响应（测试用），传 null 复位为真实路径 */
export function __setEmbedTransportForTests(fn: EmbedTransport | null): void {
  _embedTransport = fn;
}

// ---------------------------------------------------------------------------
// 认证解析（03 §2.1）
// ---------------------------------------------------------------------------

function authToHeaders(auth: { headerName: string; token: string }): Record<string, string> {
  return { [auth.headerName]: auth.token };
}

/**
 * 把 recipe 变成 apiKey 或自定义头。优先 `recipe.auth`（自定义头方案），
 * 其次 `recipe.apiKey`（默认 Authorization: Bearer），都没有则空对象。
 */
function applyResolveAuth(
  recipe: ProviderRecipe,
  _cfg: ReturnType<typeof getConfig>,
): { apiKey?: string; headers?: Record<string, string> } {
  if (recipe.auth) return { headers: authToHeaders(recipe.auth) };
  if (recipe.apiKey) return { apiKey: recipe.apiKey };
  return {};
}

// ---------------------------------------------------------------------------
// @ai-sdk 模型工厂（03 §4.1）—— 调用形状按锁定版本 .d.ts 核对
// ---------------------------------------------------------------------------

/**
 * 运行时构造 @ai-sdk 模型对象（供 generateText/embedMany 使用）。
 * anthropic/google/openai-compatible 在 v6 下以 `provider(modelId)` 调用；
 * openai 额外提供 `.chat(modelId)` 便捷访问器。
 */
export function buildAiSdkModel(parsed: ParsedModel, recipe: ProviderRecipe): unknown {
  const auth = applyResolveAuth(recipe, getConfig());
  switch (parsed.providerId) {
    case 'anthropic':
      return createAnthropic({ apiKey: auth.apiKey, ...auth })(parsed.modelId);
    case 'openai':
      return createOpenAI({ apiKey: auth.apiKey, baseURL: recipe.baseURL, ...auth }).chat(
        parsed.modelId,
      );
    case 'google':
      return createGoogleGenerativeAI({ apiKey: auth.apiKey, ...auth })(parsed.modelId);
    case 'ollama':
      return createOpenAICompatible({
        name: 'ollama',
        baseURL: recipe.baseURL ?? 'http://localhost:11434/v1',
        apiKey: 'ollama',
      })(parsed.modelId);
    default:
      return createOpenAICompatible({
        name: parsed.providerId,
        baseURL: recipe.baseURL ?? 'http://localhost:11434/v1',
        apiKey: auth.apiKey,
      })(parsed.modelId);
  }
}

// ---------------------------------------------------------------------------
// usage / stopReason 归一化（03 §4 / P0-6）
// ---------------------------------------------------------------------------

function firstFiniteOf(...vals: Array<number | undefined | null>): number {
  for (const v of vals) {
    if (v != null && Number.isFinite(v)) return v;
  }
  return 0;
}

/**
 * 把 @ai-sdk 的 LanguageModelUsage 归一化为契约 `usage`。
 * v6 形状：inputTokens/outputTokens；legacy 形状：promptTokens/completionTokens（兜底）。
 * 缓存令牌：anthropic providerMetadata 优先 → v6 中立 `inputTokenDetails`。
 */
export function normalizeSdkUsage(res: {
  usage?: Record<string, unknown>;
  providerMetadata?: unknown;
}): ReasoningResult['usage'] {
  const u = (res.usage ?? {}) as Record<string, unknown>;
  const pm = (res.providerMetadata ?? {}) as
    | Record<string, Record<string, unknown> | undefined>
    | undefined;
  const anthropic = (pm?.anthropic ?? {}) as Record<string, unknown>;
  const details = (u.inputTokenDetails as Record<string, unknown> | undefined) ?? {};
  return {
    inputTokens: firstFiniteOf(
      u.inputTokens as number | undefined,
      u.promptTokens as number | undefined,
    ),
    outputTokens: firstFiniteOf(
      u.outputTokens as number | undefined,
      u.completionTokens as number | undefined,
    ),
    cacheReadTokens: firstFiniteOf(
      anthropic.cacheReadInputTokens as number | undefined,
      details.cacheReadTokens as number | undefined,
    ),
    cacheWriteTokens: firstFiniteOf(
      anthropic.cacheCreationInputTokens as number | undefined,
      details.cacheWriteTokens as number | undefined,
    ),
  };
}

/**
 * 把 finishReason + providerMetadata 映射到契约 stopReason（F3.4-05）。
 * 注：v6 的 FinishReason 不含 'refusal'/'end-turn'，二者来自 anthropic 的
 * `providerMetadata.anthropic.stopReason`，故优先读之。
 */
export function mapStopReason(
  finishReason: string | undefined,
  providerMetadata: Record<string, Record<string, unknown> | undefined> | undefined,
): ReasoningResult['stopReason'] {
  const anthropic = (providerMetadata?.anthropic ?? {}) as Record<string, unknown>;
  const raw = String(
    anthropic.stopReason ?? anthropic.stop_reason ?? finishReason ?? '',
  ).replace(/_/g, '-'); // end_turn → end-turn
  if (raw === 'refusal') return 'refusal';
  if (raw === 'content-filter' || raw === 'content_filter') return 'content_filter';
  if (raw === 'tool-calls' || raw === 'tool_calls') return 'tool_calls';
  if (raw === 'length' || raw === 'max-tokens' || raw === 'max_tokens') return 'length';
  if (raw === 'stop' || raw === 'end' || raw === 'end-turn' || raw === '') return 'end';
  return 'other';
}

/** 把 @ai-sdk 的 ResponseMessage[] 摊平为契约 ChatBlock[]（F3.4-06） */
export function toChatBlocks(messages: Array<{ role: string; content: unknown }>): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.length > 0) blocks.push({ type: 'text', text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; [k: string]: unknown };
      if (p.type === 'text') {
        blocks.push({ type: 'text', text: String(p.text ?? '') });
      } else if (p.type === 'tool-call') {
        blocks.push({
          type: 'tool-call',
          toolCallId: String(p.toolCallId ?? ''),
          toolName: String(p.toolName ?? ''),
          input: p.input,
        });
      } else if (p.type === 'tool-result') {
        blocks.push({
          type: 'tool-result',
          toolCallId: String(p.toolCallId ?? ''),
          toolName: String(p.toolName ?? ''),
          output: p.output,
        });
      }
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// 超时（03 §5 / I4）
// ---------------------------------------------------------------------------

/**
 * 全链路超时：用 AbortSignal.any 组合调用方 signal 与超时 signal。
 * 调用方已 abort 则直接复用调用方信号（caller 优先）。纯超时触发由调用方捕获后归一化。
 */
export function withDefaultTimeout(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  // caller 已 abort → 直接复用本体（caller 优先）。否则 AbortSignal.any 会生成新 composite，
  // 而已触发 abort 事件的信号无法被 transport 的 addEventListener('abort') 监听，导致 hung（T3.5-06）。
  if (caller?.aborted) return caller;
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

// ---------------------------------------------------------------------------
// 错误归一化（03 §6 / I5）
// ---------------------------------------------------------------------------

/**
 * 把 provider/网络错误归一化为 ConfigError / TransientError。
 * 4xx（401/403/400）→ ConfigError(PROVIDER_CONFIG)；
 * 429/408/5xx/AbortError/网络层 → TransientError(TRANSIENT)；
 * 其余原样上抛（不吞，避免漏入兜底分支）。
 */
export function normalizeGatewayError(err: unknown): Error {
  const e = err as {
    statusCode?: number;
    name?: string;
    message?: string;
  } | null;
  if (e == null) return new Error(String(err));
  // 配置错
  if (e.statusCode === 401 || e.statusCode === 403 || e.statusCode === 400) {
    return new ConfigError('PROVIDER_CONFIG', String(e.message));
  }
  // 可重试：限流/超时/服务端瞬断/网络层
  if (
    e.statusCode === 429 ||
    e.statusCode === 408 ||
    (e.statusCode != null && e.statusCode >= 500 && e.statusCode < 600) ||
    e.name === 'AbortError' ||
    /timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(String(e.message))
  ) {
    return new TransientError('TRANSIENT', String(e.message));
  }
  // 未知错误原样上抛
  return e instanceof Error ? e : new Error(String(err));
}

// ---------------------------------------------------------------------------
// 预算计量（03 §7 / F3.6-04）
// ---------------------------------------------------------------------------

export interface BudgetEvent {
  modelId: string;
  kind: 'chat' | 'embed';
  tokens?: number;
}

export interface BudgetTracker {
  reserve?(event: BudgetEvent): void;
  record?(event: { model: string; usage: ReasoningResult['usage'] }): void;
}

const __budgetStore = new AsyncLocalStorage<BudgetTracker>();

/** 在当前异步上下文注入预算追踪器（MVP 可传 no-op tracker） */
export function withBudgetTracker<T>(tracker: BudgetTracker, fn: () => Promise<T>): Promise<T> {
  return __budgetStore.run(tracker, fn);
}

/** 读取当前上下文的预算追踪器；未注入则 null */
export function getCurrentBudgetTracker(): BudgetTracker | null {
  return __budgetStore.getStore() ?? null;
}

// ---------------------------------------------------------------------------
// 响应大小上限 + 缩容（03 §8 / F3.6-02）
// ---------------------------------------------------------------------------

const MAX_VOYAGE_RESPONSE_BYTES = 256 * 1024 * 1024; // 256MB
const SHRINK_FLOOR = 0.05; // 最小缩到原尺寸的 5%
const SHRINK_HEAL_AFTER = 10; // 连续 10 次成功后恢复 1.0

/** embed 响应过大时抛出的错误（非全局错误类，仅本模块内部用于触发缩容） */
export class VoyageResponseTooLargeError extends Error {
  constructor(byteSize: number) {
    super(`embed 响应 ${byteSize} 字节超 ${MAX_VOYAGE_RESPONSE_BYTES} 字节，已缩容`);
    this.name = 'VoyageResponseTooLargeError';
  }
}

let shrinkLevel = 1.0;
let healCount = 0;

/** 当前缩容系数（测试可观测） */
export function currentShrinkLevel(): number {
  return shrinkLevel;
}

/** 测试复位缩容状态 */
export function __resetShrinkForTests(): void {
  shrinkLevel = 1.0;
  healCount = 0;
}

/**
 * 检查 embed 响应字节大小；超限则缩容并抛 VoyageResponseTooLargeError，
 * 连续 SHRINK_HEAL_AFTER 次成功后回升到 1.0。
 * 导出便于单测直接以字节数触发（避免构造 256MB 真实向量，省内存）。
 */
export function maybeShrink(byteSize: number): void {
  if (byteSize > MAX_VOYAGE_RESPONSE_BYTES) {
    shrinkLevel = Math.max(SHRINK_FLOOR, shrinkLevel * 0.8);
    healCount = 0;
    throw new VoyageResponseTooLargeError(byteSize);
  }
  if (++healCount >= SHRINK_HEAL_AFTER) {
    shrinkLevel = 1.0;
    healCount = 0;
  }
}

function estimateEmbeddingsByteSize(embeddings: Array<Float32Array | number[]>): number {
  let total = 0;
  for (const e of embeddings) {
    total += e instanceof Float32Array ? e.byteLength : e.length * 4;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 推理入口（03 §4）
// ---------------------------------------------------------------------------

/**
 * 单轮/多轮 chat。真实路径走 generateText；测试接缝 `_chatTransport` 优先。
 * 全程在 `withBudgetTracker` 上下文内计量（reserve/record）。
 */
export async function chat(req: ReasoningRequest): Promise<ReasoningResult> {
  const modelStr = req.model ?? getConfig().chat_model;
  const { parsed, recipe } = resolveRecipe(modelStr);
  assertTouchpoint(recipe, 'chat', modelStr);

  const abortSignal = withDefaultTimeout(req.abortSignal, defaultTimeoutMs());
  const tracker = getCurrentBudgetTracker();
  tracker?.reserve?.({ modelId: modelStr, kind: 'chat' });

  try {
    // 已 abort 的 caller 信号其事件已触发，transport 的 addEventListener('abort') 不会回放，
    // 故在此立即归一化为 TransientError，避免 hung（T3.5-06）。
    if (abortSignal.aborted) {
      const ab = new Error('Aborted: caller signal already aborted');
      ab.name = 'AbortError';
      throw ab;
    }
    if (_chatTransport) {
      const r = await _chatTransport({ ...req, model: modelStr, abortSignal });
      tracker?.record?.({ model: modelStr, usage: r.usage });
      return r;
    }

    const model = buildAiSdkModel(parsed, recipe) as Parameters<typeof generateText>[0]['model'];
    const res = await generateText({
      model,
      system: req.system,
      messages: (req.messages ?? []) as unknown as NonNullable<
        Parameters<typeof generateText>[0]['messages']
      >,
      maxOutputTokens: req.maxTokens,
      abortSignal,
      providerOptions: req.providerOptions as never,
    });
    const usage = normalizeSdkUsage(res);
    tracker?.record?.({ model: modelStr, usage });
    return {
      text: res.text,
      blocks: toChatBlocks((res.response?.messages ?? []) as Array<{ role: string; content: unknown }>),
      stopReason: mapStopReason(res.finishReason, res.providerMetadata),
      usage,
      model: modelStr,
      providerId: parsed.providerId,
    };
  } catch (err) {
    throw normalizeGatewayError(err);
  }
}

/** 多行展开查询为子查询数组（F3.6-03，复用 chat） */
export async function expand(query: string): Promise<string[]> {
  const r = await chat({
    messages: [
      { role: 'user', content: `展开查询为子查询（每行一个）：${query}` },
    ],
  });
  return r.text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** embedding（F3.6-01/02）。配置校验在接缝之前，确保 NO_EMBED_TOUCHPOINT/NO_DIMS 零网络即可触发 */
export async function embed(texts: string[], opts?: EmbedOpts): Promise<Float32Array[]> {
  const modelStr = opts?.model ?? getConfig().embedding_model;
  const { parsed, recipe } = resolveRecipe(modelStr);
  assertTouchpoint(recipe, 'embedding', modelStr);
  embeddingDimsForModel(recipe, modelStr); // 缺 dims → NO_DIMS（在接缝前，零网络）

  const abortSignal = withDefaultTimeout(opts?.abortSignal, defaultTimeoutMs());
  const tracker = getCurrentBudgetTracker();
  tracker?.reserve?.({ modelId: modelStr, kind: 'embed' });

  try {
    if (abortSignal.aborted) {
      const ab = new Error('Aborted: caller signal already aborted');
      ab.name = 'AbortError';
      throw ab;
    }
    if (_embedTransport) {
      const r = await _embedTransport(texts, opts);
      tracker?.record?.({
        model: modelStr,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
      return r;
    }

    const model = buildAiSdkModel(parsed, recipe) as Parameters<typeof embedMany>[0]['model'];
    const res = await embedMany({
      model,
      values: texts,
      abortSignal,
    });
    const byteSize = estimateEmbeddingsByteSize(res.embeddings as Array<Float32Array | number[]>);
    maybeShrink(byteSize); // 超限 → VoyageResponseTooLargeError
    tracker?.record?.({
      model: modelStr,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    return res.embeddings as unknown as Float32Array[];
  } catch (err) {
    throw normalizeGatewayError(err);
  }
}

// ---------------------------------------------------------------------------
// GatewayBackend：ReasoningBackend 默认实现（00 §4 / M3 §1）
// ---------------------------------------------------------------------------

export class GatewayBackend implements ReasoningBackend {
  readonly kind = 'gateway' as const;

  /** 单轮：prompt → messages → chat */
  async complete(req: ReasoningRequest): Promise<ReasoningResult> {
    const messages =
      req.messages ?? (req.prompt != null ? [{ role: 'user', content: req.prompt }] : []);
    return chat({ ...req, messages });
  }

  async chat(req: ReasoningRequest): Promise<ReasoningResult> {
    return chat(req);
  }

  async embed(texts: string[], opts?: EmbedOpts): Promise<Float32Array[]> {
    return embed(texts, opts);
  }

  async expand(query: string): Promise<string[]> {
    return expand(query);
  }

  capabilities() {
    return {
      streaming: false,
      tools: true,
      sessionPersistence: false,
      embeddings: true,
    } satisfies import('./backend').AgentCapabilityFlags;
  }

  async dispose(): Promise<void> {
    // 网关无持久连接资源
  }
}
