/**
 * M1-F1.6 Windows 退化分支 + Vault 接口组装（01 §5.1 + 00 §5）
 *
 * T1.6-01 win32 + 非 NTFS 卷 → UNSUPPORTED_PLATFORM
 * T1.6-02 判定对象是 vault root 所在卷，不是 process.cwd()
 * T1.6-03 原子替换后重读 sha256 一致（退化分支 b 条）
 * T1.6-04 Vault.read 白名单读 + 越界读拒绝
 * T1.6-05 端到端 plan → preview → apply → read
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { SafetyError } from '../../src/errors';
import { createVault } from '../../src/vault/vault';
import { applyBundle, _platform } from '../../src/vault/transaction';
import { makeVault, type TempVault } from '../helpers/make-vault';
import { expectErrorCodeAsync } from '../helpers/errors';

const vaults: TempVault[] = [];

const ORIGINAL_IS_NTFS = _platform.isNtfsVolume;

afterEach(async () => {
  for (const v of vaults.splice(0)) await v.cleanup();
  _platform.isNtfsVolume = ORIGINAL_IS_NTFS; // 恢复注入
});

async function freshVault(): Promise<TempVault> {
  const v = await makeVault();
  vaults.push(v);
  return v;
}

function sha256hex(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

function symlinkSupported(): boolean {
  const base = mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-probe2-'));
  const target = path.join(base, 't');
  const link = path.join(base, 'l');
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const SUPPORTS_SYMLINK = symlinkSupported();

describe('F1.6 Windows 退化分支 + Vault 组装', () => {
  it.skipIf(process.platform !== 'win32')(
    'T1.6-01 win32 + vault 在 FAT/exFAT 卷（mock 判定）→ UNSUPPORTED_PLATFORM，不落盘',
    async () => {
      const vault = await freshVault();
      _platform.isNtfsVolume = () => false;

      const p = {
        operationId: 'op-fat',
        schema: 'llm-wiki.transaction.v1' as const,
        operationType: 'save' as const,
        writes: [{ relativePath: 'wiki/a.md', content: 'A', operationType: 'create' as const }],
      };
      await expectErrorCodeAsync(applyBundle(vault.root, p, { timeoutMs: 2_000 }), 'UNSUPPORTED_PLATFORM');
      expect(vault.exists('wiki/a.md')).toBe(false);
      // 断言它抛的是 SafetyError（fail-closed 语义）
      await expect(applyBundle(vault.root, p, { timeoutMs: 2_000 })).rejects.toBeInstanceOf(SafetyError);
    },
  );

  it('T1.6-02 判定对象是 vault root 所在卷而非 process.cwd()', async () => {
    const vault = await freshVault();
    const seen: string[] = [];
    _platform.isNtfsVolume = (p: string) => {
      seen.push(p);
      return true;
    };

    const p = {
      operationId: 'op-vol',
      schema: 'llm-wiki.transaction.v1' as const,
      operationType: 'save' as const,
      writes: [{ relativePath: 'wiki/a.md', content: 'A', operationType: 'create' as const }],
    };
    await applyBundle(vault.root, p, { timeoutMs: 2_000 });

    expect(seen).toContain(vault.root);
    // 绝不传 cwd（测试进程的 cwd 是产品仓库，与 vault 不同卷的场景由 mock 参数断言覆盖）
    expect(seen.every((p) => p === vault.root)).toBe(true);
  });

  it('T1.6-03 原子替换后重读文件，sha256 与写入前一致（01 §5.1 退化分支 b 条）', async () => {
    const vault = await freshVault();
    const content = '原子替换验证：\n'.repeat(500);

    const p = {
      operationId: 'op-sha',
      schema: 'llm-wiki.transaction.v1' as const,
      operationType: 'save' as const,
      writes: [{ relativePath: 'wiki/big.md', content, operationType: 'create' as const }],
    };
    await applyBundle(vault.root, p, { timeoutMs: 5_000 });

    const onDisk = await vault.read('wiki/big.md');
    expect(sha256hex(onDisk)).toBe(sha256hex(content));
  });

  it('T1.6-04 Vault.read 经白名单读取正常返回；越界读拒绝', async () => {
    const vault = await freshVault();
    await vault.write('wiki/a.md', '你好');
    const v = createVault(vault.root);

    expect(await v.read('wiki/a.md')).toBe('你好');

    // 结构层越界：.. / 反斜杠
    await expectErrorCodeAsync(v.read('../secret'), 'PARENT_ESCAPE');
    await expectErrorCodeAsync(v.read('a\\b.md'), 'BACKSLASH_OR_CONTROL');
    // 不存在的合法路径 → ENOENT（不是越界错误）
    await expect(v.read('wiki/not-exist.md')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('T1.6-04b Vault.read 拒绝经 symlink 逃逸的路径', async () => {
    if (!SUPPORTS_SYMLINK) return;
    const vault = await freshVault();
    const outside = await makeVault({ initialize: false, scaffold: false });
    vaults.push(outside);
    writeFileSync(path.join(outside.root, 'secret.txt'), 'secret', 'utf8');
    symlinkSync(outside.root, path.join(vault.root, 'escape-link'));

    const v = createVault(vault.root);
    await expectErrorCodeAsync(v.read('escape-link/secret.txt'), 'PATH_OUTSIDE_VAULT');
  });

  it('T1.6-05 端到端组装：plan → preview → apply → read，全链路一个 fixture vault', async () => {
    const vault = await freshVault();
    const v = createVault(vault.root);

    const p = await v.plan([
      { relativePath: 'wiki/topic.md', content: '# 主题\n正文', operationType: 'create' },
      { relativePath: 'raw/source.txt', content: '原文 verbatim', operationType: 'create' },
    ]);
    expect(p.schema).toBe('llm-wiki.transaction.v1');
    expect(p.operationId).toBeTruthy();

    const preview = v.preview(p);
    expect(preview.approvalSha256).toBe(p.approvalSha256);
    expect(preview.changedPaths).toEqual(['wiki/topic.md', 'raw/source.txt']);

    const result = await v.apply(p, { approvedPlanSha256: preview.approvalSha256 });
    expect(result.changedPaths).toEqual(['wiki/topic.md', 'raw/source.txt']);

    expect(await v.read('wiki/topic.md')).toBe('# 主题\n正文');
    expect(await v.read('raw/source.txt')).toBe('原文 verbatim');
    // apply 后 dirty 标记就位（M5 hook）
    expect(vault.exists('.index/bm25/.dirty')).toBe(true);
  });

  it('T1.6-05b plan() 对 delete op 接受省略 content', async () => {
    const vault = await freshVault();
    await vault.write('wiki/a.md', 'A');
    const v = createVault(vault.root);

    const p = await v.plan([{ relativePath: 'wiki/a.md', operationType: 'delete' }]);
    const preview = v.preview(p);
    await v.apply(p, { approvedPlanSha256: preview.approvalSha256 });
    expect(vault.exists('wiki/a.md')).toBe(false);
  });
});
