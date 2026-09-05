/**
 * F14.3 ingest 内容短路单测（T14.3-*）。
 * 覆盖：同文件重跑 LLM 零调用、wiki/实体页逐字节不变（I18）、body 变更恢复全流程、
 * 存量页回填（I19）、同内容不同来源不短路、M13 联动（D8 短路不产生票）、
 * 存量旧路径形式经规范化收敛（D6/T14.3-07）。
 * 零真实网络、零真实 LLM。
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ingest } from '../../src/ingest/ingest';
import { createVault } from '../../src/vault/vault';
import { parseNote } from '../../src/notes/frontmatter';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';
import { normalizeSourceUrl } from '../../src/ingest/source-url';
import { FakeGateway } from '../../test/fakes/fake-gateway';

const WIKI_PAGE = `---
type: project
date: 2026-09-05
ai-first: true
confidence: high
slug: topic-page
---

## For future agent

整理自外部原文，提到 ZenithFlow。
`;

const EXTRACT = JSON.stringify({
  entities: [
    { name: 'ZenithFlow', slug: 'zenithflow', kind: 'project', coverage: 'discussed', summary: '编排引擎' },
  ],
  relations: [],
});

function gwFor(): FakeGateway {
  return new FakeGateway({
    replies: new Map([
      ['整理为一篇', WIKI_PAGE],
      ['实体抽取', EXTRACT],
    ]),
  });
}

const BODY_V1 = 'ZenithFlow 是一个编排引擎。\n';

async function rawRels(tv: TempVault): Promise<string[]> {
  const entries = await readdir(path.join(tv.root, 'raw'));
  return entries.filter((f) => f.endsWith('.md')).sort().map((f) => `raw/${f}`);
}

describe('F14.3 ingest 内容短路', () => {
  let tmpDir: string;
  let fileA: string;
  let tv: TempVault | null = null;

  const beforeAllOnce = async () => {
    if (!tmpDir) {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm14-shortcut-'));
      fileA = path.join(tmpDir, 'article-a.txt');
      await writeFile(fileA, BODY_V1, 'utf8');
    }
  };

  afterEach(async () => {
    if (tv) {
      await tv.cleanup();
      tv = null;
    }
  });
  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('T14.3-01 同文件重跑：LLM 零调用、changedPaths 仅 raw、wiki/实体页逐字节不变（I17/I18）', async () => {
    await beforeAllOnce();
    tv = await makeVault();
    const vault = createVault(tv.root);
    const gw = gwFor();

    const r1 = await ingest(fileA, { vault, gateway: gw });
    expect(gw.calls).toHaveLength(2); // summarize + extract
    expect(r1!.changedPaths.length).toBeGreaterThanOrEqual(3); // raw + wiki + 实体页
    const wikiBefore = await tv.read('wiki/topic-page.md');
    const entityBefore = await tv.read('wiki/notes/zenithflow.md');

    const r2 = await ingest(fileA, { vault, gateway: gw });
    expect(gw.calls).toHaveLength(2); // 短路：LLM 零新增
    expect(r2!.changedPaths).toHaveLength(1);
    expect(r2!.changedPaths[0]!.startsWith('raw/')).toBe(true);
    expect(await tv.read('wiki/topic-page.md')).toBe(wikiBefore);
    expect(await tv.read('wiki/notes/zenithflow.md')).toBe(entityBefore);

    // raw 页指纹在场
    const rawRel = (await rawRels(tv))[0]!;
    expect(parseNote(await tv.read(rawRel)).frontmatter.source_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('T14.3-02/06 body 变更（同 source_url）→ 恢复全流程 + 指纹更新（短路只看指纹，I17）', async () => {
    await beforeAllOnce();
    tv = await makeVault();
    const vault = createVault(tv.root);
    const gw = gwFor();

    await ingest(fileA, { vault, gateway: gw });
    expect(gw.calls).toHaveLength(2);

    await writeFile(fileA, 'ZenithFlow 是一个编排引擎，新增了调度器模块。\n', 'utf8');
    const r2 = await ingest(fileA, { vault, gateway: gw });
    expect(gw.calls).toHaveLength(4); // 全流程恢复
    const rawRel = (await rawRels(tv))[0]!;
    const newSha = parseNote(await tv.read(rawRel)).frontmatter.source_sha256;
    expect(newSha).toMatch(/^[0-9a-f]{64}$/);
    void r2;
  });

  it('T14.3-03 存量页无 source_sha256 → 不短路 + 回填（I19）', async () => {
    await beforeAllOnce();
    tv = await makeVault();
    const vault = createVault(tv.root);
    const gw = gwFor();

    await ingest(fileA, { vault, gateway: gw });
    // 手工抹掉指纹（模拟 M14 之前的存量页）
    const rawRel = (await rawRels(tv))[0]!;
    const content = await tv.read(rawRel);
    await tv.write(rawRel, content.replace(/^source_sha256: .*\n/m, ''));

    const r2 = await ingest(fileA, { vault, gateway: gw });
    expect(gw.calls).toHaveLength(4); // 不短路：全流程
    const fm = parseNote(await tv.read(rawRel)).frontmatter;
    expect(fm.source_sha256).toMatch(/^[0-9a-f]{64}$/); // 回填
    void r2;
  });

  it('T14.3-04 内容相同的不同文件 → 各自独立 ingest，互不短路', async () => {
    await beforeAllOnce();
    const fileB = path.join(tmpDir, 'article-b.txt');
    await writeFile(fileB, BODY_V1, 'utf8');

    tv = await makeVault();
    const vault = createVault(tv.root);
    const gw = gwFor();

    await ingest(fileA, { vault, gateway: gw });
    await ingest(fileB, { vault, gateway: gw });
    expect(gw.calls).toHaveLength(4); // fileB 不短路
    expect((await rawRels(tv))).toHaveLength(2); // 两条独立 raw 页
  });

  it('T14.3-05 M13 联动（D8）：短路重跑不产生票，建议页零变化', async () => {
    await beforeAllOnce();
    tv = await makeVault();
    const vault = createVault(tv.root);
    const gw = gwFor();

    await ingest(fileA, { vault, gateway: gw });
    const notesBefore = await tv.read('wiki/notes/zenithflow.md');
    const fmBefore = parseNote(notesBefore).frontmatter;

    await ingest(fileA, { vault, gateway: gw }); // 短路
    const notesAfter = await tv.read('wiki/notes/zenithflow.md');
    const fmAfter = parseNote(notesAfter).frontmatter;
    expect(fmAfter.suggested_source).toBe(fmBefore.suggested_source);
    expect(fmAfter.suggested_kind).toBe(fmBefore.suggested_kind);
    expect(notesAfter).toBe(notesBefore); // 逐字节不变
  });

  it('T14.3-07 存量页记录旧路径形式（file:// 无指纹）→ 规范化收敛到同一 raw 页 + 回填（D6）', async () => {
    await beforeAllOnce();
    tv = await makeVault();
    const vault = createVault(tv.root);

    // 手工造存量页：source_url 为 file:// 旧形式、无指纹
    const legacy = `---\ntype: source\nsource_url: file:///${fileA.split(path.sep).join('/')}\nfetched_at: 2026-09-05T00:00:00.000Z\n---\n\n${BODY_V1}`;
    await tv.write('raw/legacy-form.md', legacy);

    const gw = gwFor();
    const r = await ingest(fileA, { vault, gateway: gw });

    // 收敛：更新 legacy 页而非新建（raw 目录仍 1 页）
    expect(await rawRels(tv)).toEqual(['raw/legacy-form.md']);
    expect(r!.changedPaths).toContain('raw/legacy-form.md');
    // 回填指纹 + 全流程（存量无指纹不短路）；source_url 同步收敛为规范形式（I20）
    const fm = parseNote(await tv.read('raw/legacy-form.md')).frontmatter;
    expect(fm.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fm.source_url).toBe(normalizeSourceUrl(fileA));

    // 再跑一次：指纹已回填 → 短路
    const gw2 = gwFor();
    const r2 = await ingest(fileA, { vault, gateway: gw2 });
    expect(gw2.calls).toHaveLength(0); // 短路
    expect(r2!.changedPaths).toEqual(['raw/legacy-form.md']);
  });

  it('T14.3-08 onSkip 回调：短路命中时在 approve 之前触发一次', async () => {
    await beforeAllOnce();
    tv = await makeVault();
    const vault = createVault(tv.root);
    const gw = gwFor();

    let skipCount = 0;
    let approveSeenSkip = -1;
    await ingest(
      fileA,
      { vault, gateway: gw },
      {
        onSkip: () => {
          skipCount++;
        },
        approve: async () => {
          approveSeenSkip = skipCount; // approve 时 onSkip 已触发（D9）
          return true;
        },
      },
    );
    expect(skipCount).toBe(0); // 首次不短路

    await ingest(
      fileA,
      { vault, gateway: gw },
      {
        onSkip: () => {
          skipCount++;
        },
        approve: async () => {
          approveSeenSkip = skipCount;
          return true;
        },
      },
    );
    expect(skipCount).toBe(1);
    expect(approveSeenSkip).toBe(1); // approve 之前已触发
  });
});
