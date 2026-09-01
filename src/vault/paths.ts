/**
 * 路径白名单与归一化（01 §3）。
 *
 * agent 生成的 wiki 文件名 / 相对路径必须过这层校验，防目录逃逸。
 * 逐条对照 claude-obsidian `transaction.py` 的 `_normalize_vault_path` /
 * `_assert_portable_write_path` 移植。
 */

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Stats } from 'node:fs';

import { SafetyError, ValidationError } from '../errors';

/** 受保护目录：其「目录本体」不可被写成文件 */
export const RESERVED_WRITE_DIRS = new Set(['.vault-meta', '.index', 'raw', 'wiki', '.git']);

/** 受保护文件 */
export const RESERVED_WRITE_FILES = new Set(['.llm-wiki.json']);

/** `:` 单列（NTFS 备用数据流）；其余为 Win32 非法字符 */
const UNPORTABLE_CHARS = new Set([...'<>|?*"']);

/** claude-obsidian MAX_TRANSACTION_PATH_BYTES */
export const MAX_PATH_BYTES = 1024;

/** Windows 保留设备名（不区分大小写） */
export const RESERVED_DEVICE_NAMES = new Set(
  [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
  ].map((s) => s.toUpperCase()),
);

/**
 * 结构层校验：空 / 反斜杠与控制字符 / 归一形态 / `..` 段 / NFC / 长度。
 * 通过则返回原路径（已保证是归一形态）。
 */
export function normalizeVaultPath(value: string): string {
  if (!value) throw new ValidationError('EMPTY_PATH', '空路径');

  // 控制字符与反斜杠（照抄：\x00 \n \r 与反斜杠一并拒）
  if (/[\x00\n\r]/.test(value) || value.includes('\\')) {
    throw new ValidationError('BACKSLASH_OR_CONTROL', '路径禁止反斜杠与控制字符');
  }

  // canonical 形式：必须是已归一的 posix 形态（拒绝 ./、//、尾斜杠、前导 /）
  //
  // 骨架修正：原骨架只 filter 空串，导致 `./a` 的 `.` 段被保留、判不出 NONCANONICAL
  // （T1.2-03 要求拒绝 `./a`）。这里把 `.` 段一并滤除再比对。
  if (value !== value.split('/').filter((s) => s.length > 0 && s !== '.').join('/')) {
    throw new ValidationError('NONCANONICAL_PATH', `路径须为归一形态：${value}`);
  }

  // `..` 按路径段判（子串判会误伤合法文件名如 a..b.md —— 照抄 parsed.parts 判法）
  if (value.split('/').some((seg) => seg === '..')) {
    throw new ValidationError('PARENT_ESCAPE', '路径段不得为 ..（目录逃逸）');
  }

  // NFC Unicode 归一（CJK 文件名必需）
  if (value.normalize('NFC') !== value) {
    throw new ValidationError('NON_NFC_PATH', '路径须为 NFC 归一形式');
  }

  if (Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    throw new ValidationError('PATH_TOO_LONG', `路径超 ${MAX_PATH_BYTES} 字节`);
  }

  return value;
}

/**
 * 便携性 + 保留路径层校验：NTFS 备用数据流、Win32 非法字符、段尾点/空格、
 * 保留设备名、受保护目录与文件。
 */
export function assertPortableWritePath(value: string): void {
  const rel = normalizeVaultPath(value);

  if (rel.includes(':')) {
    throw new ValidationError('NTFS_STREAM', '路径禁止 NTFS 备用数据流 (:)');
  }

  for (const ch of rel) {
    if (UNPORTABLE_CHARS.has(ch)) {
      throw new ValidationError('UNPORTABLE_CHAR', `路径含便携文件系统不安全字符：${rel}`);
    }
  }

  // 逐段校验：结尾点/空格与保留设备名都是 per-component，不是只看最后一段
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') continue; // 结构问题归 normalizeVaultPath 管
    if (/[. ]$/.test(seg)) {
      throw new ValidationError('TRAILING_DOT_SPACE', `路径段结尾不能是 . 或空格：${seg}`);
    }
    if (RESERVED_DEVICE_NAMES.has(seg.split('.', 1)[0]!.toUpperCase())) {
      throw new ValidationError('RESERVED_NAME', `保留设备名：${seg}`);
    }
  }

  const segments = rel.split('/');
  const top = segments[0]!;

  if (RESERVED_WRITE_DIRS.has(top) && segments.length === 1) {
    throw new ValidationError('RESERVED_PATH', `受保护目录本体不可写为文件：${rel}`);
  }
  if (RESERVED_WRITE_DIRS.has(top) && top === '.vault-meta') {
    throw new ValidationError('RESERVED_PATH', '.vault-meta 整目录只可经事务 API 写');
  }
  if (RESERVED_WRITE_FILES.has(rel)) {
    throw new ValidationError('RESERVED_PATH', `受保护文件不可写：${rel}`);
  }
}

/* ------------------------------------------------------------------ *
 * §3.1 symlink / 重解析点拒绝（对应 paths.py 的 assert_within / is_name_surrogate）
 * ------------------------------------------------------------------ */

/**
 * 解析后的真实路径必须仍在 vault 内。
 *
 * 用 `realRoot + path.sep` 而非裸前缀比较，避免 `/vault2` 被当成 `/vault` 的子路径。
 */
export function assertWithin(root: string, candidate: string, allowRoot = false): void {
  const real = realpathSync(candidate);
  const realRoot = realpathSync(root);
  if (!real.startsWith(realRoot + path.sep) && !(allowRoot && real === realRoot)) {
    throw new SafetyError('PATH_OUTSIDE_VAULT', `路径越界：${candidate} 不在 ${root} 内`);
  }
}

/**
 * 写前对每个目标用 lstat 拒绝 symlink / 重解析点。
 *
 * 向上遍历目标及其全部已存在祖先：任一层是别名即拒绝（fail-closed）。
 * 目标本身不存在时（新建文件）lstat 抛错即停止该层，继续检查父目录。
 *
 * 遍历上界是文件系统根，因此 vault root 之上的路径若在 symlink 下也会被拒 ——
 * 这是刻意的保守取向；本机实测 `%TEMP%` 祖先链无重解析点，不影响正常使用
 * （实测结论见 test/vault/symlink.test.ts 末尾注释）。
 */
export function assertUnaliased(target: string): void {
  let p: string | null = target;
  while (p) {
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch {
      // 骨架修正：目标层不存在（ENOENT 等）时跳过该层、继续向上检查祖先链。
      // 原骨架在此处 break，会让「经软链目录写新文件」漏检（T1.3-01d 即其回归）。
      const parent = path.dirname(p);
      if (parent === p) break;
      p = parent;
      continue;
    }
    if (isNameSurrogate(st)) {
      throw new SafetyError('SYMLINK_ESCAPE', `拒绝经软链/重解析点写入：${p}`);
    }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
}

/**
 * 别名（symlink / junction / mount point）判定。
 *
 * 01 §5.1：Node/libuv 的 `lstat` 把 junction 报告为 symlink（与 Python 3.8 的坑不同），
 * 故两个平台都只需 `isSymbolicLink()`。已在 win32 真实 junction 样本上实测确认
 * （test/vault/symlink.test.ts 的 T1.3-03）。
 */
function isNameSurrogate(st: Stats): boolean {
  return st.isSymbolicLink();
}
