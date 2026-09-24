/**
 * 从标注好的 compare.md 提取 golden.yaml（evals 用）。
 *
 * 为什么需要这一步：`compare.md` 由 `trace-compare.ts` 重新生成（会覆盖你的标注），
 * 而 `golden.yaml` 是稳定的、能进版本、能算分的产物。
 *
 * 用法：npx tsx dev/trace-extract-golden.ts [--compare <md路径>] [--out <yaml路径>]
 *   缺省扫描 dev/trace-out/_compare/*.compare.md，逐个提取到 dev/evals/<同名>.golden.yaml
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 解析 compare.md 主表的行：实体名 + 裁决（倒数第 2 列）+ 归因标签（倒数第 1 列） */
export function parseAnnotatedTable(md: string): { name: string; verdict: string; tag: string }[] {
  const out: { name: string; verdict: string; tag: string }[] = [];
  const lines = md.split('\n');
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith('| 实体 |')) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!line.startsWith('|')) {
        inTable = false;
        continue;
      }
      if (/^\|\s*-+/.test(line)) continue; // 分隔行
      const cells = line.split('|').map((c) => c.trim());
      // 表头：| 实体 | ss | sc | es | ec | 门理由 | 裁决 | 归因标签 |
      // split 后两端各有一个空串；列固定为 实体=1 ... 裁决=len-3, 归因标签=len-2
      if (cells.length < 7) continue;
      const name = (cells[1] ?? '').replace(/^\*\*|\*\*$/g, '').trim();
      // 用「从右侧数」的稳健定位：忽略末尾空单元格
      const trimmed = cells[cells.length - 1] === '' ? cells.slice(0, -1) : cells;
      const verdict = (trimmed[trimmed.length - 2] ?? '').trim();
      const tagRaw = (trimmed[trimmed.length - 1] ?? '').trim();
      const tag = tagRaw === '·' || tagRaw === '-' || tagRaw === '—' ? '' : tagRaw;
      if (name === '') continue;
      out.push({ name, verdict, tag });
    }
  }
  return out;
}

/** 裁决串 → y/n/?；未标注（含原样 ☐该抽 ☐不该抽）归为 '?' */
export function normalizeVerdict(v: string): 'y' | 'n' | '?' {
  const t = v.toLowerCase().trim();
  if (t === 'y' || t === '是' || t === '该抽') return 'y';
  if (t === 'n' || t === '否' || t === '不该抽') return 'n';
  return '?';
}

/** 分析产物的一个条目 */
export interface GoldenEntry {
  name: string;
  verdict: 'y' | 'n' | '?';
  /** 归因标签（仅 n/? 有；未填或不在枚举内则缺省） */
  tag?: string;
  /** 标签后的自由说明（不参与统计） */
  note?: string;
}

/**
 * 解析「## 裁决理由（人工）」节的**补充说明**（可选）。
 * 行格式：`- <实体名> —— <说明>`（本节的标签枚举表与引用块会被跳过）
 *
 * 跳过 HTML 注释块（`<!-- ... -->`）—— 模板里的示例放在注释中，不应被当作真实标注。
 */
export function parseReasonSection(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = md.split('\n');
  let inSection = false;
  let inComment = false;
  for (const line of lines) {
    if (line.includes('<!--')) inComment = true;
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.startsWith('## 裁决理由')) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith('## ')) break;
    if (!inSection) continue;
    if (line.trimStart().startsWith('>') || line.trimStart().startsWith('|')) continue; // 引用块 / 枚举表
    const m = /^-\s+([^—]+?)\s*——\s*(.+)$/.exec(line.trim());
    if (m === null) continue;
    const name = m[1]!.trim();
    const note = m[2]!.trim();
    if (name === '' || note === '') continue;
    out.set(name, note);
  }
  return out;
}

