/**
 * F3.3 GatewayBackend 类装配验证（M3 §1 / 00 §4）。经接缝验证 complete/chat/embed/
 * expand/capabilities/dispose 正确转发到模块函数。
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  GatewayBackend,
} from '../../src/reasoning/gateway-backend';
import { configureGateway } from '../../src/reasoning/gateway-config';
import type { ReasoningResult } from '../../src/reasoning/backend';

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
  embedding_model: 'voyage:v',
  providers: { anthropic: { apiKey: 'k' }, voyage: { apiKey: 'k-v', dims: 1024 } },
};

describe('F3.3 GatewayBackend 类', () => {
  let backend: GatewayBackend;

  beforeEach(() => {
    configureGateway({ ...cfg });
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    backend = new GatewayBackend();
  });

  it('kind === "gateway"', () => {
    expect(backend.kind).toBe('gateway');
  });

  it('complete(prompt) 包装为 user 消息 → chat 接缝', async () => {
    __setChatTransportForTests(async (req) => {
      expect(req.messages).toEqual([{ role: 'user', content: 'hi' }]);
      return fakeResult();
    });
    const r = await backend.complete({ prompt: 'hi' });
    expect(r.text).toBe('ok');
  });

  it('complete(messages) 原样透传 → chat 接缝', async () => {
    __setChatTransportForTests(async (req) => {
      expect(req.messages).toEqual([{ role: 'user', content: 'm' }]);
      return fakeResult();
    });
    const r = await backend.complete({ messages: [{ role: 'user', content: 'm' }] });
    expect(r.text).toBe('ok');
  });

  it('chat / embed / expand 转发到模块函数', async () => {
    __setChatTransportForTests(async () => fakeResult());
    __setEmbedTransportForTests(async () => [new Float32Array([0.1])]);

    expect((await backend.chat({ messages: [{ role: 'user', content: 'x' }] })).text).toBe('ok');

    const v = await backend.embed(['t']);
    expect(v).toHaveLength(1);

    __setChatTransportForTests(async () => fakeResult({ text: 'a\n\nb' }));
    expect(await backend.expand('q')).toEqual(['a', 'b']);
  });

  it('capabilities() 声明 embeddings 支持', () => {
    const caps = backend.capabilities();
    expect(caps.embeddings).toBe(true);
    expect(caps.streaming).toBe(false);
    expect(caps.tools).toBe(true);
  });

  it('dispose() 可解析', async () => {
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});
