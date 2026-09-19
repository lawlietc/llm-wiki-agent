/**
 * 源片段锚点（M20 工单 05）。
 *
 * **解决什么问题**：引用式抽取（工单 04）保证「实体页上的事实逐字来自原文」，
 * 但读者无法核对——本模块给每条事实一个**可导航**的锚点，指向 raw 页里的具体一块。
 *
 * **命名空间隔离（硬要求）**：检索综合层已有形如 `[slug#chunk-NNN]` 的引用锚点
 * （`src/qa/synthesize.ts` 的 `CITATION_RE`），那是**面向 wiki 页**的引用。
 * 本模块的锚点是**面向源正文片段**的，两者必须不碰撞：
 * - 源锚点形如 `[src:<raw 页相对路径>#chunk-<N>]`，前缀 `src:` 使其**不可能**被
 *   `CITATION_RE`（要求 `#` 前只有 `[\w-]`）接受，也就绝不能被解析成页级 slug；
 * - 综合层对源锚点另有显式处理（见 `validateCitations`），不会误认、也不静默丢弃。
 *
 * **可重复推导**：raw 页把源正文**逐字**存放（`renderRawNote` 的 body 段），
 * 故 `chunkPage(rawBodyOf(raw 页))[N]` 是 (源页, 块号) → 正文 的唯一确定映射，
 * 任何时刻重跑都得到同一块（`resolveAnchorChunk`）。
 */

import { chunkPage } from './chunk';

/** 源锚点命名空间前缀（与页级引用 `[slug#chunk-N]` 明确区分） */
export const SOURCE_ANCHOR_PREFIX = 'src:';

/** 源锚点完全形态：`[src:<源页相对路径>#chunk-<N>]`（路径不含空白/`#`/`]`，与 rawSlugFor 产出相容） */
const SOURCE_ANCHOR_RE = /^\[src:([^\]#\s]+)#chunk-(\d+)\]$/;

/** 渲染源锚点（(源页, 块号) → 唯一字符串，故同一块恒得同一锚点，不产生同义异形） */
export function renderSourceAnchor(sourceRef: string, chunkIndex: number): string {
  return `[${SOURCE_ANCHOR_PREFIX}${sourceRef}#chunk-${chunkIndex}]`;
}

/** 是否为源片段锚点（严格完全匹配；用于与页级引用区分） */
export function isSourceAnchor(text: string): boolean {
  return SOURCE_ANCHOR_RE.test(text.trim());
}

/** 源锚点 → (源页, 块号)；非源锚点 → null */
export function parseSourceAnchor(text: string): { sourceRef: string; chunkIndex: number } | null {
  const m = SOURCE_ANCHOR_RE.exec(text.trim());
  if (m === null) return null;
  return { sourceRef: m[1]!, chunkIndex: Number(m[2]) };
}

/**
 * raw 页 → 其中的源正文（**逐字**）。
 * raw 页形态由 `renderRawNote` 固定：`---\n<frontmatter>\n---\n\n<body>`，
 * body 不改写不 trim，故此处按行还原即得原始 body。
 * 结构不符（无 frontmatter 围栏）→ 原样返回（防御性，不猜）。
 */
export function rawBodyOf(rawContent: string): string {
  const lines = rawContent.split('\n');
  if (lines[0] !== '---') return rawContent;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return lines.slice(i + 2).join('\n'); // 跳过闭合围栏与其后的空行
  }
  return rawContent;
}

/**
 * 锚点 + 源页内容 → 被引用的那一块正文。
 * 解析失败或块号越界 → undefined（调用方据此判定「锚点不可回查」）。
 */
export function resolveAnchorChunk(anchor: string, rawContent: string): string | undefined {
  const parsed = parseSourceAnchor(anchor);
  if (parsed === null) return undefined;
  return chunkPage(rawBodyOf(rawContent))[parsed.chunkIndex];
}
