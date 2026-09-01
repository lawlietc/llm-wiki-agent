/**
 * F5.3 hybridRetrieve 融合（06 §1.2 定稿）。
 * T5.3-01~06。纯函数，零网络/LLM：注入 stub Ranked 列表。
 */
import { describe, it, expect, vi } from 'vitest';
import type { Ranked } from '../../src/reasoning/types';
import { hybridRetrieve, RRF_K, HIGH_CONFIDENCE_BOOST, PRE_FUSION_POOL_FLOOR, RRF_WEIGHT, COSINE_WEIGHT } from '../../src/qa/retrieve';

function r(id: string, slug: string, extra: Partial<Ranked> = {}): Ranked {
  return { id, slug, score: 0, ...extra };
}

describe('F5.3 hybridRetrieve 融合', () => {
  it('T5.3-01 仅 BM25 腿（embed/vectorSearch 缺席）→ 纯 rrf 排序不报错', async () => {
    const bm25 = vi.fn(async () => [r('a#chunk-0', 'a'), r('b#chunk-0', 'b'), r('c#chunk-0', 'c')]);
    const out = await hybridRetrieve('q', { bm25 });
    expect(out.map((x) => x.slug)).toEqual(['a', 'b', 'c']); // rrf：rank0 最高
  });

  it('T5.3-02 双腿注入（stub 列表，无 cosine）→ RRF 按 rank 求和正确', async () => {
    const embed = vi.fn(async () => [new Float32Array([1, 0, 0])]);
    const vectorSearch = vi.fn(async () => [r('c#chunk-0', 'c'), r('a#chunk-0', 'a')]); // 无 cosine → 纯 rrf
    const bm25 = vi.fn(async () => [r('a#chunk-0', 'a'), r('b#chunk-0', 'b')]);
    const out = await hybridRetrieve('q', { bm25, embed, vectorSearch });
    // A 两腿都中（bm25 rank0 + vec rank1）→ 分最高；C 仅 vec rank0；B 仅 bm25 rank1
    expect(out.map((x) => x.slug)).toEqual(['a', 'c', 'b']);
    const a = out.find((x) => x.slug === 'a')!;
    const b = out.find((x) => x.slug === 'b')!;
    const c = out.find((x) => x.slug === 'c')!;
    expect(a.score).toBeCloseTo(1 / RRF_K + 1 / (RRF_K + 1), 6); // rrf(0)+rrf(1)
    expect(c.score).toBeCloseTo(1 / RRF_K, 6);
    expect(b.score).toBeCloseTo(1 / (RRF_K + 1), 6);
  });

  it('T5.3-03 两列表同名 id 合并计分、不重复输出', async () => {
    const embed = vi.fn(async () => [new Float32Array([1])]);
    const vectorSearch = vi.fn(async () => [r('a#chunk-0', 'a')]); // 无 cosine
    const bm25 = vi.fn(async () => [r('a#chunk-0', 'a')]);
    const out = await hybridRetrieve('q', { bm25, embed, vectorSearch });
    expect(out.length).toBe(1);
    // 合并：bm25 rank0 rrf + vec rank0 rrf = 2 * (1/60)，不重复输出
    expect(out[0]!.slug).toBe('a');
    expect(out[0]!.score).toBeCloseTo(2 * (1 / RRF_K), 6);
  });

  it('T5.3-04 confidence stated/high 的条目分数 ×2.0（I3）', async () => {
    const bm25 = vi.fn(async () => [
      r('a#chunk-0', 'a', { confidence: 'stated' }),
      r('b#chunk-0', 'b', { confidence: 'medium' }),
    ]);
    const out = await hybridRetrieve('q', { bm25 });
    const a = out.find((x) => x.slug === 'a')!;
    const b = out.find((x) => x.slug === 'b')!;
    expect(a.score).toBeCloseTo((1 / RRF_K) * HIGH_CONFIDENCE_BOOST, 6); // rank0 × 2.0
    expect(b.score).toBeCloseTo(1 / (RRF_K + 1), 6); // rank1 不加权
    expect(out[0]!.slug).toBe('a');
  });

  it('T5.3-05 余弦归一化：无向量腿时纯 rrf；有 cosine 时 blend=0.7*rrf+0.3*(cos/maxCos) 量级不失衡', async () => {
    const embed = vi.fn(async () => [new Float32Array([1, 0])]);
    const vectorSearch = vi.fn(async () => [r('b#chunk-0', 'b', { cosine: 1.0 })]);
    const bm25 = vi.fn(async () => [r('a#chunk-0', 'a')]);
    const out = await hybridRetrieve('q', { bm25, embed, vectorSearch });
    const a = out.find((x) => x.slug === 'a')!;
    const b = out.find((x) => x.slug === 'b')!;
    // b 高分 cosine 经归一化后应压过 a（纯 rrf）
    expect(b.score).toBeGreaterThan(a.score);
    // 校验 blend 公式：a 无 cosine → 0.7*rrf + 0；b → 0.7*rrf + 0.3*1.0
    expect(a.score).toBeCloseTo((1 / RRF_K) * RRF_WEIGHT, 6);
    expect(b.score).toBeCloseTo((1 / RRF_K) * RRF_WEIGHT + (1.0 / 1.0) * COSINE_WEIGHT, 6);
  });

  it('T5.3-06 融合前每列表至少取前 PRE_FUSION_POOL_FLOOR（k 小于 floor 时取 floor）', async () => {
    const bm25 = vi.fn(async () => [r('a#chunk-0', 'a')]);
    await hybridRetrieve('q', { bm25, k: 10 });
    expect(bm25).toHaveBeenCalledWith('q', Math.max(10, PRE_FUSION_POOL_FLOOR));
  });
});
