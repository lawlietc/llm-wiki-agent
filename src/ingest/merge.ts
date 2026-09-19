/**
 * 批量跨源实体归并（M20 工单 06 / D20-3 / I44）。
 *
 * **为什么需要它**：批量原本是「逐项 ingest」——抽取关在单项流程内部，N 篇提到同一实体
 * 就 N 次探测既有页、N 次重渲染，且 aliases / relations / mentions 的最终形态取决于处理顺序
 * （后写覆盖先写）。本模块在**相位 A 之后、相位 C 之前**做一次**串行 reduce**：
 * 按 slug 把整批的贡献合并成一个视图，同一实体只在**宿主项**（首次出现者）的事务里落一次。
 *
 * **红线**：
 * - 归并只发生在串行 reduce，**不引入写侧并发**（I44）；写侧仍是逐项事务、逐项走基线与冲突检查；
 * - 归并**不丢信息**：aliases / 关系 / 源指针 / 事实都是并集；同 slug 不同 kind 时保留先出现者，
 *   并把冲突**记入报告**（不静默丢弃）；
 * - 事实按**源**分组保留（`FactRef.sourceRef`）：跨源合并后各源事实仍指向自己的分块编号空间。
 *
 * 纯函数、无 I/O、无 LLM。
 */

import { extractMention } from '../notes/entity-page';
import { contradictionKey, type ContradictionEntry } from '../notes/contradictions';
import type { EntityKind, FactRef, GatedCandidate } from './candidate-gate';

/** 一项（一篇文章）对某个 slug 的贡献 */
export interface MergeContribution {
  /** 本批内的项序号（= todos 下标）——决定「先出现者」与事务归属 */
  index: number;
  /** 本项的原始输入（报告与排障用） */
  input: string;
  /** 本项来源的 raw 页相对路径（溯源指针 + 事实锚点归属） */
  sourceRel: string;
  /** 本项的 wiki 主页 slug（Mentions 归属） */
  wikiSlug: string;
  /** 本项原文（取 Mentions 摘录） */
  body: string;
  /** 本项的关系表（含来源页 relates_to；归并要求它的 incomingRels） */
  relMap: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  gated: GatedCandidate;
  /** 【工单 08】本项检测到的矛盾记录（归并时并集） */
  contradictions?: readonly ContradictionEntry[];
}

/** 归并后的实体（宿主项写它） */
export interface MergedEntity {
  slug: string;
  /** 宿主项下标（首次出现者）——实体页在它的事务里落盘 */
  owner: number;
  /** 合并视图候选：aliases 并集、facts 并集、summary 取首个非空；kind 取先出现者 */
  gated: GatedCandidate;
  /** 支撑本实体的全部源（按项序） */
  sourceRels: string[];
  /** 宿主之外的贡献源 Mentions（按项序累加） */
  extraMentions: { quote: string; wikiSlug: string }[];
  /** 关系并集（各贡献项对本 slug 的 incomingRels 并集，去重保序） */
  incomingRels: Map<string, string[]>;
  /** 【工单 08】矛盾记录并集（按幂等键去重、保序） */
  contradictions: ContradictionEntry[];
  /** 被折叠的重复贡献数（= sourceRels.length - 1） */
  mergedCount: number;
}

/** 同 slug 不同 kind 的类型冲突（保留先出现者） */
export interface KindMergeConflict {
  slug: string;
  keptKind: EntityKind | null;
  droppedKind: EntityKind | null;
  keptInput: string;
  droppedInput: string;
}

export interface MergeResult {
  /** 按 slug 首次出现顺序 */
  entities: MergedEntity[];
  /** 项序号 → 该项要写的实体（宿主视角；非宿主项为空数组） */
  byIndex: Map<number, MergedEntity[]>;
  kindConflicts: KindMergeConflict[];
  /** 归并计数：被折叠的重复贡献总数（= 省下的实体页写操作数） */
  merged: number;
}

/** 去重保序并集 */
function unionStrings(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const s of list) if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** 事实并集：同源同块去重（跨源同块号不算重复——块号只在源内有意义） */
function unionFacts(lists: readonly (readonly FactRef[])[]): FactRef[] {
  const out: FactRef[] = [];
  for (const list of lists) {
    for (const f of list) {
      if (out.some((x) => x.sourceRef === f.sourceRef && x.chunkIndex === f.chunkIndex && x.text === f.text)) continue;
      out.push({ ...f });
    }
  }
  return out;
}

