/**
 * F10.4 实体/概念词条页工厂（确定性、零 LLM，07 规划 D2/D6）。
 *
 * - renderEntityPage：page（整页，含 Mentions 溯源段）/ stub（最小占位，frontmatter
 *   标 `stub: true`，待后续补全时 promotion 剥离）两种形态。stub 用抽取自身已产出的
 *   summary 直接落页（obsidian-llm-wiki `stub-page.ts` 的确定性原则，不额外调 LLM）。
 * - withFrontmatterRelations：文本层把 relations 块注入页面 frontmatter
 *   （保持页面其余部分字节不变；已有 relations 块先移除再写入 = 幂等）。
 *
 * 词条页 type 取注册表中最接近的 `idea`（02 §5 类型表封闭），真实实体类别记在
 * `entity_kind` 字段；status: captured（stub）/ active（page）对应两阶富集节奏。
 */

import { renderFrontmatter } from './frontmatter';
import type { NoteFrontmatter } from './types';
import type { EntityKind } from '../ingest/candidate-gate';

export interface EntityPageInput {
  name: string;
  slug: string;
  kind: EntityKind;
  /** page = 存活候选整页；stub = 分歧候选最小占位 */
  outcome: 'page' | 'stub';
  /** YYYY-MM-DD（取 raw fetched_at 日期） */
  date: string;
  summary?: string;
  aliases?: string[];
  /** type → ['[[target]]']（已含 inverse 反向边） */
  relations?: Map<string, string[]>;
  /** Mentions 溯源：原文摘录 + 来源 wiki 页 slug */
  mention?: { quote: string; wikiSlug: string };
}

/** relations Map → frontmatter 值对象（Record<type, ['[[x]]']>） */
function relationsToFm(relations: Map<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [type, links] of relations) {
    if (links.length > 0) out[type] = [...links];
  }
  return out;
}

/** 生成实体页完整内容（可直接经 VaultWriteOp 落盘） */
export function renderEntityPage(input: EntityPageInput): string {
  const isStub = input.outcome === 'stub';
  const fm: NoteFrontmatter & Record<string, unknown> = {
    date: input.date,
    type: 'idea',
    status: isStub ? 'captured' : 'active',
    entity_kind: input.kind,
    tags: ['entity', input.kind],
    'ai-first': true,
    confidence: isStub ? 'medium' : 'high',
    slug: input.slug,
    title: input.name,
  };
  if (input.aliases && input.aliases.length > 0) fm.aliases = [...input.aliases];
  if (isStub) fm.stub = true;
  if (input.relations && relationsToFm(input.relations) && Object.keys(relationsToFm(input.relations)).length > 0) {
    fm.relations = relationsToFm(input.relations);
  }

  const summary = input.summary && input.summary.trim() !== '' ? input.summary.trim() : '（待补全）';
  const body = isStub
    ? `本页是实体「${input.name}」的占位词条（stub），由 ingest 实体抽取自动建立，待后续补全；来源见 [[${input.mention?.wikiSlug ?? ''}]]。\n\n## 摘要\n\n${summary}\n`
    : `本页描述实体「${input.name}」，由 ingest 实体抽取自动生成，内容整理自来源页 [[${input.mention?.wikiSlug ?? ''}]]。\n\n## 摘要\n\n${summary}\n${
        input.mention ? `\n## Mentions\n\n> "${input.mention.quote}" — [[${input.mention.wikiSlug}]]\n` : ''
      }`;

  return `---\n${renderFrontmatter(fm)}\n---\n\n## For future agent\n\n${body}`;
}

/* ------------------------------ frontmatter relations 注入 ------------------------------ */

/**
 * 把 relations 块注入页面 frontmatter（文本层，幂等）：
 * - 已有 `relations:` 块先整体移除再写入（重复调用结果一致）；
 * - 页面 frontmatter 之外的正文与其余字段字节不变。
 * - relations 为空 → 原样返回。
 * frontmatter 结构非法（无围栏）时原样返回（调用前内容已过 parseNote 校验，防御性）。
 */
export function withFrontmatterRelations(
  content: string,
  relations: Map<string, string[]>,
): string {
  const meaningful = [...relations.entries()].filter(([, links]) => links.length > 0);
  if (meaningful.length === 0) return content;
  if (!content.startsWith('---\n')) return content;

  const lines = content.split('\n');
  let fenceEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      fenceEnd = i;
      break;
    }
  }
  if (fenceEnd === -1) return content;

  // 移除既有 relations 块：从 `relations:` 行起，吃掉后续空行/缩进行/列表项
  const kept: string[] = [];
  let skipUntilTopLevel = false;
  for (let i = 1; i < fenceEnd; i++) {
    const line = lines[i]!;
    if (/^relations:\s*$/.test(line)) {
      skipUntilTopLevel = true;
      continue;
    }
    if (skipUntilTopLevel) {
      const isContinuation = line.trim() === '' || /^\s/.test(line) || line.trimStart().startsWith('- ');
      if (isContinuation) continue;
      skipUntilTopLevel = false; // 回到顶层键，恢复正常收集
    }
    kept.push(line);
  }

  const block: string[] = ['relations:'];
  for (const [type, links] of meaningful) {
    block.push(`  ${type}:`);
    for (const link of links) block.push(`    - '${link.replace(/'/g, "''")}'`);
  }

  const fmLines = [...kept, ...block];
  return ['---', ...fmLines, '---', ...lines.slice(fenceEnd + 1)].join('\n');
}

/* ------------------------------ Mentions 溯源摘录 ------------------------------ */

/** 摘录最大长度（超出截断加 …） */
const QUOTE_MAX = 160;

/**
 * 从原文中确定性抽出一处提到该实体的句子（首个命中），供 Mentions 溯源段。
 * 找不到命中（不该发生——gate 已验 absent）返回 undefined。
 */
export function extractMention(
  body: string,
  name: string,
  aliases?: string[],
): { quote: string } | undefined {
  const terms = [name, ...(aliases ?? [])].filter((t) => typeof t === 'string' && t.trim() !== '');
  const lower = body.toLowerCase();
  let pos = -1;
  for (const term of terms) {
    const p = lower.indexOf(term.toLowerCase());
    if (p !== -1 && (pos === -1 || p < pos)) pos = p;
  }
  if (pos === -1) return undefined;

  const sentenceEnd = /[。！？!?\n]/;
  let start = pos;
  while (start > 0 && !sentenceEnd.test(body[start - 1]!)) start--;
  let end = pos;
  while (end < body.length && !sentenceEnd.test(body[end]!)) end++;
  const raw = body.slice(start, end).trim().replace(/\s+/g, ' ');
  const quote = raw.length > QUOTE_MAX ? `${raw.slice(0, QUOTE_MAX)}…` : raw;
  return quote !== '' ? { quote } : undefined;
}