function yamlEscape(s: string): string {
  // 含特殊字符时用单引号（YAML 单引号里单引号需双写）
  if (/[:#\-{}[\],&*?|>'"%@`\n]/.test(s) || s.trim() !== s) return `'${s.replace(/'/g, "''")}'`;
  return s;
}

async function extractOne(comparePath: string, outPath: string): Promise<{ y: number; n: number; q: number; missingReason: string[] }> {
  const md = await readFile(comparePath, 'utf8');
  const rows = parseAnnotatedTable(md);
  if (rows.length === 0) throw new Error(`未在 ${comparePath} 解析到候选表`);

  const reasons = parseReasonSection(md); // 补充说明（可选）
  const srcMatch = /^# 参数对比（待标注）：(.+)$/m.exec(md);
  const source = srcMatch?.[1]?.trim() ?? path.basename(comparePath, '.compare.md');

  const mustExist = rows.filter((r) => normalizeVerdict(r.verdict) === 'y').map((r) => r.name);
  const mustNotExist = rows.filter((r) => normalizeVerdict(r.verdict) === 'n').map((r) => r.name);
  const unsure = rows.filter((r) => normalizeVerdict(r.verdict) === '?').map((r) => r.name);

  // 归因标签取自表格的「归因标签」列（主填位置）
  const tags = new Map<string, string>();
  for (const r of rows) {
    if (r.tag !== '' && (normalizeVerdict(r.verdict) === 'n' || normalizeVerdict(r.verdict) === '?')) {
      tags.set(r.name, r.tag);
    }
  }

  // 校验：标 n / ? 的应当有归因标签（缺失只警告，不阻断——但不阻断会降低指标可用性）
  const needReason = [...mustNotExist, ...unsure];
  const missingReason = needReason.filter((name) => !tags.has(name));

  const lines: string[] = [];
  lines.push('# golden 标注（由 trace-extract-golden.ts 从 compare.md 提取；请勿手改此文件，改 compare.md 再重跑）');
  lines.push(`source: ${yamlEscape(source)}`);
  lines.push(`annotatedAt: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('# 该存在的实体（规范化名，与 align.ts 归一化一致）');
  lines.push('must_exist:');
  for (const n of mustExist) lines.push(`  - ${yamlEscape(n)}`);
  if (mustExist.length === 0) lines.push('  []');
  lines.push('');
  lines.push('# 明确不该存在的（噪声）');
  lines.push('must_not_exist:');
  for (const n of mustNotExist) lines.push(`  - ${yamlEscape(n)}`);
  if (mustNotExist.length === 0) lines.push('  []');
  lines.push('');
  lines.push('# 存疑（不参与算分，仅记录）');
  lines.push('unsure:');
  for (const n of unsure) lines.push(`  - ${yamlEscape(n)}`);
  if (unsure.length === 0) lines.push('  []');
  lines.push('');
  // 归因标签（供 trace-score.ts 聚合统计）+ 可选补充说明
  lines.push('# 归因标签（键 = 实体名，值 = 标签）—— 标 n/? 的实体应有');
  lines.push('reasons:');
  if (tags.size === 0) lines.push('  {}');
  else {
    for (const [name, tag] of tags) {
      const note = reasons.get(name);
      lines.push(`  ${yamlEscape(name)}: ${yamlEscape(tag)}${note !== undefined ? `  # ${note}` : ''}`);
    }
  }
  lines.push('');

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, lines.join('\n'), 'utf8');
  return { y: mustExist.length, n: mustNotExist.length, q: unsure.length, missingReason };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let comparePath = '';
  let outPath = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--compare') comparePath = argv[++i] ?? '';
    else if (argv[i] === '--out') outPath = argv[++i] ?? '';
  }

  const targets: { compare: string; out: string }[] = [];
  if (comparePath !== '') {
    outPath = outPath !== '' ? outPath : path.join('dev', 'evals', `${path.basename(comparePath, '.compare.md')}.golden.yaml`);
    targets.push({ compare: comparePath, out: outPath });
  } else {
    const dir = path.join('dev', 'trace-out', '_compare');
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.compare.md'));
    } catch {
      console.error(`未找到对比视图目录：${dir}。请先跑 npx tsx dev/trace-compare.ts`);
      process.exitCode = 1;
      return;
    }
    if (files.length === 0) {
      console.error(`目录 ${dir} 下没有 .compare.md`);
      process.exitCode = 1;
      return;
    }
    for (const f of files) {
      targets.push({ compare: path.join(dir, f), out: path.join('dev', 'evals', `${path.basename(f, '.compare.md')}.golden.yaml`) });
    }
  }

  for (const t of targets) {
    const r = await extractOne(t.compare, t.out);
    console.log(`✅ ${t.out}`);
    console.log(`   must_exist ${r.y} ｜ must_not_exist ${r.n} ｜ unsure ${r.q}`);
    if (r.y === 0) console.log(`   ⚠️ 没有标任何 y —— 请先编辑 compare.md 的「裁决」列（填 y/n/?）再重跑`);
    if (r.missingReason.length > 0) {
      console.log(`   ⚠️ ${r.missingReason.length} 个 n/? 实体缺归因标签（建议补，否则无法归因到修复动作）：`);
      for (const name of r.missingReason.slice(0, 8)) console.log(`      - ${name}`);
      if (r.missingReason.length > 8) console.log(`      … 其余 ${r.missingReason.length - 8} 个`);
    }
  }
}

main().catch((e: unknown) => {
  console.error('失败:', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
});
