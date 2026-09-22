/**
 * ingest 编排（05 §5 / F4.5；M10 扩展实体抽取；M13 扩展分类与毕业）。
 *
 * detect → extract → renderRawNote → summarizeToWiki（过反伪造 + lint）→
 * extractEntities（LLM 提议，失败降级）→ gateCandidates（确定性质量门 + 分类判定树，D2/D3）→
 * relations 注入 wiki 页 + planEntityWrite（新建 / 原地升级 / 跨目录迁移三形态，M13 §2.1）→
 * 组装 raw+wiki+实体页 同事务 VaultPlan(operationType=ingest) → preview →
 * io.err 冲突快照（approve 之前打印，Q2 拍板）→ approve 回调（false 丢弃，零写入）→
 * apply（事务原子落盘，任一步失败整体回滚）。
 *
 * 不变量：I1 raw/wiki/实体页 同事务；I2 反伪造（summarizeToWiki 内 fence）；I3 无静默覆盖；
 * I4 同 source_url 去重 + 抽取失败降级；I5 lint 闸门；门绝不制造死链（D4）；
 * I-a 迁移原子性（create+delete 同事务）；I-b slug 不变；I-c 迁移门槛（确定性才迁移）；
 * I-d 无静默覆盖（KIND_CONFLICT/KIND_PIN_CONFLICT）；I-h 分类异常降级；
 * I-i pin 优先；I-k 来源独立性（suggested_source 异源才构成确认）；I-l ingest 不刷新 links.json。
 */

import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { selectAdapter } from './sources';
import { normalizeSourceUrl } from './source-url';
import { renderRawNote } from '../notes/template';
import { parseFrontmatter } from '../notes/frontmatter';
import { summarizeToWiki } from './summarize';
import { extractEntities, detectContradictions, DEFAULT_GRANULARITY, DEFAULT_EXTRACT_MODE, MAX_ENTITIES, MAX_RELATIONS, type ExtractMode, type Granularity, type ExtractionResult } from './extract';
import { gateCandidates, ENTITY_KINDS, type Coverage, type EntityKind, type FactRef, type GatedCandidate, type GateResult } from './candidate-gate';
import { groupRelationsBySlug, mergeRelationMaps } from '../notes/relations';
import { renderEntityPage, withFrontmatterRelations, extractMention } from '../notes/entity-page';
import { entityPagePath, kindOfPath, noteTypeFor, isEntityDir, ALL_KINDS } from '../notes/kind';
import { withFrontmatterKind } from '../notes/kind-frontmatter';
import { withFrontmatterSources, readSourceRefs } from '../notes/source-fm';
import { readFactsBySource, withSourceFacts, type FactsBySource } from '../notes/facts';
import { factPointer, withContradictions, type ContradictionEntry } from '../notes/contradictions';
import { baselineState, contentSha256, readBaselines } from '../vault/baseline';
import { isMustAbort } from './abort';
import { walkMarkdown } from '../vault/scan';
import { ValidationError } from '../errors';
import type { Classification } from '../notes/classify';
import type { Vault, VaultPlan, ApplyResult, VaultWriteOp } from '../vault/vault';
import type { ReasoningBackend } from '../reasoning/backend';

export type { WikiNote } from './summarize';

/** body 内容指纹（sha256 hex；M14 D1，与 M1 事务哈希同算法）。导出供测试复用 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface IngestDeps {
  vault: Vault;
  gateway: ReasoningBackend;
}

export interface ApproveContext {
  plan: VaultPlan;
  preview: { approvalSha256: string; changedPaths: string[] };
}

export interface IngestOptions {
  /** CLI/UI 层注入的暂停点：返回 false → 丢弃 plan，零写入 */
  approve?: (ctx: ApproveContext) => Promise<boolean>;
  /** 冲突快照打印通道（io.err）：approve 之前即时可见（Q2 拍板） */
  io?: { err(text: string): void };
  /** 【M14】内容短路命中回调（CLI 打印「内容未变更」）；plan 组装后、approve 之前触发（D9） */
  onSkip?: () => void;
  /** 【M15】忽略短路条件，强制全流程（换模型重抽 / 页丢失后重建） */
  force?: boolean;
  /** 【M15】把磁盘现状采纳为基线：冲突不拒绝，直接覆盖并重置基线（存量逃生口，D5） */
  adopt?: boolean;
  /** 【M15】忽略基线冲突强制覆盖；被覆盖的旧版快照到 .vault-meta/conflicts/（D6） */
  overwrite?: boolean;
  /** 【M20】抽取粒度（缺省 standard = 与 M19 逐字一致）；单条与批量同语义（工单 01） */
  granularity?: Granularity;
  /** 【M20】抽取模式（缺省 single = 与 M19 逐字一致；cited = 引用式抽取，工单 04） */
  extractMode?: ExtractMode;
  /**
   * 【M20 工单 06】**批内已占用的 raw 路径**（跨项 I25）。
   *
   * 两相位下同一批的各项在相位 A 都读**盘上**现状，若两个来源（如 `https://x/A` 与
   * `https://x/a`）折叠出同一 raw 文件名，双方都会看到「未占用」而各自 create 同一路径。
   * 批量层把先完成者的落点登记进来，后到者据此换名——与单条路径扫盘发现碰撞时的行为一致。
   * 单条 ingest 不传（undefined = 只看盘）。
   */
  reservedRawRels?: ReadonlySet<string>;
  /**
   * 【spike 观测】填充 `PreparedIngest.trace`（门控全量 + 抽取原始结果）。
   *
   * 纯观测用途，**零行为影响**：缺省 `undefined`（falsy）时返回对象与改动前
   * 字节级一致；打开时也只是在返回对象上多挂一个只读字段，不改变任何写入/校验路径。
   */
  collectTrace?: boolean;
}

