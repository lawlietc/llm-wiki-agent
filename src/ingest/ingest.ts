/**
 * ingest 编排（05 §5 / F4.5）：把 raw 文件/URL 导进来，整理成 wiki 库。
 *
 * detect → extract → renderRawNote → summarizeToWiki（过反伪造 + lint）→
 * 组装 raw+wiki 同事务 VaultPlan(operationType=ingest) → preview → approve 回调
 * （false 丢弃，零写入）→ apply（事务原子落盘，任一步失败整体回滚）。
 *
 * 不变量：I1 raw/wiki 同事务；I2 反伪造（summarizeToWiki 内 fence）；I3 无静默覆盖
 * （slug 命中已存在页 → update 且经 approve）；I4 同 source_url 去重；I5 lint 闸门。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { selectAdapter } from './sources';
import { renderRawNote } from '../notes/template';
import { parseFrontmatter } from '../notes/frontmatter';
import { summarizeToWiki } from './summarize';
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
  const wikiRel = `wiki/${wiki.slug}.md`;
  const wikiExists = await existsRel(deps.vault, wikiRel);
  const wikiOp: VaultWriteOp = {
    relativePath: wikiRel,
    content: wiki.content,
    operationType: wikiExists ? 'update' : 'create',
  };

  // 3) raw + wiki 同一次事务（operationType=ingest）
  const plan = await deps.vault.plan([rawOp, wikiOp]);
  plan.operationType = 'ingest';
  const preview = deps.vault.preview(plan);

  // 4) 暂停点：approve 拒绝 → 丢弃，零写入（I3）
  const approved = opts?.approve ? await opts.approve({ plan, preview }) : true;
  if (!approved) return null;

  // 5) 事务原子落盘（任一步失败整体回滚）
  return deps.vault.apply(plan, { approvedPlanSha256: preview.approvalSha256 });
}
