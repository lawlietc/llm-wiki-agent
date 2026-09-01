/**
 * M1-F1.4 MutationLock（01 §4.3）
 *
 * T1.4-01 二次 acquire 超时抛错；T1.4-02 owner.json 内容；T1.4-03 stale 收割；
 * T1.4-04 release 语义；T1.4-05 并发恰好 1 成功。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransientError } from '../../src/errors';
import { MutationLock } from '../../src/vault/transaction';
import { makeVault, type TempVault } from '../helpers/make-vault';

const vaults: TempVault[] = [];

afterEach(async () => {
  for (const v of vaults.splice(0)) await v.cleanup();
});

async function freshVault(): Promise<TempVault> {
  const v = await makeVault();
  vaults.push(v);
  return v;
}

function lockDirOf(vaultRoot: string): string {
  return path.join(vaultRoot, '.vault-meta', 'mutation.lock');
}

describe('F1.4 MutationLock', () => {
  it('T1.4-01 已持锁时二次 acquire → 超时抛 TransientError(MUTATION_LOCK_HELD)，不静默放行', async () => {
    const vault = await freshVault();
    const lock1 = new MutationLock(vault.root, 5_000);
    await lock1.acquire();

    const lock2 = new MutationLock(vault.root, 300);
    await expect(lock2.acquire()).rejects.toMatchObject({ code: 'MUTATION_LOCK_HELD' });
    await expect(lock2.acquire()).rejects.toBeInstanceOf(TransientError);

    await lock1.release();
  });

  it('T1.4-02 owner.json 记录 pid / host / started_epoch', async () => {
    const vault = await freshVault();
    const lock = new MutationLock(vault.root, 5_000);
    const before = Date.now();
    await lock.acquire();

    const ownerRaw = await readFile(path.join(lockDirOf(vault.root), 'owner.json'), 'utf8');
    const owner = JSON.parse(ownerRaw) as { pid: number; host: string; started_epoch: number };
    expect(owner.pid).toBe(process.pid);
    expect(owner.host).toBe(os.hostname());
    expect(owner.started_epoch).toBeGreaterThanOrEqual(before - 60_000);
    expect(owner.started_epoch).toBeLessThanOrEqual(Date.now());

    await lock.release();
  });

  it('T1.4-03 stale 锁（超阈值且进程已死）→ 可收割重取', async () => {
    const vault = await freshVault();
    const lockDir = lockDirOf(vault.root);
    await mkdir(lockDir, { recursive: true });
    // pid 取一个几乎不可能存在的值；started_epoch 故意老于 staleAfterMs（1000ms）
    await writeFile(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 999_999_999, host: os.hostname(), started_epoch: Date.now() - 60_000 }),
      'utf8',
    );

    const lock = new MutationLock(vault.root, 3_000, 1_000);
    await expect(lock.acquire()).resolves.toBeUndefined();
    await lock.release();
  });

  it('T1.4-03b 超阈值但进程还活着 → 不收割（等到超时仍拒绝）', async () => {
    const vault = await freshVault();
    const lockDir = lockDirOf(vault.root);
    await mkdir(lockDir, { recursive: true });
    // pid 是当前测试进程（活着的），虽然 started_epoch 很老
    await writeFile(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), started_epoch: Date.now() - 60_000 }),
      'utf8',
    );

    const lock = new MutationLock(vault.root, 300, 1_000);
    await expect(lock.acquire()).rejects.toMatchObject({ code: 'MUTATION_LOCK_HELD' });
  });

  it('T1.4-04 release 后锁目录消失、可再次 acquire', async () => {
    const vault = await freshVault();
    const lock = new MutationLock(vault.root, 5_000);
    await lock.acquire();
    expect(existsSync(lockDirOf(vault.root))).toBe(true);

    await lock.release();
    expect(existsSync(lockDirOf(vault.root))).toBe(false);

    const again = new MutationLock(vault.root, 5_000);
    await expect(again.acquire()).resolves.toBeUndefined();
    await again.release();
  });

  it('T1.4-05 并发 10 个 acquire（同进程锁对象）→ 恰好 1 个成功', async () => {
    const vault = await freshVault();
    const locks = Array.from({ length: 10 }, () => new MutationLock(vault.root, 3_000));
    const results = await Promise.allSettled(locks.map((l) => l.acquire()));

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<void> => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'MUTATION_LOCK_HELD' });
    }

    // 清理：赢家释放，避免 afterEach 删临时目录时锁目录还在
    const winner = locks[results.indexOf(fulfilled[0]!)]!;
    await winner.release();
  });

  it('T1.4-06 未 acquire 就 release → 幂等无副作用', async () => {
    const vault = await freshVault();
    const lock = new MutationLock(vault.root, 1_000);
    await expect(lock.release()).resolves.toBeUndefined();
    expect(existsSync(lockDirOf(vault.root))).toBe(false);
  });
});
