/**
 * M7 F7.1（fake agent 行为）+ F7.2（spawn/NDJSON 流）+ F7.3（initialize 协商）。
 *
 * 全部零网络：fake agent 跑在 `process.execPath` 子进程里。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Readable } from 'node:stream';

import {
  spawnTransport,
  initializeTransport,
  createLoggedNdJsonStream,
} from '../../src/reasoning/acp/transport';

import {
  makeFakeAgent,
  cleanupFakeAgent,
  readJsonFile,
  fileExists,
  type FakeAgentFixture,
} from './helpers';

/** 构造一个按给定 chunk 边界推送的 Readable（确定性模拟分块） */
function chunkedReadable(chunks: string[]): Readable {
  const r = new Readable({ read() {} });
  for (const c of chunks) r.push(Buffer.from(c));
  r.push(null);
  return r;
}

let fx: FakeAgentFixture | null = null;
afterEach(() => {
  if (fx) {
    cleanupFakeAgent(fx);
    fx = null;
  }
});

// --- F7.1 + F7.2-01 + F7.3-01：fake agent 说协议、握手成功 ---
describe('F7.1/F7.2/F7.3 握手与协议', () => {
  it('T7.1-01 / T7.2-01 / T7.3-01：initialize+session/new+session/prompt 全链路', async () => {
    fx = makeFakeAgent({ agentCapabilities: { supportsStreaming: true, supportsSessionPersistence: true } });
    const t = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    const init = await initializeTransport(t);
    expect(init.agentCapabilities.supportsStreaming).toBe(true);
    expect(init.agentCapabilities.supportsSessionPersistence).toBe(true);

    const s = await t.connection.request<{ sessionId: string }>('session/new', {});
    expect(s.sessionId).toMatch(/^sess-\d+$/);

    const p = await t.connection.request<{ content: string }>('session/prompt', {
      sessionId: s.sessionId,
      prompt: 'hi',
    });
    expect(p.content).toBe('PONG:hi');
    await t.connection.terminate(1_000);
  });

  it('T7.3-02（安全回归门）：握手 clientCapabilities 必须 fs 全 false、terminal false', async () => {
    fx = makeFakeAgent({});
    const t = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    await initializeTransport(t);
    const echoed = readJsonFile(fx.echoFile) as {
      protocolVersion: number;
      clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean };
      clientInfo: { name: string; version: string };
    };
    expect(echoed.protocolVersion).toBe(1);
    expect(echoed.clientCapabilities.fs.readTextFile).toBe(false);
    expect(echoed.clientCapabilities.fs.writeTextFile).toBe(false);
    expect(echoed.clientCapabilities.terminal).toBe(false);
    expect(echoed.clientInfo.name).toBe('LLM-Wiki-Agent');
    await t.connection.terminate(1_000);
  });

  it('T7.3-04（I3 探针）：initialize 读回 agentCapabilities → terminate 可观测', async () => {
    fx = makeFakeAgent({ agentCapabilities: { supportsStreaming: false, supportsSessionPersistence: true } });
    const t = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    const init = await initializeTransport(t);
    expect(init.agentCapabilities?.supportsSessionPersistence).toBe(true);
    await t.connection.terminate(1_000);
    expect(t.child.exitCode != null || t.child.signalCode != null || t.child.killed).toBe(true);
  });
});

// --- F7.2-02：命令不存在 → ACP_SPAWN_FAILED ---
describe('F7.2-02 spawn 失败归一化', () => {
  it('command 不存在 → TransientError(ACP_SPAWN_FAILED)', async () => {
    const t = spawnTransport('no-such-bin-xyz', [], {});
    let err: unknown;
    try {
      await initializeTransport(t);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('ACP_SPAWN_FAILED');
  });
});

// --- F7.2-03 / F7.1-03：畸形行 warn-and-skip，不中断连接 ---
describe('F7.2-03 / F7.1-03 畸形容错', () => {
  it('fake agent 先吐畸形行再回合法响应 → 畸形被跳过、握手仍成功', async () => {
    fx = makeFakeAgent({ malformed: true });
    const warns: string[] = [];
    const t = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {}, (m) => warns.push(m));
    const init = await initializeTransport(t);
    expect(init.agentCapabilities).toBeDefined();
    expect(warns.some((w) => w.includes('畸形'))).toBe(true);
    await t.connection.terminate(1_000);
  });
});

