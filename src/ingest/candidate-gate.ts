/**
 * F10.2 候选质量门（07 规划 D2/D4 细化，移植 obsidian-llm-wiki
 * `src/core/candidate-gate.ts` 的确定性三结果决策表）。
 *
 * 抽取器只提名，本门决定谁真正建页：
 * - classifyCandidate：判定名字出现在 prose（正文）/ aside（括号、短列表项）/ absent。
 *   ASCII 词用词边界匹配；含非 ASCII（CJK 等）用子串匹配（中文无词边界）。
 * - isHandLinked：名字（或别名）出现在 LLM 页面的 `[[...]]` 内 = 最强相关性声明，优先保活。
 * - applyOutcomeTable（S135 三结果路由）：
 *     absent → drop；hand-linked → page；
 *     prose+covered(defined/discussed) → page；prose+named → stub；
 *     aside+covered → stub；aside+named → drop。
 * - 门绝不制造死链：被 drop 候选从 relations 端点里一并剪除。
 *
 * 纯函数、无 I/O、无 LLM（确定性）。
 */

import { isRelationType, type RelationEdge, type RelationType } from '../notes/relations';
import { classifyEntity, type Classification } from '../notes/classify';
import { entityPagePath } from '../notes/kind';

export type EntityKind = 'person' | 'project' | 'concept' | 'decision' | 'company';
export const ENTITY_KINDS: ReadonlySet<string> = new Set<EntityKind>([
  'person',
  'project',
  'concept',
  'decision',
  'company',
]);

export type Coverage = 'defined' | 'discussed' | 'named';

/** 抽取器提名的实体候选（M10.3 解析后的原始形态） */
export interface EntityCandidate {
  name: string;
  slug: string;
  kind: EntityKind;
  coverage: Coverage;
  /** 抽取自身产出的一句话摘要（stub 内容来源，不额外调 LLM） */
  summary?: string;
  aliases?: string[];
}

/** 原始边（type 尚未校验） */
export interface RawEdge {
  from: string;
  type: string;
  to: string;
}

export type CandidateLocation = 'prose' | 'aside' | 'absent';
export type CandidateOutcome = 'page' | 'stub' | 'drop';

export interface GatedCandidate {
  candidate: EntityCandidate;
  outcome: CandidateOutcome;
  location: CandidateLocation;
  handLinked: boolean;
  reason: string;
  /** M13 分类结果（判定树产出；每个候选都有，含 drop 的） */
  classification: Classification;
}

export interface GateResult {
  candidates: GatedCandidate[];
  /** 存活端点的合法声明边（已去重；未补反向边） */
  edges: RelationEdge[];
}

/* ------------------------------ 文本分类 ------------------------------ */

/** 转义正则元字符 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 找 term 在 text 中的所有出现位置（返回每次出现的 start index）。
 * 纯 ASCII 词用词边界；含非 ASCII（CJK）用子串匹配。
 */
function findOccurrences(text: string, term: string): number[] {
  if (term.length === 0) return [];
  const asciiWord = /^[\w -]+$/.test(term);
  const flags = asciiWord ? 'g' : 'gu';
  const pattern = asciiWord
    ? `(?<![\\w])${escapeRe(term)}(?![\\w])`
    : escapeRe(term);
  const re = new RegExp(pattern, flags);
  const out: number[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(m.index);
    re.lastIndex = m.index + Math.max(m[0].length, 1); // 防 zero-length 死循环
  }
  return out;
}

/** 计算 text 中所有括号（半角/全角）内部的字符区间 */
function parenSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const open = new Set(['(', '（']);
  const close = new Set([')', '）']);
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (open.has(text[i]!)) stack.push(i);
    else if (close.has(text[i]!) && stack.length > 0) spans.push([stack.pop()!, i]);
  }
  return spans;
}

/** 短列表项阈值：更短的行视为枚举/罗列（aside 启发式之一） */
const SHORT_LIST_LINE_MAX = 80;

function inShortListItem(text: string, pos: number): boolean {
  const lineStart = text.lastIndexOf('\n', pos) + 1;
  const lineEnd = text.indexOf('\n', pos);
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  if (!/^\s*(?:[-*·]|\d+[.)])\s/.test(line)) return false;
  return line.trim().length <= SHORT_LIST_LINE_MAX;
}

