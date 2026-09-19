/**
 * `wiki ingest` 命令（M6 F6.2 / 00 §8.1）。
 *
 * 走 M4 ingest 管线；**CLI 层负责 dry-run→approve 暂停**（展示 changedPaths，确认后回传
 * approvedPlanSha256）。不变量 I1：暂停与确认只在 CLI 层，Vault/ingest 编排只算 plan 与
 * 校验哈希。非交互环境（非 TTY）且无 --yes → 拒绝（必须显式 --yes 才能跳过确认）。
 */

import { ConfigError } from '../errors';
import { ingest } from '../ingest/ingest';
import { DEFAULT_GRANULARITY, DEFAULT_EXTRACT_MODE, type ExtractMode, type Granularity } from '../ingest/extract';
import {
  executeBatch,
  formatBatchPlan,
  formatBatchReport,
  prepareBatch,
  type BatchReport,
  type BatchSourceSpec,
} from '../ingest/batch';
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
  /** M15 D5：采纳磁盘现状为基线（存量逃生口，存量首次重跑不被冲突拒绝） */
  adopt?: boolean;
  /** M15 D6：覆盖前把被改旧版快照到 .vault-meta/conflicts/ */
  overwrite?: boolean;
  /** M15：忽略短路条件强制全流程（换模型重抽 / 页丢失后重建） */
  force?: boolean;
  /** 【M20】抽取粒度（缺省 standard，与 M19 逐字一致） */
  granularity?: Granularity;
  /** 【M20】抽取模式（缺省 single，与 M19 逐字一致） */
  extractMode?: ExtractMode;
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
    force: opts.force,
    adopt: opts.adopt,
    overwrite: opts.overwrite,
    granularity: opts.granularity,
    extractMode: opts.extractMode,
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

export interface IngestBatchCommandOpts {
  io: CliIO;
  autoApprove?: boolean;
  adopt?: boolean;
  overwrite?: boolean;
  force?: boolean;
  /** --plan：只读预演，零写入零 LLM */
  planOnly?: boolean;
  maxItems?: number;
  maxBytes?: number;
  /** 相对路径的解析基准（默认 process.cwd()） */
  cwd?: string;
  /** 【M20】抽取粒度：整批共用（缺省 standard） */
  granularity?: Granularity;
  /** 【M20】抽取模式：整批共用（缺省 single） */
  extractMode?: ExtractMode;
  /** 【M20】--json：预演或报告改以 JSON 输出（机器可读；默认渲染人类可读文本） */
  json?: boolean;
}

/**
 * M17 F17.8：批量 ingest。
 *
 * 审批粒度（D3 / I37）：开始前展示预演并确认**一次**，之后每项沿用该决定 ——
 * 批量下每项一次 approve 不可用。非 TTY 且无 --yes 仍抛 NON_INTERACTIVE（不新开后门）。
 *
 * 预演（--plan）在确认之前返回，零写入零 LLM。
 * @returns 取消或预演返回 null；否则返回聚合报告
 */
export async function runIngestBatch(
  spec: BatchSourceSpec,
  deps: IngestDeps,
  opts: IngestBatchCommandOpts,
): Promise<BatchReport | null> {
  const io = opts.io;

  const { plan, todos } = await prepareBatch(spec, deps, {
    io,
    cwd: opts.cwd,
    budget: {
      ...(opts.maxItems !== undefined ? { maxItems: opts.maxItems } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    },
  });

  if (opts.json === true && opts.planOnly === true) {
    io.out(
      JSON.stringify(
        {
          ...plan,
          granularity: opts.granularity ?? DEFAULT_GRANULARITY,
          extractMode: opts.extractMode ?? DEFAULT_EXTRACT_MODE,
        },
        null,
        2,
      ),
    );
    return null;
  }
  io.out(formatBatchPlan(plan));

  if (opts.planOnly) return null;
  if (todos.length === 0) {
    io.out('没有需要处理的来源。');
    return null;
  }

  let approved = opts.autoApprove === true;
  if (!approved) {
    if (!io.isTTY) {
      throw new ConfigError('NON_INTERACTIVE', '非交互环境无法确认变更，请加 --yes 以自动批准');
    }
    approved = await io.confirm(`确认处理以上 ${todos.length} 个来源？(y/N) `);
  }
  if (!approved) {
    io.out('已取消，未处理任何来源。');
    return null;
  }

  const report = await executeBatch(todos, deps, {
    io,
    force: opts.force,
    adopt: opts.adopt,
    overwrite: opts.overwrite,
    granularity: opts.granularity,
    extractMode: opts.extractMode,
    autoApprove: true, // I37：已一次性确认，逐项沿用
  });

  if (opts.json === true) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatBatchReport(report));
  }
  return report;
}
