/**
 * Vault 根解析（01 §2，fail-closed）。
 *
 * 优先级：explicit > env(LLM_WIKI_VAULT) > workspace（cwd 最近的含 .llm-wiki.json 的祖先）
 * → 都不命中抛 ConfigError，**绝不静默用 cwd**。
 *
 * 本文件是全产品唯一允许读取 `process.env` 的 vault 模块（env 以入参注入，
 * 见 M1 DoD：「全模块 grep 无 process.env 业务读取，仅 resolve-root 的 env 入参注入」）。
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { ConfigError } from '../errors';

/** vault 初始化标记文件 */
export const VAULT_MARKER_FILE = '.llm-wiki.json';

/** 产品根标记，用于识别「候选落在产品自身安装目录内」 */
export const PRODUCT_MARKER = 'llm-wiki-agent';

export interface VaultSelection {
  /** realpath 解析后的 vault 根 */
  root: string;
  source: 'explicit' | 'env' | 'workspace' | 'cwd';
}

export interface ResolveVaultRootOptions {
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 允许指向未初始化目录（供 `wiki init` 用） */
  allowUninitialized?: boolean;
}

export function resolveVaultRoot(opts: ResolveVaultRootOptions): VaultSelection {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  // candidate 与 source 绑成同一个对象：分成两个 let 时，TS 无法从
  // `candidate` 非空反推出 `source` 已赋值（TS2454）。
  let selection: { candidate: string; source: VaultSelection['source'] } | undefined;

  if (opts.explicit) {
    selection = { candidate: opts.explicit, source: 'explicit' };
  } else if (env.LLM_WIKI_VAULT) {
    selection = { candidate: env.LLM_WIKI_VAULT, source: 'env' };
  } else {
    const found = findNearestVault(cwd);
    if (found) selection = { candidate: found, source: 'workspace' };
  }

  if (!selection) {
    // 找不到已初始化 vault：除非「显式指定了目录 + 显式允许未初始化」，否则 fail-closed。
    // 单独给 allowUninitialized 而不给 explicit 不算数 —— 那等于给 cwd 背书。
    if (opts.allowUninitialized && opts.explicit) {
      selection = { candidate: opts.explicit, source: 'explicit' };
    } else {
      throw new ConfigError(
        'VAULT_NOT_FOUND',
        `未找到 vault（需 --vault、${'LLM_WIKI_VAULT'} 或含 ${VAULT_MARKER_FILE} 的目录）`,
      );
    }
  }

  const root = realpathSync(selection.candidate);
  assertNotProductTree(root, selection.source);
  if (!opts.allowUninitialized) assertVaultInitialized(root);
  return { root, source: selection.source };
}

/** 从 start 向上找最近的含 .llm-wiki.json 的祖先目录；找不到返回 undefined */
export function findNearestVault(start: string): string | undefined {
  let p = path.resolve(start);
  while (true) {
    if (existsSync(path.join(p, VAULT_MARKER_FILE))) return p;
    const parent = path.dirname(p);
    if (parent === p) return undefined;
    p = parent;
  }
}

/**
 * 拒绝把 vault 选到产品自身安装目录内（防把可变状态写进产品树、被升级清掉）。
 * 判定对象包含 root 自身与全部祖先。
 */
export function assertNotProductTree(root: string, source?: VaultSelection['source']): void {
  let p = root;
  while (true) {
    if (isProductInstallDir(p)) {
      throw new ConfigError(
        'VAULT_INSIDE_PRODUCT',
        `vault 不能选到产品自身目录（来源：${source ?? 'unknown'}）：${root}`,
      );
    }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
}

/**
 * 产品安装目录的两个判据（01 §2.2）：
 * 1. 含 `node_modules/<PRODUCT_MARKER>`
 * 2. 自身 `package.json` 的 `name` === PRODUCT_MARKER
 */
function isProductInstallDir(dir: string): boolean {
  if (existsSync(path.join(dir, 'node_modules', PRODUCT_MARKER))) return true;

  const pkgPath = path.join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return false;
    return (parsed as { name?: unknown }).name === PRODUCT_MARKER;
  } catch {
    // package.json 损坏或不可读：不据此判为产品目录（落盘安全由 vault 其它层 fail-closed 兜底）
    return false;
  }
}

/** vault 必须已初始化（含 .llm-wiki.json） */
export function assertVaultInitialized(root: string): void {
  if (!existsSync(path.join(root, VAULT_MARKER_FILE))) {
    throw new ConfigError(
      'VAULT_NOT_FOUND',
      `目录尚未初始化为 vault（缺 ${VAULT_MARKER_FILE}）：${root}`,
    );
  }
}
