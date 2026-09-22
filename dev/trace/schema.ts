/**
 * trace 数据模型（spike 观测，单一事实源）。
 *
 * **借 OTel 形状，不引 OTel SDK**（见 docs/adr/ADR-001）：字段命名严格照抄
 * OpenTelemetry 词汇表（traceId / spanId / parentSpanId / name / startTime /
 * endTime / attributes / status / events），但不引入任何 `@opentelemetry/*` 依赖。
 * 将来若要接 Langfuse / Jaeger，只需写一个 exporter 把这些字段映射成 OTLP，零改业务代码。
 *
 * 本文件是 **JSON 落盘与 md 渲染共用的唯一类型来源**——渲染器不得另立结构。
 *
 * 与 OTel 的已知偏差（有意为之，记录在此以便未来映射）：
 * - 时间为 ISO 8601 字符串（带毫秒），而非 OTel 的 epoch nanos（可读性优先）。
 * - `kind` 只取 'internal' | 'client' 两项（OTel 的 5 种 SpanKind 我们用不到其余）。
 * - `status` 只取 'unset' | 'ok' | 'error'（OTel 的 status 是 code + message 组合）。
 * - 不做采样、不做 context propagation、不做批量导出（明确非目标）。
 */

/** span 终态（OTel SpanStatus 的简化子集） */
export type SpanStatus = 'unset' | 'ok' | 'error';

/** span 属性值类型（只取我们用到的四种标量） */
export type AttrValue = string | number | boolean | null;

/** span 属性字典（只放标量，不塞结构化数据） */
export type Attributes = Record<string, AttrValue>;

/** 结构化事件（不影响 span 树结构，仅追加；承载告警等） */
export interface SpanEvent {
  /** 事件名（如 'warning' / 'truncated' / 'extract_failed' / 'io_err'） */
  name: string;
  /** ISO 8601 */
  time: string;
  attributes?: Attributes;
}

/**
 * LLM 调用负载（仅 `kind: 'client'` 的 span 有）。
 *
 * **请求文本必须与实际发送同构**：ACP 腿的 `session/prompt` 没有 system 字段，
 * 其实现（`src/reasoning/acp/backend.ts` 的 `buildPrompt`）把 system 并入 prompt，
 * 拼成 `${system}\n\n---\n\n${user}` 作为**单个文本块**发送。因此本装饰器复刻该
 * 语义（见 `requestForm`），而不是自造两段式——否则 trace 会显示「system 独立发送」，
 * 与实际不符，读 trace 的人会被误导。
 */
export interface LlmPayload {
  /** 该调用发生在哪个 ingest 子步骤（'summarize' | 'extract.single' | 'contradiction:<slug>' …） */
  phase: string;
  /** 送入模型的文本（形态见 requestForm） */
  requestText: string;
  /** requestText 的形态：'acp-merged' = system 已按 ACP 语义并入；'gateway-split' = system/prompt 分离 */
  requestForm: 'acp-merged' | 'gateway-split';
  /** 独立的 system 指令（仅 gateway 腿有；ACP 腿已并入 requestText，此处缺省） */
  system?: string;
  /** 回稿正文 */
  responseText: string;
  /** 实际应答的模型标识 */
  model: string;
  /** 提供方标识 */
  providerId: string;
  /** 停止原因 */
  stopReason: string;
  /**
   * token 用量。**可选**——ACP 协议把用量放在 `session/update` 的 `usage_update`
   * 通知变体里（`used`/`size`/`cost`），而本项目 transport 层当前只识别正文块、
   * 其余通知被丢弃（`src/reasoning/acp/transport.ts` 的 `consumeUpdate`），
   * 因此 ACP 腿下取不到。缺省 vs 零值语义不同：缺省 = 不可得，见 `usageUnavailable`。
   */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** 本腿不上报 usage（ACP 腿为 true）。**不要**把缺省误读为「消耗 0 token」 */
  usageUnavailable?: boolean;
  /** 回稿为空时的显式标记（不静默；ACP 正文经通知推送，某些版本可能不发） */
  responseEmpty?: boolean;
  /** 调用失败时的错误信息（status 为 'error' 时存在） */
  error?: string;
}

/** 候选级快照的一个实体（L3 主体；**含被 drop 的**） */
export interface CandidateTrace {
  slug: string;
  name: string;
  /** 实体类型（concept / person / tool …） */
  kind: string;
  /** 覆盖度（defined / discussed / named） */
  coverage: string;
  /** 判决结果 */
  outcome: 'page' | 'stub' | 'drop';
  /** 出现位置（正文 / 旁注 / 缺失） */
  location: 'prose' | 'aside' | 'absent';
  /** 是否手工链接 */
  handLinked: boolean;
  /** 门的判决理由（回答「该不该抽」的核心证据） */
  reason: string;
  /** 分类判定结果（basis 区分词表判定 vs 模型判定） */
  classification: { kind: string | null; basis: string; reason: string; rejected?: boolean };
  /** 抽取自身给的一句话摘要（模型认为它是什么） */
  summary?: string;
  aliases?: string[];
  /** 该实体所属的关系边 */
  edges?: { from: string; type: string; to: string }[];
  /** 引用式抽取的逐字事实与锚点 */
  facts?: { text: string; chunkIndex: number; sourceRef?: string }[];
  /** 模型提名序号（保留原始顺序信号；排序时不丢） */
  ordinal: number;
  /**
   * 渲染期补充的原文证据：按 location 从 body 截出的片段（与偏移）。
   * `null` = 明确「正文中找不到出处」（疑似模型幻觉提名）。
   */
  evidence?: { snippet: string; offset: number } | null;
}

