/**
 * F11.1/F11.2 链接解析 / 反链索引 / 死链 stub（07 规划 E3/E4，M11）。
 *
 * resolveLinks：确定性（零 LLM）扫描 vault 全部 markdown，解析正文 `[[x]]`
 * （支持 `#fragment`、`|display`）与 frontmatter `relations` 类型边，按
 * 路径全等 → 路径后缀 → basename → slug/title/aliases 四级归一解析（仿
 * obsidian-llm-wiki `dead-link-detector.ts` 三级 + 本仓库 frontmatter 约定）。
 * 产出五类问题模型（抄 claude-obsidian `lint_engine.py`）：
 * deadLinks / ambiguous / danglingTypedEdges / orphans / duplicateBasenames + 反链表。
 *
 * generateStubs（D2 二分法）：只对**普通 wikilink 的 not-found 死链**建
 * `wiki/concepts/<slug>.md` 最小 stub（stub: true，title = 目标原文，使其可被
 * 解析器命中 → check→fix 幂等，仿 gbrain）；**歧义目标不建**（无法确定身份）；
 * **类型边缺失不建 stub**（lint error，反虚构）。
 *
 * stub 建页走 Vault 事务（R5 写入权边界）；反链索引落 `.vault-meta/links.json`
 * （内部元数据，与 `.index/` 同层，不经白名单）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { parseNote, type ParsedNote } from '../notes/frontmatter';
import { renderEntityPage } from '../notes/entity-page';
import { ENTITY_KINDS, type EntityKind } from '../ingest/candidate-gate';
import { isEntityDir, kindOfPath, noteTypeFor, entityPagePath, UNCLASSIFIED_DIR } from '../notes/kind';
import { withFrontmatterKind } from '../notes/kind-frontmatter';
import { createVault, type VaultWriteOp } from './vault';
import { walkMarkdown } from './scan';

const ENTITY_KINDS_SET: ReadonlySet<string> = ENTITY_KINDS;

/* ------------------------------ 数据模型 ------------------------------ */

export interface DeadLink {
  source: string;
  target: string;
  reason: 'not-found';
}

export interface AmbiguousLink {
  source: string;
  target: string;
  candidates: string[];
}

export interface DanglingTypedEdge {
  source: string;
  type: string;
  to: string;
}

export interface LinkReport {
  /** 扫描到的全部 md 页（vault 相对路径，posix） */
  pages: string[];
  /** 反链表：目标页相对路径 → 指向它的来源页列表（去重、稳定排序） */
  backlinks: Record<string, string[]>;
  deadLinks: DeadLink[];
  ambiguous: AmbiguousLink[];
  danglingTypedEdges: DanglingTypedEdge[];
  /** 零入链的 wiki/ 页（raw/ 不参与孤儿判定） */
  orphans: string[];
  duplicateBasenames: { basename: string; paths: string[] }[];
  /** M13 未分类（wiki/notes/）：pending=有建议待确认；undetermined=完全未定（占位页带 （stub） 标记） */
  unclassified: { pending: string[]; undetermined: string[] };
  /** M13 entity_kind 与目录不符；或 pin 与 suggested 冲突 */
  kindMismatch: { rel: string; declared?: string; suggested?: string }[];
  /** M13 同 slug 多目录并存（error 级，阻塞 exit） */
  duplicateEntitySlug: { slug: string; paths: string[] }[];
  /** M13 手填 entity_kind 不在五类内 */
  invalidKind: { rel: string; value: string }[];
}

/* ------------------------------ 扫描 ------------------------------ */

// SKIP_DIRS 与 walkMarkdown 收口到 src/vault/scan.ts（M12 I13：links/bm25/slugIndex/graph 四消费者共用）

/** 解析页面：损坏 frontmatter 容错（fm 记空对象，正文用全文） */
function safeParse(content: string): ParsedNote {
  try {
    return parseNote(content);
  } catch {
    return { frontmatter: {} as ParsedNote['frontmatter'], body: content };
  }
}

interface PageInfo {
  rel: string;
  relNoExt: string;
  basename: string;
  fm: ParsedNote['frontmatter'];
  body: string;
}

/** 从 wikilink/类型边目标提取纯目标串（剥 `|display` 与 `#fragment`） */
function linkTarget(raw: string): string {
  const t = raw.split('|')[0] ?? '';
  return t.split('#')[0]?.trim() ?? '';
}

