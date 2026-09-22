/**
 * 人读 markdown 视图（spike 观测）。
 *
 * **设计原则**：对每条被 drop 的候选，把「模型说了什么」与「门为什么否掉它」
 * 并排放在一眼能看到的距离内，并附原文证据片段与空白裁决位。
 *
 * 渲染器**直接消费 `schema.ts` 的类型**（单一事实源），不重复定义数据结构。
 *
 * **不显示 token 列**：ACP 腿拿不到 usage（协议走 `session/update` 通知，
 * 本项目 transport 未解析），显示全 0 会误导。若某条 LLM span 确有 usage，才在
 * 该条下附一行。
 */

import type { CandidateTrace, ExtractionTrace, RunManifest, Span, Trace, TraceSummary } from './schema';

function sec(n: number): string {
  return `${(n / 1000).toFixed(1)}s`;
}

/** 候选的证据片段（找不到出处 → 显式标注疑似幻觉） */
function evidenceLine(c: CandidateTrace): string {
  if (c.evidence === null) {
    return '- **原文片段**: （无 —— 正文中找不到该名字，**疑似模型幻觉提名**；请对照下方 LLM 回稿核对）';
  }
  if (c.evidence === undefined) return '- **原文片段**: （未采集）';
  return `- **原文片段** @ 偏移 ${c.evidence.offset}:\n  \`\`\`\n  ${c.evidence.snippet}\n  \`\`\``;
}

