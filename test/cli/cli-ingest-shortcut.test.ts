/**
 * F14.4 CLI 短路提示单测（T14.4-01/02）。
 * 短路场景输出「内容未变更」提示 + plan 只含 raw；approve 拒绝零写入。
 * 零真实网络、零真实 LLM。
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runIngest } from '../../src/cli/ingest';
import { createVault } from '../../src/vault/vault';
import { fakeCliIO, type FakeCliIO } from '../../src/cli/io';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';
import { FakeGateway } from '../../test/fakes/fake-gateway';

const BODY = 'CLI 短路提示验证内容 shortcutword。\n';

const WIKI_PAGE = `---
type: project
date: 2026-09-05
ai-first: true
confidence: high
slug: cli-shortcut-topic
---

## For future agent

整理自外部原文。
`;

describe('F14.4 CLI ingest 短路提示', () => {
  let tmpDir: string | null = null;
  let tv: TempVault | null = null;

  const makeFile = async (): Promise<string> => {
    if (!tmpDir) tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm14-cli-'));
    const f = path.join(tmpDir, `cli-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    await writeFile(f, BODY, 'utf8');
    return f;
  };

  afterEach(async () => {
    if (tv) {
      await tv.cleanup();
      tv = null;
    }
  });
  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('T14.4-01 短路场景：输出「内容未变更」提示 + changedPaths 仅 raw', async () => {
    tv = await makeVault();
    const file = await makeFile();
    const gw = new FakeGateway({ defaultReply: WIKI_PAGE }); // 首次抽取降级也不影响

    const io1: FakeCliIO = fakeCliIO();
    await runIngest(file, { vault: createVault(tv.root), gateway: gw }, { io: io1, autoApprove: true });
    const callsAfterFirst = gw.calls.length;

    const io2: FakeCliIO = fakeCliIO();
    const res = await runIngest(file, { vault: createVault(tv.root), gateway: gw }, { io: io2, autoApprove: true });

    expect(gw.calls.length).toBe(callsAfterFirst); // LLM 零新增
    expect(io2.outLines.some((l) => l.includes('内容未变更'))).toBe(true);
    expect(res!.changedPaths).toHaveLength(1);
    expect(res!.changedPaths[0]!.startsWith('raw/')).toBe(true);
    void io1;
  });

  it('T14.4-02 短路场景 approve 拒绝 → 零写入（I3 延续）', async () => {
    tv = await makeVault();
    const file = await makeFile();
    const gw = new FakeGateway({ defaultReply: WIKI_PAGE });
    const io1: FakeCliIO = fakeCliIO();
    await runIngest(file, { vault: createVault(tv.root), gateway: gw }, { io: io1, autoApprove: true });

    const io2: FakeCliIO = fakeCliIO(); // 非交互 → 拒绝路径（NON_INTERACTIVE）
    await expect(
      runIngest(file, { vault: createVault(tv.root), gateway: gw }, { io: io2, autoApprove: false }),
    ).rejects.toThrowError(/非交互环境/);

    // 用 TTY + 'n' 应答验证真正拒绝
    const io3 = fakeCliIO({ isTTY: true, answers: ['n'] });
    const res = await runIngest(file, { vault: createVault(tv.root), gateway: gw }, { io: io3, autoApprove: false });
    expect(res).toBeNull();
    const raws = (await readdir(path.join(tv.root, 'raw'))).filter((f) => f.endsWith('.md'));
    expect(raws).toHaveLength(1); // 仍是首次那条，无新写入
  });
});
