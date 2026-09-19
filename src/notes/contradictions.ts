/**
 * 冲突显性化：`## Contradictions / Updates` 段（M20 工单 08 / D20-5 / I46）。
 *
 * **要解决什么**：两个源的事实互相矛盾时，今天只有两条路——新值静默覆盖旧值，或者在
 * 页面外人工处理。知识矛盾本身应当被**记录**：新主张 + 来源、旧主张 + 来源、时间。
 *
 * **三条纪律**：
 * - **不覆盖**：旧主张仍然逐字留在 `## 事实` 段（事实段由 `facts.ts` 管，本模块不碰它），
 *   本段只是**追加的留痕**；
 * - **不自动 supersede**：不写 `supersedes` / `superseded_by` 边，不删旧内容——
 *   裁决是人的事（I46）；
 * - **不留空段**：没有矛盾就不产生这一段（字节零改动）。
 *
 * **幂等**：同一矛盾重复 ingest 不重复追加——条目以 (分歧点, 旧指针, 新指针) 为键去重，
 * 已记录的条目**不被后续重算改写**（记录就是记录：它记的是「当时发现了什么」），
 * 因此 `date` 是首次发现的日期。
 *
 * **与写冲突严格隔离**：本段是普通页面内容。`WIKI_CONTENT_CONFLICT`（外部手改 vs 基线）
 * 是**事务层**的整单拒绝，与本模块无任何调用关系——两类冲突不可能走同一条路径。
 *
 * **作用域（有意收窄到 `cited`）**：判定矛盾要拿两侧的**逐字事实**对照，而事实只由引用式
 * 抽取（`--extract-mode cited`，工单 04）产生 → 默认的 `single` 路径不产生事实，也就不会
 * 触发本段（I47 由此天然成立）。这不是遗漏：`single` 模式里没有可对照的原文片段，任何
 * 「语义矛盾」判断都只能靠模型直觉，其成本与幻觉面都会进默认路径。
 *
 * **指针形态**：用反引号包 `raw/x.md#chunk-N`（**不带方括号**），因此既不匹配检索综合层的
 * `[slug#chunk-N]` 引用语法，也不匹配事实段的 `[src:…#chunk-N]` 源锚点语法——三种命名空间
 * 互不干扰。
 */

import { isSourceAnchor } from './source-anchor';
import { findSectionHeading, replaceSection, sectionEnd, sectionTextOf } from './markdown-section';

/** 段标题（固定，渲染与解析共用） */
export const CONTRADICTIONS_HEADING = '## Contradictions / Updates';

/** 段首说明行 */
const CONTRADICTIONS_NOTE =
  '> 两源事实互相矛盾时在此留痕：**不覆盖**旧内容，也**不自动 supersede**，请人工裁决。';

/** 主张/引文单行化上限（矛盾记录不要求逐字——精确文本靠后面的指针回查） */
const TEXT_MAX = 200;

/** 一条矛盾记录 */
export interface ContradictionEntry {
  /** 首次发现的日期（YYYY-MM-DD） */
  date: string;
  /** 分歧点（一句话概括在什么问题上矛盾） */
  claim: string;
  /** 旧主张（既有页事实的单行摘录） */
  oldText: string;
  /** 旧主张的出处指针：`raw/<页>#chunk-<N>` */
  oldRef: string;
  /** 新主张（本次源事实的单行摘录） */
  newText: string;
  /** 新主张的出处指针 */
  newRef: string;
}

/** 单行化（折叠空白 + 截断；换行会破坏 markdown 列表项结构） */
function oneLine(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t;
}

/** 幂等键：同一分歧点 + 同一对出处 = 同一条记录（已记录的条目不被改写） */
export function contradictionKey(e: ContradictionEntry): string {
  return `${e.claim}\u0000${e.oldRef}\u0000${e.newRef}`;
}

/** 出处指针文本 */
export function factPointer(rawRel: string, chunkIndex: number): string {
  return `${rawRel}#chunk-${chunkIndex}`;
}

/* ------------------------------ 渲染 / 解析 ------------------------------ */

