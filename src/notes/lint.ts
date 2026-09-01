/**
 * write-time lint（02 §6，正则逐字采用修正版）。
 *
 * 纯函数、无 I/O（M2 DoD）。error 级 issue ≥1 时调用方（M4）必须拒绝落盘；
 * 本模块只报告不裁决（M2 I1）。
 */

import { parseFrontmatter } from './frontmatter';

export interface LintIssue {
  rule: string;
  message: string;
  severity: 'error' | 'warn';
}

/**
 * 规则清单（02 §6）：
 * error 级：no-date-today / preamble / ai-first-flag / confidence
 * warn 级：recency / sources / no-curly-quotes / wikilinks
 */
export function lintNote(relPath: string, content: string): LintIssue[] {
  void relPath; // 签名保留路径参数（后续版本可能用于按目录差异化规则），当前不使用
  const issues: LintIssue[] = [];
  const fm = parseFrontmatter(content);

  // 反模式检查（02 §6：Common Anti-Patterns 节）
  if (fm.date === 'today') {
    issues.push({ rule: 'no-date-today', message: 'date 禁止用 today', severity: 'error' });
  }
  if (!content.includes('## For future agent')) {
    issues.push({ rule: 'preamble', message: '缺 For future agent 前言', severity: 'error' });
  }
  if (fm['ai-first'] !== true) {
    issues.push({ rule: 'ai-first-flag', message: '缺 ai-first: true', severity: 'error' });
  }
  if (!fm.confidence) {
    issues.push({ rule: 'confidence', message: '缺 confidence', severity: 'error' });
  }

  // recency：外部事实必须有 as_of + sources。
  // 该正则召回有限（只覆盖常见表述），MVP 以 warn 提示为主（02 §6 注释；校验报告 P1-2 已定降级）
  const hasExternalClaim = /\(as of|据报道|融了|发布了/.test(content);
  if (hasExternalClaim && !fm.as_of) {
    issues.push({ rule: 'recency', message: '疑似外部事实缺 as_of', severity: 'warn' });
  }
  if (hasExternalClaim && (!fm.sources || fm.sources.length === 0)) {
    issues.push({ rule: 'sources', message: '疑似外部事实缺 sources', severity: 'warn' });
  }

  // em-dash / 弯引号是英文 AI 写作反模式。中文正文天然用全角标点，
  // 仅在【紧邻 ASCII 字母数字】时才判为英文语境反模式（02 §6 已修正的正则，I4）
  if (/[\w][”’—]|[“‘—][\w]/.test(content)) {
    issues.push({ rule: 'no-curly-quotes', message: '英文语境禁用 em-dash/弯引号，用 ASCII', severity: 'warn' });
  }

  // wikilinks 必填：正文出现大写开头实体 ≥2 处但全文无 [[ 时提示。
  // 修正后的正则不含首字符类 `[`（原稿 `[[A-Z]...` 会把 markdown 链接 `[Title](url)`
  // 整体误判为实体；修正后只命中 Title 单个词，单链接场景不再误触发）
  const entityHits = content.match(/\b[A-Z][a-zA-Z0-9]*(?:[ -][A-Z][a-zA-Z0-9]+)*\b/g) ?? [];
  if (entityHits.length >= 2 && !content.includes('[[')) {
    issues.push({ rule: 'wikilinks', message: '提及实体未用 [[wikilink]]', severity: 'warn' });
  }

  return issues;
}
