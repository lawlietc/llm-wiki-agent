/**
 * frontmatter 解析/渲染/校验（02 §2.1 + §5）。
 *
 * 解析器是「最小 YAML 子集」，覆盖 02 模板实际用到的语法：
 * - 顶层 `key: value` 标量（string/number/boolean/null）
 * - 流式数组 `[a, b, c]`（元素支持引号、裸词、嵌套数组）
 * - `[[wikilink]]` 双中括号整体作为字符串元素（Obsidian 语法，不是 YAML 嵌套数组）
 * - 块式列表 `- item`
 * - 缩进嵌套对象（如 relations，2 空格）
 *
 * 校验分层：parse 只做「语法解析」（损坏结构报 MALFORMED_FRONTMATTER）；
 * date 格式 / type 合法 / 必备字段 / confidence 域属于 validateFrontmatter 层
 * （lint 需要拿到 `date: today` 这类非法值才能报 no-date-today，所以 parse 必须宽松）。
 */

import { ValidationError } from '../errors';
import { CONFIDENCE_LEVELS, NOTE_TYPES, NOTE_TYPE_REQUIRED_FIELDS, type NoteFrontmatter } from './types';

export const FRONTMATTER_FENCE = '---';

export interface ParsedNote {
  frontmatter: NoteFrontmatter;
  body: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------ 解析 ------------------------------ */

/** 解析完整页面：frontmatter + 正文分离 */
export function parseNote(content: string): ParsedNote {
  if (!content.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    throw new ValidationError('MALFORMED_FRONTMATTER', 'frontmatter 必须以 --- 开头');
  }

  // 找结束 fence：从第 2 行起找独立的 '---' 行
  const lines = content.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_FENCE) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    throw new ValidationError('MALFORMED_FRONTMATTER', 'frontmatter 缺少闭合 ---');
  }

  const fmLines = lines.slice(1, endIndex);
  // 空 frontmatter 也视为损坏（不能静默空对象）
  if (fmLines.every((l) => l.trim() === '')) {
    throw new ValidationError('MALFORMED_FRONTMATTER', 'frontmatter 为空');
  }

  const frontmatter = parseBlock(fmLines) as unknown as NoteFrontmatter;

  // 正文：结束 fence 之后的内容，去掉紧跟的一个空行（render 用 '---\n\n' + body 组装）
  const after = lines.slice(endIndex + 1).join('\n');
  const body = after.replace(/^\n/, '');

  return { frontmatter, body };
}

/** 只取 frontmatter（lint / 其它读 frontmatter 的入口） */
export function parseFrontmatter(content: string): NoteFrontmatter {
  return parseNote(content).frontmatter;
}

/** 解析 frontmatter 文本块（不含围栏），递归处理嵌套对象与块式列表 */
function parseBlock(lines: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    if (trimmed.startsWith('- ')) {
      throw new ValidationError('MALFORMED_FRONTMATTER', `意外的顶层列表项：${trimmed}`);
    }

    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!m) {
      throw new ValidationError('MALFORMED_FRONTMATTER', `无法解析的行：${trimmed}`);
    }
    const key = m[1]!;
    const valueRaw = m[2]!.trim();
    i++;

    if (valueRaw !== '') {
      obj[key] = parseValue(valueRaw);
      continue;
    }

    // 空值：看后续行决定是块式列表还是嵌套对象
    const nextNonEmpty = lines.slice(i).find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    if (nextNonEmpty === undefined) {
      obj[key] = undefined;
      continue;
    }
    const nextIndent = nextNonEmpty.length - nextNonEmpty.trimStart().length;
    if (nextIndent <= 0) {
      obj[key] = undefined; // 后续是平级键 → 本键为空
      continue;
    }
    if (nextNonEmpty.trimStart().startsWith('- ')) {
      // 块式列表
      const items: unknown[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.trim() === '') {
          i++;
          continue;
        }
        if (!l.trimStart().startsWith('- ')) break;
        items.push(parseScalar(l.trimStart().slice(2).trim()));
        i++;
      }
      obj[key] = items;
      continue;
    }
    // 嵌套对象（缩进子块）
    const sub = parseBlockAtIndent(lines, i, nextIndent);
    obj[key] = sub.obj;
    i = sub.next;
  }
  return obj;
}