/** sourceUrl → raw 页文件名（稳定、可移植；去协议/query，非字母数字转 `-`） */
function rawSlugFor(sourceUrl: string): string {
  const slug = sourceUrl
    .replace(/^https?:\/\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug.slice(0, 120) || 'source';
}

/** 读相对路径存在与否（经 Vault.read，缺失即视为不存在） */
async function existsRel(vault: Vault, rel: string): Promise<boolean> {
  try {
    await vault.read(rel);
    return true;
  } catch {
    return false;
  }
}

/** I4 去重 + I25 碰撞检查 + I30 比对时归一化（单趟扫描，D16/D4）。
 * - hit：存量 `fm.source_url` 与入参 `sourceUrl` **两侧都过 `normalizeSourceUrl`** 后全等 → 同源（update 即可）
 * - occupied：目标文件名（rawRel）被**其他来源**占用（slug 折叠碰撞，如全中文名折叠后同名；或匿名 raw）
 * 归一化使 `file:///C:/x` 与 realpath/junction/相对路径在比对时统一，来源身份单一化（M14 C3）；
 * 存量 `source_url` 字段值只读不改（I30）。 */
async function scanRaw(
  vault: Vault,
  sourceUrl: string,
  rawRel: string,
): Promise<{ hit: string | null; occupied: boolean }> {
  const norm = normalizeSourceUrl(sourceUrl);
  const rawDir = path.join(vault.root, 'raw');
  let entries: string[];
  try {
    entries = await readdir(rawDir);
  } catch {
    return { hit: null, occupied: false }; // raw/ 不存在 → 无去重目标也无碰撞
  }
  let occupied = false;
  for (const f of entries.filter((e) => e.endsWith('.md'))) {
    const rel = `raw/${f}`;
    try {
      const fm = parseFrontmatter(await vault.read(rel));
      const stored = typeof fm.source_url === 'string' ? normalizeSourceUrl(fm.source_url) : null;
      if (stored !== null && stored === norm) return { hit: rel, occupied }; // 规范化后全等即同源
      if (rel === rawRel && stored !== norm) occupied = true; // 同名且非本源（含匿名 raw）→ 碰撞
    } catch {
      /* 跳过损坏/不可读文件 */
    }
  }
  return { hit: null, occupied };
}

/** M17 F17.2：一次性收集 raw/ 下全部来源标识（规范化后），供批量预演判「已有来源页」。
 * 单次 O(raw 页数) 扫描替代逐项 scanRaw —— 否则预演是 O(n×m)，大批量下不可接受。
 * 只读，零写入，零 LLM。 */
export async function collectRawSourceKeys(vault: Vault): Promise<Set<string>> {
  const keys = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(path.join(vault.root, 'raw'));
  } catch {
    return keys; // raw/ 不存在 → 全新 vault
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    try {
      const fm = parseFrontmatter(await vault.read(`raw/${f}`));
      if (typeof fm.source_url === 'string') keys.add(normalizeSourceUrl(fm.source_url));
    } catch {
      /* 跳过损坏/不可读文件 */
    }
  }
  return keys;
}

/** I27 短路守门：扫 wiki/** 找**主页**上溯源指针（集合形态，工单 03）含 rawRel 的页。
 *
 * 「主页」= 非实体页目录（`wiki/notes|people|companies|projects|decisions|concepts`）下的页。
 * 实体页自工单 03 起也承载指针，但它们是**派生页**：把实体页也算进去会让
 * 「主页被删 → 重跑重建」（M15 D13 / T15.9）失效——只要任一实体页还在就会短路。
 *
 * 找不到（无指针 / 页被删）→ 不短路，全流程重建（D13：删除的正确姿势是删 raw）。
 * 全扫 wiki/**：页量在千级内可接受；万级再考虑索引化（本里程碑不做）。 */
async function findWikiByRawSource(vault: Vault, rawRel: string): Promise<string | null> {
  for (const rel of await walkMarkdown(vault.root, 'wiki')) {
    if (isEntityDir(rel)) continue;
    try {
      const fm = parseFrontmatter(await vault.read(rel)) as unknown as Record<string, unknown>;
      // 集合包含语义：本页是否由该源支撑（旧标量指针经 readSourceRefs 一并兼容）
      if (readSourceRefs(fm).includes(rawRel)) return rel;
    } catch {
      /* 跳过损坏页 */
    }
  }
  return null;
}

/** M15 C2：对 create/update 目标做基线校验（delete 不查）。总是收集冲突项
 * （rel + 当前磁盘内容，供 --overwrite 快照）；是否拒绝由调用方决定（I24 整单拒绝）。 */
async function collectConflicts(
  vault: Vault,
  ops: readonly VaultWriteOp[],
): Promise<{ rel: string; oldContent: string }[]> {
  const baselines = await readBaselines(vault.root);
  const out: { rel: string; oldContent: string }[] = [];
  for (const op of ops) {
    if (op.operationType === 'delete') continue;
    let current: string;
    try {
      current = await vault.read(op.relativePath);
    } catch {
      continue; // 目标不存在 → 'none'（新建，无冲突）
    }
    if (baselineState(baselines[op.relativePath], contentSha256(current)) === 'conflict') {
      out.push({ rel: op.relativePath, oldContent: current });
    }
  }
  return out;
}

/** M15 D6：--overwrite 场景把被覆盖的旧版旁路快照到 .vault-meta/conflicts/
 * （不进 VaultWriteOp——assertPortableWritePath 对 .vault-meta 抛 RESERVED_PATH；
 * 旁路写也保证 approve 拒绝 → 无 apply → 无副本，I3 零写入成立）。 */
async function snapshotConflicts(
  vaultRoot: string,
  conflicts: readonly { rel: string; oldContent: string }[],
): Promise<void> {
  if (conflicts.length === 0) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const c of conflicts) {
    const esc = c.rel.replace(/[\\/]/g, '__');
    const abs = path.join(vaultRoot, '.vault-meta', 'conflicts', `${esc}.${stamp}.md`);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, c.oldContent, 'utf8');
  }
}

/** 冲突拒绝信息（I24：整单拒绝，不部分写入） */
function conflictError(conflicts: readonly { rel: string }[]): ValidationError {
  return new ValidationError(
    'WIKI_CONTENT_CONFLICT',
    `以下页面在系统写出后被外部修改或无基线记录：${conflicts.map((c) => c.rel).join('、')}` +
      '——加 --adopt 采纳现状，或 --overwrite 覆盖（覆盖前自动快照到 .vault-meta/conflicts/）',
  );
}

/* ------------------------------ M13 实体页编排 ------------------------------ */

/** 本次判定的落点 kind：确定性 basis 直接落；model 只在有效票（非 named）时带建议 kind */
function landingKind(cls: Classification, coverage: Coverage): EntityKind | null {
  if (cls.basis === 'lexicon' || cls.basis === 'pin') return cls.kind;
  if (cls.basis === 'model' && coverage !== 'named') return cls.kind;
  return null;
}

/** 迁移/升级时的确认态 classification（renderEntityPage 用） */
function confirmedCls(kind: EntityKind): Classification {
  return { kind, basis: 'lexicon', reason: '确认态（迁移/升级重渲染）' };
}

