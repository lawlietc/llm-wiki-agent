/**
 * M14 C3：source_url 规范化（来源身份单一化）。
 *
 * - file 输入 → realpath 绝对路径（剥 file:// 前缀；junction/短名/相对路径/正反斜杠
 *   全部展开）——TestWiki 三条同文重复 raw 页正是「同一文件不同路径形式」的实证
 *   （M14 §1.1）。realpath 失败（竞态删文件等）退回 path.resolve 兜底，不抛。
 * - 非 file 输入（URL）原样返回：URL 等价性（尾斜杠/utm/fragment）是独立议题，D5。
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

/** 去掉 `file://` 前缀（与 sources.ts 的 stripFileProto 同口径）；
 * Windows `file:///C:/x` 残留的 `/C:/...` 盘符斜杠一并剥掉 */
function stripFileProto(input: string): string {
  let p = input.replace(/^file:\/\//, '');
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

/** 是否 file 类输入（裸路径或 file:// 形态；与 FILE_ADAPTER.detect 同口径） */
function isFileInput(input: string): boolean {
  if (input.startsWith('file://')) return true;
  return /\.\w+$/.test(input);
}

/**
 * file 输入 → realpath 绝对路径；realpath 失败退回 resolve；非 file 输入原样返回。
 * @param cwd 相对路径的解析基准（默认 process.cwd()；测试注入用）
 */
export function normalizeSourceUrl(input: string, cwd: string = process.cwd()): string {
  if (!isFileInput(input)) return input;
  const p = stripFileProto(input);
  try {
    return realpathSync(p);
  } catch {
    const resolved = path.resolve(cwd, p);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
}