/**
 * 判定名字（含别名任一命中）在原文中的出现形态：
 * prose（正文）/ aside（括号或短列表项）/ absent。
 */
export function classifyCandidate(
  body: string,
  name: string,
  aliases?: string[],
): { location: CandidateLocation; matched: string | null } {
  const terms = [name, ...(aliases ?? [])].filter((t) => typeof t === 'string' && t.trim() !== '');
  const spans = parenSpans(body);
  for (const term of terms) {
    const positions = findOccurrences(body, term);
    if (positions.length === 0) continue;
    const asideCount = positions.filter(
      (p) => spans.some(([s, e]) => p > s && p < e) || inShortListItem(body, p),
    ).length;
    return { location: asideCount === positions.length ? 'aside' : 'prose', matched: term };
  }
  return { location: 'absent', matched: null };
}

/**
 * 名字（或别名）是否被作者亲手写进 `[[...]]`（检查 LLM 生成页全文）。
 * 链接目标与显示文本都算。
 */
export function isHandLinked(wikiContent: string, name: string, aliases?: string[]): boolean {
  const linkRe = /\[\[([^\]]+)\]\]/g;
  const terms = [name, ...(aliases ?? [])].filter((t) => typeof t === 'string' && t.trim() !== '');
  for (let m = linkRe.exec(wikiContent); m; m = linkRe.exec(wikiContent)) {
    const inner = m[1] ?? '';
    const parts = inner.split('|');
    for (const term of terms) {
      const t = term.trim();
      if (t === '') continue;
      // 目标段（去 fragment）或显示段命中都算
      const target = (parts[0] ?? '').split('#')[0]?.trim() ?? '';
      const display = (parts[1] ?? '').trim();
      if (target === t || target.toLowerCase() === t.toLowerCase()) return true;
      if (display !== '' && (display === t || display.toLowerCase() === t.toLowerCase())) return true;
    }
  }
  return false;
}

/* ------------------------------ 三结果决策表 ------------------------------ */

/** S135 路由：两道门（结构分类 × coverage）意见一致与否决定 page/stub/drop */
export function applyOutcomeTable(location: CandidateLocation, handLinked: boolean, coverage: Coverage): { outcome: CandidateOutcome; reason: string } {
  if (handLinked) return { outcome: 'page', reason: 'hand-linked' };
  switch (location) {
    case 'absent':
      return { outcome: 'drop', reason: 'absent' };
    case 'prose':
      return coverage === 'named'
        ? { outcome: 'stub', reason: 'prose+named（分歧 → stub）' }
        : { outcome: 'page', reason: `prose+${coverage}` };
    case 'aside':
      return coverage === 'named'
        ? { outcome: 'drop', reason: 'aside+named（一致否决）' }
        : { outcome: 'stub', reason: `aside+${coverage}（分歧 → stub）` };
  }
}

