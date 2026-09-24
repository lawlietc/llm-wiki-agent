/**
 * 用 golden 算各参数组的抽取质量指标（evals 用）。
 *
 * 指标：
 * - 召回率 = must_exist 里被该组抽到的比例（该抽的漏了吗）
 * - 精确率 = 该组抽出来的里属于 must_exist 的比例（抽出来的有噪声吗）
 * - factsCoverage = 带逐字事实的候选占比（cited 的收益只有这个指标看得见）
 *
 * 对齐：一切比对走 `align.ts` 的身份键（name/aliases 归一化），不按 slug。
 *
 * 用法：npx tsx dev/trace-score.ts [--root dev/trace-out] [--golden dev/evals]
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { alignCandidates, loadRuns, normalizeName, type AlignedCandidate } from './trace/align';
import { REASON_TAGS } from './trace/reason-tags';
import type { CandidateTrace, Span, Trace } from './trace/schema';

export interface Golden {
  source: string;
  mustExist: string[];
  mustNotExist: string[];
  unsure: string[];
  /** 归因标签：实体名 → 标签 */
  reasons: Map<string, string>;
}

/** 极简 YAML 解析（只认我们自己的 golden 形状：source + 三个字符串列表 + reasons 映射） */
export function parseGolden(text: string): Golden {
  const lines = text.split('\n');
  let source = '';
  const lists: Record<string, string[]> = { must_exist: [], must_not_exist: [], unsure: [] };
  const reasons = new Map<string, string>();
  let cur: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('#') || line.trim() === '') continue;

    // reasons 映射：`  <name>: <tag>`
    if (cur === 'reasons') {
      const m = /^\s+([^:]+):\s*(.+)$/.exec(line);
      if (m !== null) {
        reasons.set(unquote(m[1]!), unquote(m[2]!));
        continue;
      }
    }

    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv !== null && !line.startsWith('  -')) {
      if (kv[1] === 'source') {
        source = unquote(kv[2]!);
        cur = null;
      } else if (kv[1] === 'reasons') {
        cur = 'reasons';
      } else if (kv[1]! in lists) {
        cur = kv[1]!;
        if (kv[2] !== '' && kv[2] !== '[]') lists[cur]!.push(unquote(kv[2]!));
      }
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item !== null && cur !== null && cur !== 'reasons') lists[cur]!.push(unquote(item[1] ?? ''));
  }
  return { source, mustExist: lists['must_exist']!, mustNotExist: lists['must_not_exist']!, unsure: lists['unsure']!, reasons };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

function candidatesOf(trace: Trace): CandidateTrace[] {
  const span: Span | undefined = trace.spans.find((s) => s.extraction !== undefined);
  return span?.extraction?.candidates ?? [];
}

export interface ScoreRow {
  combo: string;
  /** 该组抽出的唯一身份数 */
  extracted: number;
  /** 命中的 must_exist 数 */
  hitMust: number;
  mustTotal: number;
  recall: number;
  precision: number;
  factsCoverage: number;
  /** 抽出来但 golden 未标注的实体数（供判断 golden 覆盖度） */
  unlabeled: number;
}

