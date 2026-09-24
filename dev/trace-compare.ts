/**
 * 单文件 4 组并排对比视图（evals 用，待人工标注）。
 *
 * 产出 `dev/trace-out/_compare/<file>.compare.md`：
 * - 顶部：4 组的计数/成本指标表
 * - 主体：按**身份对齐**后的候选并排表（一眼看出「哪些实体只在某组出现」「判决是否变化」）
 * - 每条候选附**裁决位**（☐ 该抽 ☐ 不该抽）——你标完就是第一个 golden case
 * - 附「可疑项」区：对齐仍无法处理的同义/超长名，列出来供人工核对
 *
 * 用法：npx tsx dev/trace-compare.ts [--root dev/trace-out] [--out <md路径>]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { alignCandidates, loadRuns, normalizeName, type AlignedCandidate } from './trace/align';
import { REASON_TAGS } from './trace/reason-tags';
import type { CandidateTrace, RunManifest, Span, Trace } from './trace/schema';

const COMBOS = ['standard-single', 'standard-cited', 'exhaustive-single', 'exhaustive-cited'];

/** 短标签：ss / sc / es / ec */
function label(combo: string): string {
  const [g, m] = combo.split('-') as [string, string];
  return `${g[0]}${m[0]}`;
}

function candidatesOf(trace: Trace): CandidateTrace[] {
  const span: Span | undefined = trace.spans.find((s) => s.extraction !== undefined);
  return span?.extraction?.candidates ?? [];
}

function countsOf(trace: Trace): { page: number; stub: number; drop: number } {
  const cs = candidatesOf(trace);
  return {
    page: cs.filter((c) => c.outcome === 'page').length,
    stub: cs.filter((c) => c.outcome === 'stub').length,
    drop: cs.filter((c) => c.outcome === 'drop').length,
  };
}

function tokensOf(trace: Trace): number {
  let t = 0;
  for (const s of trace.spans) if (s.llm?.usage !== undefined) t += s.llm.usage.inputTokens + s.llm.usage.outputTokens;
  return t;
}

function factsCount(c: CandidateTrace | undefined): number {
  return c?.facts?.length ?? 0;
}

