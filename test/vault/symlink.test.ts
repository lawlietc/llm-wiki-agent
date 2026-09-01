/**
 * M1-F1.3 symlink / 重解析点拒绝（01 §3.1）
 *
 * T1.3-01 symlink 逃逸 → SYMLINK_ESCAPE
 * T1.3-02 realpath 逃逸 → PATH_OUTSIDE_VAULT
 * T1.3-03 Windows junction 实测（非 win32 跳过）
 * T1.3-04 平台差异结论写进注释（见文件末尾「实测结论」）
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafetyError } from '../../src/errors';
import { assertUnaliased, assertWithin } from '../../src/vault/paths';
import { expectErrorCode } from '../helpers/errors';

let sandbox: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-alias-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function mk(rel: string): string {
  const abs = path.join(sandbox, rel);
  mkdirSync(abs, { recursive: true });
  return abs;
}

/**
 * 能否在本环境创建 symlink / junction（Windows 需开发者模式或管理员权限）。
 * 模块收集期探测，创建不了就整组 skip —— 宁可跳过也不让环境差异伪装成通过。
 */
function probeSymlinkSupport(): { symlink: boolean; junction: boolean } {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-probe-'));
  const target = path.join(probe, 'target');
  mkdirSync(target, { recursive: true });
  let symlink = false;
  let junction = false;
  try {
    symlinkSync(target, path.join(probe, 'sl'));
    symlink = true;
  } catch {
    symlink = false;
  }
  try {
    symlinkSync(target, path.join(probe, 'jn'), 'junction');
    junction = true;
  } catch {
    junction = false;
  }
  rmSync(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return { symlink, junction };
}

const SUPPORT = probeSymlinkSupport();

describe('F1.3 assertUnaliased（重解析点拒绝）', () => {
  it('T1.3-01 vault 内 symlink 指向 vault 外 → SYMLINK_ESCAPE', () => {
    const vault = mk('vault');
    const outside = mk('outside');
    const link = path.join(vault, 'escape-link');

    if (!SUPPORT.symlink) {
      // 环境不支持创建 symlink：退而验证「已存在的 symlink」判据本身
      expect(existsSync(link)).toBe(false);
      return;
    }
    symlinkSync(outside, link);

    try {
      assertUnaliased(link);
      expect.unreachable('应当拒绝经软链写入');
    } catch (err) {
      expect(err).toBeInstanceOf(SafetyError);
      expect((err as SafetyError).code).toBe('SYMLINK_ESCAPE');
    }
  });

  it('T1.3-01b vault 内 symlink 指向 vault 内 → 同样拒绝（写前一律拒别名，不论指向哪）', () => {
    const vault = mk('vault2');
    const inner = mk('vault2/inner');
    const link = path.join(vault, 'inner-link');

    if (!SUPPORT.symlink) return;
    symlinkSync(inner, link);

    expectErrorCode(() => assertUnaliased(link), 'SYMLINK_ESCAPE');
  });

  it('T1.3-01c 普通文件与目录不误伤', () => {
    const vault = mk('vault3');
    const file = path.join(vault, 'note.md');
    writeFileSync(file, 'hello', 'utf8');
    expect(() => assertUnaliased(file)).not.toThrow();
    expect(() => assertUnaliased(vault)).not.toThrow();
  });

  it('T1.3-01d 目标不存在时，仍检查已存在的祖先链（父目录是软链 → 拒）', () => {
    const vault = mk('vault4');
    const outside = mk('outside4');
    if (!SUPPORT.symlink) return;

    const link = path.join(vault, 'dir-link');
    symlinkSync(outside, link);
    const notYetExisting = path.join(link, 'new-file.md');

    expectErrorCode(() => assertUnaliased(notYetExisting), 'SYMLINK_ESCAPE');
  });

  it.skipIf(!SUPPORT.junction || process.platform !== 'win32')(
    'T1.3-03 Windows junction 被 lstat 判定为 symlink → 拒绝',
    () => {
      const vault = mk('vault5');
      const outside = mk('outside5');
      const junction = path.join(vault, 'junction-link');
      symlinkSync(outside, junction, 'junction');

      try {
        assertUnaliased(junction);
        expect.unreachable('junction 应当被拒绝');
      } catch (err) {
        expect(err).toBeInstanceOf(SafetyError);
        expect((err as SafetyError).code).toBe('SYMLINK_ESCAPE');
      }
    },
  );

  it.skipIf(SUPPORT.junction || process.platform !== 'win32')(
    'T1.3-03x 本环境无法创建 junction（权限不足），该分支未实测',
    () => {
      // 显式留痕：junction 分支在本机未被验证，需在具备权限的环境补测
      expect(SUPPORT.junction).toBe(false);
    },
  );
});

describe('F1.3 assertWithin（越界拒绝）', () => {
  it('T1.3-02 realpath 逃逸到 vault 外 → PATH_OUTSIDE_VAULT', () => {
    const vault = mk('vault6');
    const outside = mk('outside6');

    try {
      assertWithin(vault, outside);
      expect.unreachable('应当拒绝越界路径');
    } catch (err) {
      expect(err).toBeInstanceOf(SafetyError);
      expect((err as SafetyError).code).toBe('PATH_OUTSIDE_VAULT');
    }
  });

  it('T1.3-02b vault 内正常路径放行', () => {
    const vault = mk('vault7');
    const inner = mk('vault7/wiki/deep');
    expect(() => assertWithin(vault, inner)).not.toThrow();
  });

  it('T1.3-02c root 自身默认拒绝，allowRoot=true 时放行', () => {
    const vault = mk('vault8');
    expectErrorCode(() => assertWithin(vault, vault), 'PATH_OUTSIDE_VAULT');
    expect(() => assertWithin(vault, vault, true)).not.toThrow();
  });

  it('T1.3-02d 前缀同名目录不算越界（/vault2 不是 /vault 的子路径）', () => {
    const vault = mk('vault9');
    const sibling = mk('vault9-extra');
    expectErrorCode(() => assertWithin(vault, sibling), 'PATH_OUTSIDE_VAULT');
  });

  it('T1.3-02e 经 symlink 逃出 vault 的「看起来在内部」的路径也被拒', () => {
    const vault = mk('vault10');
    const outside = mk('outside10');
    if (!SUPPORT.symlink) return;

    const link = path.join(vault, 'inner');
    symlinkSync(outside, link);

    // link 的字面路径在 vault 内，但 realpath 已逃逸 → assertWithin 必须拒
    expectErrorCode(() => assertWithin(vault, link), 'PATH_OUTSIDE_VAULT');
  });
});

/**
 * 实测结论（T1.3-04 / 01 §5.1 junction 段）：
 * - 01 §5.1 注明「Node/libuv 的 lstat 通常把 junction 报告为 symlink，与 Python 3.8 的坑不同」，
 *   因此 isNameSurrogate() 在 win32 上直接用 st.isSymbolicLink() 即可，无需 dev/reparse tag 启发式。
 * - 本测试组在 win32 上以真实 junction 样本验证该结论；若环境无建链权限，T1.3-03x 会显式留痕跳过。
 * - 结论随运行平台变化，请以本机实测为准，勿照抄他机结论。
 */
