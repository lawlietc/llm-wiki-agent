/**
 * ingest trace spike 主脚本（可丢弃）。
 *
 * 目的：用**真实 LLM（ACP 腿 opencode）**跑真实 raw 文件，产出 trace JSON + 人读 md，
 * 供判断「这份数据够不够用来做评测（evals）」。
 *
 * 运行（项目无独立 ts 运行器，用 tsx）：
 *   npx tsx dev/trace-spike.ts --vault <vaultDir> --out dev/trace-out \
 *     --granularity exhaustive --extract-mode cited [--commit] [--diffable] raw/xxx.md
 *
 * 缺省 **dry-run**：只跑 `prepareIngest` 相位（覆盖 L1+L2+L3 绝大部分价值），不写盘。
 * 加 `--commit` 才调 `commitIngest` 真正落盘。
 *
 * 类型检查注记：`tsconfig.json` 的 include 不含 `dev/`，故 `npm run typecheck` 不覆盖本文件。
 * 手工检查：
 *   npx tsc --noEmit --strict --moduleResolution bundler --allowImportingTsExtensions \
 *     --verbatimModuleSyntax --module ESNext --target ES2022 --skipLibCheck --lib ES2023 dev/trace-spike.ts
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVault } from '../src/vault/vault';
import { prepareIngest, commitIngest, type IngestOptions } from '../src/ingest/ingest';
import { getACPProvider } from '../src/reasoning/acp/registry';
import { ACPAgentBackend } from '../src/reasoning/acp/backend';
import type { CliIO } from '../src/cli/io';
import { TraceSink, serializeManifest, serializeTrace } from './trace/sink';
import { TracingBackend, type LlmCallRecord } from './trace/tracing-backend';
import { renderTraceMarkdown } from './trace/render-md';
import { probeUsageUpdate, type UsageProbeResult } from './trace/usage-probe';
import type { RunManifest, Trace, TraceSummary } from './trace/schema';
import type { Granularity, ExtractMode } from '../src/ingest/extract';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

interface Args {
  vaultRoot: string;
  outDir: string;
  inputs: string[];
  granularity: Granularity;
  extractMode: ExtractMode;
  commit: boolean;
  diffable: boolean;
  agent: string;
}

function parseArgs(argv: string[]): Args {
  let vaultRoot = process.cwd();
  let outDir = path.join(ROOT, 'dev', 'trace-out');
  let granularity: Granularity = 'standard';
  let extractMode: ExtractMode = 'single';
  let commit = false;
  let diffable = false;
  let agent = 'opencode';
  const inputs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--vault') vaultRoot = path.resolve(argv[++i] ?? '');
    else if (a === '--out') outDir = path.resolve(argv[++i] ?? '');
    else if (a === '--granularity') granularity = (argv[++i] ?? 'standard') as Granularity;
    else if (a === '--extract-mode') extractMode = (argv[++i] ?? 'single') as ExtractMode;
    else if (a === '--agent') agent = argv[++i] ?? 'opencode';
    else if (a === '--commit') commit = true;
    else if (a === '--diffable') diffable = true;
    else if (!a.startsWith('--')) inputs.push(a);
  }
  if (inputs.length === 0) {
    throw new Error('需要至少一个输入文件（vault 内相对路径或 file:// URL）');
  }
  return { vaultRoot, outDir, inputs, granularity, extractMode, commit, diffable, agent };
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

function gitInfo(): { head: string; dirty: boolean } {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
    return { head, dirty };
  } catch {
    return { head: 'unknown', dirty: false };
  }
}

/** 把 vault 内相对路径转成 ingest 接受的 file:// 输入 */
function toInput(vaultRoot: string, raw: string): { input: string; label: string } {
  if (raw.startsWith('file://') || /^https?:\/\//i.test(raw)) return { input: raw, label: raw };
  const abs = path.resolve(vaultRoot, raw);
  const url = `file://${abs.replace(/\\/g, '/')}`;
  return { input: url, label: raw };
}

/** 收集 io.err 的 IO（把告警挂到 trace span 上） */
function makeCollectingIO(sink: TraceSink, phaseSpanId: () => string | null): CliIO {
  return {
    isTTY: true,
    out: () => {},
    err: (text: string) => {
      const sid = phaseSpanId();
      if (sid !== null) sink.addEvent(sid, 'io_err', { text });
    },
    confirm: async () => false,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = newRunId();
  const outRunDir = path.join(args.outDir, runId);
  await mkdir(outRunDir, { recursive: true });

  const vault = createVault(args.vaultRoot);
  const sink = new TraceSink({ diffable: args.diffable });

  // --- 装配推理腿（语义等价 `--agent opencode`，实现上绕过 CLI 参数解析）---
  const provider = getACPProvider(args.agent);
  const acp = new ACPAgentBackend(provider, { initializeTimeoutMs: 60_000, cwd: args.vaultRoot });
  const tracing = new TracingBackend(acp, (rec: LlmCallRecord) => sink.llm(rec));

  // 当前阶段 span（供 io.err 与 llm 归属）
  let currentPhaseSpanId: string | null = null;
  const io = makeCollectingIO(sink, () => currentPhaseSpanId);

  const summaries: TraceSummary[] = [];
  /** 已产出的 trace，待 manifest 齐备后统一渲染 md */
  const rendered: { trace: Trace; summary: TraceSummary; fileName: string }[] = [];
  const startedAt = new Date().toISOString();
  const capabilities = tracing.capabilities();

  // 每个输入一棵 span 树
  try {
    for (let i = 0; i < args.inputs.length; i++) {
      const raw = args.inputs[i]!;
      const { input, label } = toInput(args.vaultRoot, raw);
      const fileName = `${String(i + 1).padStart(3, '0')}-${label.replace(/[\\/]/g, '-').replace(/\.md$/, '')}`;
      sink.beginTrace(label);
      const t0 = performance.now();
      let ok = true;
      let failure: string | undefined;
      let shortCircuited: boolean | undefined;
      let counts: { page: number; stub: number; drop: number } | undefined;

      const root = sink.phaseStart('ingest');
      try {
        // phase 标签刻意不设成 'prepare'——那会让所有 LLM span 都标成 'llm.prepare'，
        // 掩盖「哪一步调的模型」。核心层未暴露子步骤边界（I-W1' 只加了一个观测开关），
        // 故 LLM span 的相位由 TracingBackend 依据 system 指令特征推断。
        const prepareSpan = sink.phaseStart('ingest.prepare', root.spanId);
        currentPhaseSpanId = prepareSpan.spanId;
        const opts: IngestOptions = {
          io,
          collectTrace: true,
          granularity: args.granularity,
          extractMode: args.extractMode,
        };
        const prepared = await prepareIngest(input, { vault, gateway: tracing }, opts);
        sink.attachExtraction(prepareSpan.spanId, prepared);
        shortCircuited = prepared.shortCircuited;
        const gate = prepared.trace?.gate.candidates ?? [];
        counts = {
          page: gate.filter((c) => c.outcome === 'page').length,
          stub: gate.filter((c) => c.outcome === 'stub').length,
          drop: gate.filter((c) => c.outcome === 'drop').length,
        };
        prepareSpan.end('ok', {
          'ingest.shortCircuited': prepared.shortCircuited,
          'ingest.sourceRel': prepared.sourceRel,
          'ingest.wikiSlug': prepared.wikiSlug ?? '',
        });

        if (args.commit) {
          const commitSpan = sink.phaseStart('ingest.commit', root.spanId);
          currentPhaseSpanId = commitSpan.spanId;
          const applied = await commitIngest(prepared, { vault, gateway: tracing }, {
            ...opts,
            approve: async () => true,
          });
          const changed = applied?.changedPaths ?? [];
          commitSpan.end('ok', { 'ingest.changedCount': changed.length, 'ingest.changedPaths': changed.join(',') });
        }
        root.end('ok');
      } catch (e) {
        // 逐项隔离：一个输入失败不中断其余输入（trace 的价值恰在失败场景）
        ok = false;
        failure = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        root.end('error', { 'ingest.error': failure });
      }
      currentPhaseSpanId = null;

      const durationMs = Math.round(performance.now() - t0);
      const trace: Trace = sink.endTrace();
      const summary: TraceSummary = {
        file: `${fileName}.trace.json`,
        input: label,
        ok,
        durationMs,
        ...(failure !== undefined ? { error: failure } : {}),
        ...(shortCircuited !== undefined ? { shortCircuited } : {}),
        ...(counts !== undefined ? { counts } : {}),
      };
      await writeFile(path.join(outRunDir, summary.file), serializeTrace(trace), 'utf8');
      summaries.push(summary);
      rendered.push({ trace, summary, fileName });
    }
  } finally {
    await tracing.dispose();
  }

  // --- usage_update 探测（回答「ACP 腿能否支持 token 评测」）---
  const usageProbe: UsageProbeResult = await probeUsageUpdate(provider);

  const manifest: RunManifest = {
    runId,
    startedAt,
    git: gitInfo(),
    node: process.version,
    backend: {
      kind: tracing.kind,
      providerId: provider.id,
      command: provider.command,
      args: provider.args,
      ...(usageProbe.agentInfo !== null ? { agentInfo: usageProbe.agentInfo } : {}),
    },
    ...(usageProbe.registryNote !== '' ? { registryNote: usageProbe.registryNote } : {}),
    capabilities,
    options: { granularity: args.granularity, extractMode: args.extractMode, committed: args.commit },
    usageUpdateProbe: {
      observedUpdateKinds: usageProbe.observedUpdateKinds,
      seen: usageProbe.seen,
      ...(usageProbe.sample !== undefined ? { sample: usageProbe.sample } : {}),
    },
    traces: summaries,
  };
  await writeFile(path.join(args.outDir, 'manifest.json'), serializeManifest(manifest), 'utf8');
  await writeFile(path.join(outRunDir, 'manifest.json'), serializeManifest(manifest), 'utf8');

  // --- 渲染 md ---
  for (const entry of rendered) {
    const md = renderTraceMarkdown(entry.trace, manifest, entry.summary);
    await writeFile(path.join(outRunDir, `${entry.fileName}.trace.md`), md, 'utf8');
  }

  console.log(`[spike] runId=${runId}`);
  console.log(`[spike] 输出目录: ${outRunDir}`);
  console.log(`[spike] usage_update 探测: ${usageProbe.seen ? '✅ 观测到' : '❌ 未观测到'} ｜ 变体: ${usageProbe.observedUpdateKinds.join(', ') || '（无）'}`);
  console.log(`[spike] agentInfo: ${usageProbe.agentInfo !== null ? `${usageProbe.agentInfo.name} ${usageProbe.agentInfo.version}` : '（未探测到）'}`);
  for (const s of summaries) console.log(`[spike] ${s.ok ? '✅' : '❌'} ${s.input} (${(s.durationMs / 1000).toFixed(1)}s)`);
}

main().catch((e: unknown) => {
  console.error('[spike] 失败:', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
});
