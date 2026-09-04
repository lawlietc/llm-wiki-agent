/**
 * `wiki link` 命令（M11 F11.3 / 07 规划 E4）：vault 级链接体检（仿 gbrain check→fix）。
 *
 * - 默认：resolveLinks 确定性扫描，输出五类问题 + 写 `.vault-meta/links.json` 反链索引。
 * - `--fix`：对普通死链建 `wiki/concepts/<slug>.md` 占位词条（歧义不建、类型边悬空
 *   不建 = D2 二分法），fix 后重解析并刷新索引。
 *
 * exit code：存在死链/歧义/悬空类型边 → 1；孤儿与同名冲突为 warn 级不致失败。
 */

import { generateStubs, resolveLinks, writeBacklinkIndex, type LinkReport } from '../vault/links';
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
  return lines;
}

function blockingCount(r: LinkReport): number {
  return r.deadLinks.length + r.ambiguous.length + r.danglingTypedEdges.length;
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
    const created = await generateStubs(deps.vaultRoot, report);
    io.out(`--fix：新建占位词条 ${created.length} 个${created.length > 0 ? `：${created.join(', ')}` : ''}`);
    final = await resolveLinks(deps.vaultRoot);
    io.out(`fix 后重扫：死链 ${final.deadLinks.length} / 歧义 ${final.ambiguous.length} / 悬空类型边 ${final.danglingTypedEdges.length}`);
  }

  const indexFile = await writeBacklinkIndex(deps.vaultRoot, final);
  io.out(`反链索引已写入 ${indexFile}（${Object.keys(final.backlinks).length} 个目标页有入链）`);

  return { exitCode: blockingCount(final) > 0 ? 1 : 0 };
}
