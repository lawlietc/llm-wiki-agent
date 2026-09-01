/**
 * fixture vault 助手（SPEC-0 §2.5 接缝表）。
 *
 * 在临时目录建一个已初始化的 vault（含 `.llm-wiki.json` 与目录骨架），
 * 用例结束后递归删除。M1/M4/M5/M6 共用。
 *
 * 注意：临时目录前缀恒为 ASCII —— Windows 上非 ASCII 路径会引入编码坑
 * （M7 §4 提到测试脚本勿含非 ASCII 路径）。
 */

import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TempVault {
  /** realpath 解析后的 vault 根（symlink/junction 已展开，便于 assertWithin 断言） */
  root: string;
  configPath: string;
  /** 在该 vault 下建文件（相对路径，父目录自动创建） */
  write(relativePath: string, content: string): Promise<string>;
  /** 读文件（相对路径） */
  read(relativePath: string): Promise<string>;
  exists(relativePath: string): boolean;
  /** 绝对路径换算 */
  abs(relativePath: string): string;
  cleanup(): Promise<void>;
}

export interface MakeVaultOptions {
  /** 预置文件：相对路径 → 内容 */
  files?: Record<string, string>;
  /** 是否建 raw/ wiki/ .index/ .vault-meta/ 骨架，默认 true */
  scaffold?: boolean;
  /** 是否写 .llm-wiki.json（vault 已初始化标记），默认 true */
  initialize?: boolean;
  /** 配置文件内容，默认最小可用配置 */
  config?: unknown;
}

const DEFAULT_CONFIG = { version: 1, vault: { schema: 'llm-wiki.vault.v1' } };

export async function makeVault(opts: MakeVaultOptions = {}): Promise<TempVault> {
  const { scaffold = true, initialize = true, config = DEFAULT_CONFIG } = opts;

  // realpath：Windows 的 %TEMP% 常含 junction/短名，不展开会让 assertWithin 的
  // startsWith(realRoot + sep) 断言在真实文件系统上出现假阴性。
  const raw = await mkdtemp(path.join(os.tmpdir(), 'llm-wiki-test-'));
  const root = await realpath(raw);

  const configPath = path.join(root, '.llm-wiki.json');

  if (scaffold) {
    for (const dir of ['raw', 'wiki', '.index', '.vault-meta']) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
  }
  if (initialize) {
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  const vault: TempVault = {
    root,
    configPath,
    abs(rel) {
      return path.join(root, rel);
    },
    async write(rel, content) {
      const abs = path.join(root, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return abs;
    },
    async read(rel) {
      return readFile(path.join(root, rel), 'utf8');
    },
    exists(rel) {
      return existsSync(path.join(root, rel));
    },
    async cleanup() {
      // Windows 上文件句柄释放有延迟，直接 rm 偶发 EBUSY/EPERM，退避重试。
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  return vault;
}

/** 用例里配合 afterEach 使用：const v = await makeVault(); afterEach(v.cleanup) */
export function useVault(opts?: MakeVaultOptions): { vault: Promise<TempVault> } {
  return { vault: makeVault(opts) };
}
