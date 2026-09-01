/**
 * F6.4 runCli 调度 + 端到端链路（T6.4-01~04）。
 * 进程边界与测试共用同一条 runCli 分发路径；gateway/env/vaultRoot 全部注入，零真实网络。
 *
 * T6.4-04（win32 自然覆盖）由 cli-ingest-ask.test.ts 的 F6.2-05（反斜杠路径）覆盖，此处补用法分支。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../../src/cli/run';
import { makeVault, type TempVault } from '../helpers/make-vault';
import { fakeCliIO } from '../../src/cli/io';
import { FakeGateway } from '../fakes/fake-gateway';
import { COMPLIANT_A, COMPLIANT_B, COMPLIANT, ASK_JSON } from './fixtures';

let tmpDir: string;
let fileAlpha: string;
let fileBeta: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm6-run-'));
  fileAlpha = path.join(tmpDir, 'alpha.txt');
  fileBeta = path.join(tmpDir, 'beta.txt');
  await writeFile(fileAlpha, 'Alpha 主题原文。\n', 'utf8');
  await writeFile(fileBeta, 'Beta 主题原文。\n', 'utf8');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

const ENV = { ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' } as NodeJS.ProcessEnv;
const INGEST_GW = () => new FakeGateway({ replies: new Map([['Alpha', COMPLIANT_A], ['Beta', COMPLIANT_B]]), defaultReply: COMPLIANT });

describe('F6.4 runCli 主链路', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.4-01 init → ingest file → ingest file → ask → status（页数=2）', async () => {
    tv = await makeVault({ initialize: false });

    // init
    const ioInit = fakeCliIO();
    expect(await runCli(['init'], { cwd: tv.root, env: ENV, io: ioInit })).toBe(0);
    expect(tv.exists('.llm-wiki.json')).toBe(true);

    // 两次 ingest（各自不同 slug，--yes 自动批准）
    const ioIngest = fakeCliIO();
    expect(await runCli(['ingest', fileAlpha, '--yes'], { cwd: tv.root, env: ENV, io: ioIngest, gateway: INGEST_GW(), vaultRoot: tv.root })).toBe(0);
    expect(await runCli(['ingest', fileBeta, '--yes'], { cwd: tv.root, env: ENV, io: ioIngest, gateway: INGEST_GW(), vaultRoot: tv.root })).toBe(0);
    expect(tv.exists('wiki/alpha-topic.md')).toBe(true);
    expect(tv.exists('wiki/beta-topic.md')).toBe(true);

    // ask（三段输出）
    const ioAsk = fakeCliIO();
    expect(await runCli(['ask', '法国的首都是哪里？'], { cwd: tv.root, env: ENV, io: ioAsk, gateway: new FakeGateway({ defaultReply: ASK_JSON }), vaultRoot: tv.root })).toBe(0);
    expect(ioAsk.outLines.join('\n')).toContain('答案：');

    // status（页数=2）
    const ioStatus = fakeCliIO();
    expect(await runCli(['status'], { cwd: tv.root, env: ENV, io: ioStatus, gateway: INGEST_GW(), vaultRoot: tv.root })).toBe(0);
    expect(ioStatus.outLines.join('\n')).toContain('wiki 页数: 2');
  });
});

describe('F6.4 崩溃恢复', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.4-02 预处理态 journal 在下次写入时被回滚（rolled-back），新事务正常提交', async () => {
    tv = await makeVault();
    // 预置一个 prepared（未完成）的 journal，模拟上次崩溃
    await tv.write('.vault-meta/journal/recover-op/state.json', JSON.stringify({ phase: 'prepared', bundleSha256: 'deadbeef' }));
    await tv.write('.vault-meta/journal/recover-op/backups/0/meta.json', JSON.stringify({ relativePath: 'wiki/ghost.md', existed: false }));

    const io = fakeCliIO();
    expect(await runCli(['ingest', fileAlpha, '--yes'], { cwd: tv.root, env: ENV, io, gateway: INGEST_GW(), vaultRoot: tv.root })).toBe(0);

    // 新事务落盘成功
    expect(tv.exists('wiki/alpha-topic.md')).toBe(true);
    // 旧 prepared journal 被回滚标记
    const state = JSON.parse(await tv.read('.vault-meta/journal/recover-op/state.json'));
    expect(state.phase).toBe('rolled-back');
  });
});

describe('F6.4 edit → ask 检索闭环', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.4-03 ingest → edit（--yes）→ ask 端到端无异常，status 页数=1', async () => {
    tv = await makeVault({ initialize: false });
    await runCli(['init'], { cwd: tv.root, env: ENV, io: fakeCliIO() });
    await runCli(['ingest', fileAlpha, '--yes'], { cwd: tv.root, env: ENV, io: fakeCliIO(), gateway: INGEST_GW(), vaultRoot: tv.root });

    const ioEdit = fakeCliIO();
    expect(await runCli(['edit', 'alpha-topic', '--yes'], { cwd: tv.root, env: ENV, io: ioEdit, gateway: new FakeGateway({ defaultReply: COMPLIANT }), vaultRoot: tv.root })).toBe(0);
    expect((await tv.read('wiki/alpha-topic.md')).includes('向量数据库用于存储高维向量')).toBe(true);

    const ioAsk = fakeCliIO();
    expect(await runCli(['ask', '高维向量用于什么？'], { cwd: tv.root, env: ENV, io: ioAsk, gateway: new FakeGateway({ defaultReply: ASK_JSON }), vaultRoot: tv.root })).toBe(0);
    expect(ioAsk.outLines.join('\n')).toContain('答案：');

    const ioStatus = fakeCliIO();
    await runCli(['status'], { cwd: tv.root, env: ENV, io: ioStatus, gateway: INGEST_GW(), vaultRoot: tv.root });
    expect(ioStatus.outLines.join('\n')).toContain('wiki 页数: 1');
  });
});

describe('F6.4 用法分支', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.4-04 无参数/未知命令/ask 空问题 → 退出码 2（用法错误）', async () => {
    tv = await makeVault({ initialize: false });
    await runCli(['init'], { cwd: tv.root, env: ENV, io: fakeCliIO() });

    const io1 = fakeCliIO();
    expect(await runCli([], { cwd: tv.root, env: ENV, io: io1, gateway: INGEST_GW(), vaultRoot: tv.root })).toBe(2);

    const io2 = fakeCliIO();
    expect(await runCli(['bogus'], { cwd: tv.root, env: ENV, io: io2, gateway: INGEST_GW(), vaultRoot: tv.root })).toBe(2);

    const io3 = fakeCliIO();
    expect(await runCli(['ask', ''], { cwd: tv.root, env: ENV, io: io3, gateway: INGEST_GW(), vaultRoot: tv.root })).toBe(2);
  });
});

describe('F6.4 经 cwd 解析路由（不注入 vaultRoot，覆盖 resolveVaultRoot 兜底分支）', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.4-01b lint/index/ingest/ask/edit/status 全部经 cwd 找到 vault（兜底分支）', async () => {
    tv = await makeVault({ initialize: false });
    await runCli(['init'], { cwd: tv.root, env: ENV, io: fakeCliIO() });

    // lint 经 cwd（runLint 用 cwd 解析相对文件）
    await tv.write('wiki/clean.md', COMPLIANT);
    const ioLint = fakeCliIO();
    expect(await runCli(['lint', 'wiki/clean.md'], { cwd: tv.root, env: ENV, io: ioLint, gateway: INGEST_GW() })).toBe(0);

    // index rebuild 经 cwd
    const ioIdx = fakeCliIO();
    expect(await runCli(['index', 'rebuild'], { cwd: tv.root, env: ENV, io: ioIdx, gateway: INGEST_GW() })).toBe(0);

    // ingest 经 cwd
    expect(await runCli(['ingest', fileAlpha, '--yes'], { cwd: tv.root, env: ENV, io: fakeCliIO(), gateway: INGEST_GW() })).toBe(0);
    expect(tv.exists('wiki/alpha-topic.md')).toBe(true);

    // ask 经 cwd
    const ioAsk = fakeCliIO();
    expect(await runCli(['ask', '高维向量用于什么？'], { cwd: tv.root, env: ENV, io: ioAsk, gateway: new FakeGateway({ defaultReply: ASK_JSON }) })).toBe(0);
    expect(ioAsk.outLines.join('\n')).toContain('答案：');

    // edit 经 cwd
    const ioEdit = fakeCliIO();
    expect(await runCli(['edit', 'alpha-topic', '--yes'], { cwd: tv.root, env: ENV, io: ioEdit, gateway: new FakeGateway({ defaultReply: COMPLIANT }) })).toBe(0);

    // status 经 cwd
    const ioStatus = fakeCliIO();
    expect(await runCli(['status'], { cwd: tv.root, env: ENV, io: ioStatus, gateway: INGEST_GW() })).toBe(0);
    expect(ioStatus.outLines.join('\n')).toContain('wiki 页数: 2');
  });
});
