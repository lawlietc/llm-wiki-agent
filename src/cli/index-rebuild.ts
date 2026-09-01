/**
 * `wiki index rebuild` 命令（M6 F6.3 / 00 §8.1）。
 *
 * 全量重建 `.index/`（M5-F5.2 buildIndex），完成后清除 dirty 标记（T6.3-06）。
 * 正常情况索引随写入自动刷新，此命令为兜底手动重建。
 */

import { buildIndex } from '../qa/index/bm25';
import type { CliIO } from './io';

export async function runIndexRebuild(
  deps: { vaultRoot: string },
  opts: { io: CliIO },
): Promise<void> {
  await buildIndex(deps.vaultRoot);
  opts.io.out('索引已全量重建。');
}
