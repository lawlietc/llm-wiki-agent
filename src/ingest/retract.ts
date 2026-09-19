/**
 * M20 工单 07：源回收（`wiki retract <source>`）。
 *
 * **要解决什么**：溯源指针是「这页由哪些源支撑」的唯一记录。源被撤下后，只由它支撑的
 * 事实会变成库里的**孤儿事实**——没人再能解释它们从哪来、也没人会回收它们。本模块按
 * 指针集合把「只由该源支撑」的部分摘掉，仍被其他源支撑的部分**原样保留**（I45）。
 *
 * **作用面与红线**：
 * - 只动 **wiki 页**；`raw/` 只读，**一个字节都不改**（M18 语义）——回收不是删档，
 *   源文件仍在，重新 ingest 即可重建。
 * - 产物走**现有事务模型**（`VaultWriteOp` + `vault.plan/apply`），不新增写入通道。
 * - **零 LLM**：判据全是 frontmatter 的 `source_refs` 集合与 `## 事实` 段的分源块，
 *   确定性、可重复推导 → 因此「预计回收」计数可以进 `--plan`（不破 M17 的零 LLM 契约）。
 *
 * **支撑集被清空时的产物**（D20-4「update / 或整体删除空页」+「删完变空 → 输出空页说明」）：
 * - **实体页**是派生页 → 按既有空页约定**降级为 stub 占位**（`renderEntityPage(outcome:'stub')`）。
 *   不整页删除有两个实在的好处：① 其他页对它的 `[[链接]]` 不会变成死链（否则下次
 *   `wiki link --fix` 又会把它当死链重建 stub，白绕一圈）；② `stub: true` 让后续来源
 *   能经 M13 的 promotion 通道把它补回整页。
 * - **主页**（`wiki/<slug>.md`）就是该源在 wiki 里的呈现物 → **整体删除**；重新 ingest
 *   该源即可重建（M14 短路也因此正确地不再命中）。
 *
 * 不在本期范围：连带清理他页指向被删页的 `relations`（死链体检属 `wiki link` 职责）。
 */

import path from 'node:path';

import { ValidationError } from '../errors';
import { parseFrontmatter } from '../notes/frontmatter';
import { readSourceRefs, replaceFrontmatterSources } from '../notes/source-fm';
import { readFactsBySource, withoutSourceFacts } from '../notes/facts';
import { renderEntityPage } from '../notes/entity-page';
import { isEntityDir, kindOfPath } from '../notes/kind';
import { walkMarkdown } from '../vault/scan';
import { ENTITY_KINDS, type EntityKind } from './candidate-gate';
import type { Vault, VaultPlan, VaultWriteOp } from '../vault/vault';

export interface RetractDeps {
  vault: Vault;
}

/** 回收预演/结果（`writes` 即事务产物，可直接喂 `vault.plan`） */
export interface RetractPlan {
  /** 用户输入原样（报告用） */
  input: string;
  /** 本次回收的源（raw 相对路径；以 wiki 主页 slug 输入时可能解析出多个） */
  rawRels: string[];
  /** 保留其余源、仅摘掉孤儿事实的页 */
  updatedPaths: string[];
  /** 支撑集清空 → 降级为 stub 占位的实体页 */
  stubbedPaths: string[];
  /** 支撑集清空 → 整体删除的主页 */
  deletedPaths: string[];
  updated: number;
  stubbed: number;
  deleted: number;
  /** 被移除的孤儿事实条数（实体页 `## 事实` 段中属于该源的条目） */
  factsRemoved: number;
  /** 预计/实际回收的页数（更新 + 占位 + 删除）——`--plan` 的「预计回收」 */
  retracted: number;
  /** 无任何写操作 = 干净的 no-op */
  noop: boolean;
  writes: VaultWriteOp[];
}

export interface RetractApproveContext {
  plan: RetractPlan;
  preview: { approvalSha256: string; changedPaths: string[] };
}

export interface RetractOptions {
  /** CLI/UI 层注入的暂停点：返回 false → 丢弃 plan，零写入（no-op 时不触发） */
  approve?: (ctx: RetractApproveContext) => Promise<boolean>;
}

export interface RetractResult {
  plan: RetractPlan;
  changedPaths: string[];
}

/* ------------------------------ 输入解析 ------------------------------ */