/** 算一组的指标 */
export function scoreOne(combo: string, trace: Trace, golden: Golden): ScoreRow {
  const cands = candidatesOf(trace);
  const extractedKeys = new Set(cands.map((c) => normalizeName(c.name)));
  const mustKeys = new Set(golden.mustExist.map(normalizeName));
  const noiseKeys = new Set(golden.mustNotExist.map(normalizeName));

  let hitMust = 0;
  for (const k of mustKeys) if (extractedKeys.has(k)) hitMust++;

  // 精确率分母只算「已标注」的抽出项（must_exist + must_not_exist）；未标注的不罚
  let correct = 0;
  let labeled = 0;
  for (const k of extractedKeys) {
    if (mustKeys.has(k)) {
      correct++;
      labeled++;
    } else if (noiseKeys.has(k)) {
      labeled++;
    }
  }
  const unlabeled = [...extractedKeys].filter((k) => !mustKeys.has(k) && !noiseKeys.has(k)).length;

  const withFacts = cands.filter((c) => (c.facts?.length ?? 0) > 0).length;

  return {
    combo,
    extracted: extractedKeys.size,
    hitMust,
    mustTotal: mustKeys.size,
    recall: mustKeys.size === 0 ? 0 : hitMust / mustKeys.size,
    precision: labeled === 0 ? 0 : correct / labeled,
    factsCoverage: cands.length === 0 ? 0 : withFacts / cands.length,
    unlabeled,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let rootDir = path.join('dev', 'trace-out');
  let goldenDir = path.join('dev', 'evals');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') rootDir = argv[++i] ?? rootDir;
    else if (argv[i] === '--golden') goldenDir = argv[++i] ?? goldenDir;
  }

  let goldenFiles: string[];
  try {
    goldenFiles = (await readdir(goldenDir)).filter((f) => f.endsWith('.golden.yaml'));
  } catch {
    console.error(`未找到 golden 目录 ${goldenDir}。请先标注 compare.md 再跑 trace-extract-golden.ts`);
    process.exitCode = 1;
    return;
  }
  if (goldenFiles.length === 0) {
    console.error(`${goldenDir} 下没有 .golden.yaml。请先标注 compare.md 再跑 trace-extract-golden.ts`);
    process.exitCode = 1;
    return;
  }

  for (const gf of goldenFiles) {
    const golden = parseGolden(await readFile(path.join(goldenDir, gf), 'utf8'));
    console.log(`\n## ${golden.source}`);
    console.log(`golden: must_exist ${golden.mustExist.length} ｜ must_not_exist ${golden.mustNotExist.length} ｜ unsure ${golden.unsure.length}\n`);

    const runs = loadRuns(rootDir, ['standard-single', 'standard-cited', 'exhaustive-single', 'exhaustive-cited']);
    if (runs.length === 0) {
      console.error(`  ⚠️ ${rootDir} 下未找到 run（需先跑 trace-spike）`);
      continue;
    }

    // 用对齐后的身份做「该组是否抽到」的判定（与 align.ts 一致）
    const aligned: AlignedCandidate[] = alignCandidates(runs);

    console.log('| 组合 | 抽出身份 | 召回 | 精确 | factsCoverage | 未标注 |');
    console.log('|---|---|---|---|---|---|');
    for (const { combo, trace } of runs) {
      const row = scoreOne(combo, trace, golden);
      console.log(`| ${combo} | ${row.extracted} | ${row.hitMust}/${row.mustTotal}=${pct(row.recall)} | ${pct(row.precision)} | ${pct(row.factsCoverage)} | ${row.unlabeled} |`);
    }
    void aligned;

    // 归因统计：噪声按标签分布（回答「该修哪一环」）
    if (golden.reasons.size > 0) {
      const byTag = new Map<string, string[]>();
      for (const [name, tag] of golden.reasons) {
        const arr = byTag.get(tag) ?? [];
        arr.push(name);
        byTag.set(tag, arr);
      }
      console.log(`\n### 归因分布（共 ${golden.reasons.size} 条人工理由）\n`);
      console.log('| 归因标签 | 条数 | 实体 | 指向的修复 |');
      console.log('|---|---|---|---|');
      for (const [tag, names] of [...byTag.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const meta = REASON_TAGS.find((t) => t.tag === tag);
        console.log(`| ${tag} | ${names.length} | ${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''} | ${meta?.fix ?? '（未知标签）'} |`);
      }
    }

    // 缺理由提醒
    const needReason = [...golden.mustNotExist, ...golden.unsure].filter((n) => !golden.reasons.has(n));
    if (needReason.length > 0) {
      console.log(`\n> ⚠️ ${needReason.length} 个 n/? 实体未填归因标签，无法归因到修复动作：${needReason.slice(0, 5).join('、')}${needReason.length > 5 ? '…' : ''}`);
    }
  }
}

main().catch((e: unknown) => {
  console.error('失败:', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
});