export interface EntityWritePlanArgs {
  vault: Vault;
  gated: GatedCandidate;
  /** 本次 ingest 的 raw 页相对路径（suggested_source 主信源） */
  sourceRel: string;
  /** 全部支撑本候选的 raw 页（跨源归并时 >1，工单 06）；缺省 = [sourceRel] */
  sourceRels?: readonly string[];
  /** 【工单 05】本次源通过门控的逐字事实（缺省 = 无 → 事实段不动） */
  facts?: readonly FactRef[];
  /** 【工单 06】宿主之外的贡献源 Mentions（跨源归并累加） */
  extraMentions?: readonly { quote: string; wikiSlug: string }[];
  /** 【工单 08】本次检测到的矛盾记录（缺省 = 无 → 不新增，仅继承既有留痕） */
  contradictions?: readonly ContradictionEntry[];
  relMap: Map<string, Map<string, string[]>>;
  date: string;
  wikiSlug: string;
  body: string;
  /** 冲突快照通道（io.err） */
  onConflict: (line: string) => void;
}

/** 同 slug 既有实体页命中（五 kind 目录 → notes/，固定顺序；≥2 = 多目录并存） */
async function probeEntityPages(vault: Vault, slug: string): Promise<string[]> {
  const probe: string[] = [];
  for (const k of ALL_KINDS) probe.push(entityPagePath(k, slug));
  probe.push(entityPagePath(null, slug));
  const hits: string[] = [];
  for (const rel of probe) {
    if (await existsRel(vault, rel)) hits.push(rel);
  }
  return hits;
}

/**
 * M20 工单 03 + 05 + 08：把**溯源指针集合**、**事实段**与**矛盾留痕**累加进实体页写操作。
 *
 * - 本轮已在写某页（create / update）→ 直接在其内容上注入；
 * - 页面存在但本轮无写操作（如「同 kind 不动」「票级保险」分支）→ 只有当注入后
 *   内容**确实改变**时才补一条 update。指针由代码掌管（I26），「这页由哪些源支撑」
 *   「这页有哪些事实」「这页记过哪些矛盾」都不能因为某分支选择不重渲染而丢失；
 * - 迁移（create 新页 + delete 旧页）→ 三者都要随搬家继承，否则搬家即失忆；
 * - 本次源没有事实（single 模式 / 引用全被丢弃）→ 事实段零触碰（I47 默认路径）；
 * - 没有任何矛盾 → `## Contradictions / Updates` 段零触碰（不留空段，I46）。
 *
 * 多目录并存（KIND_SOURCE_CONFLICT）不在本函数内处理：目标不唯一，且 M13 D7 明令两侧原样保留。
 */
async function accumulateProvenance(
  ops: VaultWriteOp[],
  existingRel: string | null,
  refs: readonly string[],
  facts: readonly FactRef[],
  factSourceRel: string,
  contradictions: readonly ContradictionEntry[],
  vault: Vault,
): Promise<VaultWriteOp[]> {
  // 既有页：指针并入（迁移时新页要继承旧页的源）+ 其它源的事实块继承
  let merged = [...refs];
  let prior: string | null = null;
  if (existingRel !== null) {
    try {
      prior = await vault.read(existingRel);
      const fm = parseFrontmatter(prior) as unknown as Record<string, unknown>;
      for (const r of readSourceRefs(fm)) if (!merged.includes(r)) merged.push(r);
    } catch {
      prior = null; // 旧页不可读 → 只写本次的源（不阻断 ingest）
    }
  }

  // 事实按**源**分组：跨源归并（工单 06）后各源事实仍回到各自的分块编号空间，
  // 否则贡献源的事实会被记到宿主源的块号下 → 锚点指向错误原文。
  const bySource = new Map<string, { text: string; chunkIndex: number }[]>();
  for (const f of facts) {
    const src = f.sourceRef ?? factSourceRel;
    const list = bySource.get(src) ?? [];
    if (!list.some((x) => x.chunkIndex === f.chunkIndex && x.text === f.text)) {
      list.push({ text: f.text, chunkIndex: f.chunkIndex });
    }
    bySource.set(src, list);
  }

  const inject = (content: string): string => {
    let out = withFrontmatterSources(content, merged);
    if (bySource.size > 0) {
      let first = true; // 只有第一个源需要继承既有页的**其它源**事实块；此后按已注入的内容增量更新
      for (const [src, list] of bySource) {
        out = withSourceFacts(out, src, list, first ? (prior ?? undefined) : undefined);
        first = false;
      }
    }
    // 工单 08：矛盾留痕（既有记录随页面继承；无新增且无既有 → 字节不变）
    return withContradictions(out, contradictions, prior ?? undefined);
  };

  const written = ops.filter((o) => o.operationType !== 'delete');
  if (written.length > 0) {
    return ops.map((o) =>
      o.operationType === 'delete' || o.content === undefined ? o : { ...o, content: inject(o.content) },
    );
  }

  // 无写操作：仅当注入后内容确有变化才补一条（否则保持既有的零操作语义，如 I-k 同源重跑）
  if (existingRel === null || prior === null) return ops;
  const next = inject(prior);
  if (next === prior) return ops;
  return [{ relativePath: existingRel, content: next, operationType: 'update' }];
}

/**
 * 统一产出单个存活候选的「新建 / 原地升级 / 跨目录迁移」写操作（M13 §2.1）。
 * 冲突不抛错：经 onConflict 打印快照后跳过该候选（不阻断 ingest，I-d/Q2）。
 *
 * 本函数只负责**知识形态**（页面类型 / 目录 / 迁移）；**溯源指针**由 `planEntityWrite`
 * 包装层统一累加（工单 03），两者职责分离。
 *
 * @param trace 探针回传：既有页落点（`existingRel`）与「多目录并存」（`ambiguous`）
 */
