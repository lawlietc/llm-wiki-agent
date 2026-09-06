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
import { extractEntities } from './extract';
import { gateCandidates, ENTITY_KINDS, type Coverage, type EntityKind, type GatedCandidate, type GateResult } from './candidate-gate';
import { groupRelationsBySlug, mergeRelationMaps } from '../notes/relations';
import { renderEntityPage, withFrontmatterRelations, extractMention } from '../notes/entity-page';
import { entityPagePath, kindOfPath, noteTypeFor, ALL_KINDS } from '../notes/kind';
import { withFrontmatterKind } from '../notes/kind-frontmatter';
import { withFrontmatterSource } from '../notes/source-fm';
import { baselineState, contentSha256, readBaselines } from '../vault/baseline';
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

/** I4 去重 + I25 碰撞检查（一次扫描，D16）：raw/ 下逐页读 frontmatter。
 * - hit：source_url 两级匹配（M14 D6：① 规范化值全等快路径；② 存量旧形式规范化后比对）命中的既有 raw 页
 * - occupied：目标文件名（rawRel）已被**其他来源**占用（slug 折叠碰撞，如全中文名折叠后同名） */
async function scanRaw(
  vault: Vault,
  sourceUrl: string,
  rawRel: string,
): Promise<{ hit: string | null; occupied: boolean }> {
  const rawDir = path.join(vault.root, 'raw');
  let entries: string[];
  try {
    entries = await readdir(rawDir);
  } catch {
    return { hit: null, occupied: false }; // raw/ 不存在 → 无去重目标也无碰撞
  }
  const mds = entries.filter((f) => f.endsWith('.md'));

  let occupied = false;
  for (const f of mds) {
    try {
      const fm = parseFrontmatter(await vault.read(`raw/${f}`));
      if (fm.source_url === sourceUrl) return { hit: `raw/${f}`, occupied };
      if (`raw/${f}` === rawRel && typeof fm.source_url === 'string' && fm.source_url !== sourceUrl) {
        occupied = true; // 同名且一级不匹配：可能是碰撞，也可能二级匹配（下一轮排除）
      }
    } catch {
      /* 跳过损坏/不可读文件 */
    }
  }
  for (const f of mds) {
    try {
      const fm = parseFrontmatter(await vault.read(`raw/${f}`));
      if (typeof fm.source_url === 'string' && normalizeSourceUrl(fm.source_url) === sourceUrl) {
        return { hit: `raw/${f}`, occupied }; // 二级命中优先于碰撞（同一来源，update 即可）
      }
      if (`raw/${f}` === rawRel) occupied = true; // 两级都不匹配的同名文件 = 真碰撞
    } catch {
      /* 跳过损坏/不可读文件 */
    }
  }
  return { hit: null, occupied };
}

/** I27 短路守门：扫 wiki/** 找 frontmatter.raw_source 指向 rawRel 的页。
 * 找不到（无指针 / 页被删）→ 不短路，全流程重建（D13：删除的正确姿势是删 raw）。
 * 全扫 wiki/**：页量在千级内可接受；万级再考虑索引化（本里程碑不做）。 */
