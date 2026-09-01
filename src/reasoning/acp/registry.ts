/**
 * ACP provider 注册表（04 §6 / M7 F7.5）。
 *
 * 覆盖 9 个原生说 ACP 的后发 agent。Claude Code / Codex 走专用后端（官方 SDK /
 * app-server JSON-RPC），**不在此表**——HAPI 源码证明当前不是用 ACP 接它们。
 *
 * ⚠️ 启动参数 `args` 是社区常见示例，**未经逐一官方验证**。启用某个 agent 前必须
 * 对照其官方文档核验 `command`/`args`（例如 Gemini CLI 的 ACP flag 实为
 * `--experimental-acp` 而非 `--acp`）。注册表做成「配置可覆盖」：用户配置优先级
 * 高于内置默认值（T7.5-02）。
 */

import { ConfigError } from '../../errors';

/** 一个可被 ACP 拉起的本地 agent 的描述 */
export interface ACPProvider {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * 内置注册表（9 条，未验证注释见各行）。
 * Claude / Codex 刻意缺席（走专用后端）。
 */
export const ACP_REGISTRY: ACPProvider[] = [
  { id: 'cursor', command: 'cursor', args: ['--acp'] }, // 未验证
  { id: 'kimi', command: 'kimi', args: ['acp'] }, // 未验证
  { id: 'kiro', command: 'kiro', args: ['--agent-protocol'] }, // 未验证
  { id: 'trae', command: 'trae', args: ['acp'] }, // 未验证
  { id: 'grok', command: 'grok', args: ['--acp'] }, // 未验证
  { id: 'opencode', command: 'opencode', args: ['--acp'] }, // 未验证
  { id: 'copilot', command: 'copilot', args: ['acp'] }, // 未验证
  { id: 'dsh', command: 'dsh', args: ['--acp'] }, // 未验证
  { id: 'gemini', command: 'gemini', args: ['--acp'] }, // 未验证（实为 --experimental-acp）
];

/** 解析一个 provider：注册表条目 + 用户配置覆盖（command/args/env 优先） */
export function getACPProvider(id: string, overrides?: Partial<ACPProvider>): ACPProvider {
  const base = ACP_REGISTRY.find((p) => p.id === id);
  if (!base) {
    throw new ConfigError('ACP_PROVIDER_UNKNOWN', `未知 ACP provider: ${id}（不在注册表内）`);
  }
  return {
    id: base.id,
    command: overrides?.command ?? base.command,
    args: overrides?.args ?? base.args,
    env: { ...(base.env ?? {}), ...(overrides?.env ?? {}) },
  };
}
