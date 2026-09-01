/**
 * SPEC-0 验收：T0-01 ~ T0-04 + DoD 两条自动化项。
 *
 * 级别说明：T0-04 只断言「门槛配置生效」；「覆盖率报告可生成」为 tooling 级验收，
 * 由 `npm run coverage` 手动跑（在 vitest 内嵌套 spawn vitest 既慢又脆，不写进套件）。
 */

import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ConfigError, SafetyError, TransientError, ValidationError } from '../src/errors';
import type { ChatBlock, ChatMessage, Ranked } from '../src/reasoning/types';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('T0-01 工程骨架：vitest 配置就绪', () => {
  it('package.json 暴露 test / coverage / typecheck 三个脚本', async () => {
    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      engines: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts.test).toMatch(/vitest/);
    expect(pkg.scripts.coverage).toMatch(/coverage/);
    expect(pkg.scripts.typecheck).toMatch(/tsc/);
    // 00 §2：Node >= 20 是硬约束
    expect(pkg.engines.node).toBe('>=20');
    // SPEC-0 §2.1 版本锁：测试框架 vitest ^3.x
    expect(pkg.devDependencies.vitest).toMatch(/^\^3\./);
  });

  it('tsconfig 开启严格模式，vitest 配置存在', async () => {
    const tsconfigRaw = await readFile(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8');
    // 去注释后解析（tsconfig 允许注释）
    const tsconfig = JSON.parse(tsconfigRaw.replace(/\/\*[\s\S]*?\*\//g, '')) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, 'vitest.config.ts'))).toBe(true);
  });
});

describe('T0-02 全局错误类（src/errors.ts）', () => {
  const cases = [
    { Cls: ConfigError, name: 'ConfigError' },
    { Cls: TransientError, name: 'TransientError' },
    { Cls: ValidationError, name: 'ValidationError' },
    { Cls: SafetyError, name: 'SafetyError' },
  ] as const;

  it.each(cases)('$name 可实例化且 name/code/message 正确', ({ Cls, name }) => {
    const err = new Cls('SOME_CODE', '出错了');
    expect(err.name).toBe(name);
    expect(err.code).toBe('SOME_CODE');
    expect(err.message).toBe('出错了');
    expect(err).toBeInstanceOf(Error);
    expect(err.stack).toBeTruthy();
  });

  it('四类互不相等（catch 时可凭 instanceof 分流）', () => {
    const err: unknown = new SafetyError('X', 'y');
    expect(err).toBeInstanceOf(SafetyError);
    expect(err).not.toBeInstanceOf(ConfigError);
    expect(err).not.toBeInstanceOf(TransientError);
    expect(err).not.toBeInstanceOf(ValidationError);
  });
});

describe('T0-03 共享类型（src/reasoning/types.ts）经 tsc 严格检查', () => {
  it('tsc --noEmit 零错误', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', path.join(REPO_ROOT, 'tsconfig.json')],
      { cwd: REPO_ROOT, timeout: 120_000 },
    );
    expect(stdout.trim()).toBe('');
  }, 150_000);

  it('共享类型可被消费（编译期形状抽查）', () => {
    const msg: ChatMessage = { role: 'user', content: 'hi' };
    const block: ChatBlock = { type: 'tool-call', toolCallId: 't1', toolName: 'search', input: {} };
    const ranked: Ranked = { id: 'slug#chunk-001', slug: 'slug', score: 0.5 };
    expect(msg.role).toBe('user');
    expect(block.type).toBe('tool-call');
    expect(ranked.id).toBe('slug#chunk-001');
  });
});

interface LoadedCoverageThresholds {
  default: {
    test: { coverage: { thresholds?: Record<string, { lines?: number } | number> } };
  };
}

/** 重新加载 vitest.config.ts（vi.resetModules 清缓存，让 env 开关当场生效） */
async function loadCoverageConfig(): Promise<LoadedCoverageThresholds> {
  vi.resetModules();
  return (await import('../vitest.config.ts')) as LoadedCoverageThresholds;
}

function restoreEnv(prev: string | undefined): void {
  if (prev === undefined) delete process.env.LLM_WIKI_COVERAGE_ENFORCE;
  else process.env.LLM_WIKI_COVERAGE_ENFORCE = prev;
}

describe('T0-04 覆盖率门槛配置生效', () => {
  it('默认启用三档门槛：vault ≥95、lint ≥90、其余 ≥85（SPEC-0 §2.6）', async () => {
    const prev = process.env.LLM_WIKI_COVERAGE_ENFORCE;
    delete process.env.LLM_WIKI_COVERAGE_ENFORCE;
    try {
      const { default: config } = await loadCoverageConfig();
      const th = config.test.coverage.thresholds;
      expect(th).toBeTruthy();
      const vault = th?.['src/vault/**'] as { lines?: number };
      const lint = th?.['src/notes/lint.ts'] as { lines?: number };
      expect(vault?.lines).toBe(95);
      expect(lint?.lines).toBe(90);
      expect(th?.['lines']).toBe(85);
    } finally {
      restoreEnv(prev);
    }
  });

  it('LLM_WIKI_COVERAGE_ENFORCE=0 时关闭门槛（开发期只看报告不卡门禁）', async () => {
    const prev = process.env.LLM_WIKI_COVERAGE_ENFORCE;
    process.env.LLM_WIKI_COVERAGE_ENFORCE = '0';
    try {
      const { default: config } = await loadCoverageConfig();
      expect(config.test.coverage.thresholds).toBeUndefined();
    } finally {
      restoreEnv(prev);
    }
  });
});

describe('DoD：唯一定义处与测试替身就绪', () => {
  it('src/ 下四个错误类只在 src/errors.ts 定义（全库无重复定义）', async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (entry.name.endsWith('.ts')) {
          const src = await readFile(p, 'utf8');
          if (/class\s+(Config|Transient|Validation|Safety)Error\b/.test(src)) offenders.push(p);
        }
      }
    };
    await walk(path.join(REPO_ROOT, 'src'));
    expect(offenders.map((p) => path.relative(REPO_ROOT, p).replace(/\\/g, '/'))).toEqual(['src/errors.ts']);
  });

  it('测试替身 make-vault / fake-gateway 可导入', async () => {
    const { makeVault } = await import('../test/helpers/make-vault');
    const { FakeGateway } = await import('../test/fakes/fake-gateway');
    expect(typeof makeVault).toBe('function');

    const gw = new FakeGateway({ replies: new Map([['摘要', '固定回稿']]) });
    const res = await gw.complete({ prompt: '请给摘要' });
    expect(res.text).toBe('固定回稿');
    expect(gw.calls).toHaveLength(1);
  });
});
