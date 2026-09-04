/**
 * ingest 编排（05 §5 / F4.5；M10 扩展实体抽取）。
 *
 * detect → extract → renderRawNote → summarizeToWiki（过反伪造 + lint）→
 * extractEntities（LLM 提议，失败降级）→ gateCandidates（确定性质量门，D2）→
 * relations 注入 wiki 页 + 实体页 page/stub ops（E1–E3）→
 * 组装 raw+wiki+实体页 同事务 VaultPlan(operationType=ingest) → preview → approve 回调
 * （false 丢弃，零写入）→ apply（事务原子落盘，任一步失败整体回滚）。
 *
 * 不变量：I1 raw/wiki/实体页 同事务；I2 反伪造（summarizeToWiki 内 fence）；I3 无静默覆盖
 * （slug 命中已存在页 → update 且经 approve；既有实体页不覆盖，仅 stub→page promotion）；
 * I4 同 source_url 去重 + 抽取失败降级；I5 lint 闸门；门绝不制造死链（D4）。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { selectAdapter } from './sources';
import { renderRawNote } from '../notes/template';
import { parseFrontmatter } from '../notes/frontmatter';
import { summarizeToWiki } from './summarize';
import { extractEntities } from './extract';
import { gateCandidates, type GateResult } from './candidate-gate';
import { groupRelationsBySlug, mergeRelationMaps } from '../notes/relations';
import { renderEntityPage, withFrontmatterRelations, extractMention } from '../notes/entity-page';
import type { Vault, VaultPlan, ApplyResult, VaultWriteOp } from '../vault/vault';
import type { ReasoningBackend } from '../reasoning/backend';

export type { WikiNote } from './summarize';

export interface IngestDeps {
  vault: Vault;
  gateway: ReasoningBackend;
}

export interface ApproveContext {
  plan: VaultPlan;
  preview: { approvalSha256: string; changedPaths: string[] };
}

export interface IngestOptions {
  /** CLI/UI 层注入的暂停点：返回 false → 丢弃 plan，零写入 */
  approve?: (ctx: ApproveContext) => Promise<boolean>;
}

