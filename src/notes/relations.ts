/**
 * F10.1 relations 类型边 inverse 表（07 规划 D3，抄 obsidian-second-brain
 * `references/ai-first-rules.md` 的 typed edges 表）。
 *
 * 纯函数、无 I/O。非法类型在抽取端被确定性过滤（M10.3），在解析端报
 * danglingTypedEdges 之外还可用 isRelationType 拒绝。
 */

/** 固定 relation 类型 → inverse（对称类型 inverse 为自身） */
export const RELATION_INVERSE: Readonly<Record<string, string>> = {
  supersedes: 'superseded_by',
  superseded_by: 'supersedes',
  depends_on: 'required_by',
  required_by: 'depends_on',
  caused: 'caused_by',
  caused_by: 'caused',
  decided_by: 'decides',
  decides: 'decided_by',
  relates_to: 'relates_to',
  contradicts: 'contradicts',
};

export type RelationType = keyof typeof RELATION_INVERSE & string;

/** 是否合法 relation 类型 */
export function isRelationType(t: string): t is RelationType {
  return Object.prototype.hasOwnProperty.call(RELATION_INVERSE, t);
}

/** inverse（已保证 t 合法） */
export function inverseOf(t: RelationType): RelationType {
  return RELATION_INVERSE[t] as RelationType;
}

/** 对称类型（inverse 即自身） */
export function isSymmetric(t: RelationType): boolean {
  return RELATION_INVERSE[t] === t;
}

/** 带类型的一条边（slug → slug） */
export interface RelationEdge {
  from: string;
  type: RelationType;
  to: string;
}

/**
 * 把一组（可能重复、只有单向的）边补全成双向边集：
 * 声明边 (from,type,to) 保留原样；若 (to,inverse,from) 不在其中则补上。
 * 对称类型不重复补。结果按 (from,type,to) 去重、稳定排序，可重算（幂等）。
 */
export function invertEdges(edges: readonly RelationEdge[]): RelationEdge[] {
  const seen = new Set<string>();
  const out: RelationEdge[] = [];
  const key = (e: RelationEdge) => `${e.from}\u0000${e.type}\u0000${e.to}`;

  for (const e of edges) {
    if (!seen.has(key(e))) {
      seen.add(key(e));
      out.push(e);
    }
  }
  for (const e of edges) {
    const inv: RelationEdge = { from: e.to, type: inverseOf(e.type), to: e.from };
    if (!seen.has(key(inv))) {
      seen.add(key(inv));
      out.push(inv);
    }
  }

  return out.sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * 把双向边集按「声明页」分组：实体 from 收下自己的出边；作为 to 的实体收下 inverse 入边。
 * 返回 slug → (type → ['[[target]]'])，可直接喂 frontmatter 的 relations 字段约定
 * （值为 ["[[wikilink]]"]，02 §3）。
 */
export function groupRelationsBySlug(edges: readonly RelationEdge[]): Map<string, Map<string, string[]>> {
  const result = new Map<string, Map<string, string[]>>();
  for (const e of invertEdges(edges)) {
    for (const [owner, type, target] of [
      [e.from, e.type, e.to],
      [e.to, inverseOf(e.type), e.from],
    ] as const) {
      let byType = result.get(owner);
      if (!byType) {
        byType = new Map();
        result.set(owner, byType);
      }
      const list = byType.get(type) ?? [];
      const link = `[[${target}]]`;
      if (!list.includes(link)) list.push(link);
      byType.set(type, list);
    }
  }
  return result;
}

/**
 * 把既有 relations（Record<type, ['[[slug]]']>）与新边合并：
 * 去重后返回合并 Map（type → links）。用于 stub→page promotion 时保留旧边。
 */
export function mergeRelationMaps(
  existing: Record<string, unknown> | undefined,
  incoming: Map<string, string[]>,
): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  if (existing) {
    for (const [type, value] of Object.entries(existing)) {
      if (!Array.isArray(value)) continue;
      const links = value.filter((v): v is string => typeof v === 'string' && v.startsWith('[['));
      if (links.length > 0) merged.set(type, [...links]);
    }
  }
  for (const [type, links] of incoming) {
    const list = merged.get(type) ?? [];
    for (const l of links) if (!list.includes(l)) list.push(l);
    if (list.length > 0) merged.set(type, list);
  }
  return merged;
}
