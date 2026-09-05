/**
 * F12.4 CLI 端到端（T12.4-01）：wiki ask 三段输出在含 relations 的 vault 上不变。
 * 零真实网络、零真实 LLM。
 */
import { describe, it, expect, afterEach } from 'vitest';

import { runAsk } from '../../src/cli/ask';
import { buildIndex } from '../../src/qa/index/bm25';
import { fakeCliIO } from '../../src/cli/io';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';
import { FakeGateway } from '../../test/fakes/fake-gateway';

const PAGE = (slug: string, body: string, extra = ''): string =>
  `---\ntype: idea\ndate: 2026-09-05\nai-first: true\nconfidence: high\nslug: ${slug}${extra}\n---\n\n## For future agent\n\n${body}\n`;

const FILES = {
  'wiki/concepts/rag.md': PAGE('rag', 'RAG 是检索增强生成 retrieval 核心概念。'),
  'wiki/concepts/vector-db.md': PAGE('vector-db', '向量数据库存储高维向量 retrieval。', '\nrelations:\n  depends_on:\n    - \'[[rag]]\''),
};

const REPLY = JSON.stringify({ answer: '答案正文 [rag]', citations: ['[rag]'], gaps: ['缺一点'] });

describe('F12.4 wiki ask CLI 端到端', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) {
      await tv.cleanup();
      tv = null;
    }
  });

  it('T12.4-01 含 relations 的 vault：CLI 输出仍为 答案/引用/待补充 三段，图消费不改格式', async () => {
    tv = await makeVault({ files: FILES });
    await buildIndex(tv.root);
    const io = fakeCliIO();
    await runAsk('retrieval', { vaultRoot: tv.root, gateway: new FakeGateway({ defaultReply: REPLY }) }, { io });
    const out = io.outLines.join('\n');
    expect(out).toContain('答案：');
    expect(out).toContain('引用：');
    expect(out).toContain('待补充（gaps）：');
    expect(out).toContain('缺一点');
  });
});
