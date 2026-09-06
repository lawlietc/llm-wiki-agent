/**
 * 事务化写（01 §4）：MutationLock（§4.3）与 applyBundle（§4.2）。
 *
 * 本文件当前只含 MutationLock（F1.4）；applyBundle 在 F1.5 加入。
 */

import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SafetyError, TransientError, ValidationError } from '../errors';
import { applyBaseline } from './baseline';
import { assertPortableWritePath, assertUnaliased, assertWithin } from './paths';
import type { ApplyResult, VaultPlan } from './vault';

/** 锁目录相对路径（相对 vault 根） */
export const MUTATION_LOCK_DIR = path.join('.vault-meta', 'mutation.lock');
/** vault 元数据目录（journal / 备份 / 锁都在此） */
export const VAULT_META_DIR = '.vault-meta';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 同机进程存活探测：EPERM（存在但无权发信号）视为活着 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockOwner {
  pid: number;
  host: string;
  started_epoch: number;
}

/**
 * 创建型互斥锁：用锁目录的 mkdir 原子性实现（01 §4.3）。
 *
 * POSIX 原版靠 dir_fd 围笼钉死 `.vault-meta` 命名空间；Windows 退化分支没有该原语，
 * 这里用「mkdir 锁目录 + owner.json + stale 收割」替代，详见 01 §5.1。
 */
export class MutationLock {
  private readonly lockPath: string;
  private acquired = false;

  constructor(
    public readonly vaultRoot: string,
    public readonly timeoutMs = 10_000,
    public readonly staleAfterMs = 3_600_000,
  ) {
    this.lockPath = path.join(vaultRoot, MUTATION_LOCK_DIR);
  }

  /** 拿不到锁时轮询重试；超时抛 TransientError(MUTATION_LOCK_HELD)，绝不静默放行 */
  async acquire(): Promise<void> {
    // .vault-meta 可能尚不存在（如裸目录上首个事务），先幂等建好
    await mkdir(path.dirname(this.lockPath), { recursive: true });

    const start = Date.now();
    while (true) {
      try {
        // mkdir 原子创建：目录已存在 → EEXIST → 视为锁被持有
        await mkdir(this.lockPath);
        const owner: LockOwner = {
          pid: process.pid,
          host: os.hostname(),
          started_epoch: Date.now(),
        };
        await writeFile(path.join(this.lockPath, 'owner.json'), JSON.stringify(owner), 'utf8');
        this.acquired = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        await this.tryReap();
        if (Date.now() - start > this.timeoutMs) {
          throw new TransientError(
            'MUTATION_LOCK_HELD',
            `另一事务持有 mutation.lock（等待超 ${this.timeoutMs}ms）：${this.lockPath}`,
          );
        }
        await sleep(50);
      }
    }
  }