/** 抽取阶段快照（L3 主体；挂在 `ingest.extract` span 上） */
export interface ExtractionTrace {
  /**
   * 抽取原始回稿（未经解析的文本；回答「模型到底回了什么」）。
   *
   * 注意：`ExtractionResult` 本身**不含**原始回稿（只带解析后的 entities/relations/
   * warnings），回稿在 `extractEntities` 内部被消费后即丢弃。因此这里从**装饰器采集到的
   * 抽取类 LLM span** 回填，多条（cited 模式的骨架 + 分批）按调用顺序拼接并标注。
   */
  rawResponseText: string;
  /** 门控全量候选（含被 drop 的） */
  candidates: CandidateTrace[];
  /** 抽取过程中的可见告警 */
  warnings: string[];
  /** 触硬上限被截断的腿 */
  truncated?: { entities: boolean; relations: boolean };
  /** 抽取是否降级 */
  failed: boolean;
  /** 降级时的错误信息 */
  errorMessage?: string;
}

/** 一个 span（阶段或 LLM 调用） */
export interface Span {
  /** 32 hex（全 trace 一致） */
  traceId: string;
  /** 16 hex */
  spanId: string;
  /** 父 span（根为 null） */
  parentSpanId: string | null;
  /** span 名称（见 spawn 命名表：`ingest.prepare` / `llm.summarize` …） */
  name: string;
  /** 'internal' = 阶段；'client' = LLM 调用 */
  kind: 'internal' | 'client';
  /** ISO 8601（带毫秒） */
  startTime: string;
  /** ISO 8601（带毫秒） */
  endTime: string;
  /** 耗时（毫秒；冗余但便于排序与对比） */
  durationMs: number;
  status: SpanStatus;
  attributes: Attributes;
  /** 结构化事件（告警等） */
  events?: SpanEvent[];
  /** 仅 LLM span 有 */
  llm?: LlmPayload;
  /** 仅 `ingest.extract` span 有（L3 主体） */
  extraction?: ExtractionTrace;
}

/** 一条 trace（一个输入文件一棵 span 树） */
export interface Trace {
  /** 32 hex */
  traceId: string;
  /** 输入标识（vault 内相对路径或原始 input） */
  input: string;
  spans: Span[];
}

/** 单个输入的运行结果摘要（进 manifest） */
export interface TraceSummary {
  /** trace JSON 文件名 */
  file: string;
  input: string;
  ok: boolean;
  durationMs: number;
  /** 失败时的错误信息 */
  error?: string;
  /** 【M14】内容短路命中（仅刷新 raw 元数据，未走 LLM） */
  shortCircuited?: boolean;
  /** 阈值：候选判决计数（evals 的原始指标） */
  counts?: { page: number; stub: number; drop: number };
}

/**
 * 运行级元数据（manifest）。
 *
 * 记录**全部自变量**——这是跨 run 对比时可归因的前提（评测集的「我改了什么」）。
 */
export interface RunManifest {
  runId: string;
  startedAt: string;
  /** 代码版本（git HEAD + 是否有未提交改动） */
  git: { head: string; dirty: boolean };
  node: string;
  /** 推理腿信息（含**运行期实际探测到**的 agent 版本，不信任注册表静态注记） */
  backend: {
    kind: string;
    providerId: string;
    command: string;
    args: string[];
    /** 运行期从 initialize 握手探测到的 agent 名称与版本 */
    agentInfo?: { name?: string; version?: string };
  };
  /** 注册表里的静态注记（供与 agentInfo 对比，暴露版本漂移） */
  registryNote?: string;
  capabilities: { streaming: boolean; tools: boolean; sessionPersistence: boolean; embeddings: boolean };
  /** 参数快照（本次 run 的自变量） */
  options: { granularity: string; extractMode: string; committed: boolean };
  /**
   * 【探测结论】opencode 是否发送 `session/update` 的 `usage_update` 通知。
   * 回答「ACP 腿能否支持 token 评测」。`unknown` = 未探测/未观测到。
   */
  usageUpdateProbe: {
    /** 观测到的 session/update 变体类型集合 */
    observedUpdateKinds: string[];
    /** 是否观测到 usage_update */
    seen: boolean;
    /** 若观测到，其原始载荷（裁剪用，供人工核对字段形状） */
    sample?: unknown;
  };
  traces: TraceSummary[];
}
