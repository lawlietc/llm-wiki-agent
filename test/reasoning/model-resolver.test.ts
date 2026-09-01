/**
 * F3.1 模型解析（M3 §3 / 03 §3）。T3.1-01~06。
 * 纯函数，零网络、零 @ai-sdk 依赖。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  assertTouchpoint,
  embeddingDimsForModel,
  parseModelId,
  resolveRecipe,
} from '../../src/reasoning/model-resolver';
import { configureGateway } from '../../src/reasoning/gateway-config';
import { expectErrorCode } from '../helpers/errors';

const baseConfig = {
  chat_model: 'anthropic:claude-x',
  embedding_model: 'voyage:voyage-3',
  providers: {
    anthropic: { apiKey: 'k-anthropic' },
    openai: { apiKey: 'k-openai' },
    voyage: { apiKey: 'k-voyage', dims: 1024, chat: false },
  },
} as const;

describe('F3.1 模型解析', () => {
  beforeEach(() => {
    configureGateway({ ...baseConfig });
  });

  // T3.1-01: "provider:model" 形式
  it('parseModelId 冒号形式 → {providerId, modelId}', () => {
    expect(parseModelId('anthropic:claude-x')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-x',
    });
  });

  // T3.1-02: "provider/model" 斜杠形式同样可解析
  it('parseModelId 斜杠形式 → {providerId, modelId}', () => {
    expect(parseModelId('openai/gpt-x')).toEqual({ providerId: 'openai', modelId: 'gpt-x' });
  });

  // T3.1-03: 裸名 → BAD_MODEL_ID
  it('parseModelId 裸名 → BAD_MODEL_ID', () => {
    expectErrorCode(() => parseModelId('claude-x'), 'BAD_MODEL_ID');
  });

  // T3.1-04: provider 未配置 → UNKNOWN_PROVIDER
  it('resolveRecipe provider 未配置 → UNKNOWN_PROVIDER', () => {
    expectErrorCode(() => resolveRecipe('unknown:foo'), 'UNKNOWN_PROVIDER');
  });

  it('resolveRecipe 已配置 provider → 正常返回 parsed+recipe', () => {
    const r = resolveRecipe('anthropic:claude-x');
    expect(r.parsed).toEqual({ providerId: 'anthropic', modelId: 'claude-x' });
    expect(r.recipe.apiKey).toBe('k-anthropic');
  });

  // T3.1-05: assertTouchpoint 拦 chat / embedding
  it('assertTouchpoint recipe.chat=false → NO_CHAT_TOUCHPOINT', () => {
    const recipe = baseConfig.providers.voyage;
    expectErrorCode(() => assertTouchpoint(recipe, 'chat', 'voyage:voyage-3'), 'NO_CHAT_TOUCHPOINT');
  });

  it('assertTouchpoint recipe.embedding=false → NO_EMBED_TOUCHPOINT', () => {
    const recipe = { apiKey: 'k', chat: true, embedding: false } as const;
    expectErrorCode(
      () => assertTouchpoint(recipe, 'embedding', 'x:y'),
      'NO_EMBED_TOUCHPOINT',
    );
  });

  it('assertTouchpoint 默认支持两路（未显式置 false）不抛', () => {
    const recipe = { apiKey: 'k' } as const;
    expect(() => assertTouchpoint(recipe, 'chat', 'x:y')).not.toThrow();
    expect(() => assertTouchpoint(recipe, 'embedding', 'x:y')).not.toThrow();
  });

  // T3.1-06: embeddingDimsForModel 无 dims → NO_DIMS
  it('embeddingDimsForModel 无 dims → NO_DIMS', () => {
    const recipe = { apiKey: 'k' } as const;
    expectErrorCode(() => embeddingDimsForModel(recipe, 'x:y'), 'NO_DIMS');
  });

  it('embeddingDimsForModel 有 dims → 返回维度', () => {
    expect(embeddingDimsForModel(baseConfig.providers.voyage, 'voyage:voyage-3')).toBe(1024);
  });
});
