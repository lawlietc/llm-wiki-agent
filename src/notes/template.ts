/**
 * 页模板（02 §2）：renderWikiNote（ai-first 完整页）与 renderRawNote（raw source 页，免前言）。
 */

import { renderFrontmatter } from './frontmatter';
import type { NoteFrontmatter } from './types';

/** 来源元数据（05 §4 定稿；camelCase 接口，落盘 frontmatter 用 snake_case） */
export interface SourceMeta {
  sourceUrl: string;
  fetchedAt: string; // ISO 8601
  mime?: string;
}

/**
 * ai-first 完整页模板：frontmatter + `## For future agent` 前言 + `## 正文` 三段。
 */
export function renderWikiNote(fm: NoteFrontmatter, preamble: string, body: string): string {
  return `---\n${renderFrontmatter(fm)}\n---\n\n## For future agent\n\n${preamble}\n\n## 正文\n\n${body}\n`;
}

/**
 * raw source 页模板（02 §1 表 / I3）：
 * 免前言；frontmatter 仅 `type: source` + `source_url` + `fetched_at` 三字段；
 * body verbatim（不改写、不 trim）。
 */
export function renderRawNote(body: string, meta: SourceMeta): string {
  return `---\ntype: source\nsource_url: ${meta.sourceUrl}\nfetched_at: ${meta.fetchedAt}\n---\n\n${body}`;
}
