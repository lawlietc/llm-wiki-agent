/**
 * M1-F1.1 resolveVaultRoot（01 §2）
 *
 * 覆盖 T1.1-01 ~ T1.1-06。核心是 fail-closed：任何不确定的情况都报错，绝不静默用 cwd。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigError } from '../../src/errors';
import { resolveVaultRoot } from '../../src/vault/resolve-root';
import { expectErrorCode } from '../helpers/errors';

/** 每个用例一套独立临时树，afterEach 递归清理 */
let sandbox: string;
const dirs: string[] = [];

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-root-')));
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** 在 sandbox 下造目录（父目录自动建） */
function mk(rel: string, withMarker = false): string {
  const abs = path.join(sandbox, rel);
  mkdirSync(abs, { recursive: true });
  if (withMarker) writeFileSync(path.join(abs, '.llm-wiki.json'), '{"version":1}\n', 'utf8');
  return abs;
}

const NO_ENV: NodeJS.ProcessEnv = {};

describe('F1.1 resolveVaultRoot', () => {
  it('T1.1-01 explicit 参数存在 → 返回该根，source=explicit', () => {
    const vault = mk('explicit-vault', true);
    const sel = resolveVaultRoot({ explicit: vault, env: NO_ENV, cwd: sandbox });
    expect(sel.source).toBe('explicit');
    expect(sel.root).toBe(vault);
  });

  it('T1.1-01b explicit 优先级高于 env 与 workspace', () => {
    const a = mk('a', true);
    const b = mk('b', true);
    const nested = mk('a/deep/deeper', true); // cwd 最近的 vault 是 a/deep/deeper
    const sel = resolveVaultRoot({
      explicit: b,
      env: { LLM_WIKI_VAULT: a } as NodeJS.ProcessEnv,
      cwd: nested,
    });
    expect(sel.source).toBe('explicit');
    expect(sel.root).toBe(b);
  });

  it('T1.1-02 无 explicit、有 env LLM_WIKI_VAULT → source=env', () => {
    const vault = mk('env-vault', true);
    const sel = resolveVaultRoot({ env: { LLM_WIKI_VAULT: vault } as NodeJS.ProcessEnv, cwd: sandbox });
    expect(sel.source).toBe('env');
    expect(sel.root).toBe(vault);
  });

  it('T1.1-03 二者皆无、cwd 祖先含 .llm-wiki.json → source=workspace', () => {
    const vault = mk('ws-vault', true);
    const deep = mk('ws-vault/sub/deeper');
    const sel = resolveVaultRoot({ env: NO_ENV, cwd: deep });
    expect(sel.source).toBe('workspace');
    expect(sel.root).toBe(vault);
  });

  it('T1.1-03b workspace 取最近祖先（多层嵌套时不被更上层抢走）', () => {
    const outer = mk('outer', true);
    const inner = mk('outer/inner', true);
    const sel = resolveVaultRoot({ env: NO_ENV, cwd: mk('outer/inner/x/y') });
    expect(sel.root).toBe(inner);
    expect(sel.root).not.toBe(outer);
  });

  it('T1.1-04 全不命中 → ConfigError(VAULT_NOT_FOUND)，绝不静默用 cwd', () => {
    const empty = mk('no-vault-anywhere/deep');
    expect(() => resolveVaultRoot({ env: NO_ENV, cwd: empty })).toThrow(ConfigError);
    try {
      resolveVaultRoot({ env: NO_ENV, cwd: empty });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('VAULT_NOT_FOUND');
      // 关键：不得把 cwd 当 vault 返回
      expect((err as ConfigError).message).not.toContain(empty);
    }
  });

  it('T1.1-05 候选落在产品安装目录内（node_modules/llm-wiki-agent）→ VAULT_INSIDE_PRODUCT', () => {
    const prod = mk('product');
    mkdirSync(path.join(prod, 'node_modules', 'llm-wiki-agent'), { recursive: true });
    const vault = mk('product/data-vault', true);

    try {
      resolveVaultRoot({ explicit: vault, env: NO_ENV, cwd: sandbox });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('VAULT_INSIDE_PRODUCT');
    }
  });

  it('T1.1-05b 候选自身就是产品安装目录（package.json name=llm-wiki-agent）→ 同样被拒', () => {
    const prod = mk('product-self', true);
    writeFileSync(path.join(prod, 'package.json'), JSON.stringify({ name: 'llm-wiki-agent' }), 'utf8');

    expectErrorCode(() => resolveVaultRoot({ explicit: prod, env: NO_ENV, cwd: sandbox }), 'VAULT_INSIDE_PRODUCT');
  });

  it('T1.1-05c 产品目录标记只认 name 匹配，别的 package.json 不误伤', () => {
    const other = mk('other-pkg', true);
    writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'some-other-thing' }), 'utf8');
    const sel = resolveVaultRoot({ explicit: other, env: NO_ENV, cwd: sandbox });
    expect(sel.root).toBe(other);
  });

  it('T1.1-06 未初始化目录且未传 allowUninitialized → 抛错（不静默当作 vault）', () => {
    const bare = mk('bare-dir');
    try {
      resolveVaultRoot({ explicit: bare, env: NO_ENV, cwd: sandbox });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('VAULT_NOT_FOUND');
    }
  });

  it('T1.1-06b allowUninitialized + explicit → 放行（供 wiki init 用）', () => {
    const bare = mk('bare-dir-2');
    const sel = resolveVaultRoot({ explicit: bare, env: NO_ENV, cwd: sandbox, allowUninitialized: true });
    expect(sel.source).toBe('explicit');
    expect(sel.root).toBe(bare);
  });

  it('T1.1-06c allowUninitialized 但无 explicit → 仍然 fail-closed（不给未初始化目录背书）', () => {
    const bare = mk('bare-dir-3');
    expect(() => resolveVaultRoot({ env: NO_ENV, cwd: bare, allowUninitialized: true })).toThrow(ConfigError);
  });
});
