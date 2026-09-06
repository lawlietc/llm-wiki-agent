/**
 * M15 基线表（I21/I22/I23）：记录「本系统写出的版本」的内容哈希，
 * 是判断页面是否被外部改动的**唯一依据**。
 *
 * 设计要点：
 * - 状态住 `.vault-meta/baselines.json`，**不进页面 frontmatter**——页面会被
 *   summarizeToWiki / renderEntityPage 整页重写，标记放页面里会在第一次覆盖时自毁。
 * - 旁路写（tmp + rename），**不走 VaultWriteOp**：`assertPortableWritePath` 对
 *   `top === '.vault-meta'` 一律抛 RESERVED_PATH（受保护目录只可经事务 API 写的反面）。
 * - 读侧容错：文件缺失/损坏/结构非法一律返回空表，绝不抛——缺基线的后果是落到冲突
 *   分支（fail-safe），而不是让写入链路崩掉。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 基线表相对 vault 根的路径 */
export const BASELINE_REL = '.vault-meta/baselines.json';

/** 页面相对路径（posix）→ 系统写出时的内容 sha256（hex） */
export type BaselineMap = Record<string, string>;

/** 事务写入项的裁剪形态（只取基线需要的三个字段） */
export interface BaselineWrite {
  relativePath: string;
  content?: string;
  operationType: 'create' | 'update' | 'delete';
}

/** 内容指纹（与 M14 的 sha256Hex 同算法、同编码） */
export function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 读基线表；缺失/损坏 → 空表 */
export async function readBaselines(vaultRoot: string): Promise<BaselineMap> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(vaultRoot, BASELINE_REL), 'utf8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: BaselineMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 整体覆写基线表（原子写：tmp + rename） */
export async function writeBaselines(vaultRoot: string, map: BaselineMap): Promise<void> {
  const abs = path.join(vaultRoot, BASELINE_REL);
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * 按一次事务的写入项更新基线：create/update 记哈希，delete 清条目。
 * 幂等——同内容重复应用结果一致（I3 家族语义）。
 */
export async function applyBaseline(vaultRoot: string, writes: readonly BaselineWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const map = await readBaselines(vaultRoot);
  for (const w of writes) {
    if (w.operationType === 'delete') delete map[w.relativePath];
    else if (typeof w.content === 'string') map[w.relativePath] = contentSha256(w.content);
  }
  await writeBaselines(vaultRoot, map);
}

/**
 * 单页冲突判定（纯函数，供 ingest 与测试复用）：
 * - 目标不存在（currentSha 缺席）→ 'none'（新建，无冲突可言）
 * - 有基线且与当前内容哈希相同 → 'clean'（没人动过，可放心覆盖）
 * - 其余：无基线却有内容（存量/手写页）、或哈希不符（被改过）→ 'conflict'（I22 fail-safe）
 */
export function baselineState(
  baseline: string | undefined,
  currentSha: string | undefined,
): 'none' | 'clean' | 'conflict' {
  if (currentSha === undefined) return 'none';
  if (baseline === undefined) return 'conflict';
  return baseline === currentSha ? 'clean' : 'conflict';
}
