/**
 * F6.2 ingest 命令 + approve 交互（I1）+ ask 三段输出（T6.2-01~06）。
 * 零真实 LLM/网络：FILE_ADAPTER 读本地文件 + FakeGateway 注入合规回稿。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runIngest } from '../../src/cli/ingest';
import { runAsk } from '../../src/cli/ask';
import { createVault } from '../../src/vault/vault';
import { makeVault, type TempVault } from '../helpers/make-vault';
import { fakeCliIO } from '../../src/cli/io';
import { FakeGateway } from '../fakes/fake-gateway';
import { COMPLIANT, ASK_JSON } from './fixtures';

let tmpDir: string;
let articlePath: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm6-ingest-'));
  articlePath = path.join(tmpDir, 'article.txt');
  await writeFile(articlePath, '原始正文第一句。\n第二句。\n', 'utf8');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('F6.2 ingest + approve', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.2-01 approve 确认(y) → raw+wiki 同事务落盘，返回 2 个变更路径', async () => {
    tv = await makeVault();
    const gw = new FakeGateway({ defaultReply: COMPLIANT });
    const io = fakeCliIO({ isTTY: true, answers: ['y'] });

    const res = await runIngest(articlePath, { vault: createVault(tv.root), gateway: gw }, { io });
    expect(res).not.toBeNull();
    expect(res!.changedPaths).toContain('wiki/vector-db.md');
    expect(res!.changedPaths.some((p) => p.startsWith('raw/'))).toBe(true);
    expect(tv!.exists('wiki/vector-db.md')).toBe(true);
  });

  it('T6.2-02 approve 拒绝(n) → 返回 null，零写入（I3）', async () => {
    tv = await makeVault();
    const gw = new FakeGateway({ defaultReply: COMPLIANT });
    const io = fakeCliIO({ isTTY: true, answers: ['n'] });

    const res = await runIngest(articlePath, { vault: createVault(tv.root), gateway: gw }, { io });
    expect(res).toBeNull();
    expect(tv!.exists('wiki/vector-db.md')).toBe(false);
    expect(tv!.exists('raw')).toBe(true); // 目录在，但无 .md
  });

  it('T6.2-03 非交互环境且未加 --yes → 抛 ConfigError NON_INTERACTIVE', async () => {
    tv = await makeVault();
    const gw = new FakeGateway({ defaultReply: COMPLIANT });
    const io = fakeCliIO({ isTTY: false }); // 非 TTY

    let err: unknown;
    try {
      await runIngest(articlePath, { vault: createVault(tv.root), gateway: gw }, { io });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('NON_INTERACTIVE');
    expect(tv!.exists('wiki/vector-db.md')).toBe(false);
  });

  it('T6.2-04 --yes 非交互自动批准 → 落盘且未走 confirm', async () => {
    tv = await makeVault();
    const gw = new FakeGateway({ defaultReply: COMPLIANT });
    const io = fakeCliIO({ isTTY: false, answers: [] }); // 不消费任何 confirm

    const res = await runIngest(
      articlePath,
      { vault: createVault(tv.root), gateway: gw },
      { io, autoApprove: true },
    );
    expect(res).not.toBeNull();
    expect(tv!.exists('wiki/vector-db.md')).toBe(true);
    expect(io.outLines.join('\n')).not.toContain('确认写入'); // 未触发交互提示
  });

  it('T6.2-05 Windows 风格反斜杠路径 ingest 同样落盘（win32 自然覆盖）', async () => {
    tv = await makeVault();
    const gw = new FakeGateway({ defaultReply: COMPLIANT });
    const io = fakeCliIO({ isTTY: true, answers: ['y'] });
    const winPath = articlePath.split('/').join('\\');

    const res = await runIngest(winPath, { vault: createVault(tv.root), gateway: gw }, { io });
    expect(res).not.toBeNull();
    expect(tv!.exists('wiki/vector-db.md')).toBe(true);
  });
});

describe('F6.2 ask 三段输出', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.2-05/06 ask 输出 答案/引用/待补充(gaps) 三段；gaps 提示补充来源', async () => {
    tv = await makeVault();
    // 先 ingest 一页（建立索引前提）
    await runIngest(
      articlePath,
      { vault: createVault(tv.root), gateway: new FakeGateway({ defaultReply: COMPLIANT }) },
      { io: fakeCliIO({ isTTY: true, answers: ['y'] }) },
    );

    const io = fakeCliIO({ isTTY: false });
    const result = await runAsk('法国的首都是哪里？', { vaultRoot: tv.root, gateway: new FakeGateway({ defaultReply: ASK_JSON }) }, { io });

    const out = io.outLines.join('\n');
    expect(out).toContain('答案：');
    expect(out).toContain('引用：');
    expect(out).toContain('待补充（gaps）：');
    expect(out).toContain('需要人口数据'); // gaps 内容
    expect(result.answer).toContain('巴黎');
    expect(result.citations.some((c) => c.includes('alpha-topic') || c.includes('vector-db'))).toBe(true);
  });
});
