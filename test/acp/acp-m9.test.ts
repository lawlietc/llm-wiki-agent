/**
 * M9 F9.1 + F9.2 + F9.3 —— opencode/真实 ACP 兼容性修复。
 *
 * 背景（opencode 1.18.23 实测）：
 * - 正文经无 id 的 session/update 通知（agent_message_chunk）推送，response 无 content
 * - session/prompt 的 prompt 须为 ContentBlock[]
 * - session/new 须带 cwd + mcpServers
 * - system 在 session/prompt 无对应字段，须并入 prompt
 * - Windows 下 npm 全局 CLI 的 shim 需经 shell 解析；SIGTERM 杀不掉 → 需 taskkill
 *
 * 全部零网络：fake agent 跑在 process.execPath 子进程里。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  spawnTransport,
  initializeTransport,
  type SpawnedAgent,
} from '../../src/reasoning/acp/transport';
import { ACPAgentBackend } from '../../src/reasoning/acp/backend';

import {
  makeFakeAgent,
  cleanupFakeAgent,
  readJsonFile,
  type FakeAgentFixture,
} from './helpers';

let fx: FakeAgentFixture | null = null;
let spawned: SpawnedAgent | null = null;
afterEach(() => {
  if (spawned) {
    try {
      spawned.connection.terminate(1_000);
    } catch {
      /* ignore */
    }
    spawned = null;
  }
  if (fx) {
    cleanupFakeAgent(fx);
    fx = null;
  }
});

describe('F9.1 通知通道：session/update 推送正文', () => {
  it('T9.1-01：notifyChunks 经 takeStreamedText 累积（response 无 content 时取通知）', async () => {
    fx = makeFakeAgent({ notifyChunks: ['巴黎', '是法国首都'], omitContent: true });
    spawned = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    await initializeTransport(spawned);
    const s = await spawned.connection.request<{ sessionId: string }>('session/new', {});
    const res = await spawned.connection.request<{ content?: string }>('session/prompt', {
      sessionId: s.sessionId,
      prompt: '问一个简单问题',
    });
    // response 无 content
    expect(res.content).toBeUndefined();
    // 正文来自通知累积
    expect(spawned.connection.takeStreamedText()).toBe('巴黎是法国首都');
  });

  it('T9.1-02：agent_thought_chunk 被排除，只累积 agent_message_chunk', async () => {
    fx = makeFakeAgent({
      thoughtChunks: ['我在思考…', '检索中…'],
      notifyChunks: ['最终答案'],
      omitContent: true,
    });
    spawned = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    await initializeTransport(spawned);
    const s = await spawned.connection.request<{ sessionId: string }>('session/new', {});
    await spawned.connection.request('session/prompt', { sessionId: s.sessionId, prompt: 'x' });
    expect(spawned.connection.takeStreamedText()).toBe('最终答案');
  });

  it('T9.1-03：takeStreamedText 取后清空', async () => {
    fx = makeFakeAgent({ notifyChunks: ['A', 'B'], omitContent: true });
    spawned = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    await initializeTransport(spawned);
    const s = await spawned.connection.request<{ sessionId: string }>('session/new', {});
    await spawned.connection.request('session/prompt', { sessionId: s.sessionId, prompt: 'x' });
    expect(spawned.connection.takeStreamedText()).toBe('AB');
    expect(spawned.connection.takeStreamedText()).toBe('');
  });
});

