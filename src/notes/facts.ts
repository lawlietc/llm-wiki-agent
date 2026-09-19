/**
 * 实体页「事实段」（M20 工单 05）。
 *
 * 引用式抽取（工单 04）产出的事实落进实体页的 `## 事实` 段：**逐字**原文 + 源片段锚点。
 * 按**源**分块（`### <raw 页>`），使多源事实天然可并存——同一实体的两个源各自保留
 * 自己的事实，谁也不再顶掉谁（与工单 03 的指针多值化同一动机）。
 *
 * 三条不变量：
 * - **逐字**：事实正文不经改写、不折叠换行（块内可多行，故用「正文块 + 独占一行的锚点」
 *   而非 markdown 列表项——列表项扛不住多行正文）；
 * - **幂等**：同一源重复注入结果一致（先替换该源块）；
 * - **不越权**：本次没有事实（single 模式 / 引用全被门控丢弃）→ **整段不触碰**，
 *   既有事实既不新增也不删除（默认路径零影响，I47）。
 *
 * 纯文本层：不解析 frontmatter、不动页面其余字节。
 */

import { isSourceAnchor, parseSourceAnchor, renderSourceAnchor } from './source-anchor';
import { findSectionHeading, replaceSection, sectionEnd } from './markdown-section';

/** 事实段标题（固定，供渲染与解析共用） */
export const FACTS_HEADING = '## 事实';

/** 段首说明行（告知 agent 与读者锚点的读法） */
const FACTS_NOTE = '> 每条逐字取自源片段；紧随其后的 [src:<源页>#chunk-<N>] 指向该源原文的第 N 块。';

/** 源事实（与 `FactRef` 同形，但归属已由所在源块确定） */
export interface SourceFact {
  text: string;
  chunkIndex: number;
}

/** 源事实表：源页相对路径 → 该源的事实（按块号升序） */
export type FactsBySource = Map<string, SourceFact[]>;

/** 解析页面的 `## 事实` 段 → 按源分组的事实表（无该段/无有效条目 → 空表） */
export function readFactsBySource(content: string): FactsBySource {
  const table: FactsBySource = new Map();
  const lines = content.split('\n');
  const head = findSectionHeading(lines, FACTS_HEADING);
  if (head === -1) return table;

  let current: string | null = null;
  let block: string[] = [];
  const flush = (): void => {
    if (current === null || block.length === 0) return;
    // 块尾必须是锚点行；锚点前的若干行（可多行）即逐字正文
    const last = block[block.length - 1]!;
    const parsed = parseSourceAnchor(last);
    if (parsed !== null && parsed.sourceRef === current) {
      const text = block.slice(0, -1).join('\n');
      if (text !== '') {
        const list = table.get(current) ?? [];
        list.push({ text, chunkIndex: parsed.chunkIndex });
        table.set(current, list);
      }
    }
    block = [];
  };

  for (let i = head + 1; i < sectionEnd(lines, head); i++) {
    const line = lines[i]!;
    const srcHeading = /^### (.+)$/.exec(line);
    if (srcHeading !== null) {
      flush();
      current = srcHeading[1]!.trim();
      continue;
    }
    if (current === null) continue;
    if (line.trim() === '') {
      flush();
      continue;
    }
    block.push(line);
  }
  flush();

  for (const [ref, facts] of table) {
    facts.sort((a, b) => a.chunkIndex - b.chunkIndex);
    table.set(ref, facts);
  }
  return table;
}

/** 读某个源的事实（测试与检索用；无 → 空数组） */
export function readSourceFacts(content: string, sourceRef: string): SourceFact[] {
  return readFactsBySource(content).get(sourceRef) ?? [];
}

/** 渲染事实段（按表内顺序：先到先排、新源追加在后 → 确定性） */
function renderFactsSection(table: FactsBySource): string {
  const lines: string[] = [FACTS_HEADING, '', FACTS_NOTE];
  for (const [ref, facts] of table) {
    if (facts.length === 0) continue;
    lines.push('', `### ${ref}`, '');
    for (const f of facts) {
      lines.push(f.text, renderSourceAnchor(ref, f.chunkIndex), '');
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** 用新段替换页面里的事实段（无则追加到文末；空串 = 整段移除）；页面其余字节不变 */
function replaceFactsSection(content: string, section: string): string {
  return replaceSection(content, FACTS_HEADING, section);
}

/**
 * 注入「本次源」的事实（工单 04 的引用结果 → 实体页）。
 *
 * @param content 目标页内容（通常刚渲染/改写过的实体页）
 * @param sourceRef 本次来源（raw 页相对路径），事实锚点归属它
 * @param facts 本次源通过门控的事实（**空 → 原样返回**：不触碰既有事实段）
 * @param inheritFrom 既有页内容（迁移/重渲染时提供）：其它源的事实块随着搬家一起继承，
 *   否则「毕业」重渲染会把前一源的事实整段丢掉
 */
export function withSourceFacts(
  content: string,
  sourceRef: string,
  facts: readonly SourceFact[],
  inheritFrom?: string,
): string {
  if (facts.length === 0) return content; // 本次无事实 → 既有的不增不减（I47 默认路径零影响）
  const base = readFactsBySource(inheritFrom ?? content);

  // 顺序：既有源保持原序，本次源若为旧源则原位更新、若为新源则追加在后
  const ordered: FactsBySource = new Map();
  for (const [ref, list] of base) {
    if (ref === sourceRef) continue;
    ordered.set(ref, list);
  }
  ordered.set(sourceRef, [...facts].sort((a, b) => a.chunkIndex - b.chunkIndex));

  return replaceFactsSection(content, renderFactsSection(ordered));
}

/** 页面里出现的全部源锚点（顺序即出现顺序；测试与自检用） */
export function anchorsIn(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => isSourceAnchor(l));
}

/* ------------------------------ 源回收（M20 工单 07） ------------------------------ */

/**
 * 移除若干源的**整个事实块**（回收「只由这些源支撑」的事实）。
 *
 * 事实块天然按源分组（`### <raw 页>`），所以「只由 A 支撑的事实」= A 名下的那几个块；
 * 移除它不会碰到其他源的事实（I45）。
 *
 * - 移除后**没有任何源还有事实** → 整个 `## 事实` 段一并移除（不留空段）；
 * - 移除后仍有其他源 → 重渲染该段（其余源逐字保留、顺序不变）；
 * - 页面本无 `## 事实` 段，或这些源本就没有块 → **原样返回**（幂等、零改动）。
 */
export function withoutSourceFacts(content: string, removed: ReadonlySet<string>): string {
  const table = readFactsBySource(content);
  if (table.size === 0) return content;

  const kept: FactsBySource = new Map();
  let changed = false;
  for (const [ref, facts] of table) {
    if (removed.has(ref)) {
      changed = true;
      continue;
    }
    kept.set(ref, facts);
  }
  if (!changed) return content;
  return replaceFactsSection(content, kept.size === 0 ? '' : renderFactsSection(kept));
}
