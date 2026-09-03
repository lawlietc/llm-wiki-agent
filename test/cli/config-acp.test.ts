/**
 * F8.1 配置解析（T8.1-01~04）：reasoning.agent 段解析为 ACPAgentConfig；
 * enabled 时网关配置可选（ACP 独立可用，落实 T7.5-05）。
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, CONFIG_FILE } from '../../src/cli/config';
import { makeVault } from '../helpers/make-vault';

async function writeConfig(dir: string, config: unknown): Promise<string> {
  const p = path.join(dir, CONFIG_FILE);
  await writeFile(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return p;
}

describe('F8.1 reasoning.agent 配置解析', () => {
  it('T8.1-01 reasoning.agent 全字段解析为 ACPAgentConfig', async () => {
    const tv = await makeVault({
      initialize: true,
      scaffold: false,
      config: {
        version: 1,
        reasoning: {
          agent: {
            enabled: true,
            provider: 'cursor',
            command: 'cursor',
            args: ['--acp'],
            env: { FOO: 'bar' },
            routeDefault: true,
            initializeTimeoutMs: 1234,
          },
        },
      },
    });
    const loaded = loadConfig(tv.root, {} as NodeJS.ProcessEnv);
    expect(loaded.acp).toBeDefined();
    expect(loaded.acp).toMatchObject({
      enabled: true,
      provider: 'cursor',
      command: 'cursor',
      args: ['--acp'],
      env: { FOO: 'bar' },
      routeDefault: true,
      initializeTimeoutMs: 1234,
    });
    // enabled 但无网关字段 → 网关可选，不抛
    expect(loaded.gateway).toBeUndefined();
    await tv.cleanup();
  });

  it('T8.1-02 无 reasoning.agent 段 → acp 为 undefined（网关仍正常解析）', async () => {
    const tv = await makeVault({
      initialize: true,
      scaffold: false,
      config: {
        version: 1,
        chat_model: 'anthropic:claude',
        embedding_model: 'openai:text-embedding-3-small',
        providers: { anthropic: { apiKey: 'env:ANTHROPIC_API_KEY' } },
      },
    });
    const loaded = loadConfig(tv.root, { ANTHROPIC_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(loaded.acp).toBeUndefined();
    expect(loaded.gateway?.chat_model).toBe('anthropic:claude');
    await tv.cleanup();
  });

  it('T8.1-03 enabled=true 且完全无网关字段 → 不抛（ACP-only，T7.5-05）', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'm8-cfg-'));
    await writeConfig(dir, {
      version: 1,
      reasoning: { agent: { enabled: true, provider: 'cursor' } },
    });
    expect(() => loadConfig(dir, {} as NodeJS.ProcessEnv)).not.toThrow();
    const loaded = loadConfig(dir, {} as NodeJS.ProcessEnv);
    expect(loaded.gateway).toBeUndefined();
    expect(loaded.acp?.enabled).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('T8.1-04 enabled=false（且无其它实质字段）→ 网关字段缺失仍抛 BAD_CONFIG', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'm8-cfg-'));
    await writeConfig(dir, {
      version: 1,
      reasoning: { agent: { enabled: false } },
    });
    expect(() => loadConfig(dir, {} as NodeJS.ProcessEnv)).toThrow(/chat_model 必填/);
    await rm(dir, { recursive: true, force: true });
  });

  it('T8.1-05 网关字段存在但 env 缺失 → 仍抛 MISSING_API_KEY（回归：网关模式不变）', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'm8-cfg-'));
    await writeConfig(dir, {
      version: 1,
      chat_model: 'anthropic:claude',
      embedding_model: 'openai:text-embedding-3-small',
      providers: { anthropic: { apiKey: 'env:ANTHROPIC_API_KEY' } },
    });
    expect(() => loadConfig(dir, {} as NodeJS.ProcessEnv)).toThrow(/环境变量 ANTHROPIC_API_KEY/);
    await rm(dir, { recursive: true, force: true });
  });
});
