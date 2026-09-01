/**
 * M7 F7.5 provider 注册表 + 路由开关。
 */

import { describe, it, expect, afterEach } from 'vitest';

import { ACP_REGISTRY, getACPProvider } from '../../src/reasoning/acp/registry';
import { resolveReasoningBackend } from '../../src/reasoning/acp/router';
import { ACPAgentBackend } from '../../src/reasoning/acp/backend';
import { GatewayBackend } from '../../src/reasoning/gateway-backend';
import { ConfigError } from '../../src/errors';
import type { AIGatewayConfig } from '../../src/reasoning/gateway-config';

import { makeFakeAgent, cleanupFakeAgent, type FakeAgentFixture } from './helpers';

const gwCfg: AIGatewayConfig = {
  chat_model: 'openai:gpt-4',
  embedding_model: 'openai:text-embedding-3-small',
  providers: {},
};

let fx: FakeAgentFixture | null = null;
const spawned: ACPAgentBackend[] = [];
afterEach(async () => {
  for (const b of spawned) {
    try {
      await b.dispose();
    } catch {
      /* ignore */
    }
  }
  spawned.length = 0;
  if (fx) {
    cleanupFakeAgent(fx);
    fx = null;
  }
});

describe('F7.5 注册表 + 路由', () => {
  it('T7.5-01：注册表 ≥9 条；Claude/Codex 不在表内', () => {
    expect(ACP_REGISTRY.length).toBeGreaterThanOrEqual(9);
    const ids = ACP_REGISTRY.map((p) => p.id);
    for (const id of ['cursor', 'kimi', 'kiro', 'trae', 'grok', 'opencode', 'copilot', 'dsh', 'gemini']) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('claude');
    expect(ids).not.toContain('codex');
  });

  it('T7.5-02：用户配置覆盖内置 command/args；未知 provider 抛 ACP_PROVIDER_UNKNOWN', () => {
    const p = getACPProvider('cursor', { command: 'mybin', args: ['--x'] });
    expect(p.command).toBe('mybin');
    expect(p.args).toEqual(['--x']);

    let err: unknown;
    try {
      getACPProvider('does-not-exist');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as { code?: string }).code).toBe('ACP_PROVIDER_UNKNOWN');
  });

  it('T7.5-03：agent.enabled=false → 路由永不进 ACP（即使 model 带 acp: 前缀）', () => {
    const r1 = resolveReasoningBackend(undefined, { gatewayConfig: gwCfg, acpConfig: { enabled: false } });
    expect(r1.kind).toBe('gateway');
    const r2 = resolveReasoningBackend('acp:cursor', {
      gatewayConfig: gwCfg,
      acpConfig: { enabled: false, provider: 'cursor' },
    });
    expect(r2.kind).toBe('gateway');
  });

  it('T7.5-04：enabled + acp: 前缀 → 路由到 ACPAgentBackend（对 Wiki Core 透明）', () => {
    const r = resolveReasoningBackend('acp:cursor', {
      gatewayConfig: gwCfg,
      acpConfig: { enabled: true, provider: 'cursor' },
    });
    expect(r.kind).toBe('acp-agent');
    expect(r).toBeInstanceOf(ACPAgentBackend);

    // 非 acp: 前缀 + routeDefault=false → 仍走 GatewayBackend
    const gw = resolveReasoningBackend('gpt:4', {
      gatewayConfig: gwCfg,
      acpConfig: { enabled: true, provider: 'cursor', routeDefault: false },
    });
    expect(gw.kind).toBe('gateway');
    expect(gw).toBeInstanceOf(GatewayBackend);

    // routeDefault=true → 默认 model 也走 ACP
    const acpDefault = resolveReasoningBackend(undefined, {
      gatewayConfig: gwCfg,
      acpConfig: { enabled: true, provider: 'cursor', routeDefault: true },
    });
    expect(acpDefault.kind).toBe('acp-agent');
  });

  it('T7.5-05：集成 smoke —— 未配置网关时 ACP 腿仍独立可用（两腿互不拖累）', async () => {
    fx = makeFakeAgent({});
    // 注意：此处不调用 configureGateway()，证明 ACP 腿不依赖网关配置
    const backend = new ACPAgentBackend(fx.provider);
    spawned.push(backend);
    const r = await backend.complete({ prompt: 'independent' });
    expect(r.text).toBe('PONG:independent');
    expect(r.providerId).toBe('fake');
  });
});
