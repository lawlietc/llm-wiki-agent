/**
 * M1-F1.5 applyBundle 事务（01 §4.2）
 *
 * 不变量 I2（原子性/回滚）、I3（幂等重放）、I4（审批哈希绑定）的验收。
 * 故障注入是验证回滚的关键手段（SPEC-0 §2.5）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { VaultPlan, VaultWriteOp } from '../../src/vault/vault';
import { applyBundle, previewBundle } from '../../src/vault/transaction';
import { MutationLock } from '../../src/vault/transaction';
import { makeVault, type TempVault } from '../helpers/make-vault';
import { expectErrorCodeAsync } from '../helpers/errors';

const vaults: TempVault[] = [];

afterEach(async () => {
  for (const v of vaults.splice(0)) await v.cleanup();
});

async function freshVault(): Promise<TempVault> {
  const v = await makeVault();
  vaults.push(v);
  return v;
}

function plan(operationId: string, writes: VaultWriteOp[], operationType: VaultPlan['operationType'] = 'save'): VaultPlan {
  return { operationId, schema: 'llm-wiki.transaction.v1', operationType, writes };
}

function create(relativePath: string, content: string): VaultWriteOp {
  return { relativePath, content, operationType: 'create' };
}

function update(relativePath: string, content: string): VaultWriteOp {
  return { relativePath, content, operationType: 'update' };
}

function del(relativePath: string): VaultWriteOp {
  return { relativePath, operationType: 'delete' };
}

async function sha256OfFile(abs: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await readFile(abs)).digest('hex');
}

const DEFAULT_TIMEOUT = { timeoutMs: 5_000 } as const;

describe('F1.5 applyBundle 事务', () => {
  it('T1.5-01 schema 错 / operationType 非法 → ValidationError，磁盘无变化', async () => {
    const vault = await freshVault();
    const good = create('wiki/a.md', 'hello');

    // schema 错
    const badSchema = { ...plan('op-1', [good]), schema: 'wrong.schema.v9' as never };
    await expectErrorCodeAsync(applyBundle(vault.root, badSchema, DEFAULT_TIMEOUT), 'INVALID_BUNDLE_SCHEMA');
    // operationType 非法
    const badType = { ...plan('op-1', [good]), operationType: 'explode' as never };
    await expectErrorCodeAsync(applyBundle(vault.root, badType, DEFAULT_TIMEOUT), 'INVALID_OPERATION_TYPE');

    expect(vault.exists('wiki/a.md')).toBe(false);
  });

  it('T1.5-02 preview 回传正确哈希 → apply 成功，changedPaths 正确', async () => {
    const vault = await freshVault();
    const p = plan('op-2', [
      create('wiki/a.md', 'A'),
      create('wiki/sub/b.md', 'B'),
    ]);
    const preview = previewBundle(p);
    expect(preview.approvalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.changedPaths).toEqual(['wiki/a.md', 'wiki/sub/b.md']);

    const result = await applyBundle(vault.root, p, { approvedPlanSha256: preview.approvalSha256, ...DEFAULT_TIMEOUT });
    expect(result.changedPaths).toEqual(['wiki/a.md', 'wiki/sub/b.md']);
    expect(result.operationId).toBe('op-2');
    expect(await vault.read('wiki/a.md')).toBe('A');
    expect(await vault.read('wiki/sub/b.md')).toBe('B');
  });

  it('T1.5-03 回传篡改后的哈希 → PLAN_CHANGED，磁盘无变化（I4）', async () => {
    const vault = await freshVault();
    const p = plan('op-3', [create('wiki/a.md', 'A')]);
    const preview = previewBundle(p);
    const tampered = (parseInt(preview.approvalSha256.slice(0, 16), 16) ^ 1).toString(16).padStart(16, '0') + preview.approvalSha256.slice(16);

    await expectErrorCodeAsync(
      applyBundle(vault.root, p, { approvedPlanSha256: tampered, ...DEFAULT_TIMEOUT }),
      'PLAN_CHANGED',
    );
    expect(vault.exists('wiki/a.md')).toBe(false);
  });

  it('T1.5-03b 不传 approvedPlanSha256 的 apply 直接成功（未审批路径仍可用）', async () => {
    const vault = await freshVault();
    const p = plan('op-3b', [create('wiki/a.md', 'A')]);
    const result = await applyBundle(vault.root, p, DEFAULT_TIMEOUT);
    expect(result.changedPaths).toEqual(['wiki/a.md']);
  });

  it('T1.5-04 故障注入：写第 2 个文件前抛错 → 整体回滚，第 1 个文件恢复原样（I2）', async () => {
    const vault = await freshVault();
    await vault.write('wiki/keep.md', 'original');
    await vault.write('wiki/touch-me.md', 'will-be-updated');

    const p = plan('op-4', [
      update('wiki/keep.md', 'changed-1'),
      create('wiki/new-2.md', 'new'),
      update('wiki/touch-me.md', 'changed-3'),
    ]);
    // 第 2 个文件写前注入故障 → keep.md 的修改必须回滚，touch-me.md 不得被改
    await expect(
      applyBundle(vault.root, p, { failBeforeWrite: { index: 2 }, ...DEFAULT_TIMEOUT }),
    ).rejects.toThrow();

    expect(await vault.read('wiki/keep.md')).toBe('original');
    expect(vault.exists('wiki/new-2.md')).toBe(false);
    expect(await vault.read('wiki/touch-me.md')).toBe('will-be-updated');
  });

  it('T1.5-05 delete 混在 create/update 中，任一失败 → delete 的文件也恢复', async () => {
    const vault = await freshVault();
    await vault.write('wiki/to-delete.md', 'bye');
    await vault.write('wiki/to-keep.md', 'keep');

    const p = plan('op-5', [
      del('wiki/to-delete.md'),
      update('wiki/to-keep.md', 'updated'),
      create('wiki/late.md', 'late'),
    ]);
    await expect(
      applyBundle(vault.root, p, { failBeforeWrite: { index: 3 }, ...DEFAULT_TIMEOUT }),
    ).rejects.toThrow();

    // delete 已执行也必须回滚：文件还在且内容原样
    expect(await vault.read('wiki/to-delete.md')).toBe('bye');
    expect(await vault.read('wiki/to-keep.md')).toBe('keep');
    expect(vault.exists('wiki/late.md')).toBe(false);
  });

  it('T1.5-06 同 operationId 同 plan 重放 → 返回原结果，无重复写入（I3）', async () => {
    const vault = await freshVault();
    const p = plan('op-6', [create('wiki/a.md', 'A')]);
    const preview = previewBundle(p);
    const first = await applyBundle(vault.root, p, { approvedPlanSha256: preview.approvalSha256, ...DEFAULT_TIMEOUT });
    const second = await applyBundle(vault.root, p, { approvedPlanSha256: preview.approvalSha256, ...DEFAULT_TIMEOUT });

    expect(second).toEqual(first);
    expect(second.changedPaths).toEqual(first.changedPaths);
    // 幂等记录只有一份（同 opId 目录里 state 未被新建第二份）
    const journalDir = path.join(vault.root, '.vault-meta', 'journal', 'op-6');
    expect(existsSync(journalDir)).toBe(true);
    expect(await vault.read('wiki/a.md')).toBe('A');
  });

  it('T1.5-07 同 operationId 不同 plan → OPERATION_ID_REUSED', async () => {
    const vault = await freshVault();
    const p1 = plan('op-7', [create('wiki/a.md', 'A')]);
    const p2 = plan('op-7', [create('wiki/b.md', 'B')]);
    await applyBundle(vault.root, p1, DEFAULT_TIMEOUT);

    await expectErrorCodeAsync(applyBundle(vault.root, p2, DEFAULT_TIMEOUT), 'OPERATION_ID_REUSED');
    // p2 未落盘
    expect(vault.exists('wiki/b.md')).toBe(false);
  });

  it('T1.5-08 崩溃恢复：手工构造 journal 半提交状态 → 下一次 apply 前完成回滚（I2）', async () => {
    const vault = await freshVault();
    await vault.write('wiki/a.md', 'old');
    await vault.write('wiki/b.md', 'keep');

    // 手工构造一个「prepared 但未 committed」的崩溃现场：
    //   a.md 已被改成 'half-new'（模拟写入中断），备份里留着 'old'
    const crashOp = 'op-crash';
    const journalRoot = path.join(vault.root, '.vault-meta', 'journal', crashOp);
    await mkdir(path.join(journalRoot, 'backups', '0'), { recursive: true });
    await writeFile(path.join(journalRoot, 'backups', '0', 'content'), 'old', 'utf8');
    await writeFile(
      path.join(journalRoot, 'backups', '0', 'meta.json'),
      JSON.stringify({ relativePath: 'wiki/a.md', existed: true }),
      'utf8',
    );
    await writeFile(path.join(journalRoot, 'state.json'), JSON.stringify({ phase: 'prepared' }), 'utf8');
    await vault.write('wiki/a.md', 'half-new');

    // 触发一次全新 apply（走 recoverIncomplete）
    const p = plan('op-fresh', [create('wiki/c.md', 'C')]);
    await applyBundle(vault.root, p, DEFAULT_TIMEOUT);

    // 崩溃事务回滚完成：a.md 恢复 'old'
    expect(await vault.read('wiki/a.md')).toBe('old');
    const state = JSON.parse(await readFile(path.join(journalRoot, 'state.json'), 'utf8')) as { phase: string };
    expect(state.phase).toBe('rolled-back');
    // 新事务正常完成
    expect(await vault.read('wiki/c.md')).toBe('C');
  });

  it('T1.5-09 applyBundle 过程持有 MutationLock：持锁时并发 apply 被拒', async () => {
    const vault = await freshVault();
    const holder = new MutationLock(vault.root, 5_000);
    await holder.acquire();

    const p = plan('op-9', [create('wiki/a.md', 'A')]);
    await expect(applyBundle(vault.root, p, { timeoutMs: 300 })).rejects.toMatchObject({
      code: 'MUTATION_LOCK_HELD',
    });
    expect(vault.exists('wiki/a.md')).toBe(false);

    await holder.release();
    // 释放后同一 plan 可成功
    const preview = previewBundle(p);
    await expect(
      applyBundle(vault.root, p, { approvedPlanSha256: preview.approvalSha256, ...DEFAULT_TIMEOUT }),
    ).resolves.toBeTruthy();
  });

  it('T1.5-10 apply 成功后写 .index/bm25/.dirty（M5 hook）', async () => {
    const vault = await freshVault();
    const p = plan('op-10', [create('wiki/a.md', 'A')]);
    await applyBundle(vault.root, p, DEFAULT_TIMEOUT);

    expect(vault.exists('.index/bm25/.dirty')).toBe(true);
  });

  it('T1.5-11 失败路径磁盘零副作用：整树 sha256 与事务前一致', async () => {
    const vault = await freshVault();
    await vault.write('wiki/a.md', 'A');
    await vault.write('wiki/b.md', 'B');

    const before = new Map<string, string>();
    for (const rel of ['wiki/a.md', 'wiki/b.md']) {
      before.set(rel, await sha256OfFile(vault.abs(rel)));
    }

    // 三连失败：schema 错、哈希篡改、故障注入
    await expectErrorCodeAsync(
      applyBundle(vault.root, { ...plan('x', [update('wiki/a.md', 'X')]), schema: 'bad' as never }, DEFAULT_TIMEOUT),
      'INVALID_BUNDLE_SCHEMA',
    );
    await expectErrorCodeAsync(
      applyBundle(vault.root, plan('x', [update('wiki/a.md', 'X')]), { approvedPlanSha256: '0'.repeat(64), ...DEFAULT_TIMEOUT }),
      'PLAN_CHANGED',
    );
    await expect(
      applyBundle(vault.root, plan('x', [update('wiki/a.md', 'X'), create('wiki/c.md', 'C')]), {
        failBeforeWrite: { index: 2 },
        ...DEFAULT_TIMEOUT,
      }),
    ).rejects.toThrow();

    for (const [rel, hash] of before) {
      expect(await sha256OfFile(vault.abs(rel))).toBe(hash);
    }
    expect(vault.exists('wiki/c.md')).toBe(false);
  });
});
