/**
 * F3.5 错误归一化 + 超时（M3 §5,§6 / 03 §5,§6）。T3.5-01~06。
 * 错误归一化测纯函数 normalizeGatewayError；超时测 withDefaultTimeout 及其在 chat 中的集成。
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  __setChatTransportForTests,
  chat,
  normalizeGatewayError,
  withDefaultTimeout,
} from '../../src/reasoning/gateway-backend';
import { configureGateway } from '../../src/reasoning/gateway-config';
import { expectErrorCodeAsync } from '../helpers/errors';
import type { ReasoningResult } from '../../src/reasoning/backend';

function fakeResult(): ReasoningResult {
  return {
    text: 'ok',
    blocks: [{ type: 'text', text: 'ok' }],
    stopReason: 'end',
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'anthropic:claude-x',
    providerId: 'anthropic',
  };
}

describe('F3.5 错误归一化（T3.5-01~04）', () => {
  // T3.5-01：4xx → ConfigError(PROVIDER_CONFIG)
  it('T3.5-01 401/403/400 → ConfigError(PROVIDER_CONFIG)', () => {
    for (const code of [401, 403, 400]) {
      const e = normalizeGatewayError({ statusCode: code, message: 'm' });
      expect(e).toBeInstanceOf(Error);
      expect((e as Error & { code: string }).code).toBe('PROVIDER_CONFIG');
    }
  });

  // T3.5-02：429/408/5xx → TransientError（P0-7：5xx 不落兜底）
  it('T3.5-02 429/408/500/503 → TransientError(TRANSIENT)', () => {
    for (const code of [429, 408, 500, 503]) {
      const e = normalizeGatewayError({ statusCode: code, message: 'm' });
      expect((e as Error & { code: string }).code).toBe('TRANSIENT');
    }
  });

  // T3.5-03：AbortError / 网络错误 → TransientError
  it('T3.5-03 AbortError / ECONNRESET / ETIMEDOUT → TransientError', () => {
    expect((normalizeGatewayError({ name: 'AbortError', message: 'aborted' }) as Error & { code: string }).code).toBe(
      'TRANSIENT',
    );
    expect(
      (normalizeGatewayError({ message: 'read ECONNRESET' }) as Error & { code: string }).code,
    ).toBe('TRANSIENT');
    expect(
      (normalizeGatewayError({ message: 'connect ETIMEDOUT' }) as Error & { code: string }).code,
    ).toBe('TRANSIENT');
  });

  // T3.5-04：未知错误原样上抛（不吞）
  it('T3.5-04 未知 Error 原样上抛', () => {
    const original = new TypeError('unexpected');
    expect(normalizeGatewayError(original)).toBe(original);
  });

  it('T3.5-04 非 Error（普通对象/null）→ 包装为 Error', () => {
    const wrapped = normalizeGatewayError({ foo: 1 });
    expect(wrapped).toBeInstanceOf(Error);
    expect(normalizeGatewayError(null)).toBeInstanceOf(Error);
  });
});

describe('F3.5 超时（T3.5-05~06）', () => {
  beforeEach(() => {
    __setChatTransportForTests(null);
  });

  // withDefaultTimeout 纯函数
  it('withDefaultTimeout(undefined, N) 在 ~N ms 后 abort', async () => {
    const s = withDefaultTimeout(undefined, 5);
    await new Promise<void>((res) => s.addEventListener('abort', () => res()));
    expect(s.aborted).toBe(true);
  });

  it('withDefaultTimeout(caller 已 abort, huge) → 立即 abort 且复用 caller 信号', () => {
    const caller = new AbortController();
    caller.abort();
    const s = withDefaultTimeout(caller.signal, 1e9);
    expect(s.aborted).toBe(true);
    expect(s).toBe(caller.signal);
  });

  // T3.5-05：纯超时触发 → TransientError（caller 未 abort，超时先到）
  it('T3.5-05 纯超时触发 → TransientError', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-x',
      embedding_model: 'voyage:v',
      providers: { anthropic: { apiKey: 'k' } },
      chat_timeout_ms: 5,
    });
    __setChatTransportForTests(async (req) => {
      await new Promise<void>((_, rej) => {
        req.abortSignal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      });
      return fakeResult();
    });
    await expectErrorCodeAsync(
      chat({ messages: [{ role: 'user', content: 'x' }] }),
      'TRANSIENT',
    );
  });

  // T3.5-06：caller abort 优先于超时生效（超时设很大，caller 立即 abort）
  it('T3.5-06 caller abort 优先于超时生效', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-x',
      embedding_model: 'voyage:v',
      providers: { anthropic: { apiKey: 'k' } },
      chat_timeout_ms: 10000,
    });
    const caller = new AbortController();
    caller.abort();
    __setChatTransportForTests(async (req) => {
      await new Promise<void>((_, rej) => {
        req.abortSignal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      });
      return fakeResult();
    });
    const start = Date.now();
    await expectErrorCodeAsync(
      chat({ messages: [{ role: 'user', content: 'x' }], abortSignal: caller.signal }),
      'TRANSIENT',
    );
    // caller 已立即 abort，绝不会等到 10s 超时
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
