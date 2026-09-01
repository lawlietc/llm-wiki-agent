/**
 * F3.2 配置单入口 + env 隔离（M3 §2.2 / 03 §2）。T3.2-01/02/04。
 * 不碰 @ai-sdk、零网络。
 *
 * 注意：vitest 每个测试文件模块隔离，本文件起始 `_config` 为 null（未配置），
 * 因此 T3.2-01 放首位、且不依赖其他文件的配置状态。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { configureGateway, defaultTimeoutMs, getConfig, _modelCache } from '../../src/reasoning/gateway-config';
import { expectErrorCode } from '../helpers/errors';

const cfg = {
  chat_model: 'anthropic:claude-x',
  embedding_model: 'voyage:voyage-3',
  providers: { anthropic: { apiKey: 'k' } },
};

describe('F3.2 配置单入口', () => {
  it('T3.2-01 未 configure 先 getConfig → GATEWAY_NOT_CONFIGURED', () => {
    // 本文件隔离，起始未配置；直接读即应抛
    expectErrorCode(() => getConfig(), 'GATEWAY_NOT_CONFIGURED');
  });

  it('T3.2-02 configure 后 chat_timeout_ms 生效；缺省填 300_000', () => {
    configureGateway({ ...cfg, chat_timeout_ms: 5_000 });
    expect(getConfig().chat_timeout_ms).toBe(5_000);
    expect(defaultTimeoutMs()).toBe(5_000);

    configureGateway({ ...cfg }); // 不传 chat_timeout_ms
    expect(getConfig().chat_timeout_ms).toBe(300_000);
    expect(defaultTimeoutMs()).toBe(300_000);
  });

  // T3.2-04：重复 configure 清空模型缓存（旧 provider 配置不残留）
  it('T3.2-04 重复 configure 清空模型缓存 + 替换 providers 集合', () => {
    configureGateway({
      chat_model: 'anthropic:a',
      embedding_model: 'voyage:v',
      providers: { anthropic: { apiKey: 'k1' } },
    });
    // 模拟一次模型缓存写入
    _modelCache.set('anthropic:a', { tag: 'model-v1' });
    expect(_modelCache.size).toBe(1);

    // 换成不含 anthropic 的新配置
    configureGateway({
      chat_model: 'openai:o',
      embedding_model: 'voyage:v',
      providers: { openai: { apiKey: 'k2' } },
    });
    // 缓存应被清空
    expect(_modelCache.size).toBe(0);
    // 旧 provider 不应再可解析（配置整体替换，无残留）
    expect(getConfig().providers.anthropic).toBeUndefined();
    expect(getConfig().providers.openai?.apiKey).toBe('k2');
  });

  beforeEach(() => {
    _modelCache.clear();
  });
});
