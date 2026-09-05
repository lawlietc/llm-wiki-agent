/**
 * F12.3 ask 图接线 + D11 引用软降级单测（T12.3-*）。
 * 覆盖：<graph> 注入、无 relations 回归安全（I12）、子图裁剪、守规矩/对抗性引用（A1/D11）、
 * 页图同源（I15）、既有形态校验不破（T5.4-06 语义）。
 * 零真实网络、零真实 LLM。
 */
import { describe, it, expect, afterEach } from 'vitest';

import { ask } from '../../src/qa/ask';
import { buildIndex } from '../../src/qa/index/bm25';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';
import { FakeGateway } from '../../test/fakes/fake-gateway';

const PAGE = (slug: string, body: string, extra = ''): string =>
  `---\ntype: idea\ndate: 2026-09-05\nai-first: true\nconfidence: high\nslug: ${slug}${extra}\n---\n\n## For future agent\n\n${body}\n`;

/** fixture：vector-db --depends_on--> rag（双向落盘）；isolated --relates_to--> rag；unrelated 悬空边 */
const FILES = {
  'wiki/concepts/rag.md': PAGE('rag', 'RAG 是检索增强生成 retrieval 核心概念。'),
  'wiki/concepts/vector-db.md': PAGE('vector-db', '向量数据库存储高维向量 retrieval。', '\nrelations:\n  depends_on:\n    - \'[[rag]]\''),
  'wiki/isolated.md': PAGE('isolated', '孤立页 neighbors。', '\nrelations:\n  relates_to:\n    - \'[[rag]]\''),
  'wiki/unrelated.md': PAGE('unrelated', '完全无关内容 zzzipsum。', '\nrelations:\n  depends_on:\n    - \'[[island]]\''),
};

function gwFor(reply: string): FakeGateway {
  return new FakeGateway({ defaultReply: reply });
}

const OK_REPLY = JSON.stringify({ answer: '答案 [rag]', citations: ['[rag]'], gaps: [] });

/** 从 prompt 中截取 <tag>...</tag> 段 */
function segment(prompt: string, tag: string): string {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt);
  return m?.[1] ?? '';
}

describe('F12.3 ask 图接线与引用政策', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) {
      await tv.cleanup();
      tv = null;
    }
  });

  it('T12.3-01 gateway 收到的 prompt 含 <graph> 段且含类型边行', async () => {
    tv = await makeVault({ files: FILES });
    await buildIndex(tv.root);
    const gw = gwFor(OK_REPLY);
    await ask('retrieval', { vaultRoot: tv.root, gateway: gw });
    const graph = segment(gw.lastPrompt, 'graph');
    expect(graph).toContain('vector-db --depends_on--> rag');
  });

  it('T12.3-02 无 relations 库 → <graph> 段为空串（标签仍在），行为与 MVP 一致（I12）', async () => {
    tv = await makeVault({
      files: {
        'wiki/plain.md': PAGE('plain', '普通页面内容 plainword。'),
      },
    });
    await buildIndex(tv.root);
    const gw = gwFor(OK_REPLY);
    await ask('plainword', { vaultRoot: tv.root, gateway: gw });
    const prompt = gw.lastPrompt;
    expect(prompt).toContain('<graph>\n\n</graph>');
    expect(prompt).toContain('[[plain]]');
  });

  it('T12.3-03 命中页之外的边不进 <graph>（D5 端到端）', async () => {
    tv = await makeVault({ files: FILES });
    await buildIndex(tv.root);
    const gw = gwFor(OK_REPLY);
    await ask('retrieval', { vaultRoot: tv.root, gateway: gw });
    const graph = segment(gw.lastPrompt, 'graph');
    // unrelated 页未被命中（其边另一端 island 悬空已剪、自身不在命中页）→ 不进子图
    expect(graph).not.toContain('unrelated');
    expect(graph).not.toContain('island');
  });

  it('T12.3-04 守规矩输出（只引用命中页）→ citations 原样保留', async () => {
    tv = await makeVault({ files: FILES });
    await buildIndex(tv.root);
    const gw = gwFor(OK_REPLY);
    const res = await ask('retrieval', { vaultRoot: tv.root, gateway: gw });
    expect(res.citations).toEqual(['[rag]']);
    expect(res.gaps).toEqual([]);
  });

  it('T12.3-05 ask 全链路只触发一次 LLM（synthesize）；图构建零 LLM', async () => {
    tv = await makeVault({ files: FILES });
    await buildIndex(tv.root);
    const gw = gwFor(OK_REPLY);
    await ask('retrieval', { vaultRoot: tv.root, gateway: gw });
    expect(gw.calls).toHaveLength(1);
  });

  it('T12.3-06 对抗性输出（A1/D11）：邻居引用被剥 citations、落 gaps、answer 不改、不抛错', async () => {
    tv = await makeVault({ files: FILES });
    await buildIndex(tv.root);
    // isolated 是 <graph> 中的邻居（rag 的 relates_to 端点），但不在 <pages>（未被检索命中）
    const hostile = JSON.stringify({
      answer: '答案引用了邻居 [isolated] 与命中页 [rag]',
      citations: ['[isolated]', '[rag]'],
      gaps: [],
    });
    const gw = gwFor(hostile);
    const res = await ask('retrieval', { vaultRoot: tv.root, gateway: gw });

    expect(res.citations).toEqual(['[rag]']); // 越界锚点被剥
    expect(res.gaps.some((g) => g.includes('isolated'))).toBe(true); // gaps 说明
    expect(res.answer).toContain('[isolated]'); // answer 文本不被改写
  });

  it('T12.3-07 页图同源（I15）：<graph> 每条边至少一端是 <pages> 提供的页', async () => {
    tv = await makeVault({ files: FILES });
    await buildIndex(tv.root);
    const gw = gwFor(OK_REPLY);
    await ask('retrieval', { vaultRoot: tv.root, gateway: gw });
    const prompt = gw.lastPrompt;
    const pagesSeg = segment(prompt, 'pages');
    const graphSeg = segment(prompt, 'graph');

    const pageSlugs = new Set([...pagesSeg.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!));
    expect(pageSlugs.size).toBeGreaterThan(0);

    const lines = graphSeg.split('\n').filter((l) => l.includes('--'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const m = /^(\S+) --(\S+)-> (\S+)$/.exec(line);
      expect(m).not.toBeNull();
      const [, from, , to] = m!;
      // 每条边至少一端属于 pages 白名单（I15：图覆盖面 ≤ 页上下文 ∪ 邻居）
      expect(pageSlugs.has(from) || pageSlugs.has(to)).toBe(true);
    }
  });

  it('T12.3-08 既有形态校验不破：非法锚点仍硬失败（T5.4-06 语义，CITATION_FORMAT）', async () => {
    tv = await makeVault({ files: FILES });
    await buildIndex(tv.root);
    const gw = gwFor(JSON.stringify({ answer: 'a', citations: ['bad-anchor'], gaps: [] }));
    await expect(ask('retrieval', { vaultRoot: tv.root, gateway: gw })).rejects.toThrowError(/非法引用锚点/);
    await expect(ask('retrieval', { vaultRoot: tv.root, gateway: gw })).rejects.toMatchObject({
      code: 'CITATION_FORMAT',
    });
  });
});
