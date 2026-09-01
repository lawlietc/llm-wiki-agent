/**
 * F3.3 测试接缝 + chat 主链路（M3 §3 / 03 §4,§10）。T3.3-01~04。
 *
 * 全程经 `_chatTransport` 注入假响应，真实 `generateText` 永不调用（零网络）。
 * 通过 vi.mock('ai') 把 generateText/embedMany 换成 spy，断言其未被调用。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { generateText } from 'ai';

import {
  __setChatTransportForTests,
  GatewayBackend,
  chat,
} from '../../src/reasoning/gateway-backend';
import { configureGateway } from '../../src/reasoning/gateway-config';
import type { ReasoningRequest, ReasoningResult } from '../../src/reasoning/backend';
import { expectErrorCodeAsync } from '../helpers/errors';

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
  providers: { anthropic: { apiKey: 'k' }, openai: { apiKey: 'k2' } },
};

describe('F3.3 chat 主链路 + 测试接缝', () => {
  beforeEach(() => {
    configureGateway({ ...cfg });
    __setChatTransportForTests(null);
    vi.mocked(generateText).mockClear();
  });

  // T3.3-01：注入 transport → 返回 ReasoningResult，且 generateText 零调用（零网络）
  it('T3.3-01 注入 _chatTransport 返回结果，generateText 未被调用（零网络）', async () => {
    __setChatTransportForTests(async () => fakeResult({ text: 'from-transport' }));
    const r = await chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('from-transport');
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  // T3.3-02：chat 透传 system/messages/maxTokens/abortSignal 到 transport
  it('T3.3-02 chat 透传 system/messages/maxTokens/abortSignal 到 transport', async () => {
    let captured: ReasoningRequest | null = null;
    __setChatTransportForTests(async (req) => {
      captured = req;
      return fakeResult();
    });
    const controller = new AbortController();
    await chat({
      system: 'be brief',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 42,
      abortSignal: controller.signal,
    });
    expect(captured).not.toBeNull();
    expect(captured!.system).toBe('be brief');
    expect(captured!.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(captured!.maxTokens).toBe(42);
    expect(captured!.abortSignal).toBeInstanceOf(AbortSignal);
  });

  // T3.3-03：model 缺省走配置默认；指定则覆盖
  it('T3.3-03 model 缺省走配置默认模型，指定则覆盖', async () => {
    let captured: ReasoningRequest | null = null;
    __setChatTransportForTests(async (req) => {
      captured = req;
      return fakeResult({ model: req.model ?? 'anthropic:claude-x' });
    });
    await chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(captured!.model).toBe('anthropic:claude-x'); // 默认

    await chat({ model: 'openai:gpt-x', messages: [{ role: 'user', content: 'x' }] });
    expect(captured!.model).toBe('openai:gpt-x'); // 覆盖
  });

  // T3.3-04：transport 抛错 → 经 normalizeGatewayError 上抛
  it('T3.3-04 transport 抛 400 错误 → ConfigError(PROVIDER_CONFIG)', async () => {
    __setChatTransportForTests(async () => {
      throw { statusCode: 400, message: 'bad request' };
    });
    await expectErrorCodeAsync(
      chat({ messages: [{ role: 'user', content: 'x' }] }),
      'PROVIDER_CONFIG',
    );
  });

  it('T3.3-04 transport 抛未知错误 → 原样上抛（不归一化为 TransientError）', async () => {
    const original = new TypeError('weird transport failure');
    __setChatTransportForTests(async () => {
      throw original;
    });
    await expect(chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBe(original);
  });

  // complete：单轮 prompt → messages 构造后走 chat
  it('GatewayBackend.complete 单轮 prompt → 构造 user 消息并透传到 transport', async () => {
    let captured: ReasoningRequest | null = null;
    __setChatTransportForTests(async (req) => {
      captured = req;
      return fakeResult();
    });
    const backend = new GatewayBackend();
    const r = await backend.complete({ prompt: 'explain X' });
    expect(captured!.messages).toEqual([{ role: 'user', content: 'explain X' }]);
    expect(r.text).toBe('ok');
  });

  // GatewayBackend 实现委派到模块 chat
  it('GatewayBackend.chat 委派到 chat（完整 ReasoningBackend 契约）', async () => {
    __setChatTransportForTests(async () => fakeResult({ text: 'via-backend' }));
    const backend = new GatewayBackend();
    expect(backend.kind).toBe('gateway');
    const r = await backend.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('via-backend');
    const caps = backend.capabilities();
    expect(caps).toEqual({
      streaming: false,
      tools: true,
      sessionPersistence: false,
      embeddings: true,
    });
    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  // 真实路径（generateText mock 返回 v6 形状）：验证 usage/缓存/stopReason/消息摊平归一化
  it('chat 真实路径（generateText mock）归一化 generateText 结果', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'hello',
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4 },
      },
      response: { messages: [{ role: 'assistant', content: 'hello' }] },
      providerMetadata: {
        anthropic: { cacheReadInputTokens: 100, cacheCreationInputTokens: 200, stopReason: 'end_turn' },
      },
    } as never);
    const r = await chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('hello');
    expect(r.usage.inputTokens).toBe(10);
    expect(r.usage.outputTokens).toBe(20);
    expect(r.usage.cacheReadTokens).toBe(100); // anthropic 优先
    expect(r.usage.cacheWriteTokens).toBe(200);
    expect(r.stopReason).toBe('end'); // end_turn via anthropic stopReason
    expect(r.blocks).toEqual([{ type: 'text', text: 'hello' }]);
    expect(vi.mocked(generateText)).toHaveBeenCalled();
  });
});