/** slug 必须能过实体页路径白名单（M13：走 entityPagePath，六类目录同形） */
function slugIsValid(slug: string, kind: EntityKind): boolean {
  if (typeof slug !== 'string' || slug.trim() === '') return false;
  try {
    entityPagePath(kind, slug.trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * 名字（含别名）在正文 prose 中的出现次数（M13 主体判据的输入）。
 * 括号内与短列表项中的出现不计入 prose。
 */
export function countProseOccurrences(body: string, name: string, aliases?: string[]): number {
  const terms = [name, ...(aliases ?? [])].filter((t) => typeof t === 'string' && t.trim() !== '');
  const spans = parenSpans(body);
  let best = 0;
  for (const term of terms) {
    const positions = findOccurrences(body, term);
    const proseCount = positions.filter(
      (p) => !spans.some(([s, e]) => p > s && p < e) && !inShortListItem(body, p),
    ).length;
    if (proseCount > best) best = proseCount;
  }
  return best;
}

/* ------------------------------ 门入口 ------------------------------ */

/**
 * 候选质量门：抽取原始结果 + 原文 + LLM 生成页 → 存活候选（page/stub/drop）与存活边。
 *
 * 规则：
 * 1) name 空 / slug 非法 / absent → drop；kind 非法容错为 concept；coverage 非法降为 named；
 * 2) 同 slug 多提名仲裁（M13）：确定性 basis（lexicon/pin）优先于 model/none，同级先到先得；
 * 3) hand-linked 优先保活（即使 coverage named）；
 * 4) 泛化名单（classification.rejected）存活候选降级为 drop（复用通道，注明 reason）；
 * 5) 边只保留两端都存活的合法类型边；自环、非法类型、悬空端点一律剪除（不制造死链）。
 */
export function gateCandidates(
  raw: { entities?: unknown; relations?: unknown },
  body: string,
  wikiContent: string,
): GateResult {
  const rawEntities = Array.isArray(raw.entities) ? raw.entities : [];
  const rawRelations = Array.isArray(raw.relations) ? raw.relations : [];

  // 1) 逐候选分类与路由
  const candidates: GatedCandidate[] = [];
  /** slug → 已保留候选在 candidates 中的下标（同 slug 仲裁用） */
  const keptBySlug = new Map<string, number>();
  for (const item of rawEntities) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name === '') continue;

    const kind = typeof o.kind === 'string' && ENTITY_KINDS.has(o.kind) ? (o.kind as EntityKind) : 'concept';
    const coverage: Coverage =
      o.coverage === 'defined' || o.coverage === 'discussed' ? o.coverage : 'named';
    const aliases = Array.isArray(o.aliases)
      ? o.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
      : [];
    const summary = typeof o.summary === 'string' && o.summary.trim() !== '' ? o.summary.trim() : undefined;
    const slug = typeof o.slug === 'string' ? o.slug.trim() : '';

    const { location } = classifyCandidate(body, name, aliases);
    const handLinked = isHandLinked(wikiContent, name, aliases);
    const proseOccurrences = countProseOccurrences(body, name, aliases);
    const classification = classifyEntity({
      name,
      aliases,
      declaredKind: typeof o.kind === 'string' ? o.kind : undefined, // 原始声明值（可能非法）→ model 信源
      coverage,
      location,
      handLinked,
      proseOccurrences,
    });

    const pushDrop = (reason: string) =>
      candidates.push({ candidate: { name, slug, kind, coverage, summary, aliases }, outcome: 'drop', location, handLinked, reason, classification });

    if (!slugIsValid(slug, kind)) {
      pushDrop('slug 非法');
      continue;
    }

    // 同 slug 多提名仲裁：确定性 basis 优先于 model/none；同级先到先得
    const keptIdx = keptBySlug.get(slug);
    if (keptIdx !== undefined) {
      const kept = candidates[keptIdx]!;
      const deterministic = (c: Classification) => c.basis === 'lexicon' || c.basis === 'pin';
      if (deterministic(kept.classification) || !deterministic(classification)) {
        pushDrop('slug 重复（仲裁：先到者胜或确定性优先）');
        continue;
      }
      // 后到的确定性提名顶掉先到的 model/none 提名
      pushDrop('slug 仲裁落败（被确定性提名取代）');
      const winner = applyOutcomeTable(location, handLinked, coverage);
      candidates[keptIdx] = {
        candidate: { name, slug, kind, coverage, summary, aliases },
        outcome: winner.outcome,
        location,
        handLinked,
        reason: `slug 仲裁胜出（确定性 basis；${winner.reason}）`,
        classification,
      };
      continue;
    }

    const { outcome, reason } = applyOutcomeTable(location, handLinked, coverage);
    // 泛化名单（规则 10）：存活候选降级为不建页（复用 drop 通道）
    const finalOutcome: CandidateOutcome = classification.rejected === true ? 'drop' : outcome;
    const finalReason = classification.rejected === true ? '泛化名单（不建页）' : reason;
    keptBySlug.set(slug, candidates.length);
    candidates.push({ candidate: { name, slug, kind, coverage, summary, aliases }, outcome: finalOutcome, location, handLinked, reason: finalReason, classification });
  }

  // 2) 边过滤：端点必须都存活、类型合法、非自环
  const alive = new Set(candidates.filter((c) => c.outcome !== 'drop').map((c) => c.candidate.slug));
  const seen = new Set<string>();
  const edges: RelationEdge[] = [];
  for (const item of rawRelations) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const from = typeof o.from === 'string' ? o.from.trim() : '';
    const to = typeof o.to === 'string' ? o.to.trim() : '';
    const type = typeof o.type === 'string' ? o.type.trim() : '';
    if (from === '' || to === '' || from === to) continue;
    if (!isRelationType(type)) continue;
    if (!alive.has(from) || !alive.has(to)) continue;
    const key = `${from}\u0000${type}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, type: type as RelationType, to });
  }

  return { candidates, edges };
}