  /** 释放锁；未持锁时幂等无副作用 */
  async release(): Promise<void> {
    if (!this.acquired) return;
    await rm(this.lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    this.acquired = false;
  }

  /**
   * stale 收割：锁超龄（> staleAfterMs）且持锁进程已死时删除锁目录。
   * 同机但进程还活着 → 不收（避免误收正在使用的锁）；
   * owner.json 缺失/损坏 → 保守不收。
   * （产品是纯本地单机，异机场景实际不会出现；若 host 不同则只信时间阈值。）
   */
  private async tryReap(): Promise<boolean> {
    try {
      const raw = await readFile(path.join(this.lockPath, 'owner.json'), 'utf8');
      const owner = JSON.parse(raw) as Partial<LockOwner>;
      const age = Date.now() - (owner.started_epoch ?? 0);
      if (age <= this.staleAfterMs) return false;
      if (owner.host === os.hostname() && typeof owner.pid === 'number' && processAlive(owner.pid)) {
        return false;
      }
      await rm(this.lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return true;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ *
 * §4.2 applyBundle 事务（对应 transaction.py 的 apply_bundle）
 * ------------------------------------------------------------------ */

export const BUNDLE_SCHEMA = 'llm-wiki.transaction.v1';
export const OPERATION_TYPES = new Set(['base', 'save', 'ingest', 'edit', 'delete']);
/** 幂等/备份记录的根目录（相对 vault 根） */
export const JOURNAL_ROOT_REL = path.join('.vault-meta', 'journal');
/** M5 的索引脏标记（相对 vault 根）；apply 成功后必须落（T1.5-10） */
export const DIRTY_MARKER_REL = path.join('.index', 'bm25', '.dirty');

export interface ApplyBundleOptions {
  approvedPlanSha256?: string;
  timeoutMs?: number;
  /**
   * 测试注入的故障钩子（SPEC-0 §2.5）：第 index 个写（1-based）执行前抛错，
   * 用于验证回滚。产品调用方不要使用。
   */
  failBeforeWrite?: { index: number; error?: Error };
}

/* ---------------- §5.1 Windows 退化分支（requireWritePlatform） ---------------- */

/** NTFS 卷判定缓存：同一进程内同卷只探测一次（powershell 子进程约 1s，不能每次事务都跑） */
const NTFS_VOLUME_CACHE = new Map<string, boolean>();

function volumeRootOf(p: string): string {
  return path.parse(path.resolve(p)).root;
}

/**
 * 用 PowerShell 查卷文件系统类型。
 *
 * 实测：Node 的 `fs.statfsSync` 在 Windows 上 type 恒为 0（拿不到卷类型），
 * 只能借 `Get-Volume -FilePath`（该参数支持卷挂载点路径，比 -DriveLetter 更准）。
 * 探测失败 fail-closed 返回 false（宁可拒写）。
 */
function probeNtfsByVolumeQuery(p: string): boolean {
  const key = volumeRootOf(p);
  const cached = NTFS_VOLUME_CACHE.get(key);
  if (cached !== undefined) return cached;

  let ok = false;
  try {
    // PowerShell 单引号转义：' → ''（vaultRoot 是真实路径，防御性处理）
    const safe = p.replace(/'/g, "''");
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Volume -FilePath '${safe}').FileSystem`],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    ).trim();
    ok = out.toUpperCase() === 'NTFS';
  } catch {
    ok = false;
  }
  NTFS_VOLUME_CACHE.set(key, ok);
  return ok;
}

/**
 * 平台探测注入点（模块级可替换，供测试注入 —— 同 M3 的 _chatTransport 模式）。
 * 判定对象是【传入路径所在卷】，不是 process.cwd()（T1.6-02）。
 * 注：用对象属性而非 `export let` —— ESM 的 import 绑定是只读的，测试无法赋值。
 */
export const _platform = {
  isNtfsVolume: probeNtfsByVolumeQuery,
};

/**
 * 写平台能力判定（01 §5.1）。
 *
 * 原生 Windows = 退化分支是默认且唯一内置路线：要求 vault 位于 NTFS 卷，
 * FAT/exFAT/网络盘没有稳定文件身份，拒写（UNSUPPORTED_PLATFORM）。
 * macOS/Linux 有 dir_fd 围笼可用，不在此检查。
 */
export function requireWritePlatform(vaultRoot: string): void {
  if (process.platform === 'win32' && !_platform.isNtfsVolume(vaultRoot)) {
    throw new SafetyError(
      'UNSUPPORTED_PLATFORM',
      'Windows 原生写入需 vault 位于 NTFS 卷（FAT/exFAT/网络盘拒写）',
    );
  }
}

export interface BundlePreview {
  approvalSha256: string;
  changedPaths: string[];
}

/** 计划的规范化哈希：schema + operationType + 按路径排序的 writes（content 参与） */
export function canonicalHash(plan: VaultPlan): string {
  const canonical = {
    schema: plan.schema,
    operationType: plan.operationType,
    writes: [...plan.writes]
      .map((w) => ({
        relativePath: w.relativePath,
        content: w.content ?? null,
        operationType: w.operationType,
      }))
      .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** inspect 阶段：算审批哈希与变更清单（00 §5 Vault.preview 的底层） */
export function previewBundle(plan: VaultPlan): BundlePreview {
  return {
    approvalSha256: canonicalHash(plan),
    changedPaths: plan.writes.map((w) => w.relativePath),
  };
}

/** 在锁的包裹下执行 fn（F1.5 的主入口；F1.6 的 Vault.apply 也复用它） */
export async function withMutationLock<T>(
  vaultRoot: string,
  timeoutMs: number,
  fn: (lock: MutationLock) => Promise<T>,
): Promise<T> {
  const lock = new MutationLock(vaultRoot, timeoutMs);
  await lock.acquire();
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

/**
 * 事务化原子落盘（01 §4.2）。
 *
 * 流程：schema/type 校验 → 审批哈希比对（I4）→ 拿锁 → 崩溃恢复 → 幂等重放检查（I3）
 * → 备份 → 逐文件原子替换 → commit → 写 dirty 标记；任一步失败 → journal + 备份整体回滚（I2）。
 */
export async function applyBundle(vaultRoot: string, plan: VaultPlan, opts: ApplyBundleOptions = {}): Promise<ApplyResult> {
  requireWritePlatform(vaultRoot);
  if (plan.schema !== BUNDLE_SCHEMA) {
    throw new ValidationError('INVALID_BUNDLE_SCHEMA', `需 ${BUNDLE_SCHEMA}`);
  }
  if (!OPERATION_TYPES.has(plan.operationType)) {
    throw new ValidationError('INVALID_OPERATION_TYPE', `非法 operationType：${plan.operationType}`);
  }

  // 审批哈希绑定（I4）：timingSafeEqual 防时序攻击，先判等长再比较
  if (opts.approvedPlanSha256) {
    const computed = canonicalHash(plan);
    const a = Buffer.from(opts.approvedPlanSha256, 'utf8');
    const b = Buffer.from(computed, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ValidationError('PLAN_CHANGED', 'plan 与已审批哈希不符');
    }
  }

  return withMutationLock(vaultRoot, opts.timeoutMs ?? 10_000, async () => {
    await recoverIncomplete(vaultRoot);

    const journalDir = path.join(vaultRoot, JOURNAL_ROOT_REL, plan.operationId);
    const prior = await openOperation(journalDir, plan);
    if (prior.completed) return prior.result;

    await mkdir(journalDir, { recursive: true });
    await prepareWrites(vaultRoot, plan, journalDir);
    await writeJsonAtomic(path.join(journalDir, 'state.json'), {
      phase: 'prepared',
      bundleSha256: canonicalHash(plan),
    });

    const changed: string[] = [];
    try {
      for (let i = 0; i < plan.writes.length; i++) {
        if (opts.failBeforeWrite && opts.failBeforeWrite.index === i + 1) {
          throw opts.failBeforeWrite.error ?? new Error('注入故障：写前中断');
        }
        const w = plan.writes[i]!;
        assertPortableWritePath(w.relativePath);
        const abs = path.join(vaultRoot, w.relativePath);
        assertWithin(vaultRoot, abs);
        assertUnaliased(abs);

        if (w.operationType === 'delete') {
          await atomicDelete(abs);
        } else {
          if (w.content === undefined) {
            throw new ValidationError('INVALID_OPERATION_TYPE', `create/update 必须带 content：${w.relativePath}`);
          }
          await atomicReplace(abs, w.content);
        }
        changed.push(w.relativePath);
      }

      const bundleSha256 = canonicalHash(plan);
      await writeJsonAtomic(path.join(journalDir, 'state.json'), {
        phase: 'committed',
        bundleSha256,
        result: { operationId: plan.operationId, changedPaths: changed, bundleSha256 },
      });
      // M5 hook：索引脏标记（T1.5-10）
      const dirty = path.join(vaultRoot, DIRTY_MARKER_REL);
      await mkdir(path.dirname(dirty), { recursive: true });
      await writeFile(dirty, '', 'utf8');

      // M15 I21：基线记录在**提交之后**旁路写（回滚路径不会走到这里 → 基线不撒谎）。
      // 失败不阻断：基线是缓存级状态，缺了会落到冲突分支（fail-safe），不该让已提交的事务报错。
      try {
        await applyBaseline(vaultRoot, plan.writes);
      } catch {
        /* 基线写失败：下次该页判定为冲突，交人裁决 */
      }

      return { operationId: plan.operationId, changedPaths: changed, bundleSha256 };
    } catch (err) {
      await rollback(vaultRoot, journalDir, plan.operationId);
      throw err;
    }
  });
}

interface JournalState {
  phase: 'prepared' | 'committed' | 'rolled-back';
  bundleSha256?: string;
  result?: ApplyResult;
}

/** 幂等重放（I3）：同 operationId 已 committed 且 bundleSha256 一致 → 返回原结果；不一致 → OPERATION_ID_REUSED */
async function openOperation(
  journalDir: string,
  plan: VaultPlan,
): Promise<{ completed: true; result: ApplyResult } | { completed: false }> {
  const statePath = path.join(journalDir, 'state.json');
  if (!existsSync(statePath)) return { completed: false };
  const state = JSON.parse(await readFile(statePath, 'utf8')) as JournalState;
  if (state.phase === 'committed') {
    if (state.bundleSha256 === canonicalHash(plan)) {
      return { completed: true, result: state.result as ApplyResult };
    }
    throw new ValidationError('OPERATION_ID_REUSED', `operationId 已被不同 plan 占用：${plan.operationId}`);
  }
  return { completed: false }; // prepared（上次崩溃）或 rolled-back：允许重新执行
}

/** 崩溃恢复（I2）：扫描 journal，把 phase=prepared 的残留事务用备份回滚 */
async function recoverIncomplete(vaultRoot: string): Promise<void> {
  const journalRoot = path.join(vaultRoot, JOURNAL_ROOT_REL);
  if (!existsSync(journalRoot)) return;
  for (const opId of await readdir(journalRoot)) {
    const statePath = path.join(journalRoot, opId, 'state.json');
    if (!existsSync(statePath)) continue;
    let state: JournalState;
    try {
      state = JSON.parse(await readFile(statePath, 'utf8')) as JournalState;
    } catch {
      continue; // state.json 损坏：跳过（该残留目录不再被 recover 处理，保守起见不删除）
    }
    if (state.phase === 'prepared') {
      await restoreFromBackups(vaultRoot, journalRoot, opId);
      await writeJsonAtomic(statePath, { phase: 'rolled-back', bundleSha256: state.bundleSha256 });
    }
  }
}

/** 备份：目标已存在则存内容，否则记 tombstone（恢复时删除） */
async function prepareWrites(vaultRoot: string, plan: VaultPlan, journalDir: string): Promise<void> {
  for (let i = 0; i < plan.writes.length; i++) {
    const w = plan.writes[i]!;
    const abs = path.join(vaultRoot, w.relativePath);
    const backupDir = path.join(journalDir, 'backups', String(i));
    await mkdir(backupDir, { recursive: true });
    if (existsSync(abs)) {
      await writeFile(path.join(backupDir, 'content'), await readFile(abs));
      await writeJsonAtomic(path.join(backupDir, 'meta.json'), {
        relativePath: w.relativePath,
        existed: true,
      });
    } else {
      await writeJsonAtomic(path.join(backupDir, 'meta.json'), {
        relativePath: w.relativePath,
        existed: false,
      });
    }
  }
}

/** 用备份整体恢复（事务前状态） */
async function restoreFromBackups(vaultRoot: string, journalRoot: string, opId: string): Promise<void> {
  const backupsDir = path.join(journalRoot, opId, 'backups');
  if (!existsSync(backupsDir)) return;
  for (const entry of await readdir(backupsDir)) {
    const meta = JSON.parse(await readFile(path.join(backupsDir, entry, 'meta.json'), 'utf8')) as {
      relativePath: string;
      existed: boolean;
    };
    const abs = path.join(vaultRoot, meta.relativePath);
    if (meta.existed) {
      const content = await readFile(path.join(backupsDir, entry, 'content'));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    } else {
      await rm(abs, { force: true });
    }
  }
}

/** 回滚：恢复备份 + 标记 rolled-back（任一步失败不再重试 —— 恢复本身失败属于严重磁盘错误） */
async function rollback(vaultRoot: string, journalDir: string, opId: string): Promise<void> {
  await restoreFromBackups(vaultRoot, path.dirname(journalDir), opId);
  const statePath = path.join(journalDir, 'state.json');
  if (existsSync(statePath)) {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as JournalState;
    await writeJsonAtomic(statePath, { phase: 'rolled-back', bundleSha256: state.bundleSha256 });
  }
}

/** 逐文件原子替换：临时文件 + rename + rename 后重读比对（01 §5.1 退化分支 b 条，F1.6-03 验收） */
async function atomicReplace(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`;
  const buf = Buffer.from(content, 'utf8');
  const before = sha256(buf);
  try {
    await writeFile(tmp, buf);
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  const after = sha256(await readFile(abs));
  if (after !== before) {
    await rm(abs, { force: true });
    throw new SafetyError('ATOMIC_REPLACE_VERIFY_FAILED', `原子替换后校验失败：${abs}`);
  }
}

async function atomicDelete(abs: string): Promise<void> {
  await rm(abs, { force: true });
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 原子写 JSON（临时文件 + rename），供 state.json / meta.json 使用 */
async function writeJsonAtomic(abs: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value));
  try {
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
