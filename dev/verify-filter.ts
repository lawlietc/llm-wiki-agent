/**
 * 控制变量验证（工单 02 的评测验收项，替代"重跑 LLM"）。
 *
 * **为什么需要**：重跑 LLM 做前后对比会被 run-to-run 方差污染
 * （实测：两次运行候选身份数 39 → 48，模型提名了完全不同的实体）。
 * 因此本脚本**固定一份已保存的 LLM 回稿**，只让过滤规则变化，
 * 得到不受 LLM 随机性影响的确定结论。
 *
 * 用法：npx tsx dev/verify-filter.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { extractEntities } from '../src/ingest/extract';
import type { Trace } from './trace/schema';
import type { ReasoningBackend, ReasoningRequest, ReasoningResult, AgentCapabilityFlags } from '../src/reasoning/backend';

/** 从 trace JSON 里取保存的原始回稿（跨 4 组取第一个非空的）。
 *  注意：多调用（cited）时 `rawResponseText` 由 sink 拼接并带 `/* ---- 抽取调用 #N ---- *\/` 标签，
 *  该标签是**我们自己的**、不是模型输出，回放前须剥离，否则解析必然失败。 */
function loadReplies(rootDir: string, combos: readonly string[]): { combo: string; reply: string; calls: number }[] {
  const out: { combo: string; reply: string; calls: number }[] = [];
  for (const combo of combos) {
    const dir = path.join(rootDir, combo);
    let run: string;
    try {
      run = readdirSync(dir)[0]!;
    } catch {
      continue;
    }
    const manifest = JSON.parse(readFileSync(path.join(dir, run, 'manifest.json'), 'utf8')) as { traces: { file: string }[] };
    if (manifest.traces.length === 0) continue;
    const trace = JSON.parse(readFileSync(path.join(dir, run, manifest.traces[0]!.file), 'utf8')) as Trace;
    const raw = trace.spans.find((s) => s.extraction !== undefined)?.extraction?.rawResponseText ?? '';
    if (raw.trim() === '') continue;
    const calls = (raw.match(/\/\* ---- 抽取调用 #/g) ?? []).length;
    // 剥离拼接标签（只保留第一段可解析内容用于回放）
    const first = calls > 0 ? raw.replace(/^\/\* ---- 抽取调用 #\d+ ---- \*\/\n/, '').split(/\n\n\/\* ---- 抽取调用 #/)[0]! : raw;
    out.push({ combo, reply: first, calls: Math.max(1, calls) });
  }
  return out;
}

/** 回放固定回稿的假 gateway（按「实体抽取」关键词匹配，与既有测试接缝同款） */
class ReplayGateway implements ReasoningBackend {
  readonly kind = 'gateway' as const;
  constructor(private readonly reply: string) {}
  async complete(_req: ReasoningRequest): Promise<ReasoningResult> {
    return {
      text: this.reply,
      blocks: [{ type: 'text', text: this.reply }],
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'replay',
      providerId: 'replay',
    };
  }
  async chat(req: ReasoningRequest): Promise<ReasoningResult> {
    return this.complete(req);
  }
  capabilities(): AgentCapabilityFlags {
    return { streaming: false, tools: false, sessionPersistence: false, embeddings: false };
  }
  async dispose(): Promise<void> {}
}

async function main(): Promise<void> {
  const combos = ['standard-single', 'standard-cited', 'exhaustive-single', 'exhaustive-cited'];
  const runs = loadReplies(path.join('dev', 'trace-out'), combos);
  if (runs.length === 0) {
    console.error('未找到含原始回稿的 trace。请先跑 dev/trace-spike.ts');
    process.exitCode = 1;
    return;
  }

  console.log('# 控制变量验证：固定 LLM 回稿，只变化过滤规则\n');
  console.log('| 组合 | 回稿实体数 | 过滤后保留 | 被形态过滤 | 被过滤的名字 |');
  console.log('|---|---|---|---|---|');

  for (const { combo, reply } of runs) {
    // 回稿本身的实体数（不过滤）——解析失败则为"回稿畸形"
    let beforeCount: number | null;
    try {
      const parsed = JSON.parse(reply.trim().replace(/^```(?:json)?\s*\n?|\n?```$/g, '')) as { entities?: unknown[] };
      beforeCount = Array.isArray(parsed.entities) ? parsed.entities.length : 0;
    } catch {
      beforeCount = null;
    }

    let kept = 0;
    let names: string[] = [];
    try {
      const gw = new ReplayGateway(reply);
      const res = await extractEntities('（回放，正文不参与判定）', 'file:///replay', gw, {});
      kept = res.entities.length;
      names = (res.warnings ?? [])
        .filter((w) => w.includes('NAME_SHAPE_FILTERED') && w.includes('「'))
        .map((w) => /「(.+?)」/.exec(w)?.[1] ?? '?');
    } catch {
      /* 回稿畸形 → 抽取层抛错（这正是 CITED_FALLBACK 的成因），保持 kept=0 */
    }

    console.log(
      `| ${combo} | ${beforeCount === null ? '**回稿畸形**' : beforeCount} | ${kept} | ${names.length} | ${names.join('、') || '—'} |`,
    );
  }

  console.log('\n> 本验证固定 LLM 输出，结论不受 run-to-run 方差影响。');
  console.log('> 「回稿实体数」= LLM 原始回稿里的实体数（不过滤）；「过滤后保留」= 形态过滤后的实体数。');
  console.log('> 标 **回稿畸形** 的组合说明该次 LLM 回稿本身不是合法 JSON —— 见下方「已知缺陷」。');
}

main().catch((e: unknown) => {
  console.error('失败:', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
});