function renderCandidate(c: CandidateTrace, idx: number): string {
  const lines: string[] = [];
  lines.push(`#### ${idx}. \`${c.slug}\` — ${c.name}    \`${c.kind}\` / \`${c.coverage}\``);
  lines.push(`- **门理由**: ${c.reason}`);
  lines.push(
    `- **分类**: kind=${c.classification.kind ?? '（未确认）'}, basis=${c.classification.basis}, reason=\`${c.classification.reason}\`` +
      (c.classification.rejected === true ? '，**rejected: true**（泛化名单命中 → 不建页）' : ''),
  );
  lines.push(`- **位置**: ${c.location} ｜ handLinked: ${c.handLinked ? '是' : '否'} ｜ 提名序号: ${c.ordinal}`);
  lines.push(evidenceLine(c));
  if (c.summary !== undefined) lines.push(`- **模型摘要**: ${c.summary}`);
  if (c.aliases !== undefined && c.aliases.length > 0) lines.push(`- **别名**: ${c.aliases.join('、')}`);
  if (c.facts !== undefined && c.facts.length > 0) {
    lines.push(`- **事实锚点**: ${c.facts.length} 条（${c.facts.map((f) => `${f.sourceRef ?? '?'}#chunk-${f.chunkIndex}`).join(', ')}）`);
  }
  if (c.edges !== undefined && c.edges.length > 0) {
    lines.push(`- **关系边**: ${c.edges.map((e) => `${e.from} —${e.type}→ ${e.to}`).join('；')}`);
  }
  // 仅 drop 给裁决位（评测标注界面）
  if (c.outcome === 'drop') {
    lines.push('- **人工裁决**: ☐ 该抽  ☐ 不该抽   备注：__________');
  }
  return lines.join('\n');
}

function renderExtraction(ex: ExtractionTrace): string {
  const lines: string[] = [];
  const byOutcome = (o: CandidateTrace['outcome']) => ex.candidates.filter((c) => c.outcome === o);

  lines.push(`> 共 ${ex.candidates.length} 个候选：page ${byOutcome('page').length} / stub ${byOutcome('stub').length} / **drop ${byOutcome('drop').length}**。（另有非候选/非法提名不计入）`);
  lines.push('');

  const groups: { key: CandidateTrace['outcome']; title: string }[] = [
    { key: 'page', title: '✅ page' },
    { key: 'stub', title: '⚠️ stub' },
    { key: 'drop', title: '❌ drop（★重点★）' },
  ];
  for (const g of groups) {
    const items = byOutcome(g.key);
    lines.push(`### ${g.title}（${items.length}）`);
    lines.push('');
    if (items.length === 0) {
      lines.push('（无）');
      lines.push('');
      continue;
    }
    items.forEach((c, i) => {
      lines.push(renderCandidate(c, i + 1));
      lines.push('');
    });
  }

  if (ex.warnings.length > 0) {
    lines.push('### ⚠️ 抽取告警');
    lines.push('');
    for (const w of ex.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  if (ex.truncated !== undefined) {
    lines.push(`### ✂️ 截断\n\n- 实体: ${ex.truncated.entities ? '触顶' : '未触顶'} ｜ 关系: ${ex.truncated.relations ? '触顶' : '未触顶'}\n`);
  }
  if (ex.failed) {
    lines.push(`### ❌ 抽取降级\n\n- ${ex.errorMessage ?? '（无错误信息）'}\n`);
  }
  return lines.join('\n');
}

function renderSpanTree(spans: Span[]): string {
  const byParent = new Map<string | null, Span[]>();
  for (const s of spans) {
    const k = s.parentSpanId;
    const arr = byParent.get(k) ?? [];
    arr.push(s);
    byParent.set(k, arr);
  }
  const roots = byParent.get(null) ?? [];
  const lines: string[] = [];
  const walk = (s: Span, depth: number): void => {
    const indent = '  '.repeat(depth);
    const isLlm = s.kind === 'client';
    const mark = isLlm ? '🔵' : '▫️';
    const statusMark = s.status === 'error' ? ' ❌' : '';
    lines.push(`${indent}- ${mark} **${s.name}** — ${sec(s.durationMs)}${statusMark}`);
    for (const e of s.events ?? []) {
      lines.push(`${indent}  - ⚠️ ${e.name}${e.attributes !== undefined && typeof e.attributes.text === 'string' ? `: ${e.attributes.text}` : ''}`);
    }
    for (const child of byParent.get(s.spanId) ?? []) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return lines.join('\n');
}

function renderTimeline(spans: Span[]): string {
  // 根 span 是整条 trace 本身，不作为阶段列出（否则与最高层阶段重复）
  const phases = spans.filter((s) => s.kind === 'internal' && s.parentSpanId !== null);
  const llmSpans = spans.filter((s) => s.kind === 'client');
  const lines: string[] = [];
  lines.push('| 阶段 | 耗时 | LLM 调用 | 备注 |');
  lines.push('|---|---|---|---|');
  for (const p of phases) {
    // 归属：LLM span 的 start 落在该阶段 [start,end] 区间内
    const owned = llmSpans.filter((l) => l.startTime >= p.startTime && l.startTime <= p.endTime);
    const notes: string[] = [];
    if (p.status === 'error') notes.push('❌ 失败');
    if (owned.some((l) => l.llm?.usageUnavailable === true)) notes.push('usage 不可得');
    else if (owned.some((l) => l.llm?.usage !== undefined)) {
      const inTok = owned.reduce((s, l) => s + (l.llm?.usage?.inputTokens ?? 0), 0);
      const outTok = owned.reduce((s, l) => s + (l.llm?.usage?.outputTokens ?? 0), 0);
      notes.push(`in ${inTok} / out ${outTok} tok`);
    }
    lines.push(`| ${p.name} | ${sec(p.durationMs)} | ${owned.length} | ${notes.join('；')} |`);
  }
  return lines.join('\n');
}

/**
 * 一条 LLM 调用的 usage 展示文本。
 *
 * 实测修正：opencode 1.18.27 **确实**在响应里回传了真实 token 用量（非 0），
 * 故不能按「ACP 腿一律无 usage」处理。判据以**实际是否拿到非零值**为准：
 * - 有 usage → 展示数字
 * - 无 usage → 说明不可得（而不是展示 0）
 */
export function usageHint(l: Span): string {
  const llm = l.llm;
  if (llm === undefined) return '';
  if (llm.usage !== undefined) return `in ${llm.usage.inputTokens} / out ${llm.usage.outputTokens}`;
  if (llm.usageUnavailable === true) return 'usage 不可得';
  return '（无 usage）';
}

/** 渲染一条 trace 的完整 md */
export function renderTraceMarkdown(trace: Trace, manifest: RunManifest | null, summary: TraceSummary): string {
  const lines: string[] = [];
  const root = trace.spans.find((s) => s.parentSpanId === null);
  const extractSpan = trace.spans.find((s) => s.extraction !== undefined);
  const b = manifest?.backend;

  lines.push(`# Trace: ${summary.input}`);
  lines.push('');
  lines.push(`- runId: ${manifest?.runId ?? '（无 manifest）'}`);
  lines.push(`- 输入: ${summary.input}`);
  if (b !== undefined) {
    const ver = b.agentInfo?.version !== undefined ? ` ${b.agentInfo.version}` : '';
    const note = manifest?.registryNote !== undefined && manifest.registryNote !== '' ? `（注册表注记：${manifest.registryNote}）` : '';
    lines.push(`- 腿: ${b.kind} / ${b.providerId}${ver} ${note}`);
  }
  if (manifest !== null) {
    lines.push(`- 参数: granularity=${manifest.options.granularity}, extractMode=${manifest.options.extractMode}, committed=${manifest.options.committed}`);
  }
  lines.push(`- 结果: ${summary.ok ? '✅ 成功' : `❌ 失败：${summary.error ?? '（无信息）'}`} ｜ 总耗时 ${sec(summary.durationMs)}`);
  if (summary.shortCircuited !== undefined) {
    lines.push(`- 内容短路: ${summary.shortCircuited ? '**是**（仅刷新 raw 元数据，未走 LLM/未动 wiki 页）' : '否'}`);
  }
  if (summary.counts !== undefined) {
    lines.push(`- 候选计数: page ${summary.counts.page} / stub ${summary.counts.stub} / drop ${summary.counts.drop}`);
  }
  if (manifest !== null) {
    lines.push(
      `- usage 探测: ${manifest.usageUpdateProbe.seen ? '✅ 观测到 usage_update' : '❌ 未观测到 usage_update（ACP 腿无 token 数据）'}` +
        (manifest.usageUpdateProbe.observedUpdateKinds.length > 0 ? ` ｜ 观测到的变体: ${manifest.usageUpdateProbe.observedUpdateKinds.join(', ')}` : ''),
    );
  }
  lines.push('');

  if (root !== undefined) {
    lines.push('## 阶段时间线');
    lines.push('');
    lines.push(renderTimeline(trace.spans));
    lines.push('');
    lines.push('> usage 说明：opencode 1.18.27 实测在响应里回传真实 token 用量；同时协议另有 `usage_update` 通知（见 manifest 探测结论）但本项目 transport 未解析。');
    lines.push('');
  }

  lines.push('## 调用树');
  lines.push('');
  lines.push(renderSpanTree(trace.spans));
  lines.push('');

  if (extractSpan?.extraction !== undefined) {
    lines.push('## 实体判定（L3）');
    lines.push('');
    lines.push(renderExtraction(extractSpan.extraction));
  }

  const llmSpans = trace.spans.filter((s) => s.kind === 'client');
  if (llmSpans.length > 0) {
    lines.push('## LLM 调用');
    lines.push('');
    llmSpans.forEach((s, i) => {
      const l = s.llm;
      if (l === undefined) return;
      const usageNote = usageHint(s);
      lines.push(`<details><summary>${i + 1}. ${s.name}（${sec(s.durationMs)}，${usageNote}${l.responseEmpty === true ? '，⚠️ 回稿为空' : ''}）</summary>`);
      lines.push('');
      lines.push(`- phase: \`${l.phase}\` ｜ model: \`${l.model}\` ｜ stopReason: \`${l.stopReason}\` ｜ form: \`${l.requestForm}\``);
      if (l.system !== undefined) {
        lines.push('');
        lines.push('**System**');
        lines.push('```');
        lines.push(l.system);
        lines.push('```');
      }
      lines.push('');
      lines.push('**送入内容**');
      lines.push('```');
      lines.push(l.requestText);
      lines.push('```');
      lines.push('');
      lines.push('**回稿**');
      lines.push('```');
      lines.push(l.responseText);
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    });
  }

  return `${lines.join('\n')}\n`;
}