function renderSection(entries: readonly ContradictionEntry[]): string {
  const lines: string[] = [CONTRADICTIONS_HEADING, '', CONTRADICTIONS_NOTE];
  for (const e of entries) {
    lines.push('', `- **${e.date}** · ${oneLine(e.claim)}`);
    lines.push(`  - 旧（\`${e.oldRef}\`）：${oneLine(e.oldText)}`);
    lines.push(`  - 新（\`${e.newRef}\`）：${oneLine(e.newText)}`);
  }
  return lines.join('\n');
}

function findHeading(lines: readonly string[]): number {
  return findSectionHeading(lines, CONTRADICTIONS_HEADING);
}

const ENTRY_RE = /^- \*\*(\d{4}-\d{2}-\d{2})\*\* · (.*)$/;
const OLD_RE = /^\s+- 旧（`(.+)`）：(.*)$/;
const NEW_RE = /^\s+- 新（`(.+)`）：(.*)$/;

/** 解析页面里的矛盾记录（无该段 → 空数组；畸形条目跳过，不猜） */
export function readContradictions(content: string): ContradictionEntry[] {
  const lines = content.split('\n');
  const head = findHeading(lines);
  if (head === -1) return [];

  const out: ContradictionEntry[] = [];
  let cur: ContradictionEntry | null = null;
  const flush = (): void => {
    if (cur !== null) out.push(cur);
    cur = null;
  };
  for (let i = head + 1; i < sectionEnd(lines, head); i++) {
    const line = lines[i]!;
    const m = ENTRY_RE.exec(line);
    if (m !== null) {
      flush();
      cur = { date: m[1]!, claim: m[2]!, oldText: '', oldRef: '', newText: '', newRef: '' };
      continue;
    }
    if (cur === null) continue;
    const o = OLD_RE.exec(line);
    if (o !== null) {
      cur.oldRef = o[1]!;
      cur.oldText = o[2]!;
      continue;
    }
    const n = NEW_RE.exec(line);
    if (n !== null) {
      cur.newRef = n[1]!;
      cur.newText = n[2]!;
    }
  }
  flush();
  // 两侧指针都齐才算完整记录（缺一半的畸形条目跳过）
  return out.filter((e) => e.oldRef !== '' && e.newRef !== '');
}

/* ------------------------------ 写入 ------------------------------ */

/**
 * 把矛盾记录并进页面（并集去重；已记录的条目保持原样）。
 *
 * - 并集为空 → **原样返回**（不留空段，默认路径零改动）；
 * - 渲染结果与现存段落**逐字相同** → 原样返回（幂等，不扰动字节）；
 * - 页面尚无该段 → 追加到文末；已有 → 原位替换。
 *
 * @param inheritFrom 既有页内容（迁移/重渲染时提供）：换页形态（如 stub→page promotion）
 *   时旧记录随搬家一起继承，否则重新渲染会把留痕整段抹掉
 */
export function withContradictions(
  content: string,
  entries: readonly ContradictionEntry[],
  inheritFrom?: string,
): string {
  const merged = readContradictions(inheritFrom ?? content);
  for (const e of entries) {
    if (!merged.some((x) => contradictionKey(x) === contradictionKey(e))) merged.push({ ...e });
  }
  if (merged.length === 0) return content;

  const rendered = renderSection(merged);
  if (sectionTextOf(content, CONTRADICTIONS_HEADING) === rendered) return content; // 幂等
  return replaceSection(content, CONTRADICTIONS_HEADING, rendered);
}

/** 页面里出现的矛盾记录条数（自检/测试用） */
export function contradictionCount(content: string): number {
  return readContradictions(content).length;
}

/** 段中出现的事实指针（自检用；与 `[src:…]` 源锚点命名空间互不重叠） */
export function pointersIn(content: string): string[] {
  const lines = content.split('\n');
  const head = findHeading(lines);
  if (head === -1) return [];
  const out: string[] = [];
  for (let i = head + 1; i < sectionEnd(lines, head); i++) {
    const line = lines[i]!;
    if (isSourceAnchor(line.trim())) continue; // 防御：段内不该有源锚点
    const m = /`([^`]*#chunk-\d+)`/.exec(line);
    if (m !== null) out.push(m[1]!);
  }
  return out;
}
