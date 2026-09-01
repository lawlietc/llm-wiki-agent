/**
 * `wiki status` 命令（M6 F6.3 / 00 §8.1）。
 *
 * 输出 vault 根/来源、wiki 页数、索引 dirty 与否、provider 列表（T6.3-05）。
 * dirty 标记读 `.index/bm25/.dirty` 存在性（M6 §4 实现指引）。
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { DIRTY_MARKER_REL } from '../vault/transaction';
import type { LoadedConfig } from './config';
import { formatStatus, type StatusInfo } from './format';
import type { CliIO } from './io';

export interface StatusDeps {
  vaultRoot: string;
  /** resolveVaultRoot 返回的 source（explicit/env/workspace/cwd） */
  source: string;
  config: LoadedConfig;
}

export async function runStatus(
  deps: StatusDeps,
  opts: { io: CliIO },
): Promise<StatusInfo> {
  const wikiDir = path.join(deps.vaultRoot, 'wiki');
  let pages = 0;
  try {
    const entries = await readdir(wikiDir);
    pages = entries.filter((f) => f.endsWith('.md')).length;
  } catch {
    pages = 0;
  }

  const dirty = existsSync(path.join(deps.vaultRoot, DIRTY_MARKER_REL));
  const providers = Object.keys(deps.config.gateway.providers);

  const info: StatusInfo = {
    root: deps.vaultRoot,
    source: deps.source,
    pages,
    dirty,
    providers,
  };
  opts.io.out(formatStatus(info));
  return info;
}
