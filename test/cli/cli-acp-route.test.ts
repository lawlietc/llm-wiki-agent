/**
 * F8.2 `--agent` 路由到 ACP 腿（T8.2-01~04）。
 * 零真实网络：用 test/fakes/fake-acp-agent.mjs 当本地 agent 子进程，证明 CLI 真把
 * 推理后端换成了 ACPAgentBackend（而非网关腿）。ACP_COUNT_FILE 证明子进程被 spawn。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';

import { runCli } from '../../src/cli/run';
import { makeVault, type TempVault } from '../helpers/make-vault';
import { fakeCliIO } from '../../src/cli/io';
import { COMPLIANT_A } from './fixtures';

const FAKE_AGENT = fileURLToPath(new URL('../fakes/fake-acp-agent.mjs', import.meta.url));
const MARKER = 'ACP_ROUTED_MARKER_123';

/** ask 综合层期望的 JSON 回稿（含 MARKER，便于断言 ACP 腿被使用） */
const ASK_PROMPT = JSON.stringify({
  answer: `${MARKER} [seed]`,
  citations: ['[seed]'],
  gaps: ['暂无'],
});

/** 写一份 ACP-only（无网关字段）的配置文件，指向 fake agent；promptText 控制其回稿 */
async function writeAcpConfig(
  tv: TempVault,
  opts: { routeDefault?: boolean; promptText?: string } = {},
): Promise<void> {
  const scenario = { promptText: opts.promptText ?? ASK_PROMPT };
  await tv.write('.acp-scenario.json', JSON.stringify(scenario));
  const config = {
    version: 1,
    reasoning: {
      agent: {
        enabled: true,
        provider: 'cursor',
        command: process.execPath,
        args: [FAKE_AGENT, tv.abs('.acp-scenario.json')],
        env: { ACP_COUNT_FILE: tv.abs('.acp-count') },
        initializeTimeoutMs: 5000,
        ...(opts.routeDefault ? { routeDefault: true } : {}),
      },
    },
  };
  await tv.write('.llm-wiki.json', JSON.stringify(config, null, 2) + '\n');
}

describe('F8.2 --agent 路由到 ACP 腿', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T8.2-01 ask --agent cursor 走 ACP 腿，输出含 fake agent 回稿（子进程被 spawn）', async () => {
    tv = await makeVault({ initialize: false, scaffold: true });
    await writeAcpConfig(tv);

    const io = fakeCliIO();
    const rc = await runCli(['ask', '法国的首都是哪里？', '--agent', 'cursor'], {
      cwd: tv.root,
      env: {} as NodeJS.ProcessEnv,
      io,
    });
    expect(rc).toBe(0);
    expect(io.outLines.join('\n')).toContain(MARKER);
    // 子进程确实被拉起并完成一次 initialize（lazy connect）
    expect(tv.exists('.acp-count')).toBe(true);
    expect((await tv.read('.acp-count')).trim()).toBe('1');
  });

  it('T8.2-02 无 --agent 且 routeDefault=false → 默认走网关腿，网关未配置则报错退出 1', async () => {
    tv = await makeVault({ initialize: false, scaffold: true });
    await writeAcpConfig(tv); // routeDefault 默认 false

    const io = fakeCliIO();
    const rc = await runCli(['ask', '法国的首都是哪里？'], {
      cwd: tv.root,
      env: {} as NodeJS.ProcessEnv,
      io,
    });
    expect(rc).toBe(1);
    expect(io.errLines.join('\n')).toContain('Call configureGateway');
    // 证明并未 spawn ACP 子进程（默认腿是网关）
    expect(tv.exists('.acp-count')).toBe(false);
  });

  it('T8.2-03 配置 routeDefault=true 时，无 --agent 也走 ACP 腿（默认路由）', async () => {
    tv = await makeVault({ initialize: false, scaffold: true });
    await writeAcpConfig(tv, { routeDefault: true });

    const io = fakeCliIO();
    const rc = await runCli(['ask', '法国的首都是哪里？'], {
      cwd: tv.root,
      env: {} as NodeJS.ProcessEnv,
      io,
    });
    expect(rc).toBe(0);
    expect(io.outLines.join('\n')).toContain(MARKER);
  });

  it('T8.2-04 ingest --agent cursor 把 raw 交给 ACP 腿总结（ingest/ask/edit 统一路由）', async () => {
    tv = await makeVault({ initialize: false, scaffold: true });
    await writeAcpConfig(tv, { promptText: COMPLIANT_A });
    const rawFile = await tv.write('raw/alpha.txt', 'Alpha 主题原文。\n');

    const io = fakeCliIO();
    const rc = await runCli(['ingest', rawFile, '--yes', '--agent', 'cursor'], {
      cwd: tv.root,
      env: {} as NodeJS.ProcessEnv,
      io,
    });
    expect(rc).toBe(0);
    // ingest 经 ACP 腿总结，wiki 页被写出
    const pages = await readdir(tv.abs('wiki'));
    expect(pages.some((f) => f.endsWith('.md'))).toBe(true);
    // 子进程被 spawn（证明 ingest 也走了 ACP 腿，而非网关）
    expect(tv.exists('.acp-count')).toBe(true);
  });
});
