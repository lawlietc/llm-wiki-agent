/**
 * F11.1/F11.2 resolveLinks + 反链索引 + 死链 stub 单测（T11.1-x / T11.2-x）。
 * 确定性解析，零 LLM；vault 用 makeVault 预置文件。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveLinks, generateStubs, writeBacklinkIndex, slugifyName } from '../../src/vault/links';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';

const PAGE = (slug: string, body: string, extra = ''): string =>
  `---\ntype: idea\ndate: 2026-09-04\nai-first: true\nconfidence: high\nslug: ${slug}${extra}\n---\n\n## For future agent\n\n测试页。\n\n## 正文\n\n${body}\n`;

describe('F11.1 resolveLinks 确定性解析', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) {
      await tv.cleanup();
      tv = null;
    }
  });

  async function setupSample(): Promise<TempVault> {
    tv = await makeVault({
      files: {
        'wiki/vector-db.md': PAGE('vector-db', '依赖 [[pgvector]]，另有 [[redis]] 与 [[缺失页]]。'),
        'wiki/concepts/pgvector.md': PAGE(
          'pgvector',
          '向量扩展。',
          `\nrelations:\n  depends_on:\n    - '[[postgresql]]'\n  supersedes:\n    - '[[nowhere]]'`,
        ),
        'wiki/concepts/postgresql.md': PAGE('postgresql', '关系数据库。'),
        'wiki/concepts/redis.md': PAGE('redis-a', '内存数据库。'),
        'wiki/redis.md': PAGE('redis-b', '另一个同名页。'),
        'wiki/concepts/dup.md': PAGE('dup-a', '同名冲突 A。'),
        'wiki/legacy/dup.md': PAGE('dup-b', '同名冲突 B。'),
      },
    });
    return tv;
  }

  it('T11.1-01 死链/歧义/悬空类型边/孤儿/同名冲突 五类齐全', async () => {
    const v = await setupSample();
    const r = await resolveLinks(v.root);

    expect(r.pages).toHaveLength(7);
    // 死链：普通 wikilink 目标不存在
    expect(r.deadLinks).toEqual([{ source: 'wiki/vector-db.md', target: '缺失页', reason: 'not-found' }]);
    // 歧义：[[redis]] 两个 basename 候选
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0]!.target).toBe('redis');
    expect(r.ambiguous[0]!.candidates.sort()).toEqual(['wiki/concepts/redis.md', 'wiki/redis.md']);
    // 悬空类型边：supersedes → nowhere（D2：类型边缺失是 lint error，不进 deadLinks）
    expect(r.danglingTypedEdges).toEqual([{ source: 'wiki/concepts/pgvector.md', type: 'supersedes', to: 'nowhere' }]);
    // 同名冲突：dup 与 redis（redis 两页同名也是 [[redis]] 歧义的根源）
    expect(r.duplicateBasenames.map((d) => d.basename).sort()).toEqual(['dup', 'redis']);
    expect(r.duplicateBasenames.find((d) => d.basename === 'dup')!.paths).toEqual([
      'wiki/concepts/dup.md',
      'wiki/legacy/dup.md',
    ]);
    // 反链：vector-db → pgvector；pgvector → postgresql（类型边也算入链）
    expect(r.backlinks['wiki/concepts/pgvector.md']).toEqual(['wiki/vector-db.md']);
    expect(r.backlinks['wiki/concepts/postgresql.md']).toEqual(['wiki/concepts/pgvector.md']);
    // 孤儿：wiki/ 下零入链（redis 两页歧义无入链、dup 两页、vector-db 自己）
    expect(r.orphans.sort()).toEqual([
      'wiki/concepts/dup.md',
      'wiki/concepts/redis.md',
      'wiki/legacy/dup.md',
      'wiki/redis.md',
      'wiki/vector-db.md',
    ]);
  });

  it('T11.1-02 wikilink 支持 #fragment 与 |display；自链不入反链', async () => {
    tv = await makeVault({
      files: {
        'wiki/a.md': PAGE('a', '见 [[b|B 页]] 与 [[a#x]]（自链）。'),
        'wiki/b.md': PAGE('b', '反向见 [[a]]。'),
      },
    });
    const r = await resolveLinks(tv.root);
    expect(r.deadLinks).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(0);
    expect(r.backlinks['wiki/b.md']).toEqual(['wiki/a.md']);
    expect(r.backlinks['wiki/a.md']).toEqual(['wiki/b.md']);
  });

  it('T11.1-03 路径后缀匹配：[[concepts/x]] 命中 wiki/concepts/x.md；slug 匹配兜底', async () => {
    tv = await makeVault({
      files: {
        'wiki/a.md': PAGE('a', '后缀 [[concepts/x]] 与 slug 匹配 [[x-slug]]。'),
        'wiki/concepts/x.md': PAGE('whatever', '内容。'),
        'wiki/y.md': PAGE('x-slug', 'slug 命中目标。'),
      },
    });
    const r = await resolveLinks(tv.root);
    expect(r.deadLinks).toHaveLength(0);
    expect(r.backlinks['wiki/concepts/x.md']).toEqual(['wiki/a.md']);
    expect(r.backlinks['wiki/y.md']).toEqual(['wiki/a.md']);
  });

  it('T11.1-04 空 vault / 损坏 frontmatter 容错不崩', async () => {
    tv = await makeVault({ scaffold: false });
    const r1 = await resolveLinks(tv.root);
    expect(r1.pages).toHaveLength(0);
    await tv.write('wiki/broken.md', '---\ntype: [broken\n');
    const r2 = await resolveLinks(tv.root);
    expect(r2.pages).toEqual(['wiki/broken.md']);
  });

  it('T11.1-05 slugifyName：CJK 保留、空格转连字符、截断', () => {
    expect(slugifyName('Some Entity')).toBe('some-entity');
    expect(slugifyName('缺失页')).toBe('缺失页');
    expect(slugifyName('  A  B/C! ')).toBe('a-b-c');
    expect(slugifyName('!!!')).toBe('untitled');
  });
});

describe('F11.2 generateStubs 死链建 stub（D2 二分法）', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) {
      await tv.cleanup();
      tv = null;
    }
  });

  it('T11.2-01 普通死链建 stub（title=目标原文），fix 后重解析无死链；类型边悬空不建', async () => {
    tv = await makeVault({
      files: {
        'wiki/a.md': PAGE('a', '见 [[Some Entity]]。'),
        'wiki/b.md': PAGE('b', '内容。', `\nrelations:\n  supersedes:\n    - '[[nowhere]]'`),
      },
    });
    const before = await resolveLinks(tv.root);
    expect(before.deadLinks).toHaveLength(1);
    expect(before.danglingTypedEdges).toHaveLength(1);

    const created = await generateStubs(tv.root, before);
    expect(created).toEqual(['wiki/concepts/some-entity.md']);

    const after = await resolveLinks(tv.root);
    expect(after.deadLinks).toHaveLength(0); // title 匹配 → 死链修复
    expect(after.danglingTypedEdges).toHaveLength(1); // 类型边不建 stub（D2）

    const stub = await tv.read('wiki/concepts/some-entity.md');
    expect(stub).toContain('stub: true');
    expect(stub).toContain('title: Some Entity');
    expect(stub).toContain('## For future agent');
  });

  it('T11.2-02 歧义目标不建 stub；重复 fix 幂等（check→fix 幂等，仿 gbrain）', async () => {
    tv = await makeVault({
      files: {
        'wiki/a.md': PAGE('a', '见 [[dup]] 与 [[缺失]]。'),
        'wiki/dup.md': PAGE('dup-1', 'A'),
        'wiki/concepts/dup.md': PAGE('dup-2', 'B'),
      },
    });
    const r1 = await resolveLinks(tv.root);
    const created1 = await generateStubs(tv.root, r1);
    expect(created1).toEqual(['wiki/concepts/缺失.md']); // 只建 not-found；歧义不建

    const r2 = await resolveLinks(tv.root);
    const created2 = await generateStubs(tv.root, r2);
    expect(created2).toEqual([]); // 幂等
  });

  it('T11.2-03 反链索引落 .vault-meta/links.json 且 JSON 可解析', async () => {
    tv = await makeVault({
      files: { 'wiki/a.md': PAGE('a', '见 [[b]]。'), 'wiki/b.md': PAGE('b', '内容。') },
    });
    const r = await resolveLinks(tv.root);
    const file = await writeBacklinkIndex(tv.root, r);
    expect(file).toBe(path.join(tv.root, '.vault-meta', 'links.json'));
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed.backlinks['wiki/b.md']).toEqual(['wiki/a.md']);
    expect(parsed.counts.pages).toBe(2);
  });
});
