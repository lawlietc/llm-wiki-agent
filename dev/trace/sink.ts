/**
 * TraceSink —— span 树的组装、确定性排序与序列化（spike 观测）。
 *
 * 职责：
 * 1. 生成 traceId / spanId（或可 diff 模式下的确定性标识）
 * 2. 接收 LLM 采集回调与阶段边界，组装成 span 列表
 * 3. 收集 io.err 告警为 span events
 * 4. 承载入参快照所需的候选级数据（L3）
 * 5. 确定性排序与序列化（为跨 run diff 服务）
 */

import { randomBytes } from 'node:crypto';

import type { ExtractionResult } from '../../src/ingest/extract';
import type { GateResult, GatedCandidate } from '../../src/ingest/candidate-gate';
import type { PreparedIngest } from '../../src/ingest/ingest';
import type { LlmCallRecord } from './tracing-backend';
import type {
  Attributes,
  CandidateTrace,
  ExtractionTrace,
  RunManifest,
  Span,
  SpanEvent,
  SpanStatus,
  Trace,
} from './schema';

/** 阶段 span 的开启句柄 */
export interface PhaseHandle {
  /** 结束该阶段（写状态、耗时、属性） */
  end(status?: SpanStatus, attributes?: Attributes): void;
}

/** 候选排序权重：page < stub < drop（drop 置底） */
const OUTCOME_ORDER: Record<CandidateTrace['outcome'], number> = { page: 0, stub: 1, drop: 2 };

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** 排序后确定性序列化（字段顺序固定；供 --diffable 与常规落盘共用） */
const SPAN_KEY_ORDER: readonly (keyof Span)[] = [
  'traceId',
  'spanId',
  'parentSpanId',
  'name',
  'kind',
  'startTime',
  'endTime',
  'durationMs',
  'status',
  'attributes',
  'events',
  'llm',
  'extraction',
];

const EXTRACTION_KEY_ORDER: readonly (keyof ExtractionTrace)[] = [
  'rawResponseText',
  'candidates',
  'warnings',
  'truncated',
  'failed',
  'errorMessage',
];

const CANDIDATE_KEY_ORDER: readonly (keyof CandidateTrace)[] = [
  'slug',
  'name',
  'kind',
  'coverage',
  'outcome',
  'location',
  'handLinked',
  'reason',
  'classification',
  'summary',
  'aliases',
  'edges',
  'facts',
  'ordinal',
  'evidence',
];

