/**
 * M1-F1.2 路径白名单（01 §3）
 *
 * 表驱动攻击向量：T1.2-01 ~ T1.2-14。
 * `normalizeVaultPath`（结构层）与 `assertPortableWritePath`（便携性 + 保留路径层）共用一张样本表。
 */

import { describe, expect, it } from 'vitest';

import { assertPortableWritePath, normalizeVaultPath } from '../../src/vault/paths';
import { errorCodeOf } from '../helpers/errors';

/**
 * 非 NFC 样本：日文浊音「が」的 NFD 形式（か + U+3099 组合用浊点）。
 *
 * 不能用 U+337F（㍿）充当反例：它的分解是**兼容**分解（<compat>），
 * 而 NFC 只做**规范**分解，对 ㍿ 不做任何变换 —— ㍿ 本身已处于 NFC 形式。
 */
const NON_NFC = 'が'.normalize('NFD');

describe('F1.2 normalizeVaultPath（结构层）', () => {
  const table: Array<{ id: string; sample: string; expected: string | null }> = [
    { id: 'T1.2-01', sample: '', expected: 'EMPTY_PATH' },

    { id: 'T1.2-02', sample: 'a\\b.md', expected: 'BACKSLASH_OR_CONTROL' },
    { id: 'T1.2-02', sample: 'a\x00.md', expected: 'BACKSLASH_OR_CONTROL' },
    { id: 'T1.2-02', sample: 'a\nb', expected: 'BACKSLASH_OR_CONTROL' },
    { id: 'T1.2-02', sample: 'a\rb', expected: 'BACKSLASH_OR_CONTROL' },

    { id: 'T1.2-03', sample: './a', expected: 'NONCANONICAL_PATH' },
    { id: 'T1.2-03', sample: 'a//b', expected: 'NONCANONICAL_PATH' },
    { id: 'T1.2-03', sample: '/a', expected: 'NONCANONICAL_PATH' },
    { id: 'T1.2-03', sample: 'a/', expected: 'NONCANONICAL_PATH' },

    { id: 'T1.2-04', sample: '../a', expected: 'PARENT_ESCAPE' },
    { id: 'T1.2-04', sample: 'a/../b', expected: 'PARENT_ESCAPE' },
    { id: 'T1.2-04', sample: 'a/..', expected: 'PARENT_ESCAPE' },

    // 合法回归：子串含 `..` 但不成段，不得误伤（01 §3 注释明写的 parsed.parts 判法）
    { id: 'T1.2-05', sample: 'a..b.md', expected: null },
    { id: 'T1.2-05', sample: 'wiki/..隐藏/页.md', expected: null },

    { id: 'T1.2-06', sample: `${NON_NFC}.md`, expected: 'NON_NFC_PATH' },
    { id: 'T1.2-06', sample: `wiki/${NON_NFC}.md`, expected: 'NON_NFC_PATH' },
    // NFC 形式的同义路径必须放行（不能因为拒非 NFC 就误伤正常 CJK）
    { id: 'T1.2-06', sample: '株式会社.md', expected: null },
    { id: 'T1.2-06', sample: 'wiki/子目录/页.md', expected: null },

    { id: 'T1.2-07', sample: 'a'.repeat(1025), expected: 'PATH_TOO_LONG' },
    // 边界：恰好 1024 字节放行（1024 个 ASCII = 1024 字节）
    { id: 'T1.2-07', sample: 'a'.repeat(1024), expected: null },

    // 正常路径
    { id: 'T1.2-14', sample: 'raw/a.md', expected: null },
    { id: 'T1.2-14', sample: 'wiki/my-topic.md', expected: null },
  ];

  it.each(table)('$id $sample → $expected', ({ sample, expected }) => {
    expect(errorCodeOf(() => normalizeVaultPath(sample))).toBe(expected);
  });

  it('T1.2-07b 长度按 UTF-8 字节算而非 UTF-16 码元（多字节字符更早触顶）', () => {
    // 400 个汉字 = 1200 字节 > 1024，但只有 400 个码元
    expect(errorCodeOf(() => normalizeVaultPath('中'.repeat(400)))).toBe('PATH_TOO_LONG');
    // 340 个汉字 = 1020 字节 ≤ 1024
    expect(errorCodeOf(() => normalizeVaultPath('中'.repeat(340)))).toBe(null);
  });

  it('返回值即归一后的路径（幂等）', () => {
    expect(normalizeVaultPath('wiki/a.md')).toBe('wiki/a.md');
    expect(normalizeVaultPath(normalizeVaultPath('wiki/a.md'))).toBe('wiki/a.md');
  });
});

