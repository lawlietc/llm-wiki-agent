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
  /** 【M14】内容指纹（对 adapter 产出的 body 求 sha256 hex；ingest 编排层计算注入）。缺省 = 存量兼容形态 */
  sourceSha256?: string;
}

/**
 * ai-first 完整页模板：frontmatter + `## For future agent` 前言 + `## 正文` 三段。
 */
export function renderWikiNote(fm: NoteFrontmatter, preamble: string, body: string): string {
  return `---\n${renderFrontmatter(fm)}\n---\n\n## For future agent\n\n${preamble}\n\n## 正文\n\n${body}\n`;
}

/**
 * raw source 页模板（02 §1 表 / I3；M14 增 source_sha256）：
 * 免前言；frontmatter `type: source` + `source_url` + `fetched_at`（+ `source_sha256`）；
 * body verbatim（不改写、不 trim）。
 * 手拼字符串（不走 renderFrontmatter）：sha256 hex 常以数字开头，
 * serializeScalar 会给它加引号——裸串由本模板保证（M14 D3/T14.1-02）。
 */
export function renderRawNote(body: string, meta: SourceMeta): string {
  const shaLine = meta.sourceSha256 != null ? `\nsource_sha256: ${meta.sourceSha256}` : '';
  return `---\ntype: source\nsource_url: ${meta.sourceUrl}\nfetched_at: ${meta.fetchedAt}${shaLine}\n---\n\n${body}`;
}
