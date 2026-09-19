/**
 * `wiki retract <source>` 命令（M20 工单 07）。
 *
 * **零 LLM**：回收判据全在 frontmatter 的 `source_refs` 集合与 `## 事实` 段的分源块上——
 * 不构建推理后端，也就没有任何 token 成本（`--plan` 因此可以给出「预计回收」计数）。
 *
 * 审批粒度同 ingest：先展示预演（`--plan` 到此为止，零写入），TTY 下确认后走事务落盘；
 * 非 TTY 且无 `--yes` → NON_INTERACTIVE（不新开后门）；no-op 不弹确认框。
 */

import { ConfigError } from '../errors';
import {
  formatRetractPlan,
  formatRetractReport,
  planRetraction,
  retract,
  type RetractPlan,
  type RetractResult,
} from '../ingest/retract';
import type { Vault } from '../vault/vault';
import type { CliIO } from './io';

export interface RetractDeps {
  vault: Vault;
}

export interface RetractCommandOpts {
  io: CliIO;
  /** --yes 非交互模式：跳过暂停直接批准 */
  autoApprove?: boolean;
  /** --plan：只读预演，零写入零 LLM */
  planOnly?: boolean;
  /** --json：机器可读输出（不含整页正文，只给计数与路径） */
  json?: boolean;
}

/** JSON 输出去掉 `writes`（那是整页正文，塞进报告既冗长又容易被误当改动源） */
function toJson(plan: RetractPlan, changedPaths?: string[]): string {
  const { writes: _writes, ...rest } = plan;
  return JSON.stringify(changedPaths === undefined ? rest : { ...rest, changedPaths }, null, 2);
}

/**
 * 执行回收。approve 拒绝返回 null（零写入）；`--plan` 返回 null（零写入）；
 * 无孤儿事实返回 `{ plan, changedPaths: [] }`。
 */
export async function runRetract(
  source: string,
  deps: RetractDeps,
  opts: RetractCommandOpts,
): Promise<RetractResult | null> {
  const io = opts.io;

  if (opts.planOnly) {
    const plan = await planRetraction(source, deps);
    io.out(opts.json ? toJson(plan) : formatRetractPlan(plan));
    return null;
  }

  const result = await retract(source, deps, {
    approve: async ({ plan }) => {
      if (!opts.json) io.out(formatRetractPlan(plan));
      if (opts.autoApprove) return true;
      if (!io.isTTY) {
        throw new ConfigError('NON_INTERACTIVE', '非交互环境无法确认变更，请加 --yes 以自动批准');
      }
      return io.confirm(`确认回收以上 ${plan.retracted} 页？(y/N) `);
    },
  });

  if (result === null) {
    if (!opts.json) io.out('已取消，未写入任何文件。');
    return null;
  }

  io.out(opts.json ? toJson(result.plan, result.changedPaths) : formatRetractReport(result));
  return result;
}
