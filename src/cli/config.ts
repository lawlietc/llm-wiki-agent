/**
 * 配置加载（M6 §2.2 / 00 §8.2）。
 *
 * 不变量 I2（密钥安全）：`.llm-wiki.json` 支持 `"env:VAR"` 间接引用；本文件在加载期
 * 解析一次 env，**调用时仍不读 env**（与 M3 I1 衔接）。密钥值**永不**出现在任何抛错
 * 消息或输出中——报错只提 env 变量名（变量名非密）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigError } from '../errors';
import type { AIGatewayConfig, ProviderRecipe } from '../reasoning/gateway-config';
import type { ACPAgentConfig } from '../reasoning/acp/router';

/** vault 初始化标记文件（与 resolve-root 同源，集中此处避免重复字面量） */
export const CONFIG_FILE = '.llm-wiki.json';

export interface LoadedConfig {
  /** 解析 env: 后的网关配置，可直接 configureGateway；ACP-only 模式下为 undefined */
  gateway?: AIGatewayConfig;
  /** ACP 本地 agent 腿配置（reasoning.agent 段）；未配置时为 undefined */
  acp?: ACPAgentConfig;
  /** 原始 JSON 对象（status 等可能需要读其它字段） */
  raw: Record<string, unknown>;
}

/** 把 `"env:VAR"` 引用解析为环境变量值；缺失抛 ConfigError（消息只提变量名，不提值） */
function resolveEnvRef(ref: string, env: NodeJS.ProcessEnv, label: string): string {
  if (!ref.startsWith('env:')) return ref;
  const name = ref.slice(4);
  const value = env[name];
  if (value === undefined) {
    // 只暴露变量名，绝不暴露密钥值（I2）
    throw new ConfigError('MISSING_API_KEY', `配置引用了环境变量 ${name}（${label}），但该变量未设置`);
  }
  return value;
}

/** 解引用单个 provider 配方里的 env: 引用（apiKey / auth.token / headers 值） */
function derefRecipe(recipe: Record<string, unknown>, env: NodeJS.ProcessEnv): ProviderRecipe {
  const out: Record<string, unknown> = { ...recipe };

  if (typeof out.apiKey === 'string') {
    out.apiKey = resolveEnvRef(out.apiKey, env, 'apiKey');
  }

  if (out.auth && typeof out.auth === 'object') {
    const auth = { ...(out.auth as Record<string, unknown>) };
    if (typeof auth.token === 'string') auth.token = resolveEnvRef(auth.token, env, 'auth.token');
    out.auth = auth;
  }

  if (out.headers && typeof out.headers === 'object') {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.headers as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = resolveEnvRef(v, env, `headers.${k}`);
    }
    out.headers = headers;
  }

  return out as ProviderRecipe;
}

/** 配置是否含任何网关字段（chat_model/embedding_model/providers 任一存在） */
function hasGatewayFields(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.chat_model === 'string' ||
    typeof raw.embedding_model === 'string' ||
    (raw.providers !== undefined && raw.providers !== null)
  );
}

function mapGateway(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  agentEnabled: boolean,
): AIGatewayConfig | undefined {
  // ACP-only 模式：网关字段全缺时不要求网关配置（不读密钥，落实 T7.5-05 ACP 独立可用）
  if (agentEnabled && !hasGatewayFields(raw)) {
    return undefined;
  }
  const chat_model = raw.chat_model;
  if (typeof chat_model !== 'string' || chat_model.trim() === '') {
    throw new ConfigError('BAD_CONFIG', 'chat_model 必填（形如 "provider:model"）');
  }
  const embedding_model = raw.embedding_model;
  if (typeof embedding_model !== 'string' || embedding_model.trim() === '') {
    throw new ConfigError('BAD_CONFIG', 'embedding_model 必填（形如 "provider:model"）');
  }
  const providersRaw = raw.providers;
  if (!providersRaw || typeof providersRaw !== 'object') {
    throw new ConfigError('BAD_CONFIG', 'providers 必填（对象）');
  }

  const providers: Record<string, ProviderRecipe> = {};
  for (const [id, p] of Object.entries(providersRaw as Record<string, unknown>)) {
    if (!p || typeof p !== 'object') {
      throw new ConfigError('BAD_CONFIG', `provider ${id} 必须是对象`);
    }
    providers[id] = derefRecipe(p as Record<string, unknown>, env);
  }

  const timeout = raw.chat_timeout_ms;
  return {
    chat_model,
    embedding_model,
    providers,
    chat_timeout_ms: typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : undefined,
  };
}

/**
 * 把 `.llm-wiki.json` 的 `reasoning.agent` 段映射为 `ACPAgentConfig`。
 * 缺省全部字段 → undefined（CLI 不会拉起 ACP 腿）。
 */
function parseACP(raw: Record<string, unknown>): ACPAgentConfig | undefined {
  const reasoning = raw.reasoning;
  if (!reasoning || typeof reasoning !== 'object') return undefined;
  const agent = (reasoning as Record<string, unknown>).agent;
  if (!agent || typeof agent !== 'object') return undefined;
  const a = agent as Record<string, unknown>;
  const enabled = a.enabled === true;
  if (!enabled && a.provider === undefined && a.command === undefined && a.routeDefault === undefined) {
    return undefined; // 整段没实质内容，视为未配置
  }
  const provider = typeof a.provider === 'string' ? a.provider : undefined;
  const command = typeof a.command === 'string' ? a.command : undefined;
  const args = Array.isArray(a.args) ? a.args.filter((x) => typeof x === 'string') : undefined;
  const envOverrides =
    a.env && typeof a.env === 'object'
      ? (Object.fromEntries(
          Object.entries(a.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
        ) as Record<string, string>)
      : undefined;
  const routeDefault = a.routeDefault === true ? true : undefined;
  const initializeTimeoutMs =
    typeof a.initializeTimeoutMs === 'number' && Number.isFinite(a.initializeTimeoutMs)
      ? a.initializeTimeoutMs
      : undefined;
  return {
    enabled,
    ...(provider !== undefined ? { provider } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(envOverrides !== undefined ? { env: envOverrides } : {}),
    ...(routeDefault !== undefined ? { routeDefault } : {}),
    ...(initializeTimeoutMs !== undefined ? { initializeTimeoutMs } : {}),
  };
}

/**
 * 加载并解析 vault 配置。env: 解析一次性完成。
 * @throws ConfigError 文件缺失/JSON 损坏/字段缺失/密钥 env 缺失
 */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const cfgPath = path.join(root, CONFIG_FILE);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError('CONFIG_READ_FAILED', `无法读取配置 ${cfgPath}：${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('BAD_CONFIG', `配置必须是对象：${cfgPath}`);
  }
  const acp = parseACP(raw);
  const gateway = mapGateway(raw, env, acp?.enabled === true);
  return { gateway, acp, raw };
}
