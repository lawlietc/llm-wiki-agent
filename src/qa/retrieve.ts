/**
 * 混合检索融合（06 §1.2 定稿）。
 *
 * RRF 融合 + 高可信加权 + 余弦归一化混合。向量腿可整体缺席（MVP 纯 BM25）。
 * 参数锁死（I3）：RRF_K=60、HIGH_CONFIDENCE_BOOST=2.0、PRE_FUSION_POOL_FLOOR=50、权重 0.7/0.3。
 */

import type { Ranked } from '../reasoning/types';

export const RRF_K = 60;
export const HIGH_CONFIDENCE_BOOST = 2.0;
export const PRE_FUSION_POOL_FLOOR = 50;
export const RRF_WEIGHT = 0.7;
export const COSINE_WEIGHT = 0.3;

function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/** 高可信页（frontmatter confidence: stated|high）命中加权（06 §1.1） */
export function shouldBoostHighConfidence(confidence?: string): boolean {
  return confidence === 'stated' || confidence === 'high';
}

export interface HybridRetrieveDeps {
  /** BM25 腿：返回 Ranked[]（按相关性降序） */
  bm25: (query: string, k: number) => Promise<Ranked[]>;
  /** 向量腿（可选）：文本→向量 */
  embed?: (texts: string[]) => Promise<Float32Array[]>;
  /** 向量腿（可选）：向量→Ranked[]（带 cosine 字段） */
  vectorSearch?: (vec: Float32Array, k: number) => Promise<Ranked[]>;
  /** 取前 k（默认 PRE_FUSION_POOL_FLOOR） */
  k?: number;
}

/**
 * 混合检索：BM25 + 向量两路 RRF 融合。
 * 无向量腿（embed/vectorSearch 任一缺失）→ 纯 rrf 排序（I4）。
 */
export async function hybridRetrieve(query: string, deps: HybridRetrieveDeps): Promise<Ranked[]> {
  const k = deps.k ?? PRE_FUSION_POOL_FLOOR;
  const floor = Math.max(k, PRE_FUSION_POOL_FLOOR);

  const kw = await deps.bm25(query, floor);

  const vec =
    deps.embed && deps.vectorSearch
      ? await (async () => {
          const [v] = await deps.embed!([query]);
          return deps.vectorSearch!(v, floor);
        })()
      : [];

  // RRF 融合（按 rank 求和 rrfScore）
  const fused = new Map<string, { score: number; item: Ranked }>();
  const mergeItem = (a: Ranked, b: Ranked): Ranked =>
    a.cosine === undefined && b.cosine !== undefined ? b : a;

  for (const list of [kw, vec]) {
    list.forEach((item, rank) => {
      const prev = fused.get(item.id);
      if (prev) {
        prev.score += rrfScore(rank);
        if (shouldBoostHighConfidence(item.confidence)) prev.score *= HIGH_CONFIDENCE_BOOST;
        prev.item = mergeItem(prev.item, item);
      } else {
        let score = rrfScore(rank);
        if (shouldBoostHighConfidence(item.confidence)) score *= HIGH_CONFIDENCE_BOOST;
        fused.set(item.id, { score, item });
      }
    });
  }

  // 余弦重排：先归一化两路分数到同一量级再混合（rrfScore ~1/60，cosine 0~1）。
  // 无向量腿时（maxCos=0）直接按 rrf 排序。
  const maxCos = Math.max(...[...fused.values()].map((e) => e.item.cosine ?? 0), 0);
  const merged = [...fused.values()].map((e) => ({
    ...e.item,
    score:
      maxCos > 0
        ? e.score * RRF_WEIGHT + ((e.item.cosine ?? 0) / maxCos) * COSINE_WEIGHT
        : e.score,
  }));

  return merged.sort((a, b) => b.score - a.score);
}