/** sourceUrl → raw 页文件名（稳定、可移植；去协议/query，非字母数字转 `-`） */
function rawSlugFor(sourceUrl: string): string {
  const slug = sourceUrl
    .replace(/^https?:\/\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug.slice(0, 120) || 'source';
}

/** 读相对路径存在与否（经 Vault.read，缺失即视为不存在） */
async function existsRel(vault: Vault, rel: string): Promise<boolean> {
  try {
    await vault.read(rel);
    return true;
  } catch {
    return false;
  }
}

/** I4 去重：扫描 raw/ 找 source_url 命中的页，返回其相对路径（未命中返回 null） */
async function findRawBySourceUrl(vault: Vault, sourceUrl: string): Promise<string | null> {
  const rawDir = path.join(vault.root, 'raw');
  let entries: string[];
  try {
    entries = await readdir(rawDir);
  } catch {
    return null; // raw/ 不存在 → 无去重目标
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    try {
      const fm = parseFrontmatter(await vault.read(`raw/${f}`));
      if (fm.source_url === sourceUrl) return `raw/${f}`;
    } catch {
      /* 跳过损坏/不可读文件 */
    }
  }
  return null;
}

/**
 * 入口：把一段输入（file:// 路径或 http(s):// URL）ingest 为 raw+wiki 两页。
 * @returns 成功返回 ApplyResult；approve 拒绝返回 null（零写入）
 */
export async function ingest(
  input: string,
  deps: IngestDeps,
  opts?: IngestOptions,
): Promise<ApplyResult | null> {
  const adapter = selectAdapter(input);
  const { body, meta } = await adapter.extract(input);

  // 1) raw 页（verbatim，type:source，免前言）
  const rawSlug = rawSlugFor(meta.sourceUrl);
  const rawRel = `raw/${rawSlug}.md`;
  const existingRaw = await findRawBySourceUrl(deps.vault, meta.sourceUrl);
  const rawOp: VaultWriteOp = existingRaw
    ? { relativePath: existingRaw, content: renderRawNote(body, meta), operationType: 'update' }
    : { relativePath: rawRel, content: renderRawNote(body, meta), operationType: 'create' };

  // 2) wiki 页（ai-first，LLM 整理，过反伪造 + lint 闸门；slug 命中已存在 → update）
  const wiki = await summarizeToWiki(body, meta.sourceUrl, deps.gateway);

  // 2.5) 实体抽取（E1/E2，07 规划 D1/D2）：LLM 提议 + 确定性门落地。
  // 抽取回稿不可解析时降级为空（不建词条、不写 relations），不阻断 ingest 主流程（I4）。
  let gated: GateResult = { candidates: [], edges: [] };
  try {
    const extraction = await extractEntities(body, meta.sourceUrl, deps.gateway);
    gated = gateCandidates(extraction, body, wiki.content);
  } catch {
    /* 降级：本次无实体页 */
  }

  const ingestDate = meta.fetchedAt.slice(0, 10);
  const alive = gated.candidates.filter((c) => c.outcome !== 'drop');

  // 边统一补全：实体间声明边 + 来源页 relates_to 实体（对称），再按 inverse 取双向
  const allEdges = [
    ...gated.edges,
    ...alive.map((c) => ({ from: wiki.slug, type: 'relates_to' as const, to: c.candidate.slug })),
  ].filter((e) => e.from !== e.to);
  const relMap = groupRelationsBySlug(allEdges);

  // 来源页 frontmatter 写入 relations（relates_to → 各存活实体；幂等注入）
  const wikiRels = relMap.get(wiki.slug) ?? new Map<string, string[]>();
  const wikiContent = wikiRels.size > 0 ? withFrontmatterRelations(wiki.content, wikiRels) : wiki.content;

  const wikiRel = `wiki/${wiki.slug}.md`;
  const wikiExists = await existsRel(deps.vault, wikiRel);
  const wikiOp: VaultWriteOp = {
    relativePath: wikiRel,
    content: wikiContent,
    operationType: wikiExists ? 'update' : 'create',
  };

  // 2.6) 实体页 ops（E3）：page/stub 落 wiki/concepts/<slug>.md；
  // 已有页不覆盖，除非（stub 且本次判整页）→ promotion 升级（剥离 stub 标记，保留旧边）
  const entityOps: VaultWriteOp[] = [];
  for (const c of alive) {
    const cand = c.candidate;
    const relPath = `wiki/concepts/${cand.slug}.md`;
    const mention = extractMention(body, cand.name, cand.aliases);
    const base = {
      name: cand.name,
      slug: cand.slug,
      kind: cand.kind,
      outcome: c.outcome as 'page' | 'stub',
      date: ingestDate,
      summary: cand.summary,
      aliases: cand.aliases,
      mention: mention ? { ...mention, wikiSlug: wiki.slug } : undefined,
    };
    if (await existsRel(deps.vault, relPath)) {
      const fm = parseFrontmatter(await deps.vault.read(relPath));
      if (!(fm.stub === true && c.outcome === 'page')) continue; // 不覆盖既有词条
      const merged = mergeRelationMaps(fm.relations, relMap.get(cand.slug) ?? new Map());
      entityOps.push({
        relativePath: relPath,
        content: renderEntityPage({ ...base, relations: merged }),
        operationType: 'update',
      });
    } else {
      entityOps.push({
        relativePath: relPath,
        content: renderEntityPage({ ...base, relations: relMap.get(cand.slug) }),
        operationType: 'create',
      });
    }
  }

  // 3) raw + wiki + 实体页 同一次事务（operationType=ingest）
  const plan = await deps.vault.plan([rawOp, wikiOp, ...entityOps]);
  plan.operationType = 'ingest';
  const preview = deps.vault.preview(plan);

  // 4) 暂停点：approve 拒绝 → 丢弃，零写入（I3）
  const approved = opts?.approve ? await opts.approve({ plan, preview }) : true;
  if (!approved) return null;

  // 5) 事务原子落盘（任一步失败整体回滚）
  return deps.vault.apply(plan, { approvedPlanSha256: preview.approvalSha256 });
}