describe('F9.2 后端协议对齐真实 ACP', () => {
  it('T9.2-01：session/new 携带 cwd + mcpServers', async () => {
    const cwdEcho = join(tmpdir(), `acp-sesnew-${Date.now()}.json`);
    fx = makeFakeAgent({}, { ACP_SESSION_NEW_ECHO_FILE: cwdEcho });
    const backend = new ACPAgentBackend(fx.provider, { cwd: '/work/dir' });
    await backend.complete({ prompt: 'hi' });
    const params = readJsonFile(cwdEcho) as { cwd?: string; mcpServers?: unknown };
    expect(params.cwd).toBe('/work/dir');
    expect(params.mcpServers).toEqual([]); // 真实 opencode 要求数组，空对象 {} 报 Invalid params
    await backend.dispose();
  });

  it('T9.2-02：session/prompt 的 prompt 为 ContentBlock[] 且并入 system', async () => {
    const promptEcho = join(tmpdir(), `acp-prompt-${Date.now()}.json`);
    fx = makeFakeAgent({}, { ACP_PROMPT_ECHO_FILE: promptEcho });
    const backend = new ACPAgentBackend(fx.provider, {});
    const system = '你必须只输出 JSON。';
    const user = '法国的首都是哪里？';
    await backend.complete({ prompt: user, system });
    const prompt = readJsonFile(promptEcho) as Array<{ type: string; text: string }>;
    expect(Array.isArray(prompt)).toBe(true);
    expect(prompt[0].type).toBe('text');
    expect(prompt[0].text).toContain(system);
    expect(prompt[0].text).toContain(user);
    expect(prompt[0].text).toContain('---');
    await backend.dispose();
  });

  it('T9.2-03：正文优先取通知累积，回退 response.content', async () => {
    // 走通知
    fx = makeFakeAgent({ notifyChunks: ['来自通知'], omitContent: true });
    let backend = new ACPAgentBackend(fx.provider, {});
    let r = await backend.complete({ prompt: 'q' });
    expect(r.text).toBe('来自通知');
    await backend.dispose();

    // 走 response.content 回退（无通知）
    const fx2 = makeFakeAgent({ promptText: '来自响应' });
    backend = new ACPAgentBackend(fx2.provider, {});
    r = await backend.complete({ prompt: 'q' });
    expect(r.text).toBe('来自响应');
    await backend.dispose();
    cleanupFakeAgent(fx2);
  });

  it('T9.2-04：无 system 时 prompt 仅含 user 文本', async () => {
    const promptEcho = join(tmpdir(), `acp-prompt2-${Date.now()}.json`);
    fx = makeFakeAgent({}, { ACP_PROMPT_ECHO_FILE: promptEcho });
    const backend = new ACPAgentBackend(fx.provider, {});
    await backend.complete({ prompt: '单纯提问' });
    const prompt = readJsonFile(promptEcho) as Array<{ text: string }>;
    expect(prompt[0].text).toBe('单纯提问');
    await backend.dispose();
  });
});

describe('F9.3 Windows 进程兼容', () => {
  it('T9.3-01：裸命令（无扩展名）也能 spawn 成功（Windows shell 解析 .cmd shim）', async () => {
    // 非 Windows 下 shell:false 同样成功；Windows 下验证 shim 经 shell 解析
    const t = spawnTransport('node', ['--version'], {});
    expect(t.child.pid).toBeTruthy();
    // node --version 不是 ACP agent：进程正常退出（code 0）且无任何响应 → 应归一为启动失败（F9.3 早期退出检测）
    await expect(t.connection.spawnError).rejects.toMatchObject({ code: 'ACP_SPAWN_FAILED' });
    await new Promise((r) => setTimeout(r, 200));
    expect(t.child.exitCode).toBe(0);
    await t.connection.terminate(500);
  });

  it('T9.3-02：terminate 能清理忽略 SIGTERM 的进程（Windows taskkill / 非 Windows SIGKILL）', async () => {
    fx = makeFakeAgent({ ignoreTerm: true });
    spawned = spawnTransport(fx.provider.command, fx.provider.args, fx.provider.env ?? {});
    await initializeTransport(spawned);
    await spawned.connection.terminate(800); // 优雅 SIGTERM 被忽略 → 超时强杀
    expect(spawned.child.exitCode != null || spawned.child.signalCode != null || spawned.child.killed).toBe(true);
  });
});