/** 【工单 08】矛盾记录并集：按幂等键去重、保序 */
function unionContradictions(lists: readonly ContradictionEntry[]): ContradictionEntry[] {
  const out: ContradictionEntry[] = [];
  const seen = new Set<string>();
  for (const e of lists) {
    const key = contradictionKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e });
  }
  return out;
}

/** 关系并集：按 type 收敛，链接去重保序 */
function unionRels(
  maps: readonly ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>[],
  slug: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of maps) {
    const rels = m.get(slug);
    if (!rels) continue;
    for (const [type, links] of rels) {
      const list = out.get(type) ?? [];
      for (const l of links) if (!list.includes(l)) list.push(l);
      out.set(type, list);
    }
  }
  return out;
}

/**
 * 按 slug 归并整批贡献。同一 slug 的贡献按项序（先出现者在前）折叠进一个 `MergedEntity`，
 * 归并结果挂在 `owner` 名下（首次出现项）。
 */
export function reduceEntityMerges(contributions: readonly MergeContribution[]): MergeResult {
  const order: string[] = [];
  const grouped = new Map<string, MergeContribution[]>();
  for (const c of contributions) {
    const slug = c.gated.candidate.slug;
    const list = grouped.get(slug);
    if (list) list.push(c);
    else {
      grouped.set(slug, [c]);
      order.push(slug);
    }
  }

  const entities: MergedEntity[] = [];
  const kindConflicts: KindMergeConflict[] = [];
  let merged = 0;

  for (const slug of order) {
    const contribs = [...grouped.get(slug)!].sort((a, b) => a.index - b.index);
    const owner = contribs[0]!;
    const cand = owner.gated.candidate;

    const aliases = unionStrings(contribs.map((c) => c.gated.candidate.aliases ?? []));
    const facts = unionFacts(contribs.map((c) => c.gated.candidate.facts ?? []));
    const summary =
      cand.summary && cand.summary.trim() !== ''
        ? cand.summary
        : contribs.map((c) => c.gated.candidate.summary).find((s) => s !== undefined && s.trim() !== '');

    for (const c of contribs.slice(1)) {
      if (c.gated.candidate.kind !== cand.kind) {
        kindConflicts.push({
          slug,
          keptKind: cand.kind,
          droppedKind: c.gated.candidate.kind,
          keptInput: owner.input,
          droppedInput: c.input,
        });
      }
    }

    const extraMentions = contribs
      .slice(1)
      .map((c) => {
        const m = extractMention(c.body, c.gated.candidate.name, c.gated.candidate.aliases);
        return m ? { quote: m.quote, wikiSlug: c.wikiSlug } : null;
      })
      .filter((m): m is { quote: string; wikiSlug: string } => m !== null);

    entities.push({
      slug,
      owner: owner.index,
      gated: {
        ...owner.gated,
        candidate: {
          ...cand,
          ...(aliases.length > 0 ? { aliases } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(facts.length > 0 ? { facts } : {}),
        },
      },
      sourceRels: contribs.map((c) => c.sourceRel),
      extraMentions,
      incomingRels: unionRels(
        contribs.map((c) => c.relMap),
        slug,
      ),
      contradictions: unionContradictions(contribs.flatMap((c) => [...(c.contradictions ?? [])])),
      mergedCount: contribs.length - 1,
    });
    merged += contribs.length - 1;
  }

  const byIndex = new Map<number, MergedEntity[]>();
  for (const e of entities) {
    const list = byIndex.get(e.owner) ?? [];
    list.push(e);
    byIndex.set(e.owner, list);
  }

  return { entities, byIndex, kindConflicts, merged };
}

/**
 * 宿主项写实体页时用的关系表：在本项 relMap 的副本上，把被归并 slug 的入边换成并集。
 * （不动原表：相位 C 里同一份 `prepared.relMap` 还被 wiki 主页写操作引用。）
 */
export function relMapForOwner(
  prepared: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  owned: readonly MergedEntity[],
): Map<string, Map<string, string[]>> {
  const clone = new Map<string, Map<string, string[]>>();
  for (const [slug, rels] of prepared) {
    const inner = new Map<string, string[]>();
    for (const [type, links] of rels) inner.set(type, [...links]);
    clone.set(slug, inner);
  }
  for (const m of owned) clone.set(m.slug, m.incomingRels);
  return clone;
}
