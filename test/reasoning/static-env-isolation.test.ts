/**
 * F3.2 / T3.2-03 静态检查（M3 §2.2 / SPEC-0 §2.5）：三个 gateway 源文件在模块加载点与
 * 调用点均不得读取 `process.env`（I1）。本测试在 CI 防 P0-5 回归。
 *
 * 注意：本测试本身读取源文件，属静态分析，不触发任何推理/网络。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '../../src/reasoning');

const GATEWAY_FILES = [
  'gateway-backend.ts',
  'gateway-config.ts',
  'model-resolver.ts',
] as const;

describe('T3.2-03 静态检查：gateway 源文件不读 process.env', () => {
  for (const file of GATEWAY_FILES) {
    it(`${file} 无 process.env 读取`, () => {
      const content = readFileSync(resolve(srcDir, file), 'utf8');
      expect(/\bprocess\.env\b/.test(content)).toBe(false);
    });
  }
});
