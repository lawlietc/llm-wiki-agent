/**
 * F3.6-05 @ai-sdk 模型工厂（M3 §4.1 / 03 §4.1）。五分支（anthropic/openai/google/ollama/未知）
 * 经 vi.mock 替换 provider 包，仅验证调用形状与参数传递——真实可调用形状以锁定版本 `.d.ts` 复核。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { buildAiSdkModel } from '../../src/reasoning/gateway-backend';
import { configureGateway } from '../../src/reasoning/gateway-config';
import type { ProviderRecipe } from '../../src/reasoning/gateway-config';

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ __provider: 'anthropic', __model: modelId })),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ chat: (modelId: string) => ({ __provider: 'openai', __model: modelId }) })),
}));
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => (modelId: string) => ({ __provider: 'google', __model: modelId })),
}));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({ __provider: 'compatible', __model: modelId })),
}));

describe('F3.6-05 buildAiSdkModel 五分支', () => {
  beforeEach(() => {
    configureGateway({
      chat_model: 'anthropic:claude-x',
      embedding_model: 'voyage:v',
      providers: {
        anthropic: { apiKey: 'k-anthropic' },
        openai: { apiKey: 'k-openai', baseURL: 'https://oa.custom/v1' },
        google: { apiKey: 'k-google' },
        ollama: { apiKey: 'k-ollama' },
        custom: { apiKey: 'k-custom', baseURL: 'https://custom/v1' },
      },
    });
    vi.mocked(createAnthropic).mockClear();
    vi.mocked(createOpenAI).mockClear();
    vi.mocked(createGoogleGenerativeAI).mockClear();
    vi.mocked(createOpenAICompatible).mockClear();
  });

  it('anthropic：工厂调用 + modelId 透传', () => {
    const r = buildAiSdkModel({ providerId: 'anthropic', modelId: 'claude-3' }, {
      apiKey: 'k-anthropic',
    } as ProviderRecipe) as { __model: string };
    expect(r.__model).toBe('claude-3');
    expect(vi.mocked(createAnthropic)).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'k-anthropic' }),
    );
  });

  it('openai：工厂 .chat(modelId) + baseURL 透传', () => {
    const r = buildAiSdkModel({ providerId: 'openai', modelId: 'gpt-4' }, {
      apiKey: 'k-openai',
      baseURL: 'https://oa.custom/v1',
    } as ProviderRecipe) as { __model: string };
    expect(r.__model).toBe('gpt-4');
    expect(vi.mocked(createOpenAI)).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'k-openai', baseURL: 'https://oa.custom/v1' }),
    );
  });

  it('google：工厂调用 + modelId 透传', () => {
    const r = buildAiSdkModel({ providerId: 'google', modelId: 'gemini-pro' }, {
      apiKey: 'k-google',
    } as ProviderRecipe) as { __model: string };
    expect(r.__model).toBe('gemini-pro');
    expect(vi.mocked(createGoogleGenerativeAI)).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'k-google' }),
    );
  });

  it('ollama：走 openai-compatible，name=ollama + 默认本地基址 + apiKey=ollama', () => {
    const r = buildAiSdkModel({ providerId: 'ollama', modelId: 'llama3' }, {
      apiKey: 'k-ollama',
    } as ProviderRecipe) as { __model: string };
    expect(r.__model).toBe('llama3');
    expect(vi.mocked(createOpenAICompatible)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ollama',
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'ollama',
      }),
    );
  });

  it('未知 provider：走 openai-compatible，name=providerId', () => {
    const r = buildAiSdkModel({ providerId: 'custom', modelId: 'm' }, {
      apiKey: 'k-custom',
      baseURL: 'https://custom/v1',
    } as ProviderRecipe) as { __model: string };
    expect(r.__model).toBe('m');
    expect(vi.mocked(createOpenAICompatible)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'custom', baseURL: 'https://custom/v1', apiKey: 'k-custom' }),
    );
  });

  it('认证解析：recipe.auth（自定义头）→ createAnthropic 收 headers 而非 apiKey', () => {
    buildAiSdkModel(
      { providerId: 'anthropic', modelId: 'claude-3' },
      { auth: { headerName: 'X-Custom', token: 't' } } as ProviderRecipe,
    );
    expect(vi.mocked(createAnthropic)).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'X-Custom': 't' } }),
    );
  });
});
