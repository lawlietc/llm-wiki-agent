/**
 * 网关配置单入口（03 §2 / M3 §2.2）。
 *
 * 不变量 I1（env 隔离）：本文件**任何位置都不读取环境变量** —— 超时等运行期
 * 参数一律来自 `AIGatewayConfig`，由 `configureGateway` 在启动期一次性注入。
 * 调用点（chat/embed）也绝不读 env（见 gateway-backend.ts）。
 *
 * 不变量 I2（单入口）：`configureGateway` 是唯一配置注入点；未配置即调用推理入口 →
 * `getConfig()` 抛 `ConfigError(GATEWAY_NOT_CONFIGURED)`。
 */

import { ConfigError } from '../errors';

/** 单厂商配方：如何把该 provider 变成 apiKey / 基址 / 头 */
export interface ProviderRecipe {
  /** Bearer token 形式的密钥；与 `auth` 二选一 */
  apiKey?: string;
  /** 自定义基址（OpenAI 兼容端点、本地 ollama 等） */
  baseURL?: string;
  /** 直接指定的请求头（不经由默认 Authorization 解析时） */
  headers?: Record<string, string>;
  /** 自定义认证头方案（headerName + token） */
  auth?: { headerName: string; token: string };
  /** embedding 维度；未配置 → embed 抛 NO_DIMS */
  dims?: number;
  /** 是否支持 chat；false → chat 抛 NO_CHAT_TOUCHPOINT（voyage/ollama 等可能只 embedding） */
  chat?: boolean;
  /** 是否支持 embedding；false → embed 抛 NO_EMBED_TOUCHPOINT */
  embedding?: boolean;
  /** 透传给 provider 的 fetch 实现（加代理/头用） */
  fetch?: unknown;
}

/** 网关总配置：唯一注入点 `configureGateway` 的参数 */
export interface AIGatewayConfig {
  /** 默认 chat 模型 "provider:model" */
  chat_model: string;
  /** 默认 embedding 模型 "provider:model" */
  embedding_model: string;
  /** providerId → 配方 */
  providers: Record<string, ProviderRecipe>;
  /**
   * 全链路默认超时 ms；缺省 300_000。
   * 进配置而非读 env —— 维持"调用时绝不读取环境变量"契约（03 §2 / M3 I1）。
   */
  chat_timeout_ms?: number;
}

/** 缺省全链路超时（03 §5） */
export const DEFAULT_CHAT_TIMEOUT_MS = 300_000;

let _config: AIGatewayConfig | null = null;

/**
 * 唯一配置注入点（I2）。
 * 重复调用会整体替换配置并清空模型缓存，确保旧 provider 配方不残留（M3 T3.2-04）。
 */
export function configureGateway(config: AIGatewayConfig): void {
  _config = { ...config, chat_timeout_ms: config.chat_timeout_ms ?? DEFAULT_CHAT_TIMEOUT_MS };
  _modelCache.clear();
}

/** 读取配置；未配置即抛 GATEWAY_NOT_CONFIGURED（I2） */
export function getConfig(): AIGatewayConfig {
  if (!_config) {
    throw new ConfigError(
      'GATEWAY_NOT_CONFIGURED',
      'Call configureGateway() during startup before any inference.',
    );
  }
  return _config;
}

/** 全链路默认超时值（03 §5）—— 来自配置，不读 env */
export function defaultTimeoutMs(): number {
  return getConfig().chat_timeout_ms ?? DEFAULT_CHAT_TIMEOUT_MS;
}

// 模型缓存：buildAiSdkModel 按 "providerId:modelId" 缓存构造出的模型对象。
// configureGateway 会清空它（见上），避免旧 provider 配方残留。
export const _modelCache = new Map<string, unknown>();
