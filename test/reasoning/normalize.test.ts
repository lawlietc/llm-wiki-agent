/**
 * F3.4 usage / stopReason 归一化（M3 §4 / 03 §4）。T3.4-01~06。
 * 用 test/fixtures/ai-sdk-responses/samples.json（v6 / legacy / anthropic 缓存 / refusal /
 * content_filter / tool-calls 录制形状）断言归一化输出。这是防 P0-6 字段名错误的关键防线。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mapStopReason, normalizeSdkUsage, toChatBlocks } from '../../src/reasoning/gateway-backend';

const here = dirname(fileURLToPath(import.meta.url));
const samples = JSON.parse(
  readFileSync(resolve(here, '../fixtures/ai-sdk-responses/samples.json'), 'utf8'),
) as Record<string, { usage?: Record<string, unknown>; finishReason?: string; providerMetadata?: unknown; response?: { messages: Array<{ role: string; content: unknown }> } }>;

describe('F3.4 usage 归一化', () => {
  // T3.4-01：v6 形状 inputTokens/outputTokens
  it('T3.4-01 v6 形状正确映射', () => {
    const u = normalizeSdkUsage(samples.v6);
    expect(u.inputTokens).toBe(10);
    expect(u.outputTokens).toBe(20);
  });

  // T3.4-02：legacy 形状 promptTokens/completionTokens 经 firstFinite 取到
  it('T3.4-02 legacy 形状取到', () => {
    const u = normalizeSdkUsage(samples.legacy);
    expect(u.inputTokens).toBe(11);
    expect(u.outputTokens).toBe(22);
  });

  // T3.4-03：NaN/缺失 usage → 0（不抛）
  it('T3.4-03 null/缺失 usage → 0', () => {
    const u = normalizeSdkUsage(samples.nanUsage);
    expect(u.inputTokens).toBe(0);
    expect(u.outputTokens).toBe(0);
  });

  // T3.4-04：anthropic providerMetadata 缓存 token 优先于 inputTokenDetails
  it('T3.4-04 anthropic 缓存 token 优先', () => {
    const u = normalizeSdkUsage(samples.v6);
    expect(u.cacheReadTokens).toBe(100); // anthropic.cacheReadInputTokens 优先于 inputTokenDetails.cacheReadTokens(3)
    expect(u.cacheWriteTokens).toBe(200);
  });

  it('T3.4-04 无 anthropic 时回落到 v6 中立 inputTokenDetails', () => {
    const u = normalizeSdkUsage({
      usage: { inputTokens: 1, outputTokens: 2, inputTokenDetails: { cacheReadTokens: 7, cacheWriteTokens: 8 } },
      providerMetadata: undefined,
    });
    expect(u.cacheReadTokens).toBe(7);
    expect(u.cacheWriteTokens).toBe(8);
  });
});

describe('F3.4 stopReason 映射（T3.4-05）', () => {
  const cases: Array<[string | undefined, Record<string, Record<string, unknown> | undefined> | undefined, string]> = [
    ['stop', undefined, 'end'],
    ['', undefined, 'end'],
    ['tool-calls', undefined, 'tool_calls'],
    ['length', undefined, 'length'],
    ['max-tokens', undefined, 'length'],
    ['refusal', undefined, 'refusal'],
    ['content-filter', undefined, 'content_filter'],
    ['content_filter', undefined, 'content_filter'],
    ['error', undefined, 'other'],
    // anthropic 经 providerMetadata.stopReason 给 end_turn / refusal
    ['stop', { anthropic: { stopReason: 'end_turn' } }, 'end'],
    ['stop', { anthropic: { stopReason: 'refusal' } }, 'refusal'],
  ];
  for (const [finishReason, meta, expected] of cases) {
    it(`mapStopReason(${JSON.stringify(finishReason)}, ${JSON.stringify(meta)}) → ${expected}`, () => {
      expect(mapStopReason(finishReason, meta)).toBe(expected);
    });
  }

  // 来自 golden fixture 的端到端映射
  it('fixture: v6 end_turn → end', () => {
    expect(mapStopReason(samples.v6.finishReason, samples.v6.providerMetadata as never)).toBe('end');
  });
  it('fixture: refusal → refusal', () => {
    expect(mapStopReason(samples.refusal.finishReason, samples.refusal.providerMetadata as never)).toBe('refusal');
  });
  it('fixture: content-filter → content_filter', () => {
    expect(mapStopReason(samples.contentFilter.finishReason, undefined)).toBe('content_filter');
  });
  it('fixture: tool-calls → tool_calls', () => {
    expect(mapStopReason(samples.toolCalls.finishReason, undefined)).toBe('tool_calls');
  });
  it('fixture: length → length', () => {
    expect(mapStopReason(samples.length.finishReason, undefined)).toBe('length');
  });
  it('fixture: unknown(error) → other', () => {
    expect(mapStopReason(samples.unknownFinish.finishReason, undefined)).toBe('other');
  });
});

describe('F3.4 响应消息摊平（T3.4-06）', () => {
  it('纯文本 content → 单个 text 块', () => {
    const blocks = toChatBlocks(samples.v6.response!.messages);
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('数组 content（text + tool-call）→ 对应块', () => {
    const blocks = toChatBlocks(samples.toolCalls.response!.messages);
    expect(blocks).toEqual([
      { type: 'text', text: 'let me call' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'search', input: { q: 'x' } },
    ]);
  });

  it('空 content → 空块数组（不抛）', () => {
    expect(toChatBlocks([{ role: 'assistant', content: '' }])).toEqual([]);
    expect(toChatBlocks([])).toEqual([]);
  });
});
