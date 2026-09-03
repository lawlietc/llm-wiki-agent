/**
 * `wiki init` 命令（M6 F6.1 / 00 §8.1）。
 *
 * 在指定目录写 `.llm-wiki.json` + 目录骨架（raw/ wiki/ .index/ .vault-meta/）；
 * 已初始化则 fail-closed 报错（T6.1-02）。vault 根的 fail-closed 校验由 run.ts 的
 * resolveVaultRoot 在进入本命令前完成（00 §8.1「过 01 的 fail-closed 校验」）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ConfigError } from '../errors';
import { CONFIG_FILE } from './config';
import type { CliIO } from './io';

/** init 写入的最小可用配置模板（密钥走 env: 间接引用，明文值不落盘 I2） */
export const DEFAULT_CONFIG = {
  version: 1,
  chat_model: 'anthropic:claude-opus-4-20250514',
  embedding_model: 'openai:text-embedding-3-small',
  providers: {
    anthropic: { apiKey: 'env:ANTHROPIC_API_KEY' },
    openai: { apiKey: 'env:OPENAI_API_KEY' },
  },
  // ACP 本地 agent 腿开关（M8）：默认关闭，开启后配 provider/command/args 即可走本地 agent
  reasoning: {
    agent: { enabled: false },
  },
};

const SCAFFOLD_DIRS = ['raw', 'wiki', '.index', '.vault-meta'];

export interface InitResult {
  configPath: string;
}

/**
 * 初始化 vault。
 * @param opts.vaultRoot 已通过 fail-closed 校验的 vault 根
 * @param opts.config 可选自定义配置（测试/特殊场景覆盖默认模板）
 */
export async function runInit(opts: {
  vaultRoot: string;
  io: CliIO;
  config?: unknown;
}): Promise<InitResult> {
  const root = opts.vaultRoot;
  const cfgPath = path.join(root, CONFIG_FILE);

  if (existsSync(cfgPath)) {
    // T6.1-02：重复 init 报错提示已初始化（幂等或明确报错 → 定案报错）
    throw new ConfigError('VAULT_ALREADY_INIT', `目录已初始化为 vault（存在 ${CONFIG_FILE}）：${root}`);
  }

  const config = opts.config ?? DEFAULT_CONFIG;
  for (const dir of SCAFFOLD_DIRS) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  opts.io.out(`已初始化 vault：${root}`);
  opts.io.out(`配置写入：${cfgPath}`);
  return { configPath: cfgPath };
}