async function planEntityWriteBase(
  args: EntityWritePlanArgs,
  trace: { existingRel: string | null; ambiguous: boolean },
): Promise<VaultWriteOp[]> {
  const { vault, gated, sourceRel, relMap, date, wikiSlug, body, onConflict } = args;
  const cand = gated.candidate;
  const cls = gated.classification;
  const slug = cand.slug;

  // Mentions：本源的摘录在前，跨源归并带来的贡献源摘录依次累加（工单 06）
  const ownMention = extractMention(body, cand.name, cand.aliases);
  const mentions = [
    ...(ownMention ? [{ quote: ownMention.quote, wikiSlug }] : []),
    ...(args.extraMentions ?? []),
  ];
  const mentionsArg = mentions.length > 0 ? { mentions } : undefined;

  // 既有页探测：五 kind 目录 → notes/（与矛盾检测共用同一探测口径）
  const hits = await probeEntityPages(vault, slug);

  // 并存（≥2）→ KIND_SOURCE_CONFLICT：不升级不迁移（D7，duplicateEntitySlug 由 wiki link 报）
  if (hits.length >= 2) {
    trace.ambiguous = true;
    onConflict(`[KIND_SOURCE_CONFLICT] ${hits.join(' + ')}（slug=${slug} 多目录并存，不升级不迁移）`);
    return [];
  }
  trace.existingRel = hits[0] ?? null;

  const outcome = gated.outcome as 'page' | 'stub';
  const incomingRels = relMap.get(slug) ?? new Map<string, string[]>();

  if (hits.length === 1) {
    const existingRel = hits[0]!;
    const existingKind = kindOfPath(existingRel);
    const existingContent = await vault.read(existingRel);
    const fm = parseFrontmatter(existingContent);
    const pin: EntityKind | null =
      typeof fm.entity_kind === 'string' && ENTITY_KINDS.has(fm.entity_kind)
        ? (fm.entity_kind as EntityKind)
        : null;
    const needPromotion = fm.stub === true && outcome === 'page';

    // ---- pin 优先（I-i）----
    if (pin != null) {
      const L = landingKind(cls, gated.candidate.coverage);
      if (L != null && L !== pin) {
        // pin 冲突：保留 pin，不迁移；notes 页写入新建议
        onConflict(`[KIND_PIN_CONFLICT] ${existingRel}（pin ${pin} ≠ 新判定 ${L}，保留 pin）`);
        if (existingKind == null) {
          return [
            {
              relativePath: existingRel,
              content: withFrontmatterKind(existingContent, {
                suggestedKind: L,
                suggestedSource: sourceRel,
              }),
              operationType: 'update',
            },
          ];
        }
        return []; // kind 页：完全不动
      }
      // pin 与判定一致（或无判定）：notes 页 → 迁移到 pin 目录；kind 页 → 原地升级
      if (existingKind == null) {
        const target = entityPagePath(pin, slug);
        const content = needPromotion
          ? renderEntityPage({
              name: cand.name, slug, kind: pin, outcome, date, summary: cand.summary,
              aliases: cand.aliases, mentions: mentionsArg?.mentions,
              relations: mergeRelationMaps(fm.relations, incomingRels),
              classification: confirmedCls(pin),
            })
          : withFrontmatterKind(existingContent, {
              type: noteTypeFor(pin), entityKind: pin,
              needsClassification: null, suggestedKind: null, suggestedSource: null,
            });
        return [
          { relativePath: target, content, operationType: 'create' },
          { relativePath: existingRel, operationType: 'delete' },
        ];
      }
      if (needPromotion) {
        return [
          {
            relativePath: existingRel,
            content: renderEntityPage({
              name: cand.name, slug, kind: pin, outcome, date, summary: cand.summary,
              aliases: cand.aliases, mentions: mentionsArg?.mentions,
              relations: mergeRelationMaps(fm.relations, incomingRels),
              classification: confirmedCls(pin),
            }),
            operationType: 'update',
          },
        ];
      }
      return [];
    }

    // ---- 无 pin：kind 页 ----
    if (existingKind != null) {
      if (needPromotion) {
        return [
          {
            relativePath: existingRel,
            content: renderEntityPage({
              name: cand.name, slug, kind: existingKind, outcome, date, summary: cand.summary,
              aliases: cand.aliases, mentions: mentionsArg?.mentions,
              relations: mergeRelationMaps(fm.relations, incomingRels),
              classification: confirmedCls(existingKind),
            }),
            operationType: 'update',
          },
        ];
      }
      const L = landingKind(cls, gated.candidate.coverage);
      if (L != null && L !== existingKind && cls.basis === 'lexicon') {
        // 词表判新 kind → kind→kind 人工纠错通道（确定性，可迁移）
        const target = entityPagePath(L, slug);
        const content = needPromotion
          ? renderEntityPage({
              name: cand.name, slug, kind: L, outcome, date, summary: cand.summary,
              aliases: cand.aliases, mentions: mentionsArg?.mentions,
              relations: mergeRelationMaps(fm.relations, incomingRels),
              classification: confirmedCls(L),
            })
          : withFrontmatterKind(existingContent, { type: noteTypeFor(L), entityKind: L });
        return [
          { relativePath: target, content, operationType: 'create' },
          { relativePath: existingRel, operationType: 'delete' },
        ];
      }
      return []; // 同 kind 或 model 判新 kind → 不动（不回迁 notes/）
    }

    // ---- 无 pin：notes 页（建议态 / 裸未定）----
    const L = landingKind(cls, gated.candidate.coverage);
    const suggested = typeof fm.suggested_kind === 'string' ? fm.suggested_kind : null;
    const prevSource = typeof fm.suggested_source === 'string' ? fm.suggested_source : null;

    if (L == null) {
      // named / none 票：不产生 / 不更新 / 不比对（票级保险，D5）；内容升级照旧（I-g 正交）
      if (needPromotion) {
        return [
          {
            relativePath: existingRel,
            content: renderEntityPage({
              name: cand.name, slug, kind: null, outcome, date, summary: cand.summary,
              aliases: cand.aliases, mentions: mentionsArg?.mentions,
              relations: mergeRelationMaps(fm.relations, incomingRels),
              classification: cls,
            }),
            operationType: 'update',
          },
        ];
      }
      return [];
    }

    // 词表确定 → 自动毕业（I-c：确定性可迁移）
    if (cls.basis === 'lexicon') {
      const target = entityPagePath(L, slug);
      const content = needPromotion
        ? renderEntityPage({
            name: cand.name, slug, kind: L, outcome, date, summary: cand.summary,
            aliases: cand.aliases, mentions: mentionsArg?.mentions,
            relations: mergeRelationMaps(fm.relations, incomingRels),
            classification: confirmedCls(L),
          })
        : withFrontmatterKind(existingContent, {
            type: noteTypeFor(L), entityKind: L,
            needsClassification: null, suggestedKind: null, suggestedSource: null,
          });
      return [
        { relativePath: target, content, operationType: 'create' },
        { relativePath: existingRel, operationType: 'delete' },
      ];
    }

    // model 有效票
    if (suggested == null) {
      // 首张有效票 → 写建议（内容升级若同时发生，一并重渲染）
      if (needPromotion) {
        return [
          {
            relativePath: existingRel,
            content: renderEntityPage({
              name: cand.name, slug, kind: L, outcome, date, summary: cand.summary,
              aliases: cand.aliases, mentions: mentionsArg?.mentions,
              relations: mergeRelationMaps(fm.relations, incomingRels),
              classification: cls, suggestedSource: sourceRel,
            }),
            operationType: 'update',
          },
        ];
      }
      return [
        {
          relativePath: existingRel,
          content: withFrontmatterKind(existingContent, {
            suggestedKind: L, suggestedSource: sourceRel,
          }),
          operationType: 'update',
        },
      ];
    }

    if (suggested === L) {
      if (prevSource === sourceRel) {
        // 同源（含重跑同一文件）且建议值未变 → 零操作（I-k：不构成确认，也无键序扰动）
        return [];
      }
      // 双次一致（异源）→ 毕业：create(kind/) + delete(notes/) 同事务（I-a/I-b）
      const target = entityPagePath(L, slug);
      const content = needPromotion
        ? renderEntityPage({
            name: cand.name, slug, kind: L, outcome, date, summary: cand.summary,
            aliases: cand.aliases, mentions: mentionsArg?.mentions,
            relations: mergeRelationMaps(fm.relations, incomingRels),
            classification: confirmedCls(L),
          })
        : withFrontmatterKind(existingContent, {
            type: noteTypeFor(L), entityKind: L,
            needsClassification: null, suggestedKind: null, suggestedSource: null,
          });
      return [
        { relativePath: target, content, operationType: 'create' },
        { relativePath: existingRel, operationType: 'delete' },
      ];
    }

    // 判定不一致 → 滑动一步：更新建议值，不迁移（D5）
    if (needPromotion) {
      return [
        {
          relativePath: existingRel,
          content: renderEntityPage({
            name: cand.name, slug, kind: L, outcome, date, summary: cand.summary,
            aliases: cand.aliases, mentions: mentionsArg?.mentions,
            relations: mergeRelationMaps(fm.relations, incomingRels),
            classification: cls, suggestedSource: sourceRel,
          }),
          operationType: 'update',
        },
      ];
    }
    return [
      {
        relativePath: existingRel,
        content: withFrontmatterKind(existingContent, {
          suggestedKind: L, suggestedSource: sourceRel,
        }),
        operationType: 'update',
      },
    ];
  }

  // ---- 新建（hits === 0，D4 落点表）----
  const L = landingKind(cls, gated.candidate.coverage);
  if (L != null && (cls.basis === 'lexicon' || cls.basis === 'pin')) {
    // 确认态：直接落 kind 目录
    return [
      {
        relativePath: entityPagePath(L, slug),
        content: renderEntityPage({
          name: cand.name, slug, kind: L, outcome, date, summary: cand.summary,
          aliases: cand.aliases, mentions: mentionsArg?.mentions,
          relations: incomingRels, classification: cls,
        }),
        operationType: 'create',
      },
    ];
  }
  if (L != null && cls.basis === 'model') {
    // model 有效票 → notes 建议态
    return [
      {
        relativePath: entityPagePath(null, slug),
        content: renderEntityPage({
          name: cand.name, slug, kind: L, outcome, date, summary: cand.summary,
          aliases: cand.aliases, mentions: mentionsArg?.mentions,
          relations: incomingRels, classification: cls, suggestedSource: sourceRel,
        }),
        operationType: 'create',
      },
    ];
  }
  // named / none → notes 裸未定（kind: null，不写建议值）
  return [
    {
      relativePath: entityPagePath(null, slug),
      content: renderEntityPage({
        name: cand.name, slug, kind: null, outcome, date, summary: cand.summary,
        aliases: cand.aliases, mentions: mentionsArg?.mentions,
        relations: incomingRels, classification: cls,
      }),
      operationType: 'create',
    },
  ];
}

