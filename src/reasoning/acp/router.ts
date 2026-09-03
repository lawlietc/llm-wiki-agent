/**
 * ACP 路由开关（04 §6 + 00 §4 / M7 F7.5）。
 *
 * 把「用户配置」翻译成具体 `ReasoningBackend` 实例：
 * - `agent.enabled` 为 false → 永远走默认 `GatewayBackend`（T7.5-03）
 * - `agent.enabled` 且请求 model 以 `acp:` 前缀 → 路由到 `ACPAgentBackend`（T7.5-04）
 *   （`acp:cursor` 同时选定 provider 为 cursor）
 * - `agent.routeDefault` 为真 → 默认请求也走 ACP 腿
 *
 * 两条腿互不拖累：ACP 腿完全不读网关配置，网关不可用时 ACP 仍独立可用（T7.5-05）。
 */

import type { ReasoningBackend } from '../backend';
import { GatewayBackend } from '../gateway-backend';
import type { AIGatewayConfig } from '../gateway-config';

import { ACPAgentBackend } from './backend';
import { getACPProvider } from './registry';

/** ACP 腿的配置（来自用户 .llm-wiki.json 的 reasoning.agent 段，未在此硬编码默认） */
export interface ACPAgentConfig {
  enabled: boolean;
  /** 注册表 provider id（如 'cursor'）；省略时取 'cursor' */
  provider?: string;
  /** 覆盖内置 command（配置优先，T7.5-02） */
  command?: string;
  /** 覆盖内置 args */
  args?: string[];
  /** 注入子进程的环境变量 */
  env?: Record<string, string>;
  /** 默认请求也走 ACP 腿（否则仅 `acp:` 前缀 model 走 ACP） */
  routeDefault?: boolean;
  /** initialize 握手超时 ms */
  initializeTimeoutMs?: number;
}

export interface ReasoningRouterDeps {
  /** 网关配置（仅网关腿使用）；ACP-only 模式下可省略（T7.5-05 ACP 独立可用） */
  gatewayConfig?: AIGatewayConfig;
  acpConfig?: ACPAgentConfig;
}

/**
 * 按配置解析推理后端。返回对 Wiki Core 透明的 `ReasoningBackend`。
 */
export function resolveReasoningBackend(
  model: string | undefined,
  deps: ReasoningRouterDeps,
): ReasoningBackend {
  const acp = deps.acpConfig;
  if (acp?.enabled) {
    const prefix = model?.includes(':') ? model.split(':')[0] : undefined;
    const providerFromModel = prefix === 'acp' ? model!.split(':')[1] || acp.provider : undefined;
    if (providerFromModel || acp.routeDefault) {
      const provider = getACPProvider(providerFromModel ?? acp.provider ?? 'cursor', {
        command: acp.command,
        args: acp.args,
        env: acp.env,
      });
      return new ACPAgentBackend(provider, { initializeTimeoutMs: acp.initializeTimeoutMs });
    }
  }
  return new GatewayBackend();
}