async function findWikiByRawSource(vault: Vault, rawRel: string): Promise<string | null> {
  for (const rel of await walkMarkdown(vault.root, 'wiki')) {
    try {
      const fm = parseFrontmatter(await vault.read(rel));
      if (fm.raw_source === rawRel) return rel;
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
  /** 本次 ingest 的 raw 页相对路径（suggested_source 信源） */
  sourceRel: string;
  relMap: Map<string, Map<string, string[]>>;
  date: string;
  wikiSlug: string;
  body: string;
  /** 冲突快照通道（io.err） */
  onConflict: (line: string) => void;
}

/**
 * 统一产出单个存活候选的「新建 / 原地升级 / 跨目录迁移」写操作（M13 §2.1）。
 * 冲突不抛错：经 onConflict 打印快照后跳过该候选（不阻断 ingest，I-d/Q2）。
 */
export async function planEntityWrite(args: EntityWritePlanArgs): Promise<VaultWriteOp[]> {
  const { vault, gated, sourceRel, relMap, date, wikiSlug, body, onConflict } = args;
  const cand = gated.candidate;
  const cls = gated.classification;
  const slug = cand.slug;

  const mention = extractMention(body, cand.name, cand.aliases);
  const mentionArg = mention ? { ...mention, wikiSlug } : undefined;

  // 既有页探测：五 kind 目录 → notes/（Vault 无列举 API，固定顺序 existsRel）
  const probe: string[] = [];
  for (const k of ALL_KINDS) probe.push(entityPagePath(k, slug));
  probe.push(entityPagePath(null, slug));
  const hits: string[] = [];
  for (const rel of probe) {
    if (await existsRel(vault, rel)) hits.push(rel);
  }

  // 并存（≥2）→ KIND_SOURCE_CONFLICT：不升级不迁移（D7，duplicateEntitySlug 由 wiki link 报）
  if (hits.length >= 2) {
    onConflict(`[KIND_SOURCE_CONFLICT] ${hits.join(' + ')}（slug=${slug} 多目录并存，不升级不迁移）`);
    return [];
  }

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
              aliases: cand.aliases, mention: mentionArg,
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
              aliases: cand.aliases, mention: mentionArg,
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
              aliases: cand.aliases, mention: mentionArg,
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
              aliases: cand.aliases, mention: mentionArg,
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
              aliases: cand.aliases, mention: mentionArg,
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
            aliases: cand.aliases, mention: mentionArg,
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
              aliases: cand.aliases, mention: mentionArg,
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
            aliases: cand.aliases, mention: mentionArg,
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
            aliases: cand.aliases, mention: mentionArg,
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
          aliases: cand.aliases, mention: mentionArg,
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
          aliases: cand.aliases, mention: mentionArg,
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
        aliases: cand.aliases, mention: mentionArg,
        relations: incomingRels, classification: cls,
      }),
      operationType: 'create',
    },
  ];
}

/* ------------------------------ 主流程 ------------------------------ */

/**
 * 入口：把一段输入（file:// 路径或 http(s):// URL）ingest 为 raw+wiki 两页。
 * @returns 成功返回 ApplyResult；approve 拒绝返回 null（零写入）
 */
