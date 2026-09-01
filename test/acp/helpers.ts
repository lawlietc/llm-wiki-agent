/**
 * M7 ACP 测试共享 helper。
 *
 * 用 `process.execPath`（跑测试的同一 node）拉起 `fake-acp-agent.mjs` 子进程，
 * 零网络、确定性。返回 provider + 临时标记文件路径，供断言「是否启动 / 初始化几次」等。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import type { ACPProvider } from '../../src/reasoning/acp/registry';

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_SCRIPT = join(here, '..', 'fakes', 'fake-acp-agent.mjs');

export interface FakeAgentFixture {
  provider: ACPProvider;
  scenarioPath: string;
  startedFile: string;
  echoFile: string;
  countFile: string;
  tmp: string;
}

/** 写一个场景 JSON + 构造指向 fake agent 的 provider（含启动/回声/计数标记文件） */
export function makeFakeAgent(scenario: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}): FakeAgentFixture {
  const tmp = mkdtempSync(join(tmpdir(), 'acp-'));
  const scenarioPath = join(tmp, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const startedFile = join(tmp, 'started');
  const echoFile = join(tmp, 'echo-init.json');
  const countFile = join(tmp, 'count');
  const provider: ACPProvider = {
    id: 'fake',
    command: process.execPath,
    args: [AGENT_SCRIPT, scenarioPath],
    env: {
      ACP_STARTED_FILE: startedFile,
      ACP_ECHO_INIT_FILE: echoFile,
      ACP_COUNT_FILE: countFile,
      ...extraEnv,
    },
  };
  return { provider, scenarioPath, startedFile, echoFile, countFile, tmp };
}

/** 清理临时目录与已拉起的子进程（afterEach 调用） */
export function cleanupFakeAgent(f: FakeAgentFixture, child?: ChildProcess): void {
  if (child && child.exitCode == null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(f.tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function isAlive(child: ChildProcess | null | undefined): boolean {
  return !!child && child.exitCode == null && child.signalCode == null;
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
