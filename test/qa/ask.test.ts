/**
 * F5.5 端到端 ask（06 §4 MVP 形态）。
 * T5.5-01~05。零真实网络/LLM：fixture vault + FakeGateway + M4 applyBundle 串联。
 */
import { it, expect, beforeAll, afterAll } from 'vitest';

import { ask } from '../../src/qa/ask';
import { buildIndex } from '../../src/qa/index/bm25';
import { createVault } from '../../src/vault/vault';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';
import { FakeGateway } from '../../test/fakes/fake-gateway';

const PAGE_A = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: vector-db
---

## 正文

向量数据库用于存储高维向量，常见于 RAG 与推荐系统。
`;
const PAGE_B = `---
type: project
date: 2026-09-01
ai-first: true
confidence: medium
slug: cache-design
---

## 正文

缓存设计关注命中率与失效策略。LRU 是常见缓存淘汰算法。
`;

/** 经 M4 同款 applyBundle 写一页 wiki（成功后落 dirty 标记，模拟 ingest 效果） */
async function writeWikiPage(tv: TempVault, slug: string, body: string, confidence: string): Promise<void> {
  const vault = createVault(tv.root);
  const content = `---\ntype: project\ndate: 2026-09-01\nai-first: true\nconfidence: ${confidence}\nslug: ${slug}\n---\n\n## 正文\n\n${body}\n`;
  const plan = await vault.plan([{ relativePath: `wiki/${slug}.md`, content, operationType: 'create' }]);
  const preview = vault.preview(plan);
  await vault.apply(plan, { approvedPlanSha256: preview.approvalSha256 });
}

let tv: TempVault;
beforeAll(async () => {
  tv = await makeVault({ files: { 'wiki/vector-db.md': PAGE_A, 'wiki/cache-design.md': PAGE_B } });
  await buildIndex(tv.root); // 初始索引（无 dirty）
});

it('T5.5-01 fixture vault（2 页）+ FakeGateway 固定回稿 → ask 返回 answer + citations 指向真实 slug', async () => {
  const gw = new FakeGateway({
    defaultReply: JSON.stringify({ answer: '向量数据库用于高维检索。', citations: ['[vector-db]'], gaps: [] }),
  });
  const res = await ask('什么是向量数据库？', { vaultRoot: tv.root, gateway: gw });
  expect(res.answer).toContain('向量数据库');
  expect(res.citations).toContain('[vector-db]');
  // 检索真实发生：prompt 含该 slug
  expect(gw.lastPrompt).toContain('vector-db');
});

it('T5.5-02 ingest 新页后（M4 串联 + dirty）→ 立即 ask 能检索到新页（I1 端到端证明）', async () => {
  await writeWikiPage(tv, 'graph-theory', '图论研究图结构与算法，最短路径用 Dijkstra。', 'stated');
  const gw = new FakeGateway({
    defaultReply: JSON.stringify({ answer: '图论研究图算法。', citations: ['[graph-theory]'], gaps: [] }),
  });
  const res = await ask('图论是什么？', { vaultRoot: tv.root, gateway: gw });
  // 新页经 dirty 重建后立即可检：检索上下文含 graph-theory
  expect(gw.lastPrompt).toContain('graph-theory');
  expect(res.citations).toContain('[graph-theory]');
});

it('T5.5-03 检索零命中 → RetrievalContext.pages 为空，synthesize 仍返回 gaps 明示不知道（I6）', async () => {
  const empty = await makeVault({ scaffold: true, initialize: true }); // 无 wiki 页
  const gw = new FakeGateway({
    defaultReply: JSON.stringify({ answer: '我不确定，知识库里没有相关内容。', citations: [], gaps: ['未知图论细节'] }),
  });
  const res = await ask('数据库索引是怎么实现的？', { vaultRoot: empty.root, gateway: gw });
  // pages 段为空（零命中）
  expect(gw.lastPrompt).toContain('<pages>\n\n</pages>');
  expect(res.gaps.length).toBeGreaterThan(0);
  await empty.cleanup();
});

it('T5.5-04 expand 多子查询 → 每条各检索一次再融合（prompt 含两 slug）', async () => {
  const expand = async (q: string): Promise<string[]> => [q, '缓存']; // 展开为原问题 + 缓存
  const gw = new FakeGateway({
    defaultReply: JSON.stringify({ answer: '综合答案。', citations: ['[vector-db]'], gaps: [] }),
  });
  await ask('向量数据库', { vaultRoot: tv.root, gateway: gw, expand });
  // 两条子查询分别检索 vector-db 与 cache-design，融合后上下文同时含两者
  expect(gw.lastPrompt).toContain('vector-db');
  expect(gw.lastPrompt).toContain('cache-design');
});

it('T5.5-05 RetrievalContext：MVP takes/edges 恒为空数组（<takes>/<graph> 段为空）', async () => {
  const gw = new FakeGateway({
    defaultReply: JSON.stringify({ answer: 'a', citations: ['[vector-db]'], gaps: [] }),
  });
  await ask('向量数据库', { vaultRoot: tv.root, gateway: gw });
  expect(gw.lastPrompt).toContain('<takes>\n\n</takes>');
  expect(gw.lastPrompt).toContain('<graph>\n\n</graph>');
});

afterAll(async () => {
  if (tv) await tv.cleanup();
});
