/**
 * 零网络冒烟（spike 观测）：用假 LLM 回稿驱动一次真实 ingest 相位 A，
 * 断言 trace 结构正确（三类 outcome 齐全、缺省开关时无观测产物）。
 *
 * **不入 vitest 套件**（dev/ 是一次性产物），用 tsx 直接跑：
 *   npx tsx dev/trace-smoke.ts
 *
 * 通过 `__setChatTransportForTests` 注入假回稿——这是仓库既有的网关腿测试接缝。
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createVault } from '../src/vault/vault';
import { prepareIngest } from '../src/ingest/ingest';
import { __setChatTransportForTests, GatewayBackend } from '../src/reasoning/gateway-backend';
import { configureGateway } from '../src/reasoning/gateway-config';
import { TraceSink, serializeTrace } from './trace/sink';
import { renderTraceMarkdown } from './trace/render-md';
import type { ReasoningRequest, ReasoningResult } from '../src/reasoning/backend';
import type { RunManifest } from './trace/schema';

/** 伪造一条覆盖 page/stub/drop 三类的抽取回稿 + 一篇 wiki 页回稿 */
function fakeReply(req: ReasoningRequest): ReasoningResult {
  const prompt = req.prompt ?? '';
  const isSummary = prompt.includes('ai-first wiki 页');
  const isExtract = prompt.includes('抽取实体与关系');
  const isContradiction = prompt.includes('矛盾');

  let text: string;
  if (isSummary) {
    text = [
      '---',
      'type: source',
      'date: 2026-09-22',
      'ai-first: true',
      'confidence: high',
      'slug: fake-source',
      '---',
      '',
      '## For future agent',
      '这是一篇假回稿用于冒烟测试。',
      '',
      '正文提到 ACP 协议与 opencode。',
    ].join('\n');
  } else if (isExtract) {
    text = JSON.stringify({
      entities: [
        { name: 'ACP 协议', slug: 'acp-protocol', kind: 'concept', coverage: 'defined', summary: '本地 agent 与客户端的 JSON-RPC 协议' },
        // prose + named → stub
        { name: 'opencode', slug: 'opencode', kind: 'concept', coverage: 'named', summary: '一个编码 agent' },
        // 该名字不出现在正文中 → absent → drop（疑似幻觉提名）
        { name: 'Zenith Q9', slug: 'zenith-q9', kind: 'concept', coverage: 'named', summary: '虚构条目' },
      ],
      relations: [{ from: 'acp-protocol', type: 'relates_to', to: 'opencode' }],
    });
  } else if (isContradiction) {
    text = JSON.stringify({ contradictions: [] });
  } else {
    text = '{}';
  }

  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'fake:model',
    providerId: 'fake',
  };
}

/** 正文：含 ACP 协议（成段定义 → page），opencode（点名 → stub/discussed），不含 Zenith Q9（drop） */
const BODY = [
  '# 本地 agent 接入',
  '',
  'ACP 协议是本地 agent 与客户端之间的 JSON-RPC 协议。它在编辑器中定义了一套标准交互。',
  '',
  '我们使用 opencode 作为编码助手。',
].join('\n');

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'trace-smoke-'));
  try {
    await mkdir(path.join(root, 'raw'), { recursive: true });
    await mkdir(path.join(root, 'wiki'), { recursive: true });
    const rawRel = 'raw/fake-doc.md';
    await writeFile(path.join(root, rawRel), BODY, 'utf8');

    __setChatTransportForTests(async (req) => fakeReply(req));
    configureGateway({
      chat_model: 'anthropic:fake',
      embedding_model: 'anthropic:fake-embed',
      providers: { anthropic: { apiKey: 'k' } },
    });
    const gateway = new GatewayBackend();
    const vault = createVault(root);

    // --- 1) 开启观测 ---
    const sink = new TraceSink();
    sink.beginTrace(rawRel);
    const rootSpan = sink.phaseStart('ingest');
    const prepSpan = sink.phaseStart('ingest.prepare', rootSpan.spanId);
    const prepared = await prepareIngest(`file://${path.join(root, rawRel).replace(/\\/g, '/')}`, { vault, gateway }, {
      collectTrace: true,
      io: { err: (t) => sink.addEvent(prepSpan.spanId, 'io_err', { text: t }) },
    });
    sink.attachExtraction(prepSpan.spanId, prepared);
    prepSpan.end('ok');
    rootSpan.end('ok');
    const trace = sink.endTrace();

    const ex = trace.spans.find((s) => s.extraction !== undefined)?.extraction;
    if (ex === undefined) throw new Error('断言失败：未找到抽取 span');
    const outcomes = ex.candidates.map((c) => c.outcome);
    const has = (o: string) => outcomes.includes(o as never);
    if (!has('page') || !has('stub') || !has('drop')) {
      throw new Error(`断言失败：三类 outcome 不齐全，实际 = ${JSON.stringify(outcomes)}`);
    }
    // drop 的候选应有 absent 证据（证据为 null）
    const drop = ex.candidates.find((c) => c.outcome === 'drop');
    if (drop !== undefined && drop.evidence !== null) {
      throw new Error('断言失败：absent 候选的 evidence 应为 null');
    }

    // --- 2) 缺省开关：无观测产物 ---
    const preparedNoTrace = await prepareIngest(`file://${path.join(root, rawRel).replace(/\\/g, '/')}`, { vault, gateway }, {});
    if (preparedNoTrace.trace !== undefined) {
      throw new Error('断言失败：collectTrace 缺省时不应产生 trace');
    }

    const manifest: RunManifest = {
      runId: 'smoke',
      startedAt: new Date().toISOString(),
      git: { head: 'smoke', dirty: false },
      node: process.version,
      backend: { kind: 'gateway', providerId: 'fake', command: '-', args: [] },
      capabilities: { streaming: false, tools: false, sessionPersistence: false, embeddings: false },
      options: { granularity: 'standard', extractMode: 'single', committed: false },
      usageUpdateProbe: { observedUpdateKinds: [], seen: false },
      traces: [],
    };
    const md = renderTraceMarkdown(trace, manifest, { file: 'smoke.json', input: rawRel, ok: true, durationMs: 1 });
    const json = serializeTrace(trace);
    if (!md.includes('实体判定') || !md.includes('drop')) throw new Error('断言失败：md 视图缺少实体判定区');
    if (!json.includes('"outcome"')) throw new Error('断言失败：JSON 缺少 outcome 字段');

    console.log('✅ 冒烟通过');
    console.log(`   outcomes = ${JSON.stringify(outcomes)}`);
    console.log(`   候选数 = ${ex.candidates.length}`);
    console.log(`   JSON 字节数 = ${json.length} ｜ md 字节数 = ${md.length}`);
    console.log('   —— md 片段 ——');
    console.log(md.split('\n').filter((l) => l.includes('drop') || l.includes('门理由') || l.includes('裁决')).slice(0, 8).join('\n'));
  } finally {
    __setChatTransportForTests(null);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error('❌ 冒烟失败:', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
});