/**
 * 实体页写操作入口（M13 形态 + M20 工单 03 溯源指针 + 工单 05 事实段 + 工单 08 矛盾留痕）。
 * 先算知识形态，再统一累加溯源指针集合、本次源的事实段与矛盾记录——「这页由哪些源支撑」
 * 「有哪些事实」「记过哪些矛盾」都不因分支选择而丢失。
 */
export async function planEntityWrite(args: EntityWritePlanArgs): Promise<VaultWriteOp[]> {
  const trace: { existingRel: string | null; ambiguous: boolean } = {
    existingRel: null,
    ambiguous: false,
  };
  const ops = await planEntityWriteBase(args, trace);
  // 多目录并存：指针落点不唯一，且 M13 D7 明令两侧原样保留 → 不注入
  if (trace.ambiguous) return ops;
  const refs = args.sourceRels && args.sourceRels.length > 0 ? [...args.sourceRels] : [args.sourceRel];
  return accumulateProvenance(
    ops,
    trace.existingRel,
    refs,
    args.facts ?? [],
    args.sourceRel,
    args.contradictions ?? [],
    args.vault,
  );
}

/* ------------------------------ 主流程（两相位，工单 06） ------------------------------ */

/** 本项要落盘的实体页候选（跨源归并后由批量层替换为合并视图） */
export interface PreparedCandidate {
  slug: string;
  gated: GatedCandidate;
  /** 支撑本候选的全部 raw 页（跨源归并时 >1；缺省 = [本项 sourceRel]） */
  sourceRels?: readonly string[];
  /** 宿主之外的贡献源 Mentions（跨源归并累加，工单 06） */
  extraMentions?: readonly { quote: string; wikiSlug: string }[];
  /** 【工单 08】对照既有页其他源检测到的矛盾记录（缺省 = 无 → 不产生该段） */
  contradictions?: readonly ContradictionEntry[];
}

/**
 * 相位 A 产物：检测 + 全部 LLM 产出（摘要 / 抽取 / 质量门 / 关系表）——**零写入、零 approve**。
 *
 * 为何独立（工单 06）：批量必须先把整批的抽取产出收齐，才能按 slug **串行 reduce** 归并
 * （同一实体只落一次）；单条路径 `ingest()` = 准备 + 提交，对外行为逐字不变（I32）。
 */
export interface PreparedIngest {
  input: string;
  /** 本项 raw 写操作（短路时是唯一操作） */
  rawOp: VaultWriteOp;
  /** M14 内容短路：只刷新 raw 元数据，wiki/实体页零触碰（I18） */
  shortCircuited: boolean;
  /** 本项来源的 raw 页相对路径（溯源指针与事实锚点的归属） */
  sourceRel: string;
  /** wiki 主页写操作（短路 → null） */
  wikiOp: VaultWriteOp | null;
  /** wiki 主页 slug（短路 → null；Mentions 归属用） */
  wikiSlug: string | null;
  /** 原文（事实组装 / Mentions 摘录用） */
  body: string;
  /** YYYY-MM-DD（取 raw fetched_at 日期） */
  date: string;
  /** 关系表（含来源页 relates_to 与声明边；归并时由批量层覆盖） */
  relMap: Map<string, Map<string, string[]>>;
  /** 本项存活候选（drop 已剔除） */
  candidates: PreparedCandidate[];
  /**
   * 【spike 观测】相位 A 的观测产物；**仅当 `IngestOptions.collectTrace` 为真时填充**，
   * 缺省 `undefined`（既有调用方行为逐字不变）。
   */
  trace?: IngestTrace;
}