/** 统一分隔符与 `./` 前缀（让 `raw\a.md`、`./raw/a.md`、`raw/a.md` 等价） */
function normalizeSourceInput(input: string): string {
  return input.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 输入 → raw 落点候选。三种写法都认：`raw/a.md` / `a.md` / `a`。
 * 含子目录的非 `raw/` 路径不作为 raw 候选（那是别的相对路径，不是源）。
 */
function rawRelOf(input: string): string | null {
  const s = normalizeSourceInput(input);
  if (s === '') return null;
  if (s.startsWith('raw/')) return s.endsWith('.md') ? s : `${s}.md`;
  if (s.includes('/')) return null;
  return `raw/${s.endsWith('.md') ? s : `${s}.md`}`;
}

/**
 * 输入 → wiki **主页**落点候选。实体页住在子目录（`wiki/projects/x.md`），是**派生物**
 * 而不是源，故不接受 `wiki/<子目录>/…`；要回收实体页背后的源，请给 raw 路径
 * 或它所属的主页 slug。
 */
function wikiRelOf(input: string): string | null {
  const s = normalizeSourceInput(input);
  if (s === '') return null;
  const body = s.startsWith('wiki/') ? s.slice('wiki/'.length) : s;
  if (body.includes('/')) return null;
  return `wiki/${body.endsWith('.md') ? body : `${body}.md`}`;
}

/** 读取页面指针集合（解析失败 → 空集：宁可不动也不破坏页面） */
function refsOf(content: string): string[] {
  try {
    return readSourceRefs(parseFrontmatter(content) as unknown as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function existsRel(vault: Vault, rel: string): Promise<boolean> {
  try {
    await vault.read(rel);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ 清空后的实体页占位 ------------------------------ */

/** 占位页的摘要（留痕「为什么这页空了」，而不是静默变空） */
const RETRACT_STUB_SUMMARY = '原有事实全部由已回收的源支撑，已随源回收一并移除；待后续来源补全。';

/** 支撑集清空的实体页 → 既有 stub 占位形态（保留 slug/title/kind，目录不迁移） */
function emptyEntityPage(rel: string, content: string): string {
  let fm: Record<string, unknown> = {};
  try {
    fm = parseFrontmatter(content) as unknown as Record<string, unknown>;
  } catch {
    /* 损坏页照样降级：用路径兜底取 slug */
  }
  const slug = path.posix.basename(rel.replace(/\\/g, '/')).replace(/\.md$/, '');
  const title = typeof fm.title === 'string' && fm.title.trim() !== '' ? fm.title : slug;
  const fmKind =
    typeof fm.entity_kind === 'string' && ENTITY_KINDS.has(fm.entity_kind)
      ? (fm.entity_kind as EntityKind)
      : typeof fm.suggested_kind === 'string' && ENTITY_KINDS.has(fm.suggested_kind)
        ? (fm.suggested_kind as EntityKind)
        : null;
  const kind = kindOfPath(rel) ?? fmKind;
  const aliases = Array.isArray(fm.aliases)
    ? fm.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    : [];
  const date =
    typeof fm.date === 'string' && fm.date.trim() !== '' ? fm.date : new Date().toISOString().slice(0, 10);

  return renderEntityPage({
    name: title,
    slug,
    kind,
    outcome: 'stub',
    date,
    summary: RETRACT_STUB_SUMMARY,
    ...(aliases.length > 0 ? { aliases } : {}),
    // 目录已定（kindOfPath）→ 用确认态，避免降级顺带把页面挪去 notes/
    classification:
      kind !== null
        ? { kind, basis: 'lexicon', reason: '源回收后降级为占位（保持目录稳定）' }
        : { kind: null, basis: 'none', reason: '源回收后降级为占位（无确定分类）' },
  });
}

/* ------------------------------ 预演（零 LLM、零写入） ------------------------------ */

/**
 * 扫描 wiki 页，算出「回收该源」的事务产物。**只读**：不写盘、不调 LLM。
 *
 * @throws ValidationError RETRACT_SOURCE_NOT_FOUND —— 指向不存在的源（绝不静默成功）
 */
export async function planRetraction(input: string, deps: RetractDeps): Promise<RetractPlan> {
  const vault = deps.vault;

  // 全库扫描（页量千级内可接受；万级再考虑索引化）
  const pages: { rel: string; content: string }[] = [];
  for (const rel of await walkMarkdown(vault.root, 'wiki')) {
    try {
      pages.push({ rel, content: await vault.read(rel) });
    } catch {
      /* 跳过损坏/不可读页（不阻断回收） */
    }
  }

  // 全库引用面：raw 页被手工删掉但指针仍在时，该源**仍然存在**（回收照样能跑），
  // 否则「源已不在盘上」会让回收恰好失效于最需要它的场景。
  const referenced = new Set<string>();
  for (const p of pages) for (const r of refsOf(p.content)) referenced.add(r);

  let rawRels: string[] | null = null;
  const rawRel = rawRelOf(input);
  if (rawRel !== null && ((await existsRel(vault, rawRel)) || referenced.has(rawRel))) {
    rawRels = [rawRel];
  }
  if (rawRels === null) {
    const wikiRel = wikiRelOf(input);
    const page = wikiRel === null ? undefined : pages.find((p) => p.rel === wikiRel);
    if (page) {
      const refs = refsOf(page.content);
      if (refs.length === 0) {
        throw new ValidationError(
          'RETRACT_SOURCE_NOT_FOUND',
          `wiki 主页没有任何溯源指针，无法确定要回收的源：${page.rel}`,
        );
      }
      rawRels = refs;
    }
  }
  if (rawRels === null) {
    throw new ValidationError(
      'RETRACT_SOURCE_NOT_FOUND',
      `源不存在：${input}（既不是 raw/ 下的页，也不是带溯源指针的 wiki 主页）`,
    );
  }

  const retractSet = new Set(rawRels);
  const writes: VaultWriteOp[] = [];
  const updatedPaths: string[] = [];
  const stubbedPaths: string[] = [];
  const deletedPaths: string[] = [];
  let factsRemoved = 0;

  for (const p of pages) {
    const refs = refsOf(p.content);
    if (!refs.some((r) => retractSet.has(r))) continue; // 与本源无关 → 零操作
    const nextRefs = refs.filter((r) => !retractSet.has(r));

    // 事实天然按源分块 → 「只由该源支撑的事实」= 该源名下的块
    const facts = readFactsBySource(p.content);
    for (const [src, list] of facts) if (retractSet.has(src)) factsRemoved += list.length;
    const keepsFacts = [...facts.keys()].some((src) => !retractSet.has(src));

    const stripped = withoutSourceFacts(p.content, retractSet);

    if (nextRefs.length > 0 || keepsFacts) {
      // 还有其他源支撑 → 保留其余部分（I45）
      writes.push({
        relativePath: p.rel,
        content: replaceFrontmatterSources(stripped, nextRefs),
        operationType: 'update',
      });
      updatedPaths.push(p.rel);
      continue;
    }

    if (isEntityDir(p.rel)) {
      writes.push({ relativePath: p.rel, content: emptyEntityPage(p.rel, p.content), operationType: 'update' });
      stubbedPaths.push(p.rel);
      continue;
    }
    writes.push({ relativePath: p.rel, operationType: 'delete' });
    deletedPaths.push(p.rel);
  }

  return {
    input,
    rawRels,
    updatedPaths,
    stubbedPaths,
    deletedPaths,
    updated: updatedPaths.length,
    stubbed: stubbedPaths.length,
    deleted: deletedPaths.length,
    factsRemoved,
    retracted: updatedPaths.length + stubbedPaths.length + deletedPaths.length,
    noop: writes.length === 0,
    writes,
  };
}

/* ------------------------------ 执行 ------------------------------ */

/**
 * 预演 → （approve）→ 事务落盘。
 *
 * **no-op 时完全不碰 approve/plan/apply**：没有孤儿事实就不该产生任何写操作，
 * 也不该向用户弹一个「确认回收 0 页」的确认框。
 *
 * @returns approve 拒绝返回 null（零写入）；no-op 返回 `{ plan, changedPaths: [] }`
 */
export async function retract(
  input: string,
  deps: RetractDeps,
  opts?: RetractOptions,
): Promise<RetractResult | null> {
  const plan = await planRetraction(input, deps);
  if (plan.writes.length === 0) return { plan, changedPaths: [] };

  const vaultPlan: VaultPlan = await deps.vault.plan(plan.writes);
  // 事务类型实事求是：整单删除才记 'delete'，混合（多为 update + 若干 delete）记 'edit'
  vaultPlan.operationType = plan.writes.every((w) => w.operationType === 'delete') ? 'delete' : 'edit';
  const preview = deps.vault.preview(vaultPlan);

  const approved = opts?.approve ? await opts.approve({ plan, preview }) : true;
  if (!approved) return null;

  const applied = await deps.vault.apply(vaultPlan, { approvedPlanSha256: preview.approvalSha256 });
  return { plan, changedPaths: applied.changedPaths };
}

/* ------------------------------ 输出格式 ------------------------------ */

/** 预演（也是 `--plan` 的产物）：全部计数都在零 LLM 下可得 */
export function formatRetractPlan(plan: RetractPlan): string {
  const hits = plan.retracted;
  return [
    '源回收预演（只读，未写入、未调用 LLM）',
    `  源                    ${plan.rawRels.join(', ')}`,
    `  命中页                ${hits}`,
    `  更新（保留其余源）     ${plan.updated}`,
    `  占位（支撑集清空）     ${plan.stubbed}   ← 实体页降级为 stub，slug 与目录保持`,
    `  删除（主页清空）       ${plan.deleted}   ← 主页即该源的呈现物，重新 ingest 可重建`,
    `  移除事实              ${plan.factsRemoved} 条`,
    `  预计回收              ${hits} 页`,
    '  raw/ 只读：回收只作用于 wiki 页',
  ].join('\n');
}

/** 人读结果 */
export function formatRetractReport(result: RetractResult): string {
  const { plan, changedPaths } = result;
  if (plan.writes.length === 0) return '无孤儿事实：未产生任何写操作（干净的 no-op）。';
  return [
    `源回收完成（${plan.rawRels.join(', ')}）`,
    `  更新（保留其余源）  ${plan.updated}`,
    `  占位（支撑集清空）  ${plan.stubbed}`,
    `  删除（主页清空）    ${plan.deleted}`,
    `  移除事实            ${plan.factsRemoved} 条`,
    `  写入文件            ${changedPaths.length}`,
  ].join('\n');
}