describe('F1.2 assertPortableWritePath（便携性 + 保留路径层）', () => {
  const table: Array<{ id: string; sample: string; expected: string | null }> = [
    { id: 'T1.2-08', sample: 'a:b.md', expected: 'NTFS_STREAM' },
    { id: 'T1.2-08', sample: 'wiki/a:b.md', expected: 'NTFS_STREAM' },

    { id: 'T1.2-09', sample: 'a<b', expected: 'UNPORTABLE_CHAR' },
    { id: 'T1.2-09', sample: 'a>b', expected: 'UNPORTABLE_CHAR' },
    { id: 'T1.2-09', sample: 'a|b', expected: 'UNPORTABLE_CHAR' },
    { id: 'T1.2-09', sample: 'a?b', expected: 'UNPORTABLE_CHAR' },
    { id: 'T1.2-09', sample: 'a*b', expected: 'UNPORTABLE_CHAR' },
    { id: 'T1.2-09', sample: 'a"b', expected: 'UNPORTABLE_CHAR' },

    { id: 'T1.2-10', sample: 'a.', expected: 'TRAILING_DOT_SPACE' },
    { id: 'T1.2-10', sample: 'a ', expected: 'TRAILING_DOT_SPACE' },
    { id: 'T1.2-10', sample: 'a./b', expected: 'TRAILING_DOT_SPACE' },
    { id: 'T1.2-10', sample: 'wiki/a /b.md', expected: 'TRAILING_DOT_SPACE' },
    // 段中间的点/空格合法
    { id: 'T1.2-10', sample: 'wiki/a. b.md', expected: null },

    { id: 'T1.2-11', sample: 'CON.md', expected: 'RESERVED_NAME' },
    { id: 'T1.2-11', sample: 'com1.md', expected: 'RESERVED_NAME' },
    { id: 'T1.2-11', sample: 'NUL', expected: 'RESERVED_NAME' },
    { id: 'T1.2-11', sample: 'lpt9.log', expected: 'RESERVED_NAME' },
    { id: 'T1.2-11', sample: 'wiki/AUX.txt', expected: 'RESERVED_NAME' },
    // 保留名只按「首段点号之前」判，普通文件名不误伤
    { id: 'T1.2-11', sample: 'wiki/contract.md', expected: null },

    // 受保护目录本体（单层）
    { id: 'T1.2-12', sample: '.vault-meta', expected: 'RESERVED_PATH' },
    { id: 'T1.2-12', sample: 'raw', expected: 'RESERVED_PATH' },
    { id: 'T1.2-12', sample: 'wiki', expected: 'RESERVED_PATH' },
    { id: 'T1.2-12', sample: '.index', expected: 'RESERVED_PATH' },
    { id: 'T1.2-12', sample: '.git', expected: 'RESERVED_PATH' },
    { id: 'T1.2-12', sample: '.llm-wiki.json', expected: 'RESERVED_PATH' },

    // .vault-meta 整目录只可经事务 API 写
    { id: 'T1.2-13', sample: '.vault-meta/x', expected: 'RESERVED_PATH' },
    { id: 'T1.2-13', sample: '.vault-meta/journal.json', expected: 'RESERVED_PATH' },

    // 正常写入路径
    { id: 'T1.2-14', sample: 'raw/a.md', expected: null },
    { id: 'T1.2-14', sample: 'wiki/子目录/页.md', expected: null },
    { id: 'T1.2-14', sample: '.index/bm25/index.json', expected: null },
    { id: 'T1.2-14', sample: 'wiki/a.b.c.md', expected: null },
  ];

  it.each(table)('$id $sample → $expected', ({ sample, expected }) => {
    expect(errorCodeOf(() => assertPortableWritePath(sample))).toBe(expected);
  });

  it('保留路径判定只看首段，深层同名目录不误伤', () => {
    expect(errorCodeOf(() => assertPortableWritePath('wiki/raw/note.md'))).toBe(null);
    expect(errorCodeOf(() => assertPortableWritePath('wiki/.git-notes/a.md'))).toBe(null);
  });

  it('结构层错误优先于便携性层（先归一化再判便携性）', () => {
    // 既含反斜杠又含冒号 → 报 BACKSLASH_OR_CONTROL（结构层先拦）
    expect(errorCodeOf(() => assertPortableWritePath('a\\b:c.md'))).toBe('BACKSLASH_OR_CONTROL');
  });
});
