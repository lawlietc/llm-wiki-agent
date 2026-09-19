/**
 * F15.4 溯源指针注入（M15 D9/D10）→ M20 工单 03：**指针多值化**。
 *
 * 沿用 `withFrontmatterRelations` 的文本层惯例——不用 parse + render 重写
 * （renderFrontmatter 会给 date 加引号、破坏 DATE_RE）。只动指针键，
 * 页面其余部分字节不变。
 *
 * 形态演进（工单 03）：
 * - **集合键 `source_refs`**（flow array）：`source_refs: [raw/a.md, raw/b.md]`。
 *   同一页被多个源共同支撑时**取并集**，不再互相顶掉。
 * - **旧单值键 `raw_source`**：读侧兼容（`readSourceRefs` 一并返回），
 *   下次被写入时自然升级为集合形态（写侧会移除旧键）。
 *
 * 指针值 = 来源 raw 页相对路径（本次 ingest 由代码计算注入，LLM 不参与，I26）。
 */

import { parseFrontmatter } from './frontmatter';

/** 集合形态的指针键（工单 03 起为权威形态） */
export const SOURCE_REFS_KEY = 'source_refs';

/** M15 时代的单值指针键（读侧兼容，写侧移除） */
export const LEGACY_SOURCE_KEY = 'raw_source';

/** 单个指针值的文本形态（含分隔符时加引号，保证 flow array 可被最小 YAML 子集解析） */
function serializeRef(ref: string): string {
  return /[,\[\]'"]/.test(ref) || ref.trim() !== ref ? `'${ref.replace(/'/g, "''")}'` : ref;
}

/** `source_refs: [a, b]` 一行；空集合返回空串（调用方据此删键） */
function formatSourceRefsLine(refs: readonly string[]): string {
  return refs.length > 0 ? `${SOURCE_REFS_KEY}: [${refs.map(serializeRef).join(', ')}]` : '';
}

/**
 * 读页面的溯源指针集合。
 * - 优先读集合键 `source_refs`（非法元素、重复项剔除）；
 * - 兼容 M15 的单值键 `raw_source`（追加到末尾，去重）。
 * 返回顺序 = 写入顺序（并集保序），可重复推导。
 */
export function readSourceRefs(fm: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim() !== '' && !out.includes(v)) out.push(v);
  };
  const refs = fm[SOURCE_REFS_KEY];
  if (Array.isArray(refs)) for (const r of refs) push(r);
  push(fm[LEGACY_SOURCE_KEY]);
  return out;
}

/** 页面的 frontmatter 行区间（含围栏校验）；非规范页面返回 null */
function frontmatterSpan(content: string): { lines: string[]; fenceEnd: number } | null {
  if (!content.startsWith('---\n')) return null;
  const lines = content.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return { lines, fenceEnd: i };
  }
  return null;
}

/** 既有指针（解析失败 → 空集：宁可少删也不破坏页面） */
function existingRefsOf(content: string): string[] {
  try {
    return readSourceRefs(parseFrontmatter(content) as unknown as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * 把指针键写回页面（文本层，幂等）：
 * - 移除既有的 `source_refs` / `raw_source` 键（含其块式列表续行）；
 * - 在 frontmatter 首行写入新集合（与 M15 的插入位置一致）；
 * - 其余 frontmatter 行与正文逐字保留。
 * @param mode 'union' 取并集（ingest 路径）；'replace' 精确覆盖（retraction 路径）
 */
function writeSourceRefs(
  content: string,
  incoming: readonly string[],
  mode: 'union' | 'replace',
): string {
  const span = frontmatterSpan(content);
  if (span === null) return content;
  const { lines, fenceEnd } = span;

  const hadKeys = lines
    .slice(1, fenceEnd)
    .some((l) => /^source_refs:/.test(l) || /^raw_source:/.test(l));

  const merged =
    mode === 'replace'
      ? [...incoming]
      : (() => {
          const ordered = existingRefsOf(content);
          for (const r of incoming) if (!ordered.includes(r)) ordered.push(r);
          return ordered;
        })();
  // 无键可删（如新建页首次注入失败路径）+ 无值可写 → 原样返回
  if (merged.length === 0 && !hadKeys) return content;

  const kept: string[] = [];
  let skippingBlock = false;
  for (let i = 1; i < fenceEnd; i++) {
    const line = lines[i]!;
    const isRefKey = /^source_refs:/.test(line) || /^raw_source:/.test(line);
    if (isRefKey) {
      skippingBlock = /:\s*$/.test(line); // 空值 → 其块式列表续行也要吃掉
      continue;
    }
    if (skippingBlock) {
      const isContinuation = line.trim() === '' || /^\s/.test(line) || line.trimStart().startsWith('- ');
      if (isContinuation) continue;
      skippingBlock = false;
    }
    kept.push(line);
  }

  const refsLine = formatSourceRefsLine(merged);
  return ['---', ...(refsLine === '' ? [] : [refsLine]), ...kept, '---', ...lines.slice(fenceEnd + 1)].join('\n');
}

/**
 * 追加溯源指针（并集，幂等）。页面已含该源 → 字节不变。
 * @param rawRels 空数组 → 原样返回
 */
export function withFrontmatterSources(content: string, rawRels: readonly string[]): string {
  const add = rawRels.filter((r) => typeof r === 'string' && r.trim() !== '');
  if (add.length === 0) return content;
  return writeSourceRefs(content, add, 'union');
}

/** 单值便捷形态（ingest 主页注入沿用） */
export function withFrontmatterSource(content: string, rawRel: string): string {
  return withFrontmatterSources(content, [rawRel]);
}

/**
 * 精确改写指针集合（retraction 用，工单 07）：
 * 传空数组即**移除**指针键（页面已无任何源支撑时的产物）。
 */
export function replaceFrontmatterSources(content: string, rawRels: readonly string[]): string {
  return writeSourceRefs(content, rawRels, 'replace');
}