/**
 * 【spike 观测】相位 A 的观测快照（I-W1' 只增不改）。
 *
 * 存在的理由：门控全量结果（含被 drop 的候选及其判决理由）与抽取原始结果在
 * `prepareIngest` 内部被消费后即不可达——`gated.candidates` 里 drop 的成员会被
 * `alive` 过滤掉，`extraction` 是局部变量。评测（evals）恰恰最需要这些信号，
 * 故由编排层在显式开启时原样透出。
 *
 * 该结构只读，不参与任何写盘/校验逻辑。
 */
export interface IngestTrace {
  /** 门控全量结果（含 `outcome: 'drop'` 的候选，及各自的 reason/classification/location） */
  gate: GateResult;
  /** 抽取原始结果（含原始回稿、warnings、truncated）；抽取失败降级时为 null */
  extraction: ExtractionResult | null;
  /** 抽取是否发生过降级（I28：失败只降级不阻断） */
  extractionFailed: boolean;
  /** 降级时的错误信息（多个错误只保留最后一条；无则缺省） */
  extractionError?: string;
}

/** 提交相位可被覆盖的部分（工单 06 的跨源归并结果在此注入） */
export interface IngestOverride {
  /** 归并后的候选视图；缺省 = prepared.candidates */
  candidates?: readonly PreparedCandidate[];
  /** 归并后的关系表（实体页用）；缺省 = prepared.relMap */
  relMap?: Map<string, Map<string, string[]>>;
}

/** 从分源事实表里取某条事实的逐字文本（不存在 → 空串） */
function factTextOf(table: FactsBySource, ref: string, chunkIndex: number): string {
  return table.get(ref)?.find((f) => f.chunkIndex === chunkIndex)?.text ?? '';
}

/**
 * 工单 08：为每个**带事实**的候选，对照同 slug 既有实体页**其他源**的事实做一次矛盾检测。
 *
 * - 任一侧没有事实可比 → 一次 LLM 都不调（`single` 模式不产生事实 → 默认路径天然零影响，I47）；
 * - 模型只指认「哪两条事实对不上」，逐字文本与出处指针**全部由代码**从既有数据取
 *   （与引用式抽取的 I42 同一精神：留痕里不得出现模型转述或编造的指针）；
 * - 检测失败只降级（不阻断 ingest），但经 io.err 可见（不静默）。
 */
async function attachContradictions(
  candidates: readonly PreparedCandidate[],
  deps: IngestDeps,
  sourceRel: string,
  date: string,
  io?: { err(text: string): void },
): Promise<PreparedCandidate[]> {
  const out: PreparedCandidate[] = [];
  for (const c of candidates) {
    const facts = c.gated.candidate.facts ?? [];
    if (facts.length === 0) {
      out.push(c);
      continue;
    }
    const hits = await probeEntityPages(deps.vault, c.slug);
    if (hits.length !== 1) {
      out.push(c); // 无既有页 / 多目录并存 → 没有唯一的比对对象
      continue;
    }
    let existingContent: string;
    try {
      existingContent = await deps.vault.read(hits[0]!);
    } catch {
      out.push(c);
      continue;
    }
    // 只与**其他源**的事实比对：自己上一次留下的旧事实不算「两源矛盾」
    const others: FactsBySource = new Map(
      [...readFactsBySource(existingContent)].filter(([ref]) => ref !== sourceRel),
    );
    if (others.size === 0) {
      out.push(c);
      continue;
    }

    try {
      const detected = await detectContradictions(facts, sourceRel, others, deps.gateway);
      for (const w of detected.warnings) io?.err(w);
      if (detected.contradictions.length === 0) {
        out.push(c);
        continue;
      }
      out.push({
        ...c,
        contradictions: detected.contradictions.map((k) => ({
          date,
          claim: k.claim,
          oldText: factTextOf(others, k.existingRef, k.existingChunk),
          oldRef: factPointer(k.existingRef, k.existingChunk),
          newText: facts.find((f) => f.chunkIndex === k.incomingChunk)?.text ?? '',
          newRef: factPointer(sourceRel, k.incomingChunk),
        })),
      });
    } catch (err) {
      if (isMustAbort(err)) throw err; // 凭证 / 预算类 → 照旧上抛（I35）
      io?.err(`[CONTRA_DETECT_FAILED] ${c.slug}: ${err instanceof Error ? err.message : String(err)}`);
      out.push(c);
    }
  }
  return out;
}

/**
 * 相位 A：把一段输入（file:// 路径或 http(s):// URL）准备成「可提交」的形态。
 * 只读 vault + 调 LLM，**不写任何文件**、不触发 approve。
 * @throws 上游错误（含抽取的 must-abort 类）直接上抛，由调用方决定逐项隔离或整批停机
 */