/** 单元格：判决 + 关键信息的一行摘要 */
function cell(c: CandidateTrace | undefined): string {
  if (c === undefined) return '·';
  const mark = c.outcome === 'page' ? '✅' : c.outcome === 'stub' ? '⚠️' : '❌';
  const f = factsCount(c) > 0 ? ` f${factsCount(c)}` : '';
  return `${mark}${f}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let rootDir = path.join('dev', 'trace-out');
  let outFile = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') rootDir = argv[++i] ?? rootDir;
    else if (argv[i] === '--out') outFile = argv[++i] ?? '';
  }

  const runs = loadRuns(rootDir, COMBOS);
  if (runs.length === 0) {
    console.error('未找到任何 run，请先在 dev/trace-out/<combo>/ 下跑 trace-spike');
    process.exitCode = 1;
    return;
  }

  const aligned = alignCandidates(runs);
  const input = (runs[0]!.manifest as RunManifest).traces[0]?.input ?? '（未知）';

  const L: string[] = [];
  L.push(`# 参数对比（待标注）：${input}`);
  L.push('');
  L.push(`> 4 组参数 = granularity {standard, exhaustive} × extractMode {single, cited}。同一份原文。`);
  L.push(`> 身份对齐按 name/aliases 归一化（见 dev/trace/align.ts）；\`·\` = 该组未提名此实体。`);
  L.push('');

  // 指标表
  L.push('## 指标对比');
  L.push('');
  L.push('| 组合 | 标签 | page | stub | drop | 候选总数 | token | 耗时 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const { combo, trace, manifest } of runs) {
    const c = countsOf(trace);
    const m = manifest;
    L.push(
      `| ${combo} | \`${label(combo)}\` | ${c.page} | ${c.stub} | ${c.drop} | ${c.page + c.stub + c.drop} | ${tokensOf(trace)} | ${((m.traces[0]?.durationMs ?? 0) / 1000).toFixed(0)}s |`,
    );
  }
  L.push('');
  L.push(`标签列用于下面的并排表：${runs.map((r) => `${label(r.combo)}=${r.combo}`).join(' ｜ ')}`);
  L.push('');

  // 并排表
  L.push('## 候选并排（按身份对齐）');
  L.push('');
  L.push(`图例：✅ page ｜ ⚠️ stub ｜ ❌ drop ｜ · 未提名 ｜ \`fN\` = 带 N 条逐字原文事实`);
  L.push('');
  L.push(`| 实体 | ${runs.map((r) => label(r.combo)).join(' | ')} | 门理由（各组） | 裁决 | 归因标签 | 理由（自由文本，可选） |`);
  L.push(`|---|${runs.map(() => '---').join('|')}|---|---|---|---|`);
  for (const g of aligned) {
    const cells = runs.map((r) => cell(g.byCombo.get(r.combo)));
    const reasons = [...new Set([...g.byCombo.values()].map((c) => c.reason))].join(' / ');
    L.push(`| **${g.displayName}** | ${cells.join(' | ')} | ${reasons} | ☐该抽 ☐不该抽 | · |  |`);
  }
  L.push('');
  L.push('> 填法：**裁决**填 `y`/`n`/`?`（所有行）；**归因标签**填枚举值（只对 `n`/`?`）；**理由**写自由文本（可选，只给你自己看）。');
  L.push('');

  // 归因标签枚举（参考表）+ 可选补充说明
  L.push('## 归因标签枚举（参考）');
  L.push('');
  L.push('把左列的字面量填进上表的「归因标签」列。');
  L.push('');
  L.push('| 标签 | 含义 | 指向的修复 |');
  L.push('|---|---|---|');
  for (const t of REASON_TAGS) L.push(`| \`${t.tag}\` | ${t.desc} | ${t.fix} |`);
  L.push('');

  // 差异高亮
  const onlyIn = aligned.filter((g) => g.byCombo.size < runs.length);
  if (onlyIn.length > 0) {
    L.push('### 仅部分组提名（差异焦点）');
    L.push('');
    for (const g of onlyIn) {
      const has = runs.filter((r) => g.byCombo.has(r.combo)).map((r) => label(r.combo)).join(', ');
      const missing = runs.filter((r) => !g.byCombo.has(r.combo)).map((r) => label(r.combo)).join(', ');
      L.push(`- **${g.displayName}**：有 [${has}]　缺 [${missing}]`);
    }
    L.push('');
  }

  // 判决变化
  const changed = aligned.filter((g) => new Set([...g.byCombo.values()].map((c) => c.outcome)).size > 1);
  L.push('### 判决变化（同一实体在不同组 outcome 不同）');
  L.push('');
  if (changed.length === 0) L.push('（无 —— 判定逻辑跨参数稳定）');
  else {
    for (const g of changed) {
      const per = runs.map((r) => `${label(r.combo)}=${g.byCombo.get(r.combo)?.outcome ?? '·'}`).join(' ');
      L.push(`- **${g.displayName}**：${per}`);
    }
  }
  L.push('');

  // 证据（仅 drop 与 stub，附原文片段供标注判断）
  const needEvidence = aligned.filter((g) => [...g.byCombo.values()].some((c) => c.outcome !== 'page'));
  if (needEvidence.length > 0) {
    L.push('## 证据片段（stub / drop，标注时对照）');
    L.push('');
    for (const g of needEvidence) {
      const sample = [...g.byCombo.values()].find((c) => c.evidence !== undefined);
      const summary = [...new Set([...g.byCombo.values()].map((c) => c.summary).filter((s): s is string => s !== undefined))].join(' ｜ ');
      L.push(`### ${g.displayName}`);
      L.push(`- 判决: ${runs.map((r) => `${label(r.combo)}=${g.byCombo.get(r.combo)?.outcome ?? '·'}`).join(' ')}`);
      if (summary !== '') L.push(`- 模型摘要: ${summary}`);
      if (sample?.evidence === null) L.push(`- 原文证据: （无 —— 正文找不到该名字，**疑似幻觉提名**）`);
      else if (sample?.evidence !== undefined) L.push(`- 原文证据 @ ${sample.evidence.offset}:\n  \`\`\`\n  ${sample.evidence.snippet}\n  \`\`\``);
      const facts = [...g.byCombo.values()].flatMap((c) => c.facts ?? []);
      if (facts.length > 0) {
        L.push(`- 逐字事实（cited 才有，${facts.length} 条，前 2 条）:`);
        for (const f of facts.slice(0, 2)) L.push(`  - \`${f.text.slice(0, 100).replace(/\n/g, ' ')}…\``);
      }
      L.push('');
    }
  }

  // 对齐仍无法处理的可疑项
  L.push('## 对齐可疑项（需人工核对）');
  L.push('');
  const longNames = aligned.filter((g) => g.displayName.length > 20);
  const pinyinLike = aligned.filter((g) => /^[a-z-]+$/.test(g.displayName) && g.displayName.includes('-'));
  L.push(`- **超长名（疑似把整句话当实体）**：${longNames.length === 0 ? '（无）' : longNames.map((g) => `\`${g.displayName.slice(0, 40)}…\``).join('、')}`);
  L.push(`- **拼音式名（可能与中文名重复）**：${pinyinLike.length === 0 ? '（无）' : pinyinLike.map((g) => `\`${g.displayName}\``).join('、')}`);
  L.push('');
  L.push('> 若上面两组里出现同一实体的不同写法，需要外部同义表或拼音归并——这是对齐策略的已知边界。');
  L.push('');

  const content = `${L.join('\n')}\n`;
  const target = outFile !== '' ? outFile : path.join(rootDir, '_compare', `${path.basename(input).replace(/\.md$/, '')}.compare.md`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  console.log(`✅ 对比视图已生成: ${target}`);
  console.log(`   身份对齐后共 ${aligned.length} 个实体，其中仅部分组提名 ${onlyIn.length} 个，判决变化 ${changed.length} 个`);
}

void normalizeName; // 保持模块公开 API 一致性

main().catch((e: unknown) => {
  console.error('失败:', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
});

export type { AlignedCandidate };
