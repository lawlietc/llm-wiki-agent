/**
 * F3.6 embed / expand / 预算（M3 §4,§7,§8 / 03 §4,§7,§8）。T3.6-01~04。
 * embed 经 `_embedTransport` 接缝（零网络）；预算经 AsyncLocalStorage no-op 注入。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { embedMany } from 'ai';

import {
  __resetShrinkForTests,
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  VoyageResponseTooLargeError,
  currentShrinkLevel,
  maybeShrink,
  chat,
  embed,
  expand,
  withBudgetTracker,
} from '../../src/reasoning/gateway-backend';
import { configureGateway } from '../../src/reasoning/gateway-config';
import { expectErrorCodeAsync } from '../helpers/errors';
import type { ReasoningResult } from '../../src/reasoning/backend';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  embedMany: vi.fn(),
}));

function fakeResult(over: Partial<ReasoningResult> = {}): ReasoningResult {
  return {
    text: 'ok',
    blocks: [{ type: 'text', text: 'ok' }],
    stopReason: 'end',
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'anthropic:claude-x',
    providerId: 'anthropic',
    ...over,
  };
}

const cfg = {
  chat_model: 'anthropic:claude-x',
  embedding_model: 'voyage:voyage-3',
  providers: { anthropic: { apiKey: 'k' }, voyage: { apiKey: 'k-v', dims: 1024 } },
};

describe('F3.6 embed / expand / 预算', () => {
  beforeEach(() => {
    configureGateway({ ...cfg });
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    __resetShrinkForTests();
    vi.mocked(embedMany).mockClear();
  });

  // T3.6-01：_embedTransport 注入 → 返回 Float32Array[]，embedMany 零调用
  it('T3.6-01 _embedTransport 返回 Float32Array[]，embedMany 未被调用（零网络）', async () => {
    const vectors = [new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])];
    __setEmbedTransportForTests(async () => vectors);
    const r = await embed(['a', 'b']);
    expect(r).toBe(vectors);
    expect(vi.mocked(embedMany)).not.toHaveBeenCalled();
  });

  // 真实路径（embedMany mock 返回向量）：验证字节估算 + 返回，零网络
  it('embed 真实路径（embedMany mock）返回向量，小响应不缩容', async () => {
    vi.mocked(embedMany).mockResolvedValue({
      embeddings: [new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])],
    } as never);
    const r = await embed(['a', 'b']);
    expect(r.length).toBe(2);
    expect(vi.mocked(embedMany)).toHaveBeenCalled();
    expect(currentShrinkLevel()).toBe(1.0);
  });

  // T3.6-02：embed 响应超 256MB → 缩容 + VoyageResponseTooLargeError；连续 10 次成功 heal 回 1.0
  // 注：直接以字节数调 maybeShrink（已导出），避免构造 256MB 真实向量导致 OOM；
  // 缩容状态机是模块级单例，与 embed 接缝路径共用同一实现。
  it('T3.6-02 超 256MB 触发缩容，连续 10 次成功后 heal 回 1.0', () => {
    expect(() => maybeShrink(256 * 1024 * 1024 + 1)).toThrow(VoyageResponseTooLargeError);
    expect(currentShrinkLevel()).toBeLessThan(1.0);

    // 连续 10 次小响应 → 回升到 1.0
    for (let i = 0; i < 10; i++) maybeShrink(100);
    expect(currentShrinkLevel()).toBe(1.0);
  });

  // T3.6-03：expand 多行去空
  it('T3.6-03 expand 多行文本去空行成数组', async () => {
    __setChatTransportForTests(async () => fakeResult({ text: '量子计算\n\nRAG 检索\n\n  \n知识图谱' }));
    const subs = await expand('什么是检索增强');
    expect(subs).toEqual(['量子计算', 'RAG 检索', '知识图谱']);
  });

  // T3.6-04：BudgetTracker no-op；withBudgetTracker 包裹 chat 不报错且 record 可观测
  it('T3.6-04 withBudgetTracker 包裹 chat：reserve/record 被调用，usage 透传', async () => {
    const tracker = { reserve: vi.fn(), record: vi.fn() };
    __setChatTransportForTests(async () => fakeResult());
    await withBudgetTracker(tracker, async () => {
      await chat({ messages: [{ role: 'user', content: 'x' }] });
    });
    expect(tracker.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'anthropic:claude-x', kind: 'chat' }),
    );
    expect(tracker.record).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic:claude-x' }),
    );
  });

  it('T3.6-04 未注入 tracker（null）→ chat 仍正常（no-op）', async () => {
    __setChatTransportForTests(async () => fakeResult());
    const r = await chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(r.text).toBe('ok');
  });
});

describe('F3.6 embed 配置校验（接缝前，零网络）', () => {
  it('NO_EMBED_TOUCHPOINT：recipe.embedding=false → 在接缝前抛错', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-x',
      embedding_model: 'openai:no-embed',
      providers: { anthropic: { apiKey: 'k' }, openai: { apiKey: 'k2', embedding: false } },
    });
    await expectErrorCodeAsync(embed(['x'], { model: 'openai:no-embed' }), 'NO_EMBED_TOUCHPOINT');
  });

  it('NO_DIMS：recipe 无 dims → 在接缝前抛错', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-x',
      embedding_model: 'voyage:no-dims',
      providers: { anthropic: { apiKey: 'k' }, voyage: { apiKey: 'k-v' } }, // 无 dims
    });
    await expectErrorCodeAsync(embed(['x'], { model: 'voyage:no-dims' }), 'NO_DIMS');
  });
});
