/**
 * F10.4 ingest 实体抽取接线端到端单测（T10.3-*）。
 * 零真实网络：file 适配器 + FakeGateway 双回稿（summarize / extract 关键词路由）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ingest } from '../../src/ingest/ingest';
import { createVault } from '../../src/vault/vault';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';
import { FakeGateway } from '../../test/fakes/fake-gateway';

const RAW_BODY =
  '向量数据库用于存储高维向量，常见于 RAG。它基于 PostgreSQL，配合 pgvector 扩展做相似度检索。\n';

const WIKI_PAGE = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: vector-db
---

## For future agent

整理自外部原文。

## 正文

向量数据库用于存储高维向量。本方案依赖 [[PostgreSQL]]，配合 pgvector 扩展做相似度检索。
`;

const EXTRACT_V1 = JSON.stringify({
  entities: [
    { name: 'PostgreSQL', slug: 'postgresql', kind: 'project', coverage: 'discussed', summary: '开源关系型数据库' },
    { name: 'pgvector', slug: 'pgvector', kind: 'project', coverage: 'named', summary: 'PostgreSQL 向量扩展' },
    { name: '幽灵实体', slug: 'ghost', kind: 'concept', coverage: 'discussed', summary: '原文没提' },
  ],
  relations: [{ from: 'postgresql', type: 'depends_on', to: 'pgvector' }],
});

const EXTRACT_V2 = JSON.stringify({
  entities: [
    { name: 'PostgreSQL', slug: 'postgresql', kind: 'project', coverage: 'discussed', summary: '开源关系型数据库' },
    { name: 'pgvector', slug: 'pgvector', kind: 'project', coverage: 'discussed', summary: 'PostgreSQL 向量扩展' },
  ],
  relations: [],
});

function gwFor(extractReply: string): FakeGateway {
  return new FakeGateway({
    replies: new Map([
      ['整理为一篇', WIKI_PAGE],
      ['实体抽取', extractReply],
    ]),
  });
}

let tmpDir: string;
let articlePath: string;
let articlePath2: string; // M14 短路后：同文件重跑不再触发 LLM，promotion 场景用第二文件（不同 source_url）

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm10-entities-'));
  articlePath = path.join(tmpDir, 'article.txt');
  articlePath2 = path.join(tmpDir, 'article-2.txt');
  await writeFile(articlePath, RAW_BODY, 'utf8');
  await writeFile(articlePath2, RAW_BODY, 'utf8');
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('F10.4 ingest 实体抽取接线', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) {
      await tv.cleanup();
      tv = null;
    }
  });

  it('T10.3-01 抽取+门路由：wiki 页 relations 注入；model→notes 建议态（hand-linked 整页）；named→stub；absent 丢弃（M13 落点语义）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    const res = await ingest(articlePath, { vault, gateway: gwFor(EXTRACT_V1) });
    expect(res).not.toBeNull();
    expect(res!.changedPaths).toContain('wiki/notes/postgresql.md');
    expect(res!.changedPaths).toContain('wiki/notes/pgvector.md');

    // wiki 页 frontmatter 注入 relates_to（保持原文其余内容）
    const wiki = await tv.read('wiki/vector-db.md');
    expect(wiki).toContain('slug: vector-db');
    expect(wiki).toContain('relations:');
    expect(wiki).toContain('relates_to:');
    expect(wiki).toContain("'[[postgresql]]'");
    expect(wiki).toContain("'[[pgvector]]'");

    // 整页（hand-linked，model 建议态）：无 stub 标记，有 Mentions 溯源段
    const pg = await tv.read('wiki/notes/postgresql.md');
    expect(pg).not.toContain('stub: true');
    expect(pg).toContain('## Mentions');
    expect(pg).toContain('[[vector-db]]');
    expect(pg).toContain('depends_on:');
    expect(pg).toContain("'[[pgvector]]'");
    expect(pg).toContain('suggested_kind: project');
    expect(pg).toContain('needs_classification: true');
    expect(pg).not.toContain('entity_kind:');

    // stub（prose+named 分歧）：stub: true + medium；named 票不写建议
    const vec = await tv.read('wiki/notes/pgvector.md');
    expect(vec).toContain('stub: true');
    expect(vec).toContain('confidence: medium');
    expect(vec).not.toContain('suggested_kind');
    // 反向边（inverse）：depends_on 的反向 required_by 落在 pgvector
    expect(vec).toContain('required_by:');
    expect(vec).toContain("'[[postgresql]]'");

    // absent 候选（幽灵实体）不落页
    expect(tv.exists('wiki/notes/ghost.md')).toBe(false);
  });

  it('T10.3-02 抽取回稿不可解析 → 降级：无 relations、无实体页，ingest 照常成功', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    const gw = new FakeGateway({ defaultReply: WIKI_PAGE }); // extract 也回 wiki 页文本（非 JSON）
    const res = await ingest(articlePath, { vault, gateway: gw });
    expect(res).not.toBeNull();
    expect(res!.changedPaths).toHaveLength(2); // 只有 raw + wiki
    const wiki = await tv.read('wiki/vector-db.md');
    expect(wiki).not.toContain('relations:');
    expect(tv.exists('wiki/notes')).toBe(false);
  });

  it('T10.3-03 重复 ingest 幂等：relations 块只注入一次；既有整页不覆盖', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await ingest(articlePath, { vault, gateway: gwFor(EXTRACT_V1) });
    const wikiBefore = await tv.read('wiki/vector-db.md');
    const pgBefore = await tv.read('wiki/notes/postgresql.md');

    await ingest(articlePath, { vault, gateway: gwFor(EXTRACT_V1) });
    const wikiAfter = await tv.read('wiki/vector-db.md');
    expect(wikiAfter).toBe(wikiBefore); // 幂等注入
    expect(wikiAfter.split('relations:').length - 1).toBe(1);
    expect(await tv.read('wiki/notes/postgresql.md')).toBe(pgBefore); // 整页不被覆盖
  });

  it('T10.3-04 stub → page promotion：二次抽取 coverage 升级 → 剥离 stub 标记、写建议并保留旧边（M13；M14 后用第二文件触发全流程）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await ingest(articlePath, { vault, gateway: gwFor(EXTRACT_V1) });
    expect(await tv.read('wiki/notes/pgvector.md')).toContain('stub: true');

    await ingest(articlePath2, { vault, gateway: gwFor(EXTRACT_V2) }); // 不同 source_url → 不短路
    const promoted = await tv.read('wiki/notes/pgvector.md');
    expect(promoted).not.toContain('stub: true');
    expect(promoted).toContain('status: active');
    expect(promoted).toContain('suggested_kind: project'); // M13：有效票写建议
    // promotion 保留旧 relations（required_by 来自 V1 的声明边）
    expect(promoted).toContain('required_by:');
  });
});