export async function prepareIngest(
  input: string,
  deps: IngestDeps,
  opts?: IngestOptions,
): Promise<PreparedIngest> {
  const adapter = selectAdapter(input);
  const { body, meta } = await adapter.extract(input);

  // 1) raw 页（verbatim，type:source，免前言；M14：body 指纹注入 meta）
  const sha = sha256Hex(body);
  meta.sourceSha256 = sha;
  const rawSlug = rawSlugFor(meta.sourceUrl);
  const rawRel = `raw/${rawSlug}.md`;
  const scan = await scanRaw(deps.vault, meta.sourceUrl, rawRel);
  const existingRaw = scan.hit;

  // M15 I25：目标文件名已被他源占用（slug 折叠碰撞，如全中文名折叠后同名）→ 换名 + 报警，绝不覆盖。
  // 换名散列取自 source_url 而非 source_sha256——后者是正文指纹，内容一变就换名 → 重复 raw 洪水（D12）。
  let targetRawRel = rawRel;
  if (!existingRaw && (scan.occupied || opts?.reservedRawRels?.has(rawRel) === true)) {
    const urlHash = sha256Hex(meta.sourceUrl).slice(0, 8);
    targetRawRel = `raw/${rawSlug}-${urlHash}.md`;
    opts?.io?.err(`[RAW_SLUG_COLLISION] ${rawRel} 已被其他来源占用，本次改用 ${targetRawRel}`);
  }
  /** 本次来源的 raw 落点（溯源指针与事实锚点都归属它） */
  const sourceRel = existingRaw ?? targetRawRel;

  // M14 C2 + M15 I27：内容短路。判定 = 指纹相同 且 非 --force 且 指针指向的 wiki 页存在
  // （无指针/页被删 → 不短路，全流程重建；删除的正确姿势是删 raw，D13）。I19 存量无指纹 → 全流程回填。
  let skipLLM = false;
  if (existingRaw) {
    try {
      const prevFm = parseFrontmatter(await deps.vault.read(existingRaw));
      const sameSha = typeof prevFm.source_sha256 === 'string' && prevFm.source_sha256 === sha;
      const wikiRel = sameSha && !opts?.force ? await findWikiByRawSource(deps.vault, existingRaw) : null;
      skipLLM = !opts?.force && sameSha && wikiRel !== null;
    } catch {
      skipLLM = false; // 损坏页 → 不短路
    }
  }

  const rawOp: VaultWriteOp = existingRaw
    ? { relativePath: existingRaw, content: renderRawNote(body, meta), operationType: 'update' }
    : { relativePath: targetRawRel, content: renderRawNote(body, meta), operationType: 'create' };

  const base: PreparedIngest = {
    input,
    rawOp,
    shortCircuited: skipLLM,
    sourceRel,
    wikiOp: null,
    wikiSlug: null,
    body,
    date: meta.fetchedAt.slice(0, 10),
    relMap: new Map(),
    candidates: [],
  };
  // M14：短路时跳过全部 LLM 与 wiki/实体页写入（I18——wiki 页可能已被手工编辑/毕业）
  if (skipLLM) return base;

  // 2) wiki 页（ai-first，LLM 整理，过反伪造 + lint 闸门；slug 命中已存在 → update）
  const wiki = await summarizeToWiki(body, meta.sourceUrl, deps.gateway);

  // 2.5) 实体抽取（E1/E2，07 规划 D1/D2）：LLM 提议 + 确定性门 + 分类判定树落地。
  // 抽取回稿不可解析时降级为空（不建词条、不写 relations），不阻断 ingest 主流程（I4）。
  let gated: GateResult = { candidates: [], edges: [] };
  let extractionFailed = 0;
  // 【spike 观测】透出用暂存：既有代码把 extraction 留在 try 块内，这里提升到外层
  // 以便 `collectTrace` 时随返回值透出；不开启观测时这两个变量只被赋值、不被读取。
  let extractionResult: ExtractionResult | null = null;
  let lastExtractError: string | undefined;
  const granularity = opts?.granularity ?? DEFAULT_GRANULARITY;
  const extractMode = opts?.extractMode ?? DEFAULT_EXTRACT_MODE;
  try {
    const extraction = await extractEntities(body, meta.sourceUrl, deps.gateway, {
      granularity,
      extractMode,
    });
    extractionResult = extraction;
    // 工单 06：事实在入口盖「属于哪个源」的章——跨源归并后各源事实仍回到各自的分块
    // 编号空间（抽取层不知道 raw 落点，只能由编排层补）。
    for (const e of extraction.entities) {
      if (e.facts && e.facts.length > 0) {
        e.facts = e.facts.map((f) => ({ ...f, sourceRef: sourceRel }));
      }
    }
    gated = gateCandidates(extraction, body, wiki.content);
    // 工单 04：抽取层告警（编造引用被丢弃 / 骨架降级 / 批回稿不可解析）必须可见——
    // 引用式抽取不得把「模型编了引用」处理成静默（I28 精神）。
    for (const w of extraction.warnings ?? []) opts?.io?.err(w);
    // I43：粒度只决定「想抽多少」，硬上限仍决定「最多落多少」——触顶截断 + 可见告警，不抛错。
    // 只为显式选了 exhaustive 的调用方告警：standard 是默认路径，stderr 不新增噪音（I47 保守侧）。
    if (granularity === 'exhaustive' && extraction.truncated) {
      const hit = [
        extraction.truncated.entities ? `实体 ${MAX_ENTITIES}` : '',
        extraction.truncated.relations ? `关系 ${MAX_RELATIONS}` : '',
      ]
        .filter((s) => s !== '')
        .join(' / ');
      opts?.io?.err(
        `[ENTITY_TRUNCATED] ${meta.sourceUrl}: exhaustive 档位触硬上限（${hit}），已截断未落盘的提名`,
      );
    }
  } catch (err) {
    // I28：抽取失败只降级、不阻断、不静默——io.err 必有一行可见。
    // 但 must-abort 类（凭证 / NON_INTERACTIVE / 预算）**必须上抛**（工单 04）：
    // 把它们降级成「这一项没实体」会让批量把「该立刻停机」演成 N 次重复失败（I35）。
    if (isMustAbort(err)) throw err;
    extractionFailed++;
    const msg = err instanceof Error ? err.message : String(err);
    lastExtractError = msg;
    opts?.io?.err(`[ENTITY_EXTRACT_FAILED] ${meta.sourceUrl}: ${msg}`);
  }
  if (extractionFailed > 0) {
    opts?.io?.err(`[ENTITY_EXTRACT_FAILED] ${extractionFailed} 处实体抽取失败，已降级（本次无实体页）`);
  }

  const ingestDate = meta.fetchedAt.slice(0, 10);
  const alive = gated.candidates.filter((c) => c.outcome !== 'drop');

  // 边统一补全：实体间声明边 + 来源页 relates_to 实体（对称），再按 inverse 取双向
  const allEdges = [
    ...gated.edges,
    ...alive.map((c) => ({ from: wiki.slug, type: 'relates_to' as const, to: c.candidate.slug })),
  ].filter((e) => e.from !== e.to);
  const relMap = groupRelationsBySlug(allEdges);

  // 来源页 frontmatter 写入 relations（relates_to → 各存活实体；幂等注入）
  const wikiRel = `wiki/${wiki.slug}.md`;
  // 磁盘既有页与其溯源指针（工单 03）：新稿由 LLM 重新生成，不含旧指针，
  // 必须显式继承——否则第二个源落盘时会顶掉第一个（指针变成单值的退化形态）。
  let wikiExists = false;
  let priorRefs: string[] = [];
  try {
    const onDisk = await deps.vault.read(wikiRel);
    wikiExists = true;
    priorRefs = readSourceRefs(parseFrontmatter(onDisk) as unknown as Record<string, unknown>);
  } catch {
    /* 目标页不存在 → 新建 */
  }

  const wikiRels = relMap.get(wiki.slug) ?? new Map<string, string[]>();
  let wikiContent = wikiRels.size > 0 ? withFrontmatterRelations(wiki.content, wikiRels) : wiki.content;
  // M15 C4/I26：溯源指针由代码注入（LLM 填的 source 字段仅作展示，两者并存）
  wikiContent = withFrontmatterSources(wikiContent, [...priorRefs, sourceRel]);

  // 工单 08：矛盾显性化（只记录、不覆盖、不 supersede）。放在相位 A 末尾 —— 它只调 LLM、
  // 只读盘，因此两相位的「相位 A 零写入」不变。
  const candidates = await attachContradictions(
    alive.map((c) => ({ slug: c.candidate.slug, gated: c })),
    deps,
    sourceRel,
    ingestDate,
    opts?.io,
  );

  return {
    ...base,
    shortCircuited: false,
    wikiOp: { relativePath: wikiRel, content: wikiContent, operationType: wikiExists ? 'update' : 'create' },
    wikiSlug: wiki.slug,
    date: ingestDate,
    relMap,
    candidates,
    // 【spike 观测】条件展开：缺省（falsy）时不产生该键 → 返回对象与改动前逐字一致
    ...(opts?.collectTrace
      ? {
          trace: {
            gate: gated,
            extraction: extractionResult,
            extractionFailed: extractionFailed > 0,
            ...(lastExtractError !== undefined ? { extractionError: lastExtractError } : {}),
          } satisfies IngestTrace,
        }
      : {}),
  };
}