/* ------------------------------ 解析 ------------------------------ */

/** 解析一个 wikilink/类型边目标到候选页集合（0/1/多） */
function resolveTarget(target: string, pages: PageInfo[], byBasename: Map<string, PageInfo[]>): PageInfo[] {
  if (target === '') return [];
  const t = target.normalize('NFC');
  // 1) 路径全等（rel 去扩展名）/ 2) 路径后缀（[[concepts/x]] → wiki/concepts/x.md）
  const byPath = pages.filter((p) => p.relNoExt === t || p.relNoExt.endsWith(`/${t}`));
  if (byPath.length > 0) return byPath;
  // 3) basename 精确
  const byBase = byBasename.get(t) ?? [];
  if (byBase.length > 0) return byBase;
  // 4) frontmatter slug / title / aliases
  const byMeta = pages.filter((p) => {
    const aliases = Array.isArray(p.fm.aliases) ? p.fm.aliases.filter((a): a is string => typeof a === 'string') : [];
    return p.fm.slug === t || p.fm.title === t || aliases.includes(t);
  });
  return byMeta;
}

/** 提取 frontmatter relations 中的类型边目标（值形如 [[target]]） */
function typedEdgeTargets(fm: ParsedNote['frontmatter']): Array<{ type: string; to: string }> {
  const relations = fm.relations;
  const out: Array<{ type: string; to: string }> = [];
  if (relations === undefined || relations === null || typeof relations !== 'object' || Array.isArray(relations)) {
    return out;
  }
  for (const [type, value] of Object.entries(relations as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const v of value) {
      if (typeof v !== 'string' || !v.startsWith('[[') || !v.endsWith(']]')) continue;
      const to = linkTarget(v.slice(2, -2));
      if (to !== '') out.push({ type, to });
    }
  }
  return out;
}

/**
 * 确定性链接解析（零 LLM）。@param root vault 根目录（绝对路径）
 */
