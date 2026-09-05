/**
 * `wiki ingest` 命令（M6 F6.2 / 00 §8.1）。
 *
 * 走 M4 ingest 管线；**CLI 层负责 dry-run→approve 暂停**（展示 changedPaths，确认后回传
 * approvedPlanSha256）。不变量 I1：暂停与确认只在 CLI 层，Vault/ingest 编排只算 plan 与
 * 校验哈希。非交互环境（非 TTY）且无 --yes → 拒绝（必须显式 --yes 才能跳过确认）。
 */

import { ConfigError } from '../errors';
import { ingest } from '../ingest/ingest';
import type { ReasoningBackend } from '../reasoning/backend';
import type { Vault } from '../vault/vault';
import { formatChangedPaths } from './format';
import type { CliIO } from './io';

export interface IngestDeps {
  vault: Vault;
  gateway: ReasoningBackend;
}

export interface IngestCommandOpts {
  io: CliIO;
  /** --yes 非交互模式：跳过暂停直接 approve（CI/脚本用） */
  autoApprove?: boolean;
}

export interface IngestResult {
  changedPaths: string[];
}

/**
 * 执行一次 ingest。approve 拒绝返回 null（零写入）。
 * @throws 上游错误（含 apply 阶段的 PLAN_CHANGED 等）直接上抛，由 run.ts 统一归一化
 */
export async function runIngest(
  input: string,
  deps: IngestDeps,
  opts: IngestCommandOpts,
): Promise<IngestResult | null> {
  const result = await ingest(input, deps, {
    io: opts.io,
    // M14：内容短路命中 → approve 前提示（plan 只含 raw 元数据刷新）
    onSkip: () => opts.io.out('内容未变更：跳过 LLM 整理与实体抽取（仅刷新 raw 元数据）'),
    approve: async ({ preview }) => {
      opts.io.out(formatChangedPaths(preview.changedPaths));
      if (opts.autoApprove) return true;
      if (!opts.io.isTTY) {
        throw new ConfigError(
          'NON_INTERACTIVE',
          '非交互环境无法确认变更，请加 --yes 以自动批准',
        );
      }
      return opts.io.confirm('确认写入以上变更？(y/N) ');
    },
  });

  if (!result) {
    opts.io.out('已取消，未写入任何文件。');
    return null;
  }

  opts.io.out(`已写入 ${result.changedPaths.length} 个文件：${result.changedPaths.join(', ')}`);
  return { changedPaths: result.changedPaths };
}
