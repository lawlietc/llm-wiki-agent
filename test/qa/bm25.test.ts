/**
 * F5.2 BM25 索引（06 §1.3 六条全过）。
 * T5.2-01~08。零真实网络/LLM：纯 fs + fixture vault。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildIndex, bm25Query } from '../../src/qa/index/bm25';
import { DIRTY_MARKER_REL } from '../../src/vault/transaction';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';

const PAGE_A = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: vector-db
---

## 正文

向量数据库用于存储高维向量，常见于 RAG 与推荐系统。向量数据库支持近似最近邻检索。
`;
const PAGE_B = `---
type: project
date: 2026-09-01
ai-first: true
confidence: medium
slug: cache-design
---

## 正文

缓存设计关注命中率与失效策略。LRU 是常见缓存淘汰算法，适用于读多写少场景。
`;
const PAGE_C = `---
type: project
date: 2026-09-01
ai-first: true
confidence: stated
slug: graph-theory
---

## 正文

图论研究图结构与算法。最短路径可用 Dijkstra 算法求解，适用于路由规划。
`;

let tv: TempVault;
beforeAll(async () => {
  tv = await makeVault({
    files: {
      'wiki/vector-db.md': PAGE_A,
      'wiki/cache-design.md': PAGE_B,
      'wiki/graph-theory.md': PAGE_C,
    },
  });
});
afterAll(async () => {
  await tv.cleanup();
});

describe('F5.2 BM25 索引', () => {
  it('T5.2-01 三篇 wiki 页建索引 → index.json schema 正确', async () => {
    await buildIndex(tv.root);
    const idxPath = tv.abs(path.join('.index', 'bm25', 'index.json'));
    expect(existsSync(idxPath)).toBe(true);
    const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
    expect(idx.schema_version).toBe(1);
    expect(idx.params).toEqual({ k1: 1.5, b: 0.75 });
    expect(idx.doc_count).toBeGreaterThan(0);
    expect(typeof idx.avg_dl).toBe('number');
    expect(idx.avg_dl).toBeGreaterThan(0);
    expect(typeof idx.updated_at).toBe('string');
    expect(idx.vocab).toBeTypeOf('object');
    expect(idx.docs).toBeTypeOf('object');
  });

  it('T5.2-02 chunk id `<slug>:<n>`、chunk 文件落 .index/chunks/', async () => {
    await buildIndex(tv.root);
    const chunkDir = tv.abs(path.join('.index', 'chunks'));
    const files = readdirSync(chunkDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const someChunk = JSON.parse(readFileSync(path.join(chunkDir, files[0]!), 'utf8'));
    expect(someChunk.id).toMatch(/^[\w-]+:\d+$/); // <slug>:<n>
    expect(someChunk.slug).toBeTypeOf('string');
    expect(typeof someChunk.text).toBe('string');
    // 索引 docs 里记录的 path 与 chunk 文件对应（文件名编码方式无关，只验证存在）
    const idx = JSON.parse(readFileSync(tv.abs(path.join('.index', 'bm25', 'index.json')), 'utf8'));
    expect(existsSync(tv.abs(idx.docs[someChunk.id].path))).toBe(true);
  });

  it('T5.2-03 中文查询命中长文档（n-gram 生效，未分词中文可检索）', async () => {
    await buildIndex(tv.root);
    const hits = await bm25Query(tv.root, '向量数据库', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.slug).toBe('vector-db');
  });

  it('T5.2-04 重建进行中（仅写 .tmp 半文件）→ 读方读到旧完整索引，不崩溃', async () => {
    await buildIndex(tv.root); // 完整旧索引
    // 模拟重建中途：写半截临时文件，未 rename
    const tmpPath = tv.abs(path.join('.index', 'bm25', 'index.json.tmp.partial'));
    const fh = readFileSync(tv.abs(path.join('.index', 'bm25', 'index.json')), 'utf8');
    // 截断成非法 JSON 模拟半写
    writeFileSync(tmpPath, fh.slice(0, Math.floor(fh.length / 2)));
    // 读方必须忽略 .tmp，读到旧 index.json → 正确结果
    const hits = await bm25Query(tv.root, '缓存', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.slug).toBe('cache-design');
    rmSync(tmpPath, { force: true });
  });

  it('T5.2-05 重建中途 kill（仅 .tmp）→ 旧索引完整可用', async () => {
    await buildIndex(tv.root);
    const tmpPath = tv.abs(path.join('.index', 'bm25', 'index.json.tmp.killed'));
    writeFileSync(tmpPath, '{ "broken": true'); // 非法 JSON 半写
    const hits = await bm25Query(tv.root, '图论', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.slug).toBe('graph-theory');
    rmSync(tmpPath, { force: true });
  });

  it('T5.2-06 dirty 存在 → bm25Query 先重建再查（I1）；删页+dirty 后查不到旧页', async () => {
    await buildIndex(tv.root); // 无 dirty，建好
    // 删一页并置 dirty
    rmSync(tv.abs('wiki/cache-design.md'), { force: true });
    writeFileSync(tv.abs(DIRTY_MARKER_REL), '');
    const hits = await bm25Query(tv.root, '缓存', 5);
    expect(hits.find((h) => h.slug === 'cache-design')).toBeUndefined();
    expect(existsSync(tv.abs(DIRTY_MARKER_REL))).toBe(false); // 重建后清 dirty
  });

  it('T5.2-07 空目录/无 wiki 页 → buildIndex 不抛错，查询返回 []', async () => {
    const empty = await makeVault({ scaffold: true, initialize: true });
    await expect(buildIndex(empty.root)).resolves.toBeUndefined();
    const hits = await bm25Query(empty.root, '任意', 5);
    expect(hits).toEqual([]);
    await empty.cleanup();
  });

  it('T5.2-08 Ranked 字段齐全（id/slug/score/snippet/chunkIndex + confidence 取自 frontmatter）', async () => {
    await buildIndex(tv.root);
    const hits = await bm25Query(tv.root, '向量数据库', 5);
    const top = hits[0]!;
    expect(top.id).toMatch(/^vector-db#chunk-\d+$/); // 锚点形态
    expect(top.slug).toBe('vector-db');
    expect(typeof top.score).toBe('number');
    expect(top.score).toBeGreaterThan(0);
    expect(typeof top.snippet).toBe('string');
    expect(top.snippet!.length).toBeGreaterThan(0);
    expect(top.chunkIndex).toBeTypeOf('number');
    expect(top.confidence).toBe('high'); // 取自 frontmatter
  });
});
