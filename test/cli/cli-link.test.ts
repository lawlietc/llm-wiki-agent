/**
 * F11.3 `wiki link` 命令单测（T11.4-x）：报告输出 / exit code / --fix 建 stub / 索引落盘。
 */
import { describe, it, expect, afterEach } from 'vitest';

import { runCli } from '../../src/cli/run';
import { fakeCliIO } from '../../src/cli/io';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';

const PAGE = (slug: string, body: string, extra = ''): string =>
  `---\ntype: idea\ndate: 2026-09-04\nai-first: true\nconfidence: high\nslug: ${slug}${extra}\n---\n\n## For future agent\n\n测试页。\n\n## 正文\n\n${body}\n`;

const ENV = {};

describe('F11.3 wiki link 命令', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) {
      await tv.cleanup();
      tv = null;
    }
  });

  it('T11.4-01 无问题 vault：报告 + exit 0 + 索引落盘', async () => {
    tv = await makeVault({
      files: { 'wiki/a.md': PAGE('a', '见 [[b]]。'), 'wiki/b.md': PAGE('b', '内容。') },
    });
    const io = fakeCliIO();
    const code = await runCli(['link', '--vault', tv.root], { cwd: tv.root, env: ENV, io, vaultRoot: tv.root });
    expect(code).toBe(0);
    expect(io.outLines.join('\n')).toContain('死链（普通 wikilink 目标不存在）：0');
    expect(io.outLines.join('\n')).toContain('反链索引已写入');
    expect(tv.exists('.vault-meta/links.json')).toBe(true);
  });

  it('T11.4-02 有死链/悬空类型边：exit 1，报告列出明细', async () => {
    tv = await makeVault({
      files: {
        'wiki/a.md': PAGE('a', '见 [[缺失]]。'),
        'wiki/b.md': PAGE('b', '内容。', `\nrelations:\n  supersedes:\n    - '[[nowhere]]'`),
      },
    });
    const io = fakeCliIO();
    const code = await runCli(['link', '--vault', tv.root], { cwd: tv.root, env: ENV, io, vaultRoot: tv.root });
    expect(code).toBe(1);
    const out = io.outLines.join('\n');
    expect(out).toContain('wiki/a.md → [[缺失]]');
    expect(out).toContain('--supersedes--> [[nowhere]]');
  });

  it('T11.4-03 --fix：建占位词条、fix 后 exit 0（无悬空类型边场景）', async () => {
    tv = await makeVault({
      files: { 'wiki/a.md': PAGE('a', '见 [[Missing Page]]。') },
    });
    const io = fakeCliIO();
    const code = await runCli(['link', '--vault', tv.root, '--fix'], { cwd: tv.root, env: ENV, io, vaultRoot: tv.root });
    expect(code).toBe(0);
    expect(tv.exists('wiki/concepts/missing-page.md')).toBe(true);
    const out = io.outLines.join('\n');
    expect(out).toContain('新建占位词条 1 个');
    expect(out).toContain('fix 后重扫：死链 0');
  });

  it('T11.4-04 --fix 不解悬空类型边 → fix 后仍 exit 1', async () => {
    tv = await makeVault({
      files: { 'wiki/b.md': PAGE('b', '内容。', `\nrelations:\n  supersedes:\n    - '[[nowhere]]'`) },
    });
    const io = fakeCliIO();
    const code = await runCli(['link', '--vault', tv.root, '--fix'], { cwd: tv.root, env: ENV, io, vaultRoot: tv.root });
    expect(code).toBe(1);
  });
});