// --- F7.2-04：半行 JSON（无换行截断）留 buffer 等下一块 ---
describe('F7.2-04 分块边界', () => {
  it('一行 JSON 跨两个 chunk → 合并后只产出一条消息', async () => {
    const r = chunkedReadable(['{"jsonrpc":"2.0", "id":1, "met', 'hod":"initialize"}\n']);
    const got: unknown[] = [];
    for await (const m of createLoggedNdJsonStream(r, () => {})) got.push(m);
    expect(got).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize' }]);
  });

  it('畸形行被跳过、合法行仍产出', async () => {
    const r = chunkedReadable(['not json at all\n', '{"jsonrpc":"2.0", "id":2, "result":{"ok":true}}\n']);
    const got: unknown[] = [];
    const warns: string[] = [];
    for await (const m of createLoggedNdJsonStream(r, (w) => warns.push(w))) got.push(m);
    expect(got).toEqual([{ jsonrpc: '2.0', id: 2, result: { ok: true } }]);
    expect(warns.length).toBe(1);
  });
});

// --- F7.2-05：子进程提前退出 → 请求 Promise 拒绝 ---
describe('F7.2-05 子进程提前退出', () => {
  it('exitBeforeResponse → initialize 请求被拒绝', async () => {
    fx = makeFakeAgent({ exitBeforeResponse: true });
    const t = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    let err: unknown;
    try {
      await initializeTransport(t);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });

  it('exitAfterInit 后子进程确实退出、下一次请求被拒绝', async () => {
    fx = makeFakeAgent({ exitAfterInit: true });
    const t = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    await initializeTransport(t); // 握手成功
    expect(fileExists(fx.startedFile)).toBe(true);
    // 等 fake agent 自退（exitAfterInit 在 30ms 后 exit）
    await new Promise((r) => setTimeout(r, 120));
    expect(t.child.exitCode != null || t.child.signalCode != null || t.child.killed).toBe(true);
    let err: unknown;
    try {
      await t.connection.request('session/new', {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });
});

// --- F7.3-03：initialize 超时 → ACP_INITIALIZE_TIMEOUT ---
describe('F7.3-03 initialize 超时', () => {
  it('fake agent 延迟超 initializeTimeoutMs → TransientError(ACP_INITIALIZE_TIMEOUT)', async () => {
    fx = makeFakeAgent({ delayMs: 500 });
    const t = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    let err: unknown;
    try {
      await initializeTransport(t, 150);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('ACP_INITIALIZE_TIMEOUT');
  });

  it('agent 返回含 timed out 的错误 → toACPRequestError 归一为 ACP_TIMEOUT（Transient）', async () => {
    fx = makeFakeAgent({ initError: 'request timed out after 1000ms' });
    const t = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    let err: unknown;
    try {
      await initializeTransport(t);
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('ACP_TIMEOUT');
  });
});

// --- streamedText 跨请求泄漏：AcpConnection 单元级（确定性，无子进程/无 sleep）---
describe('AcpConnection 流式缓冲归属', () => {
  it('prompt() 原子清空缓冲：上一个请求的迟到 chunk 不得混入下一次', async () => {
    const { AcpConnection } = await import('../../src/reasoning/acp/transport');
    const { PassThrough } = await import('node:stream');
    const toChild = new PassThrough();
    const fromChild = new PassThrough();
    // 伪 ChildProcess：AcpConnection 只用到 stdin/stdout/stderr 三个管道 + 事件
    const fakeChild = {
      stdin: toChild,
      stdout: fromChild,
      stderr: new PassThrough(),
      on: () => fakeChild,
      once: () => fakeChild,
      kill: () => true,
      exitCode: null,
      signalCode: null,
    };
    const conn = new AcpConnection(fakeChild as never, () => {});
    // 让 stream 的异步迭代器开始消费 stdout
    await new Promise((r) => setTimeout(r, 0));

    const upd = (text: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
      }) + '\n';

    // 第一次 prompt：响应前推正文 A；响应后推**迟到** chunk "LEAK"（属上一次）
    const p1 = conn.prompt({ sessionId: 's', prompt: [] });
    await new Promise((r) => setTimeout(r, 0));
    fromChild.write(upd('A'));
    fromChild.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    const r1 = await p1;
    expect(r1.text).toBe('A');
    // 迟到块到达（此时滞留在缓冲里）
    fromChild.write(upd('LEAK'));
    await new Promise((r) => setTimeout(r, 0));

    // 第二次 prompt：缓冲必须先被清空 → 本次正文只含 B，不含 LEAK
    const p2 = conn.prompt({ sessionId: 's', prompt: [] });
    await new Promise((r) => setTimeout(r, 0));
    fromChild.write(upd('B'));
    fromChild.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }) + '\n');
    const r2 = await p2;
    expect(r2.text).toBe('B');
    expect(r2.text).not.toContain('LEAK');
  });
});
