/**
 * 输出格式化（M6 §2 命令面；纯函数，无 I/O、无副作用，便于单测断言）。
 *
 * 颜色仅在 `color=true`（真实 TTY）时加 ANSI 码；非 TTY（测试/CI）输出纯文本，
 * 便于 grep 断言与密钥零泄漏检查（I2）。
 */

import type { SynthesisResult } from '../qa/synthesize';
import type { LintIssue } from '../notes/lint';

export interface StatusInfo {
  root: string;
  source: string;
  pages: number;
  dirty: boolean;
  providers: string[];
}

/** 变更文件清单（dry-run→approve 暂停点展示用） */
export function formatChangedPaths(paths: string[]): string {
  if (paths.length === 0) return '拟变更文件：（无）';
  return ['拟变更文件：', ...paths.map((p) => `  - ${p}`)].join('\n');
}

/** 综合层三段式输出：答案 / 引用 / gaps */
export function formatAskResult(r: SynthesisResult): string {
  const lines: string[] = [];
  lines.push('答案：');
  lines.push(r.answer.trim());
  lines.push('');
  lines.push('引用：');
  if (r.citations.length === 0) lines.push('  （无）');
  else for (const c of r.citations) lines.push(`  - ${c}`);
  lines.push('');
  lines.push('待补充（gaps）：');
  if (r.gaps.length === 0) lines.push('  （无已知缺口）');
  else for (const g of r.gaps) lines.push(`  - ${g}`);
  return lines.join('\n');
}

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** lint 结果输出：error 红 / warn 黄（仅 TTY 上色）；零问题返回 OK */
export function formatLint(issues: LintIssue[], color: boolean): string {
  if (issues.length === 0) return 'OK：未发现问题。';
  const lines = issues.map((i) => {
    const tag = i.severity === 'error' ? 'ERROR' : 'WARN';
    const body = `[${tag}] ${i.rule}: ${i.message}`;
    if (!color) return body;
    return i.severity === 'error' ? `${RED}${body}${RESET}` : `${YELLOW}${body}${RESET}`;
  });
  return lines.join('\n');
}

/** vault 状态输出 */
export function formatStatus(info: StatusInfo): string {
  return [
    `vault 根: ${info.root}`,
    `来源: ${info.source}`,
    `wiki 页数: ${info.pages}`,
    `索引状态: ${info.dirty ? 'dirty（需重建）' : '最新'}`,
    `providers: ${info.providers.join(', ') || '（无）'}`,
  ].join('\n');
}

/**
 * 行级 diff（LCS 算法），供 edit 的 diff 摘要展示。
 * 返回统一 diff 风格文本：`  ` 不变 / `- ` 删 / `+ ` 增。
 */
export function diffLines(a: string, b: string): string {
  const aL = a.split('\n');
  const bL = b.split('\n');
  const n = aL.length;
  const m = bL.length;

  // dp[i][j] = LCS 长度(a[i..], b[j..])
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = aL[i] === bL[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aL[i] === bL[j]) {
      out.push(`  ${aL[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${aL[i]}`);
      i++;
    } else {
      out.push(`+ ${bL[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${aL[i++]}`);
  while (j < m) out.push(`+ ${bL[j++]}`);
  return out.join('\n');
}
