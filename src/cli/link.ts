/**
 * `wiki link` 命令（M11 F11.3 + M13 F13.5/F13.6 / 07 规划 E4）：vault 级链接体检（仿 gbrain check→fix）。
 *
 * - 默认：resolveLinks 确定性扫描，输出九类问题 + 写 `.vault-meta/links.json` 反链索引。
 *   M13 新增四段：未分类（pending/undetermined 两子段）、kind 与目录不符、同 slug 多目录、非法 kind。
 * - `--fix` 执行顺序（M13 §2.1）：先按 entity_kind 迁移 → 重扫 → 再建占位 → 最后刷新索引
 *   （迁移可能让死链变命中，少建垃圾页）。
 *
 * exit code：死链 + 歧义 + 悬空类型边 + duplicateEntitySlug > 0 → 1（D7：同 slug 并存为 error）；
 * 孤儿/同名冲突/unclassified/kindMismatch/invalidKind 为 warn 级不致失败。
 */

import { generateStubs, migrateByFrontmatterKind, resolveLinks, writeBacklinkIndex, type LinkReport } from '../vault/links';
import type { CliIO } from './io';

export interface LinkResult {
  exitCode: number;
}

function reportLines(r: LinkReport): string[] {
  const lines: string[] = [`链接体检：扫描 ${r.pages.length} 页`];
  lines.push(`死链（普通 wikilink 目标不存在）：${r.deadLinks.length}`);
  for (const d of r.deadLinks) lines.push(`  - ${d.source} → [[${d.target}]]`);
  lines.push(`歧义目标：${r.ambiguous.length}`);
  for (const a of r.ambiguous) lines.push(`  - ${a.source} → [[${a.target}]]（候选: ${a.candidates.join(', ')}）`);
  lines.push(`悬空类型边（lint error，不建占位）：${r.danglingTypedEdges.length}`);
  for (const d of r.danglingTypedEdges) lines.push(`  - ${d.source} --${d.type}--> [[${d.to}]]`);
  lines.push(`孤儿页（零入链）：${r.orphans.length}`);
  for (const o of r.orphans) lines.push(`  - ${o}`);
  lines.push(`同名冲突：${r.duplicateBasenames.length}`);
  for (const d of r.duplicateBasenames) lines.push(`  - ${d.basename}: ${d.paths.join(', ')}`);
  // ---- M13 四段 ----
  lines.push(`未分类（有建议待确认 ${r.unclassified.pending.length} / 完全未定 ${r.unclassified.undetermined.length}）：${r.unclassified.pending.length + r.unclassified.undetermined.length}`);
  for (const p of r.unclassified.pending) lines.push(`  - [pending] ${p}`);
  for (const u of r.unclassified.undetermined) lines.push(`  - [undetermined] ${u}`);
  lines.push(`kind 与目录不符：${r.kindMismatch.length}`);
  for (const m of r.kindMismatch) {
    const detail = m.suggested != null ? `（declared=${m.declared}, suggested=${m.suggested}）` : `（declared=${m.declared}）`;
    lines.push(`  - ${m.rel}${detail}`);
  }
  lines.push(`同 slug 多目录（error）：${r.duplicateEntitySlug.length}`);
  for (const d of r.duplicateEntitySlug) lines.push(`  - ${d.slug}: ${d.paths.join(', ')}`);
  lines.push(`非法 kind：${r.invalidKind.length}`);
  for (const v of r.invalidKind) lines.push(`  - ${v.rel}（entity_kind: ${v.value}）`);
  return lines;
}

function blockingCount(r: LinkReport): number {
  return r.deadLinks.length + r.ambiguous.length + r.danglingTypedEdges.length + r.duplicateEntitySlug.length;
}

export async function runLink(
  deps: { vaultRoot: string },
  opts: { io: CliIO; fix?: boolean },
): Promise<LinkResult> {
  const io = opts.io;
  const report = await resolveLinks(deps.vaultRoot);
  for (const line of reportLines(report)) io.out(line);

  let final = report;
  if (opts.fix) {
    // 顺序 1：先按 entity_kind 迁移（notes→kind / kind→kind 纠错）
    const migrated = await migrateByFrontmatterKind(deps.vaultRoot);
    for (const m of migrated.migrated) io.out(`--fix：迁移 ${m.from} → ${m.to}`);
    for (const v of migrated.invalidKind) {
      io.err(`[KIND_INVALID] ${v.rel}（entity_kind: ${v.value} 不在五类内，忽略不迁移）`);
    }
    for (const c of migrated.conflicts) {
      io.err(`[KIND_CONFLICT] ${c.rel} → ${c.target}（目标已存在）`);
    }
    io.out(`--fix：迁移 ${migrated.migrated.length} 页 / 非法 kind ${migrated.invalidKind.length} / 冲突 ${migrated.conflicts.length}`);

    // 顺序 2：重扫（迁移可能让死链变命中）
    final = await resolveLinks(deps.vaultRoot);

    // 顺序 3：再建占位（只对重扫后仍是 not-found 的死链）
    const created = await generateStubs(deps.vaultRoot, final);
    io.out(`--fix：新建占位词条 ${created.length} 个${created.length > 0 ? `：${created.join(', ')}` : ''}`);
    if (created.length > 0) final = await resolveLinks(deps.vaultRoot);

    io.out(
      `fix 后重扫：死链 ${final.deadLinks.length} / 歧义 ${final.ambiguous.length} / 悬空类型边 ${final.danglingTypedEdges.length} / 同 slug 多目录 ${final.duplicateEntitySlug.length}`,
    );
  }

  // 顺序 4：最后刷新 links.json（I-l：索引由 wiki link 重算）
  const indexFile = await writeBacklinkIndex(deps.vaultRoot, final);
  io.out(`反链索引已写入 ${indexFile}（${Object.keys(final.backlinks).length} 个目标页有入链）`);

  return { exitCode: blockingCount(final) > 0 ? 1 : 0 };
}