export async function ingest(
  input: string,
  deps: IngestDeps,
  opts?: IngestOptions,
): Promise<ApplyResult | null> {
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
  if (!existingRaw && scan.occupied) {
    const urlHash = sha256Hex(meta.sourceUrl).slice(0, 8);
    targetRawRel = `raw/${rawSlug}-${urlHash}.md`;
    opts?.io?.err(`[RAW_SLUG_COLLISION] ${rawRel} 已被其他来源占用，本次改用 ${targetRawRel}`);
  }

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

  // 2) wiki 页（ai-first，LLM 整理，过反伪造 + lint 闸门；slug 命中已存在 → update）。
  // M14：短路时跳过全部 LLM 与 wiki/实体页写入（I18——wiki 页可能已被手工编辑/毕业）。
  const wiki = skipLLM ? null : await summarizeToWiki(body, meta.sourceUrl, deps.gateway);

  // 2.5) 实体抽取（E1/E2，07 规划 D1/D2）：LLM 提议 + 确定性门 + 分类判定树落地。
  // 抽取回稿不可解析时降级为空（不建词条、不写 relations），不阻断 ingest 主流程（I4）。
  let gated: GateResult = { candidates: [], edges: [] };
  if (!skipLLM) {
    try {
      const extraction = await extractEntities(body, meta.sourceUrl, deps.gateway);
      gated = gateCandidates(extraction, body, wiki!.content);
    } catch {
      /* 降级：本次无实体页 */
    }
  }

  if (!skipLLM) {
    const ingestDate = meta.fetchedAt.slice(0, 10);
    const alive = gated.candidates.filter((c) => c.outcome !== 'drop');

    // 边统一补全：实体间声明边 + 来源页 relates_to 实体（对称），再按 inverse 取双向
    const allEdges = [
      ...gated.edges,
      ...alive.map((c) => ({ from: wiki!.slug, type: 'relates_to' as const, to: c.candidate.slug })),
    ].filter((e) => e.from !== e.to);
    const relMap = groupRelationsBySlug(allEdges);

    // 来源页 frontmatter 写入 relations（relates_to → 各存活实体；幂等注入）
    const wikiRels = relMap.get(wiki!.slug) ?? new Map<string, string[]>();
    let wikiContent = wikiRels.size > 0 ? withFrontmatterRelations(wiki!.content, wikiRels) : wiki!.content;
    // M15 C4/I26：raw_source 指针由代码注入（LLM 填的 source 字段仅作展示，两者并存）
    wikiContent = withFrontmatterSource(wikiContent, existingRaw ?? targetRawRel);

    const wikiRel = `wiki/${wiki!.slug}.md`;
    const wikiExists = await existsRel(deps.vault, wikiRel);
    const wikiOp: VaultWriteOp = {
      relativePath: wikiRel,
      content: wikiContent,
      operationType: wikiExists ? 'update' : 'create',
    };

    // 2.6) 实体页 ops（E3 + M13）：planEntityWrite 统一产出新建/原地升级/跨目录迁移；
    // 冲突经 io.err 即时打印（发生在 approve 之前，Q2 拍板），不阻断不进返回值。
    const onConflict = (line: string) => opts?.io?.err(line);
    const entityOps: VaultWriteOp[] = [];
    for (const c of alive) {
      entityOps.push(
        ...(await planEntityWrite({
          vault: deps.vault,
          gated: c,
          sourceRel: existingRaw ?? targetRawRel,
          relMap,
          date: ingestDate,
          wikiSlug: wiki!.slug,
          body,
          onConflict,
        })),
      );
    }

    // 3) raw + wiki + 实体页 同一次事务（operationType=ingest）
    const planFull = await deps.vault.plan([rawOp, wikiOp, ...entityOps]);
    planFull.operationType = 'ingest';

    // M15 C2：写入前基线校验（approve 之前——被拒时根本不到 apply）。
    // adopt/overwrite = 显式逃生口（跳过拒绝）；overwrite 在 apply 后快照旧版（D6）。
    const conflicts = await collectConflicts(deps.vault, planFull.writes);
    if (!opts?.adopt && !opts?.overwrite && conflicts.length > 0) {
      throw conflictError(conflicts);
    }

    const previewFull = deps.vault.preview(planFull);

    // 4) 暂停点：approve 拒绝 → 丢弃，零写入（I3）
    const approvedFull = opts?.approve ? await opts.approve({ plan: planFull, preview: previewFull }) : true;
    if (!approvedFull) return null;

    // 5) 事务原子落盘（任一步失败整体回滚）
    const applied = await deps.vault.apply(planFull, { approvedPlanSha256: previewFull.approvalSha256 });
    if (opts?.overwrite) {
      await snapshotConflicts(deps.vault.root, conflicts).catch(() => undefined); // 快照失败不阻断已提交事务
    }
    return applied;
  }

  // M14 短路路径：仅 raw 页 update（fetched_at 刷新 + 指纹写入/回填），wiki/实体页零触碰（I18）
  const conflictsSkip = await collectConflicts(deps.vault, [rawOp]);
  if (!opts?.adopt && !opts?.overwrite && conflictsSkip.length > 0) {
    throw conflictError(conflictsSkip);
  }
  const planSkip = await deps.vault.plan([rawOp]);
  planSkip.operationType = 'ingest';
  const previewSkip = deps.vault.preview(planSkip);

  // onSkip 在 approve 之前触发（D9）：用户批准前就知道这次为什么只写一个文件
  opts?.onSkip?.();

  const approvedSkip = opts?.approve ? await opts.approve({ plan: planSkip, preview: previewSkip }) : true;
  if (!approvedSkip) return null;

  const appliedSkip = await deps.vault.apply(planSkip, { approvedPlanSha256: previewSkip.approvalSha256 });
  if (opts?.overwrite) {
    await snapshotConflicts(deps.vault.root, conflictsSkip).catch(() => undefined);
  }
  return appliedSkip;
}