/** 从指定行解析缩进为 indent 的子块，返回子对象与下一行位置 */
function parseBlockAtIndent(
  lines: string[],
  start: number,
  indent: number,
): { obj: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const curIndent = line.length - line.trimStart().length;
    if (curIndent < indent) break;
    if (curIndent > indent) {
      throw new ValidationError('MALFORMED_FRONTMATTER', `非法缩进：${trimmed}`);
    }
    if (trimmed.startsWith('- ')) {
      throw new ValidationError('MALFORMED_FRONTMATTER', `子块中的意外列表项：${trimmed}`);
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!m) {
      throw new ValidationError('MALFORMED_FRONTMATTER', `无法解析的行：${trimmed}`);
    }
    const key = m[1]!;
    const valueRaw = m[2]!.trim();
    i++;

    if (valueRaw !== '') {
      obj[key] = parseValue(valueRaw);
      continue;
    }
    // 子块内的块式列表 / 更深嵌套
    const deeper = lines.slice(i).find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    if (deeper === undefined || deeper.length - deeper.trimStart().length < indent + 1) {
      obj[key] = undefined;
      continue;
    }
    const nextIndent = deeper.length - deeper.trimStart().length;
    if (nextIndent <= indent) {
      obj[key] = undefined;
      continue;
    }
    if (deeper.trimStart().startsWith('- ')) {
      const items: unknown[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.trim() === '') {
          i++;
          continue;
        }
        if (!l.trimStart().startsWith('- ')) break;
        items.push(parseScalar(l.trimStart().slice(2).trim()));
        i++;
      }
      obj[key] = items;
      continue;
    }
    const sub = parseBlockAtIndent(lines, i, nextIndent);
    obj[key] = sub.obj;
    i = sub.next;
  }
  return { obj, next: i };
}

/**
 * 值位置解析：
 * - `[[wikilink]]` → 单元素数组 `["[[wikilink]]"]`（frontmatter 中 wikilink 只出现在
 *   relations 值里，其类型是 Record<string, string[]>，02 §3）；
 * - 否则走通用标量。
 */
function parseValue(raw: string): unknown {
  if (raw.startsWith('[[') && raw.endsWith(']]')) return [raw];
  return parseScalar(raw);
}

/** 标量解析：wikilink / null / 布尔 / 数字 / 数组 / 字符串 */
function parseScalar(raw: string): unknown {
  if (raw.startsWith('[[') && raw.endsWith(']]')) return raw; // 数组元素位置的 wikilink 原样字符串
  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) return parseArray(raw);
  return unquote(raw);
}

/** 流式数组解析（支持引号元素与嵌套数组；wikilink 元素先被 parseScalar 接住） */
function parseArray(raw: string): unknown[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  const items: unknown[] = [];
  let cur = '';
  let depth = 0;
  let inQuote: string | null = null;
  for (const ch of inner) {
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === ']') {
      depth--;
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      items.push(parseScalar(cur.trim()));
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') items.push(parseScalar(cur.trim()));
  return items;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/* ------------------------------ 渲染 ------------------------------ */

/** 渲染 frontmatter（不含围栏），供 renderWikiNote / renderRawNote 组装 */
export function renderFrontmatter(fm: NoteFrontmatter): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv === undefined) continue;
        lines.push(`  ${sk}: ${serializeScalar(sv)}`);
      }
    } else {
      lines.push(`${k}: ${serializeScalar(v)}`);
    }
  }
  return lines.join('\n');
}

function serializeScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    // 含特殊字符（[ ] : # ' 或首尾空格/数字开头）才加引号，保持可读性；
    // 例外：YYYY-MM-DD 日期保持裸串（M13 D6——加引号会破坏 DATE_RE 校验）
    if (
      /^[A-Za-z0-9_\-./: ]+$/.test(v) &&
      v.trim() === v &&
      (!/^\d/.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v))
    ) {
      return v;
    }
    return `'${v.replace(/'/g, "''")}'`;
  }
  if (Array.isArray(v)) return `[${v.map(serializeScalar).join(', ')}]`;
  // 对象在顶层处理；嵌套对象直接 JSON 化兜底（理论到不了）
  return JSON.stringify(v);
}

/* ------------------------------ 校验 ------------------------------ */

/** 返回合规问题列表（空 = 合规）。不抛错，供调用方选择处理 */
export function validateFrontmatter(fm: NoteFrontmatter): string[] {
  const problems: string[] = [];
  const type = fm.type;

  if (!NOTE_TYPES.has(type)) {
    problems.push(`未知 type: ${String(type)}`);
  }

  if (type !== 'source') {
    // source（raw/ 原文）免前言、无 date/ai-first/confidence（02 §1 表）
    if (typeof fm.date !== 'string' || !DATE_RE.test(fm.date)) {
      problems.push('date 须为 YYYY-MM-DD');
    }
    if (fm['ai-first'] !== true) {
      problems.push('ai-first 须为 true');
    }
    if (!CONFIDENCE_LEVELS.includes(fm.confidence as (typeof CONFIDENCE_LEVELS)[number])) {
      problems.push('confidence 须为 stated/high/medium/speculation 之一');
    }
  }

  for (const field of NOTE_TYPE_REQUIRED_FIELDS[type as keyof typeof NOTE_TYPE_REQUIRED_FIELDS] ?? []) {
    if (fm[field] === undefined || fm[field] === null) {
      problems.push(`缺 ${type} 必备字段: ${field}`);
    }
  }
  return problems;
}

/** 有任一问题即抛 ValidationError(INVALID_FRONTMATTER) */
export function assertValidFrontmatter(fm: NoteFrontmatter): void {
  const problems = validateFrontmatter(fm);
  if (problems.length > 0) {
    throw new ValidationError('INVALID_FRONTMATTER', problems.join('; '));
  }
}
