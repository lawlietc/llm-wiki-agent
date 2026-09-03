/**
 * F6.1 配置加载（I2 密钥安全）+ init 命令（T6.1-01~04）。
 * 零真实网络：env 入参注入，密钥值绝不出现在抛错消息（I2 终验）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { loadConfig, CONFIG_FILE } from '../../src/cli/config';
import { runInit, DEFAULT_CONFIG } from '../../src/cli/init';
import { makeVault, type TempVault } from '../helpers/make-vault';
import { fakeCliIO } from '../../src/cli/io';

const VALID_CONFIG = {
  version: 1,
  chat_model: 'anthropic:claude-x',
  embedding_model: 'openai:emb',
  providers: {
    anthropic: { apiKey: 'env:ANTHROPIC_API_KEY' },
    openai: { apiKey: 'env:OPENAI_API_KEY' },
  },
};

describe('F6.1 config 加载', () => {
  let tv: TempVault | null = null;
  async function fresh(): Promise<TempVault> {
    tv = await makeVault({ initialize: false });
    return tv;
  }
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.1-01 加载合法 .llm-wiki.json（直接密钥）返回解析后的 gateway', async () => {
    const v = await fresh();
    const cfg = { ...VALID_CONFIG, providers: { anthropic: { apiKey: 'sk-direct' } } };
    await v.write(CONFIG_FILE, JSON.stringify(cfg));

    const loaded = loadConfig(v.root, {});
    expect(loaded.gateway).toBeDefined();
    expect(loaded.gateway!.chat_model).toBe('anthropic:claude-x');
    expect(loaded.gateway!.embedding_model).toBe('openai:emb');
    expect(loaded.gateway!.providers.anthropic.apiKey).toBe('sk-direct');
  });

  it('T6.1-02 "env:VAR" 解析为环境变量值；缺失抛 ConfigError 且只暴露变量名、不含密钥值（I2）', async () => {
    const v = await fresh();
    const cfg = { ...VALID_CONFIG, providers: { anthropic: { apiKey: 'env:MY_KEY' } } };
    await v.write(CONFIG_FILE, JSON.stringify(cfg));

    // 缺失 → 报错只提变量名 MY_KEY，绝不含哨兵密钥值 hunter2
    let err: unknown;
    try {
      loadConfig(v.root, { OTHER_SECRET: 'hunter2' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { code?: string; message: string };
    expect(e.code).toBe('MISSING_API_KEY');
    expect(e.message).toContain('MY_KEY');
    expect(e.message).not.toContain('hunter2');

    // 存在 → 解析为值，不抛错（值仅在内存，不进任何消息）
    const loaded = loadConfig(v.root, { MY_KEY: 's3cr3t' });
    expect(loaded.gateway).toBeDefined();
    expect(loaded.gateway!.providers.anthropic.apiKey).toBe('s3cr3t');
  });

  it('T6.1-03 配置文件缺失 → ConfigError CONFIG_READ_FAILED', async () => {
    const v = await fresh();
    let err: unknown;
    try {
      loadConfig(v.root, {});
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('CONFIG_READ_FAILED');
  });

  it('T6.1-04 非法 JSON / 缺 chat_model → ConfigError BAD_CONFIG', async () => {
    const v = await fresh();
    await v.write(CONFIG_FILE, '{ not json');
    let err: unknown;
    try {
      loadConfig(v.root, {});
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('CONFIG_READ_FAILED'); // 解析失败先于字段校验

    const v2 = await fresh();
    await v2.write(CONFIG_FILE, JSON.stringify({ version: 1 }));
    let err2: unknown;
    try {
      loadConfig(v2.root, {});
    } catch (e) {
      err2 = e;
    }
    expect((err2 as { code?: string }).code).toBe('BAD_CONFIG'); // 合法 JSON 但缺字段
  });
});

describe('F6.1 init 命令', () => {
  it('T6.1-01（init）写 .llm-wiki.json + 目录骨架，幂等报错（T6.1-02）', async () => {
    const v = await makeVault({ initialize: false });
    try {
      const io = fakeCliIO();
      const res = await runInit({ vaultRoot: v.root, io });
      expect(existsSync(res.configPath)).toBe(true);
      expect(v.exists('raw')).toBe(true);
      expect(v.exists('wiki')).toBe(true);
      expect(v.exists('.index')).toBe(true);
      expect(v.exists('.vault-meta')).toBe(true);
      // 默认配置是合法可加载的（含 chat_model/embedding_model + env: 引用）
      const written = JSON.parse(readFileSync(res.configPath, 'utf8'));
      expect(written.chat_model).toBe(DEFAULT_CONFIG.chat_model);

      // 重复 init → fail-closed 报错
      let err: unknown;
      try {
        await runInit({ vaultRoot: v.root, io: fakeCliIO() });
      } catch (e) {
        err = e;
      }
      expect((err as { code?: string }).code).toBe('VAULT_ALREADY_INIT');
    } finally {
      await v.cleanup();
    }
  });
});