/**
 * 相位 B：把准备产物落盘——plan（raw + wiki + 实体页同一次事务）→ 基线校验 → approve → apply。
 *
 * 逐项事务、逐项走基线与冲突检查（M15 I24 / M17 I32 语义不变）。
 * @returns 成功返回 ApplyResult；approve 拒绝返回 null（零写入）
 */
export async function commitIngest(
  prepared: PreparedIngest,
  deps: IngestDeps,
  opts?: IngestOptions,
  override?: IngestOverride,
): Promise<ApplyResult | null> {
  const vault = deps.vault;

  // M14 短路路径：仅 raw 页 update（fetched_at 刷新 + 指纹写入/回填），wiki/实体页零触碰（I18）
  if (prepared.shortCircuited || prepared.wikiOp === null) {
    const conflictsSkip = await collectConflicts(vault, [prepared.rawOp]);
    if (!opts?.adopt && !opts?.overwrite && conflictsSkip.length > 0) {
      throw conflictError(conflictsSkip);
    }
    const planSkip = await vault.plan([prepared.rawOp]);
    planSkip.operationType = 'ingest';
    const previewSkip = vault.preview(planSkip);

    // onSkip 在 approve 之前触发（D9）：用户批准前就知道这次为什么只写一个文件
    opts?.onSkip?.();

    const approvedSkip = opts?.approve ? await opts.approve({ plan: planSkip, preview: previewSkip }) : true;
    if (!approvedSkip) return null;

    const appliedSkip = await vault.apply(planSkip, { approvedPlanSha256: previewSkip.approvalSha256 });
    if (opts?.overwrite) {
      await snapshotConflicts(vault.root, conflictsSkip).catch(() => undefined);
    }
    return appliedSkip;
  }

  const relMap = override?.relMap ?? prepared.relMap;
  const candidates = override?.candidates ?? prepared.candidates;
  const wikiSlug = prepared.wikiSlug!;

  // 2.6) 实体页 ops（E3 + M13）：planEntityWrite 统一产出新建/原地升级/跨目录迁移；
  // 冲突经 io.err 即时打印（发生在 approve 之前，Q2 拍板），不阻断不进返回值。
  const onConflict = (line: string) => opts?.io?.err(line);
  const entityOps: VaultWriteOp[] = [];
  for (const c of candidates) {
    entityOps.push(
      ...(await planEntityWrite({
        vault,
        gated: c.gated,
        sourceRel: prepared.sourceRel,
        ...(c.sourceRels !== undefined ? { sourceRels: c.sourceRels } : {}),
        // 工单 05：引用式抽取的逐字事实随候选落进实体页（single 模式为空 → 段不动）
        facts: c.gated.candidate.facts ?? [],
        ...(c.extraMentions !== undefined ? { extraMentions: c.extraMentions } : {}),
        // 工单 08：矛盾留痕（无矛盾 → 段零触碰，不留空段）
        ...(c.contradictions !== undefined ? { contradictions: c.contradictions } : {}),
        relMap,
        date: prepared.date,
        wikiSlug,
        body: prepared.body,
        onConflict,
      })),
    );
  }

  // 3) raw + wiki + 实体页 同一次事务（operationType=ingest）
  const planFull = await vault.plan([prepared.rawOp, prepared.wikiOp, ...entityOps]);
  planFull.operationType = 'ingest';

  // M15 C2：写入前基线校验（approve 之前——被拒时根本不到 apply）。
  // adopt/overwrite = 显式逃生口（跳过拒绝）；overwrite 在 apply 后快照旧版（D6）。
  const conflicts = await collectConflicts(vault, planFull.writes);
  if (!opts?.adopt && !opts?.overwrite && conflicts.length > 0) {
    throw conflictError(conflicts);
  }

  const previewFull = vault.preview(planFull);

  // 4) 暂停点：approve 拒绝 → 丢弃，零写入（I3）
  const approvedFull = opts?.approve ? await opts.approve({ plan: planFull, preview: previewFull }) : true;
  if (!approvedFull) return null;

  // 5) 事务原子落盘（任一步失败整体回滚）
  const applied = await vault.apply(planFull, { approvedPlanSha256: previewFull.approvalSha256 });
  if (opts?.overwrite) {
    await snapshotConflicts(vault.root, conflicts).catch(() => undefined); // 快照失败不阻断已提交事务
  }
  return applied;
}

/**
 * 入口：把一段输入（file:// 路径或 http(s):// URL）ingest 为 raw+wiki 两页。
 *
 * 单条 = 批量的退化情形：准备 + 提交一气呵成，对外行为与引入两相位前逐字一致（I32）。
 * @returns 成功返回 ApplyResult；approve 拒绝返回 null（零写入）
 */
export async function ingest(
  input: string,
  deps: IngestDeps,
  opts?: IngestOptions,
): Promise<ApplyResult | null> {
  const prepared = await prepareIngest(input, deps, opts);
  return commitIngest(prepared, deps, opts);
}
