/**
 * F12.1/F12.2 relations 图构建与局部子图（07 §4 M12/E5；M12 spec D1–D5/D12–D15）。
 *
 * - buildSlugIndex：wiki/** 的 slug 索引（basename / frontmatter slug / alias → 页相对路径，
 *   路径排序首个胜）。首个胜是 M11 四级优先级的简化；同名碰撞态可能错接（D15 降级语义，
 *   duplicateEntitySlug=error 驱动消解）。
 * - buildEdgesFromVault：扫 wiki/** 的 relations 展平为确定性边集。端点先经 slug 索引
 *   解析到页、规范 slug = 该页 basename（D4）——去重/自环/悬空/输出全部基于规范形
 *   （否则别名形态不去重、"页引用自己别名"漏过自环）。剪除规则：悬空（D3，剪边不丢
 *   知识——事实仍住两端页 frontmatter）、非法类型、自环、非 [[...]] 形态。之后复用
 *   invertEdges 补反向（M10 落盘已双向，幂等不翻倍）。
 * - subgraphFor：命中页一跳子图（端点含任一命中 slug），截断顺序 =（端点所属命中页
 *   排名，from\0type\0to 码点序）——确定性且相关性感知（D12）。
 *
 * 不变量：I7 纯读零副作用（禁止局部缓存，I16）；I8 补边幂等；I9 不制造悬空；
 * I10 预算有界；I11 目录无关。范围 = wiki/**（raw/ 手写 relations 有意不进图，D13）。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseNote } from '../notes/frontmatter';
import { invertEdges, isRelationType, type RelationEdge, type RelationType } from '../notes/relations';
import { typedEdgeTargets } from '../vault/links';
import { walkMarkdown } from '../vault/scan';

/** prompt 预算常数：进 <graph> 段的最大边数（与 M10 MAX_RELATIONS 同为单次 prompt 预算量级，数值相同属巧合） */
export const MAX_GRAPH_EDGES = 64;

/** 页 slug 索引：slug（basename / frontmatter slug / alias）→ 页相对路径（路径排序首个胜） */
export type SlugIndex = Map<string, string>;

/** 从页相对路径提取 slug（basename，D4 的规范形来源） */
function basenameSlug(rel: string): string {
  return rel.split('/').pop()!.replace(/\.md$/, '');
}

/** 读页 frontmatter；损坏页返回 null（降级跳过） */
async function readFrontmatter(root: string, rel: string): Promise<Record<string, unknown> | null> {
  try {
    const { frontmatter } = parseNote(await readFile(path.join(root, rel), 'utf8'));
    return frontmatter as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** string 数组取值（frontmatter aliases 用） */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 扫 wiki/**.md 建 slug 索引（跳过 SKIP_DIRS；损坏页跳过）。首个胜 = M11 四级优先级的简化（D15） */
export async function buildSlugIndex(root: string): Promise<SlugIndex> {
  const index: SlugIndex = new Map();
  for (const rel of await walkMarkdown(root, 'wiki')) {
    const base = basenameSlug(rel);
    if (!index.has(base)) index.set(base, rel);
    const fm = await readFrontmatter(root, rel);
    if (!fm) continue;
    const slug = fm.slug;
    if (typeof slug === 'string' && slug.trim() !== '' && !index.has(slug.trim())) {
      index.set(slug.trim(), rel);
    }
    for (const alias of stringArray(fm.aliases)) {
      if (alias.trim() !== '' && !index.has(alias)) index.set(alias, rel);
    }
  }
  return index;
}

/** 码点序比较（不依赖 ICU/Node locale，I7） */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 扫 wiki/** 的 relations 展平成确定性边集：端点规范化 → 剪除 → inverse 补全 → 去重 → 稳定排序。
 * 纯读、零 LLM、零副作用；同输入恒同输出（I7）。
 */
export async function buildEdgesFromVault(root: string): Promise<RelationEdge[]> {
  const index = await buildSlugIndex(root);
  const pages = await walkMarkdown(root, 'wiki');

  // 1) 收集声明边（from = 本页 basename；端点取值形态跟随 M11 typedEdgeTargets——剥管道/锚点）
  const declared: RelationEdge[] = [];
  for (const rel of pages) {
    const fm = await readFrontmatter(root, rel);
    if (!fm) continue; // 损坏页降级跳过
    const from = basenameSlug(rel);
    for (const { type, to } of typedEdgeTargets(fm as never)) {
      if (!isRelationType(type)) continue;
      declared.push({ from, type, to });
    }
  }

  // 2) 端点规范化 + 剪除（悬空/自环/非法）+ 去重——全部基于规范形（D4）
  const canon = (t: string): string | null => {
    const hit = index.get(t);
    return hit ? basenameSlug(hit) : null; // 解析不到页 → 悬空，剪除
  };
  const seen = new Set<string>();
  const cleaned: RelationEdge[] = [];
  for (const e of declared) {
    const from = canon(e.from);
    const to = canon(e.to);
    if (from == null || to == null) continue;
    if (from === to) continue; // 自环（含别名穿透形态）
    const key = `${from}\u0000${e.type}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ from, type: e.type as RelationType, to });
  }

  // 3) inverse 补全（M10 落盘已双向 → 幂等不翻倍，I8）；invertEdges 内部去重 + 稳定排序
  return invertEdges(cleaned);
}

/**
 * 命中页一跳子图（F12.2）：端点含任一 rankedSlugs 成员的边。
 * 截断顺序 =（端点所属命中页的最小排名，from\0type\0to 码点序）——确定性且相关性感知（D12），
 * 高排名命中页的边不会被低排名页按字母序挤掉。
 */
export function subgraphFor(
  edges: readonly RelationEdge[],
  rankedSlugs: readonly string[],
  max: number = MAX_GRAPH_EDGES,
): RelationEdge[] {
  const rank = new Map<string, number>(rankedSlugs.map((s, i) => [s, i]));
  const UNRANKED = Number.MAX_SAFE_INTEGER;
  const candidates = edges
    .map((e) => {
      const rf = rank.get(e.from) ?? UNRANKED;
      const rt = rank.get(e.to) ?? UNRANKED;
      return { e, r: Math.min(rf, rt) };
    })
    .filter(({ r }) => r !== UNRANKED); // 一跳：至少一个端点是命中页

  candidates.sort((a, b) => {
    if (a.r !== b.r) return a.r - b.r;
    return byKey(`${a.e.from}\u0000${a.e.type}\u0000${a.e.to}`, `${b.e.from}\u0000${b.e.type}\u0000${b.e.to}`);
  });

  return candidates.slice(0, max).map(({ e }) => e);
}
