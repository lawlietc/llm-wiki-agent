/**
 * 实体身份对齐（evals 用）。
 *
 * **为什么需要**：slug 由 LLM 生成、不稳定——同一实体在不同 run 里可能叫
 * `raw层` / `raw-ceng` / `raw-ceng`，或 `双向链接` / `双链`。若按 slug 比对两次 run
 * 的候选集合，会把「命名波动」误读成「抽取质量变化」（实测：对齐前 66% 的差异是假信号）。
 *
 * 对齐策略（分级，逐级放宽）：
 * 1. **精确名归一化**：name/aliases 去空白、标点、大小写 → 唯一键
 * 2. **并查集归并**：一个候选的 name 与另一候选的 alias 相同时，两者视为同一身份
 *    （如 A.name='LLM wiki', A.aliases=['LLM Wiki'] 与 B.name='LLM Wiki' 应归并）
 *
 * **已知局限**（对齐不能完美，需人工兜底）：
 * - 同义不同词（`双向链接` vs `双链`）无法归并——需要外部同义表
 * - 拼音 vs 中文（`raw层` vs `raw-ceng`）无法归并——需要拼音转换
 * - 超长 name（把整句话当实体名）是抽取噪声，不属对齐问题
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { CandidateTrace, RunManifest, Span, Trace } from './schema';

/** 归一化：去空白/常见标点/大小写，便于同形合并 */
export function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_\-·、,，.。/|（）()【】\[\]]+/g, '');
}

/** 一个候选的身份键集合（name + aliases 归一化） */
export function candidateKeys(c: Pick<CandidateTrace, 'name' | 'aliases'>): string[] {
  const all = [c.name, ...(c.aliases ?? [])].map(normalizeName).filter((s) => s !== '');
  return [...new Set(all)];
}

export interface AlignedCandidate {
  /** 稳定身份键（归一化后的代表名） */
  identity: string;
  /** 该身份在各组里的呈现（组合名 → 候选快照）；缺失 = 该组未提名 */
  byCombo: Map<string, CandidateTrace>;
  /** 人类可读的代表名（取首次出现的原始 name，保证是原文里那个写法） */
  displayName: string;
}

/**
 * 把同一文件的多次 run 按身份对齐。
 *
 * @param runs 每个元素是一组的 {combo, trace}
 * @returns 对齐后的候选列表（按 displayName 排序）
 */
export function alignCandidates(runs: readonly { combo: string; trace: Trace }[]): AlignedCandidate[] {
  // 并查集：把「某候选的 name 等于另一候选的 alias」的情形合并到同一身份
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // 第一遍：登记所有 key，并把同一候选内部的 name/aliases 先并起来
  const keyToCandidate = new Map<string, { combo: string; cand: CandidateTrace }>();
  for (const { combo, trace } of runs) {
    for (const c of candidatesOf(trace)) {
      const keys = candidateKeys(c);
      for (const k of keys) {
        if (!parent.has(k)) parent.set(k, k);
        keyToCandidate.set(k, { combo, cand: c });
        union(keys[0]!, k);
      }
    }
  }
  // 第二遍：跨候选合并——name 相同即同一身份
  const primary = new Map<string, string>();
  for (const [k, { combo, cand }] of keyToCandidate) {
    const p = normalizeName(cand.name);
    if (primary.has(p)) union(k, primary.get(p)!);
    else primary.set(p, k);
    void combo;
  }

  // 汇总：root → 各组的候选
  const groups = new Map<string, AlignedCandidate>();
  for (const { combo, trace } of runs) {
    for (const c of candidatesOf(trace)) {
      const root = find(normalizeName(c.name));
      let g = groups.get(root);
      if (g === undefined) {
        g = { identity: root, byCombo: new Map(), displayName: c.name };
        groups.set(root, g);
      }
      // 同组内同身份多次出现时，取"更强"的 outcome（page > stub > drop）
      const rank = { page: 0, stub: 1, drop: 2 } as Record<string, number>;
      const prev = g.byCombo.get(combo);
      if (prev === undefined || rank[c.outcome]! < rank[prev.outcome]!) g.byCombo.set(combo, c);
    }
  }

  return [...groups.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'));
}

function candidatesOf(trace: Trace): CandidateTrace[] {
  const span: Span | undefined = trace.spans.find((s) => s.extraction !== undefined);
  return span?.extraction?.candidates ?? [];
}

/** 从 `<根>/<combo>/<runId>/` 读一组 run（取每个 combo 目录下第一个 run） */
export function loadRuns(rootDir: string, combos: readonly string[]): { combo: string; trace: Trace; manifest: RunManifest }[] {
  const out: { combo: string; trace: Trace; manifest: RunManifest }[] = [];
  for (const combo of combos) {
    const dir = path.join(rootDir, combo);
    let run: string;
    try {
      run = readdirSync(dir)[0]!;
    } catch {
      continue; // 该组尚未跑过
    }
    const manifest = JSON.parse(readFileSync(path.join(dir, run, 'manifest.json'), 'utf8')) as RunManifest;
    if (manifest.traces.length === 0) continue;
    const trace = JSON.parse(readFileSync(path.join(dir, run, manifest.traces[0]!.file), 'utf8')) as Trace;
    out.push({ combo, trace, manifest });
  }
  return out;
}