export async function resolveLinks(root: string): Promise<LinkReport> {
  const rels = (await walkMarkdown(root)).sort();
  const pages: PageInfo[] = [];
  for (const rel of rels) {
    let content: string;
    try {
      content = await readFile(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, body } = safeParse(content);
    pages.push({
      rel,
      relNoExt: rel.replace(/\.md$/, ''),
      basename: rel.split('/').pop()!.replace(/\.md$/, ''),
      fm: frontmatter,
      body,
    });
  }

  const byBasename = new Map<string, PageInfo[]>();
  for (const p of pages) {
    const list = byBasename.get(p.basename) ?? [];
    list.push(p);
    byBasename.set(p.basename, list);
  }

  const report: LinkReport = {
    pages: rels,
    backlinks: {},
    deadLinks: [],
    ambiguous: [],
    danglingTypedEdges: [],
    orphans: [],
    duplicateBasenames: [],
    unclassified: { pending: [], undetermined: [] },
    kindMismatch: [],
    duplicateEntitySlug: [],
    invalidKind: [],
  };
  const addBacklink = (target: string, source: string) => {
    const list = report.backlinks[target] ?? [];
    if (!list.includes(source)) list.push(source);
    report.backlinks[target] = list;
  };

  for (const p of pages) {
    // 正文 wikilink
    const linkRe = /\[\[([^\]\n]+)\]\]/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = linkRe.exec(p.body)) !== null) {
      const target = linkTarget(m[1] ?? '');
      if (target === '' || seen.has(target)) continue;
      seen.add(target);
      const candidates = resolveTarget(target, pages, byBasename);
      if (candidates.length === 0) {
        report.deadLinks.push({ source: p.rel, target, reason: 'not-found' });
      } else if (candidates.length > 1) {
        report.ambiguous.push({ source: p.rel, target, candidates: candidates.map((c) => c.rel) });
      } else if (candidates[0]!.rel !== p.rel) {
        addBacklink(candidates[0]!.rel, p.rel); // 自链不入反链
      }
    }
    // frontmatter 类型边（D2：缺失目标 = lint error，不建 stub）
    for (const { type, to } of typedEdgeTargets(p.fm)) {
      const candidates = resolveTarget(to, pages, byBasename);
      if (candidates.length === 0) {
        report.danglingTypedEdges.push({ source: p.rel, type, to });
      } else if (candidates.length === 1 && candidates[0]!.rel !== p.rel) {
        addBacklink(candidates[0]!.rel, p.rel);
      }
    }
  }

  // 孤儿：wiki/ 下零入链页
  const linkedTargets = new Set(Object.keys(report.backlinks));
  report.orphans = pages
    .filter((p) => p.rel.startsWith('wiki/') && !linkedTargets.has(p.rel))
    .map((p) => p.rel);

  // 同名冲突
  for (const [basename, list] of byBasename) {
    if (list.length > 1) report.duplicateBasenames.push({ basename, paths: list.map((p) => p.rel) });
  }

  // ---- M13 一致性报告 ----
  const ENTITY_BASENAMES = new Map<string, string[]>();
  for (const p of pages) {
    if (!isEntityDir(p.rel)) continue;
    // 同 slug 多目录并存（error 级）
    const list = ENTITY_BASENAMES.get(p.basename) ?? [];
    list.push(p.rel);
    ENTITY_BASENAMES.set(p.basename, list);

    const rawKind = p.fm.entity_kind;
    const declared = typeof rawKind === 'string' ? rawKind : null;
    const suggested = typeof p.fm.suggested_kind === 'string' ? p.fm.suggested_kind : null;

    if (declared != null && !ENTITY_KINDS_SET.has(declared)) {
      // 手填非法 kind → 忽略该值、记 invalidKind、不迁移（KIND_INVALID）
      report.invalidKind.push({ rel: p.rel, value: declared });
      continue;
    }

    // 未分类两子段（D10 成分观测）：pending=有建议待确认；undetermined=完全未定
    if (p.rel.startsWith(`${UNCLASSIFIED_DIR}/`)) {
      const marked = p.fm.stub === true ? `${p.rel}（stub）` : p.rel;
      if (suggested != null) report.unclassified.pending.push(marked);
      else report.unclassified.undetermined.push(marked);
    }

    // kindMismatch：entity_kind 与目录不符；或 pin 与 suggested 冲突（I-i）
    if (declared != null && suggested != null && declared !== suggested) {
      report.kindMismatch.push({ rel: p.rel, declared, suggested });
      continue;
    }
    if (declared != null && kindOfPath(p.rel) !== declared) {
      report.kindMismatch.push({ rel: p.rel, declared });
    }
  }
  for (const [slug, paths] of ENTITY_BASENAMES) {
    if (paths.length > 1) report.duplicateEntitySlug.push({ slug, paths });
  }

  return report;
}

/* ------------------------------ 反链索引落盘 ------------------------------ */

/** 反链索引写 `.vault-meta/links.json`（幂等，可重算）。返回写入路径 */
export async function writeBacklinkIndex(root: string, report: LinkReport): Promise<string> {
  const dir = path.join(root, '.vault-meta');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'links.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    counts: {
      pages: report.pages.length,
      deadLinks: report.deadLinks.length,
      ambiguous: report.ambiguous.length,
      danglingTypedEdges: report.danglingTypedEdges.length,
      orphans: report.orphans.length,
    },
    backlinks: Object.fromEntries(Object.entries(report.backlinks).map(([k, v]) => [k, [...v].sort()])),
  };
  await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return file;
}

/* ------------------------------ 死链 stub（D2 二分法） ------------------------------ */

/** 目标名 → 可移植 slug（保留 Unicode 字母数字，其余转 -；CJK 不转写） */
export function slugifyName(name: string): string {
  const s = name
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 64) || 'untitled';
}

/**
 * 对 report 中的 not-found 死链建最小 stub（歧义目标不建；类型边缺失不在此处理）。
 * stub frontmatter `title` = 链接目标原文 → 建页后死链经 title 匹配解析（幂等）。
 * 经 Vault 事务落盘（R5）。@returns 新建页相对路径列表
 */