/** 按固定键序重排对象（未知键按原名追加在后），使重构字段声明顺序不影响序列化 */
function reorder<T extends object>(obj: T, order: readonly (keyof T)[]): Record<string, unknown> {
  const src = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of order) {
    const key = k as string;
    if (key in src && src[key] !== undefined) out[key] = src[key];
  }
  for (const k of Object.keys(src).sort()) {
    if (!(k in out) && src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

/** JSON.stringify 的 replacer：对已知结构应用固定键序（含递归） */
function stableReplacer(this: unknown, key: string, value: unknown): unknown {
  if (key === '' || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;
  const rec = value as Record<string, unknown>;
  // 通过形状特征判定用哪套键序
  if ('spanId' in rec && 'traceId' in rec && 'parentSpanId' in rec) {
    return reorder(rec as unknown as Span, SPAN_KEY_ORDER);
  }
  if ('rawResponseText' in rec && 'candidates' in rec && 'warnings' in rec) {
    return reorder(rec as unknown as ExtractionTrace, EXTRACTION_KEY_ORDER);
  }
  if ('outcome' in rec && 'location' in rec && 'ordinal' in rec) {
    return reorder(rec as unknown as CandidateTrace, CANDIDATE_KEY_ORDER);
  }
  if ('attributes' in rec && typeof rec.attributes === 'object' && rec.attributes !== null) {
    const attrs = rec.attributes as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(attrs).sort()) sorted[k] = attrs[k];
    rec.attributes = sorted;
  }
  return rec;
}

/** 确定性序列化：固定缩进、固定键序、结尾换行 */
export function serializeTrace(trace: Trace): string {
  return `${JSON.stringify(trace, stableReplacer, 2)}\n`;
}

export function serializeManifest(manifest: RunManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * TraceSink：先 `beginTrace(input)`，随后通过 `phase()` / `llm()` / `attach()` 填充，
 * 最后 `endTrace()` 取回一棵排好序的 span 树。
 */
export class TraceSink {
  private traceId = '';
  private input = '';
  private spans: Span[] = [];
  private readonly diffable: boolean;
  /** diffable 模式下的确定性 span 序号 */
  private spanCounter = 0;

  constructor(opts: { diffable?: boolean } = {}) {
    this.diffable = opts.diffable === true;
  }

  /** 开一条新 trace（一个输入一棵树） */
  beginTrace(input: string): void {
    this.traceId = this.diffable ? '0'.repeat(32) : hex(16);
    this.input = input;
    this.spans = [];
    this.spanCounter = 0;
  }

  private nextSpanId(): string {
    if (!this.diffable) return hex(8);
    this.spanCounter += 1;
    return this.spanCounter.toString(16).padStart(16, '0');
  }

  /** 开一个阶段 span；返回句柄供结束 */
  phaseStart(name: string, parentSpanId: string | null = null, attributes: Attributes = {}): PhaseHandle & { spanId: string } {
    const spanId = this.nextSpanId();
    const startTime = new Date().toISOString();
    const t0 = performance.now();
    const span: Span = {
      traceId: this.traceId,
      spanId,
      parentSpanId,
      name,
      kind: 'internal',
      startTime,
      endTime: startTime,
      durationMs: 0,
      status: 'unset',
      attributes,
    };
    this.spans.push(span);
    return {
      spanId,
      end: (status: SpanStatus = 'ok', attrs?: Attributes) => {
        span.endTime = new Date().toISOString();
        span.durationMs = Math.round((performance.now() - t0) * 1000) / 1000;
        span.status = status;
        if (attrs) span.attributes = { ...span.attributes, ...attrs };
      },
    };
  }

  /** 记录一次 LLM 调用（由 TracingBackend 的回调驱动） */
  llm(record: LlmCallRecord, parentSpanId: string | null = null): void {
    const span: Span = {
      traceId: this.traceId,
      spanId: this.nextSpanId(),
      parentSpanId,
      name: `llm.${record.payload.phase}`,
      kind: 'client',
      startTime: record.startTime,
      endTime: new Date().toISOString(),
      durationMs: Math.round(record.durationMs * 1000) / 1000,
      status: record.payload.error !== undefined ? 'error' : 'ok',
      attributes: {
        'llm.phase': record.payload.phase,
        'llm.model': record.payload.model,
        'llm.request_form': record.payload.requestForm,
      },
      llm: record.payload,
    };
    this.spans.push(span);
  }

  /** 往指定 span 追加一个事件（如 io.err 收集到的告警） */
  addEvent(spanId: string, name: string, attributes?: Attributes): void {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    const event: SpanEvent = { name, time: new Date().toISOString(), ...(attributes ? { attributes } : {}) };
    span.events = span.events ?? [];
    span.events.push(event);
  }

  /** 把「相位 A 观测产物」挂到抽取 span 上（L3 主体） */
  attachExtraction(spanId: string, prepared: PreparedIngest): void {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    span.extraction = buildExtractionTrace(prepared, collectExtractionRawText(this.spans));
  }

  /** 取回排好序的 span 树副本 */
  endTrace(): Trace {
    const sorted = sortSpans(this.spans);
    return { traceId: this.traceId, input: this.input, spans: sorted };
  }
}

/** span 排序：按 startTime（ISO 字典序即时间序），其次按 spanId —— 保证确定性 */
function sortSpans(spans: Span[]): Span[] {
  return [...spans].sort((a, b) => (a.startTime === b.startTime ? a.spanId.localeCompare(b.spanId) : a.startTime.localeCompare(b.startTime)));
}

/** 从编排产物构造 L3 快照（含被 drop 的候选） */
export function buildExtractionTrace(prepared: PreparedIngest, rawResponseText: string): ExtractionTrace {
  const t = prepared.trace;
  const gate: GateResult = t?.gate ?? { candidates: [], edges: [] };
  const extraction: ExtractionResult | null = t?.extraction ?? null;

  const candidates = gate.candidates.map((c, ordinal) => toCandidateTrace(c, prepared.body, gate, ordinal));

  return {
    rawResponseText,
    candidates,
    warnings: extraction?.warnings ?? [],
    ...(extraction?.truncated ? { truncated: extraction.truncated } : {}),
    failed: t?.extractionFailed ?? false,
    ...(t?.extractionError !== undefined ? { errorMessage: t.extractionError } : {}),
  };
}

/**
 * 把抽取类 LLM span 的回稿按调用顺序拼成「原始回稿」。
 *
 * 为什么需要：`ExtractionResult` 不含原始回稿（在 `extractEntities` 内部被消费后即丢弃），
 * 而回稿是回答「模型到底回了什么」的唯一证据。装饰器已逐次捕获，这里按时间序拼接。
 *
 * 排序键用 `(startTime, spanId)` 而非仅 startTime：同一毫秒内的多次调用（cited 模式
 * 的骨架 + 分批可能密集触发）仅靠时间会错序；spanId 在 diffable 模式下是单调序号、
 * 常规模式下是随机 hex——故仅在 startTime 并列时以 spanId 兜底，保证「至少确定」。
 */
function collectExtractionRawText(spans: readonly Span[]): string {
  const parts = spans
    .filter((s) => s.kind === 'client' && s.llm !== undefined && s.llm.phase.startsWith('extract'))
    .sort((a, b) =>
      a.startTime === b.startTime ? a.spanId.localeCompare(b.spanId) : a.startTime.localeCompare(b.startTime),
    )
    .map((s) => s.llm!.responseText);
  if (parts.length <= 1) return parts[0] ?? '';
  return parts.map((p, i) => `/* ---- 抽取调用 #${i + 1} ---- */\n${p}`).join('\n\n');
}
/** 单个候选 → 快照（补原文证据、归属关系边） */
function toCandidateTrace(c: GatedCandidate, body: string, gate: GateResult, ordinal: number): CandidateTrace {
  const slug = c.candidate.slug;
  const edges = gate.edges
    .filter((e) => e.from === slug || e.to === slug)
    .map((e) => ({ from: e.from, type: e.type, to: e.to }))
    .sort((a, b) => `${a.from}|${a.type}|${a.to}`.localeCompare(`${b.from}|${b.type}|${b.to}`));

  const facts = (c.candidate.facts ?? [])
    .map((f) => ({ text: f.text, chunkIndex: f.chunkIndex, ...(f.sourceRef !== undefined ? { sourceRef: f.sourceRef } : {}) }))
    .sort((a, b) => `${a.sourceRef ?? ''}|${a.chunkIndex}|${a.text}`.localeCompare(`${b.sourceRef ?? ''}|${b.chunkIndex}|${b.text}`));

  return {
    slug,
    name: c.candidate.name,
    kind: c.candidate.kind,
    coverage: c.candidate.coverage,
    outcome: c.outcome,
    location: c.location,
    handLinked: c.handLinked,
    reason: c.reason,
    classification: {
      kind: c.classification.kind,
      basis: c.classification.basis,
      reason: c.classification.reason,
      ...(c.classification.rejected !== undefined ? { rejected: c.classification.rejected } : {}),
    },
    ...(c.candidate.summary !== undefined ? { summary: c.candidate.summary } : {}),
    ...(c.candidate.aliases !== undefined && c.candidate.aliases.length > 0 ? { aliases: c.candidate.aliases } : {}),
    ...(edges.length > 0 ? { edges } : {}),
    ...(facts.length > 0 ? { facts } : {}),
    ordinal,
    evidence: findEvidence(body, c.candidate.name, c.candidate.aliases),
  };
}

/**
 * 在原文中找该实体（名或别名）的出现位置；找不到返回 null（疑似幻觉提名）。
 *
 * **必须查别名**：抽取层允许实体名与正文用别名（如 `AI Native SDLC` vs 正文的
 * 「AI 原生 SDLC」）。只按 `name` 精确查会把「模型用别名提名」误判成「正文中不存在」
 * → 假阴性（把正常提名标成疑似幻觉）。
 */
function findEvidence(body: string, name: string, aliases?: readonly string[]): { snippet: string; offset: number } | null {
  const candidates = [name, ...(aliases ?? [])].filter((s) => s.trim() !== '');
  let best: { idx: number; token: string } | null = null;
  for (const token of candidates) {
    const idx = body.indexOf(token);
    if (idx !== -1 && (best === null || idx < best.idx)) best = { idx, token };
  }
  if (best === null) return null;
  const start = Math.max(0, best.idx - 40);
  const end = Math.min(body.length, best.idx + best.token.length + 40);
  const snippet = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return { snippet, offset: best.idx };
}
