/**
 * Vault 存储层统一契约（00 §5，逐字采用）+ Vault 组装（F1.6）。
 *
 * 所有对 wiki 文件的读写都经 Vault —— 禁止业务代码直接 fs.writeFile。
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { applyBundle, BUNDLE_SCHEMA, previewBundle } from './transaction';
import { assertWithin, normalizeVaultPath } from './paths';

export interface VaultWriteOp {
  /** 相对 vault 根的路径，如 "wiki/my-topic.md"；必须过路径白名单 */
  relativePath: string;
  /** 已是最终落盘内容（含 ai-first 前言 + frontmatter）；delete 可省略，create/update 必填 */
  content?: string;
  operationType: 'create' | 'update' | 'delete';
}

export interface VaultPlan {
  /** 幂等键，同 id 重放安全 */
  operationId: string;
  schema: 'llm-wiki.transaction.v1';
  operationType: 'base' | 'save' | 'ingest' | 'edit' | 'delete';
  writes: VaultWriteOp[];
  /** inspect 阶段算出的 approved_plan_sha256，apply 时回传比对 */
  approvalSha256?: string;
}

export interface ApplyResult {
  operationId: string;
  changedPaths: string[];
  bundleSha256: string;
}

export interface Vault {
  /** fail-closed 解析根目录；绝不允许选到产品自身安装目录 */
  root: string;

  /** 第一步：只算计划，不落盘。返回可供用户/agent 审阅的 VaultPlan */
  plan(ops: VaultWriteOp[]): Promise<VaultPlan>;

  /** 第二步（可选）：把计划哈希交回给用户确认（dry-run→approve） */
  preview(plan: VaultPlan): { approvalSha256: string; changedPaths: string[] };

  /** 第三步：事务化原子落盘，任一失败整体回滚 */
  apply(plan: VaultPlan, opts?: { approvedPlanSha256?: string }): Promise<ApplyResult>;

  /** 读取（agent 经此读，不经裸 fs） */
  read(relativePath: string): Promise<string>;
}

/**
 * Vault 组装（F1.6）：把 resolve-root（解析）、paths（白名单）、transaction（事务）
 * 组装成 00 §5 的统一契约。业务代码只与这个接口打交道。
 */
export function createVault(root: string): Vault {
  return {
    root,

    async plan(ops) {
      // operationType 固定 save：事务类型由上层（ingest/edit/delete）另行覆盖
      const writes = ops.map((op) => ({ ...op }));
      const plan: VaultPlan = {
        operationId: randomUUID(),
        schema: BUNDLE_SCHEMA,
        operationType: 'save',
        writes,
      };
      plan.approvalSha256 = previewBundle(plan).approvalSha256;
      return plan;
    },

    preview(plan) {
      return previewBundle(plan);
    },

    async apply(plan, opts) {
      return applyBundle(root, plan, { approvedPlanSha256: opts?.approvedPlanSha256 });
    },

    async read(relativePath) {
      // 读同样过白名单（结构层）+ 越界校验；保留路径规则只约束写，读不适用
      normalizeVaultPath(relativePath);
      const abs = path.join(root, relativePath);
      assertWithin(root, abs);
      return readFile(abs, 'utf8');
    },
  };
}