export async function generateStubs(root: string, report: LinkReport): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const ops: Array<{ relativePath: string; content: string; operationType: 'create' }> = [];
  const seenPaths = new Set<string>();

  for (const dead of report.deadLinks) {
    const slug = slugifyName(dead.target);
    // D8：占位一律落 wiki/notes/（路径形态死链的目录线索有意忽略——死链目标身份未知）；
    // kind null → needs_classification（完全未定成分），stub: true 与目录正交（I-g）。
    const rel = entityPagePath(null, slug);
    const abs = path.join(root, rel);
    // 已存在 → skip 不覆盖；同一事务内重复目标（多个来源引用同一死链）→ 只建一次
    if (existsSync(abs) || seenPaths.has(rel)) continue;
    seenPaths.add(rel);
    ops.push({
      relativePath: rel,
      content: renderEntityPage({
        name: dead.target,
        slug,
        kind: null,
        outcome: 'stub',
        date: today,
        summary: `（占位词条：由死链 [[${dead.target}]] 自动建立，待补全）`,
      }),
      operationType: 'create',
    });
  }
  if (ops.length === 0) return [];

  const vault = createVault(root);
  const plan = await vault.plan(ops);
  plan.operationType = 'save';
  const preview = vault.preview(plan);
  await vault.apply(plan, { approvedPlanSha256: preview.approvalSha256 });
  return ops.map((o) => o.relativePath);
}

/* ------------------------------ M13 按 entity_kind 迁移（--fix 人工通道） ------------------------------ */

export interface MigrateResult {
  /** 已完成的迁移（from → to） */
  migrated: Array<{ from: string; to: string }>;
  /** entity_kind 非法（忽略不迁移） */
  invalidKind: Array<{ rel: string; value: string }>;
  /** 迁移目标已存在同 slug 页（KIND_CONFLICT，不迁移不覆盖） */
  conflicts: Array<{ rel: string; target: string }>;
}

/**
 * 以 frontmatter entity_kind 为准迁移实体页（M13，--fix 的人工通道）：
 * - 凡 entity_kind 与 kindOfPath(rel) 不符即迁移（覆盖 notes→kind 与 kind→kind 两种纠错）；
 * - 建议态页（无 entity_kind）不迁移（I-j，幂等免费成立）；
 * - 非法 entity_kind → 忽略 + 记入 invalidKind（KIND_INVALID）；
 * - 目标已存在同 slug → KIND_CONFLICT（I-d 无静默覆盖），跳过；
 * - 迁移 = create(target) + delete(from) 同一 Vault 事务（I-a 原子性，operationType=save）。
 */
export async function migrateByFrontmatterKind(root: string): Promise<MigrateResult> {
  const report = await resolveLinks(root);
  const result: MigrateResult = { migrated: [], invalidKind: [], conflicts: [] };
  const ops: VaultWriteOp[] = [];

  const entityPages = report.pages.filter((rel) => isEntityDir(rel));
  for (const rel of entityPages) {
    let fm: ParsedNote['frontmatter'];
    try {
      fm = parseNote(await readFile(path.join(root, rel), 'utf8')).frontmatter;
    } catch {
      continue; // 损坏页跳过
    }
    const declared = typeof fm.entity_kind === 'string' ? fm.entity_kind : null;
    if (declared == null) continue; // 建议态/裸未定 → 不迁移（I-j）
    if (!ENTITY_KINDS_SET.has(declared)) {
      result.invalidKind.push({ rel, value: declared });
      continue;
    }
    if (kindOfPath(rel) === declared) continue; // 已在目标目录

    const target = entityPagePath(declared as EntityKind, path.basename(rel).replace(/\.md$/, ''));
    if (existsSync(path.join(root, target))) {
      result.conflicts.push({ rel, target });
      continue;
    }
    const content = await readFile(path.join(root, rel), 'utf8');
    // D6 目标态：type 改写 + entity_kind 写入 + 建议键/needs_classification 移除；正文逐字节不变
    ops.push(
      {
        relativePath: target,
        content: withFrontmatterKind(content, {
          type: noteTypeFor(declared as EntityKind),
          entityKind: declared,
          needsClassification: null,
          suggestedKind: null,
          suggestedSource: null,
        }),
        operationType: 'create',
      },
      { relativePath: rel, operationType: 'delete' },
    );
    result.migrated.push({ from: rel, to: target });
  }

  if (ops.length > 0) {
    const vault = createVault(root);
    const plan = await vault.plan(ops);
    plan.operationType = 'save';
    const preview = vault.preview(plan);
    await vault.apply(plan, { approvedPlanSha256: preview.approvalSha256 });
  }
  result.migrated.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return result;
}
