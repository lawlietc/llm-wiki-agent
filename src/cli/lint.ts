/**
 * `wiki lint <file>` 命令（M6 F6.3 / 00 §8.1）。
 *
 * 只跑 M2 lint，输出 LintIssue 列表，**绝不修改文件**（T6.3-04）。exit code：有 error → 1；
 * 仅 warn → 0。颜色仅在 TTY 上色，非 TTY 输出纯文本（便于断言与 CI grep）。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { lintNote, type LintIssue } from '../notes/lint';
import { formatLint } from './format';
import type { CliIO } from './io';

export interface LintResult {
  issues: LintIssue[];
  exitCode: number;
}

/** @param filePath 相对 cwd 或绝对路径 */
export async function runLint(
  filePath: string,
  opts: { io: CliIO; cwd?: string },
): Promise<LintResult> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(opts.cwd ?? process.cwd(), filePath);
  const content = await readFile(abs, 'utf8');
  const issues = lintNote(abs, content);
  opts.io.out(formatLint(issues, opts.io.isTTY));
  const hasError = issues.some((i) => i.severity === 'error');
  return { issues, exitCode: hasError ? 1 : 0 };
}
