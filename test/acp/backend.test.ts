/**
 * M7 F7.4 ACPAgentBackend。
 *
 * 全部零网络：fake agent 跑在 `process.execPath` 子进程里。
 */

import { describe, it, expect, afterEach } from 'vitest';

import { ACPAgentBackend } from '../../src/reasoning/acp/backend';
import { ConfigError } from '../../src/errors';

import {
  makeFakeAgent,
  cleanupFakeAgent,
  isAlive,
  fileExists,
  readJsonFile,
  type FakeAgentFixture,
} from './helpers';

const backends: ACPAgentBackend[] = [];
let fx: FakeAgentFixture | null = null;

afterEach(async () => {
  for (const b of backends) {
    try {
      await b.dispose();
    } catch {
      /* ignore */
    }
  }
  backends.length = 0;
  if (fx) {
    cleanupFakeAgent(fx);
    fx = null;
  }
});

function newBackend(scenario: Record<string, unknown> = {}): ACPAgentBackend {
  fx = makeFakeAgent(scenario);
  const b = new ACPAgentBackend(fx.provider);
  backends.push(b);
  return b;
}

describe('F7.4 ACPAgentBackend', () => {
  it('T7.4-01：complete(prompt) → ReasoningResult（text/stopReason/usage 补零）', async () => {
    const b = newBackend({});
    const r = await b.complete({ prompt: 'hi' });
    expect(r.text).toBe('PONG:hi');
    expect(r.stopReason).toBe('end');
    expect(r.blocks).toEqual([{ type: 'text', text: 'PONG:hi' }]);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(r.model).toBe('fake');
    expect(r.providerId).toBe('fake');
  });

  it('T7.4-02（I2）：tools 非空 → ACP_TOOLS_UNSUPPORTED，且 fake agent 从未启动', async () => {
    const b = newBackend({});
    let err: unknown;
    try {
      await b.complete({ prompt: 'x', tools: [{ name: 't', description: '', inputSchema: {} }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as { code?: string }).code).toBe('ACP_TOOLS_UNSUPPORTED');
    // 抛错发生在 spawn 之前 → fake agent 从未启动
    expect(fileExists(fx!.startedFile)).toBe(false);
  });

  it('T7.4-03：chat(messages) → 取最后一条 user 消息作为 prompt', async () => {
    const b = newBackend({});
    const r = await b.chat({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'final' },
      ],
    });
    expect(r.text).toBe('PONG:final');
  });

  it('T7.4-04（I5）：dispose 后子进程退出码可观测（无孤儿）', async () => {
    const b = newBackend({});
    await b.complete({ prompt: 'x' });
    const child = b.process;
    expect(isAlive(child)).toBe(true);
    await b.dispose();
    expect(b.process).toBeNull();
    expect(child!.exitCode != null || child!.signalCode != null || child!.killed).toBe(true);
  });

  it('T7.4-05：会话复用 —— 两次 complete 只 initialize 一次', async () => {
    const b = newBackend({});
    await b.complete({ prompt: 'a' });
    await b.complete({ prompt: 'b' });
    // fake agent 在每次 initialize 累加计数；复用应只 1 次
    expect(readJsonFile(fx!.countFile)).toBe(1);
  });

  it('T7.4-06：kind=acp-agent；capabilities() 由探针映射（tools/embeddings 恒 false）', async () => {
    const b = newBackend({ agentCapabilities: { supportsStreaming: true, supportsSessionPersistence: false } });
    expect(b.kind).toBe('acp-agent');
    await b.complete({ prompt: 'x' }); // 触发 initialize 以填充 rawCaps
    const caps = b.capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.sessionPersistence).toBe(false);
    expect(caps.tools).toBe(false); // I2
    expect(caps.embeddings).toBe(false);
  });

  it('T7.4-07：agent 返回错误 → toACPRequestError 归一化为 ACP_ERROR（Config）', async () => {
    const b = newBackend({ sessionError: 'boom from agent' });
    let err: unknown;
    try {
      await b.complete({ prompt: 'x' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as { code?: string }).code).toBe('ACP_ERROR');
  });

  it('usage 非空时映射到 ReasoningResult（非缺省补零分支）', async () => {
    const b = newBackend({ usage: { inputTokens: 5, outputTokens: 7 } });
    const r = await b.complete({ prompt: 'x' });
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('agent 不回 usage 时缺省补零（?? 0 分支）', async () => {
    const b = newBackend({ omitUsage: true });
    const r = await b.complete({ prompt: 'x' });
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('回归：上一次 prompt 的**迟到 chunk** 不得混入下一次的回稿', async () => {
    // 场景：第一次 complete 在响应后仍推来 "LEAK"；第二次 complete 前应已清空缓冲，
    // 回稿只能是本次内容（PONG:second），不得出现 "LEAK" 前缀。
    // 对应真实缺陷：skeleton 回稿被上一条回答的尾部污染 → JSON 断裂 → CITED_FALLBACK。
    const b = newBackend({ lateChunks: ['LEAK'], lateChunksDelayMs: 40 });
    const first = await b.complete({ prompt: 'first' });
    expect(first.text).toBe('PONG:first');

    // 等迟到 chunk 到达并被缓冲（此时若不清空，会污染下一次）
    await new Promise((r) => setTimeout(r, 120));
    const second = await b.complete({ prompt: 'second' });
    expect(second.text).toBe('PONG:second');
    expect(second.text).not.toContain('LEAK');
  });
});
