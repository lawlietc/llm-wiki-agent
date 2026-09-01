/**
 * 模型解析与能力探测（03 §3 / M3 §2.3 F3.1）。
 *
 * 纯函数集合，不依赖 @ai-sdk；调用点不读环境变量（I1 隔离契约）。
 * `resolveRecipe` / `assertTouchpoint` / `embeddingDimsForModel` 读取 `getConfig()`
 * 注入的 provider 配方。
 */

import { ConfigError } from '../errors';
import { getConfig, type ProviderRecipe } from './gateway-config';

/** 解析后的模型标识 */
export interface ParsedModel {
  providerId: string;
  modelId: string;
}

/**
 * "provider:model" 解析；冒号优先于斜杠（兼容 "provider/model" 形式）。
 * 裸名（无前缀）→ ConfigError(BAD_MODEL_ID)。
 */
export function parseModelId(id: string): ParsedModel {
  const colon = id.indexOf(':');
  if (colon > 0) return { providerId: id.slice(0, colon), modelId: id.slice(colon + 1) };
  const slash = id.indexOf('/');
  if (slash > 0) return { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) };
  throw new ConfigError('BAD_MODEL_ID', `模型必须含 provider 前缀："${id}"`);
}

/** 解析模型并尝试取出已配置 provider 配方；provider 未配置 → ConfigError(UNKNOWN_PROVIDER) */
export function resolveRecipe(modelId: string): { parsed: ParsedModel; recipe: ProviderRecipe } {
  const parsed = parseModelId(modelId);
  const recipe = getConfig().providers[parsed.providerId];
  if (!recipe) throw new ConfigError('UNKNOWN_PROVIDER', `未知 provider："${parsed.providerId}"`);
  return { parsed, recipe };
}

/**
 * 拦住无对应 touchpoint 的模型（03 §3）。
 * recipe.chat === false → NO_CHAT_TOUCHPOINT；recipe.embedding === false → NO_EMBED_TOUCHPOINT。
 * 未显式置 false 视为支持（默认 true）。
 */
export function assertTouchpoint(
  recipe: ProviderRecipe,
  touchpoint: 'chat' | 'embedding',
  modelId: string,
): void {
  if (touchpoint === 'chat' && recipe.chat === false) {
    throw new ConfigError('NO_CHAT_TOUCHPOINT', `${modelId} 不支持 chat`);
  }
  if (touchpoint === 'embedding' && recipe.embedding === false) {
    throw new ConfigError('NO_EMBED_TOUCHPOINT', `${modelId} 不支持 embedding`);
  }
}

/** 取 embedding 维度；未配置 dims → ConfigError(NO_DIMS) */
export function embeddingDimsForModel(recipe: ProviderRecipe, modelId: string): number {
  if (recipe.dims == null) throw new ConfigError('NO_DIMS', `${modelId} 未配置 embedding 维度`);
  return recipe.dims;
}
