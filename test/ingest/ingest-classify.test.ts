/**
 * F13.4 建页与毕业端到端单测（T13.4-*）。
 * 双回稿 FakeGateway（整理 / 实体抽取 关键词路由），零真实网络、零真实 LLM。
 * 覆盖：新建落点四态、票级保险三规则、双次一致毕业、滑动、同源防伪、pin 冲突、
 * 并存冲突、事务回滚、slug 不变、分类异常降级、stub 正交、三拍毕业路径。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ingest } from '../../src/ingest/ingest';
import { createVault } from '../../src/vault/vault';
import { resolveLinks } from '../../src/vault/links';
import { parseNote } from '../../src/notes/frontmatter';
import { readSourceRefs } from '../../src/notes/source-fm';
import { _classifySeam } from '../../src/notes/classify';
import { makeVault, type TempVault } from '../../test/helpers/make-vault';
import { FakeGateway } from '../../test/fakes/fake-gateway';
import { fakeCliIO, type FakeCliIO } from '../../src/cli/io';

const BODY =
  'Acme Inc. 是老牌厂商。ZenithFlow 是一个编排引擎，pgvector 是配套扩展。星尘之环是文中的比喻。相关工具列在文末。Pin Page Subject 在此出现。\n';

const WIKI_PAGE = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: topic-page
---

## For future agent

整理自外部原文。
`;

const E = (over: Record<string, unknown>) => ({
  name: 'x',
  slug: 'x',
  kind: 'concept',
  coverage: 'discussed',
  ...over,
});

const EXTRACT_A = JSON.stringify({
  entities: [
    E({ name: 'Acme Inc.', slug: 'acme', kind: 'company', summary: '老牌厂商' }),
    E({ name: 'ZenithFlow', slug: 'zenithflow', kind: 'project', summary: '编排引擎' }),
    E({ name: 'pgvector', slug: 'pgvector', kind: 'project', coverage: 'named', summary: '向量扩展' }),
    E({ name: '星尘之环', slug: 'xingchen', kind: 'vehicle', summary: '比喻' }),
    E({ name: '相关工具', slug: 'related-tools', kind: 'concept', summary: '罗列' }),
    E({ name: 'Pin Page Subject', slug: 'pinpage', kind: 'project', summary: 'pin 冲突用' }),
  ],
  relations: [],
});

const EXTRACT_B = JSON.stringify({
  entities: [
    E({ name: 'ZenithFlow', slug: 'zenithflow', kind: 'project', summary: '编排引擎' }),
    E({ name: 'Acme Inc.', slug: 'acme', kind: 'company', summary: '老牌厂商' }),
  ],
  relations: [],
});

const EXTRACT_B_SLIDE = JSON.stringify({
  entities: [E({ name: 'ZenithFlow', slug: 'zenithflow', kind: 'concept', summary: '编排引擎' })],
  relations: [],
});

const EXTRACT_NAMED = JSON.stringify({
  entities: [E({ name: 'ZenithFlow', slug: 'zenithflow', kind: 'concept', coverage: 'named' })],
  relations: [],
});

function gwFor(extractReply: string): FakeGateway {
  return new FakeGateway({
    replies: new Map([
      ['整理为一篇', WIKI_PAGE],
      ['实体抽取', extractReply],
    ]),
  });
}

let tmpDir: string;
let fileA: string;
let fileB: string;
let fileC: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm13-ingest-'));
  fileA = path.join(tmpDir, 'article-a.txt');
  fileB = path.join(tmpDir, 'article-b.txt');
  fileC = path.join(tmpDir, 'article-c.txt');
  await writeFile(fileA, BODY, 'utf8');
  await writeFile(fileB, BODY, 'utf8');
  await writeFile(fileC, BODY, 'utf8');
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

const MIN_FM = '---\ntype: idea\ndate: 2026-09-01\nslug: zenithflow\ntitle: ZenithFlow\n---\n\n## For future agent\n\n占位\n';

describe('F13.4 建页与毕业', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) {
      await tv.cleanup();
      tv = null;
    }
  });

  it('T13.4-01 新建落点四态：lexicon→kind 确认态；model 有效票→notes 建议态；none→notes 裸未定；rejected→不建页', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    const res = await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) });
    expect(res).not.toBeNull();

    // lexicon → 确认态 kind 目录
    const acme = await tv.read('wiki/companies/acme.md');
    expect(acme).toContain('entity_kind: company');
    expect(acme).toContain('type: idea');
    expect(acme).not.toContain('needs_classification');
    expect(acme).not.toContain('suggested_kind');

    // model 有效票 → notes 建议态
    const zen = await tv.read('wiki/notes/zenithflow.md');
    expect(zen).toContain('suggested_kind: project');
    expect(zen).toContain('suggested_source: raw/');
    expect(zen).toContain('needs_classification: true');
    expect(zen).not.toContain('entity_kind:');

    // declared 非法 → none → notes 裸未定
    const xc = await tv.read('wiki/notes/xingchen.md');
    expect(xc).toContain('needs_classification: true');
    expect(xc).not.toContain('suggested_kind');

    // rejected → 不建页
    expect(tv.exists('wiki/notes/related-tools.md')).toBe(false);
    expect(tv.exists('wiki/concepts/related-tools.md')).toBe(false);
  });

  it('T13.4-02 coverage=named 且仅 model → 不写 suggested_kind（票级保险①：不产生）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) });
    const pg = await tv.read('wiki/notes/pgvector.md');
    expect(pg).toContain('stub: true');
    expect(pg).toContain('needs_classification: true');
    expect(pg).not.toContain('suggested_kind');
  });

  it('T13.4-03 双次一致（不同 source）→ 迁移 + 目标态正确 + 正文逐字节不变 + date 未被破坏', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) });
    const before = await tv.read('wiki/notes/zenithflow.md');
    const bodyBefore = parseNote(before).body;

    await ingest(fileB, { vault, gateway: gwFor(EXTRACT_B) });

    expect(tv.exists('wiki/notes/zenithflow.md')).toBe(false);
    expect(tv.exists('wiki/projects/zenithflow.md')).toBe(true);
    const after = await tv.read('wiki/projects/zenithflow.md');
    const { frontmatter, body } = parseNote(after);
    expect(frontmatter.entity_kind).toBe('project');
    expect(frontmatter.type).toBe('project');
    expect(frontmatter.needs_classification).toBeUndefined();
    expect(frontmatter.suggested_kind).toBeUndefined();
    expect(frontmatter.suggested_source).toBeUndefined();
    expect(body).toBe(bodyBefore); // 正文逐字节不变
    expect(/date: \d{4}-\d{2}-\d{2}\n/.test(after)).toBe(true); // date 未被加引号破坏
  });

  it('T13.4-04 判定不一致 → 更新建议值与 suggested_source、不迁移（滑动一步）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) });
    await ingest(fileB, { vault, gateway: gwFor(EXTRACT_B_SLIDE) });

    expect(tv.exists('wiki/projects/zenithflow.md')).toBe(false);
    const zen = await tv.read('wiki/notes/zenithflow.md');
    const { frontmatter } = parseNote(zen);
    expect(frontmatter.suggested_kind).toBe('concept');
    expect(String(frontmatter.suggested_source)).toContain('article-b');
    expect(frontmatter.entity_kind).toBeUndefined();
  });

  it('T13.4-05 同一 source（同文件、内容微调）重复判定即使 kind 一致 → 不毕业（防伪确认，票级保险③；M14 短路后需改内容才能产生同源票）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) });

    // M14 短路后：同文件同内容重跑直接短路（T14.3-05 覆盖）；
    // 同源票需构造「同 source_url、不同 body」——内容微调后重 ingest
    await writeFile(fileA, BODY + '\n（内容微调，触发全流程但 source_url 不变。）\n', 'utf8');
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) });

    expect(tv.exists('wiki/projects/zenithflow.md')).toBe(false);
    expect(tv.exists('wiki/notes/zenithflow.md')).toBe(true);
    const zen = await tv.read('wiki/notes/zenithflow.md');
    expect(String(parseNote(zen).frontmatter.suggested_source)).toContain('article-a');
  });

  it('T13.4-06 pin 赢过建议：不迁移 + 报 KIND_PIN_CONFLICT + 保留 pin + 写入新建议', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await tv.write(
      'wiki/notes/pinpage.md',
      '---\ntype: idea\ndate: 2026-09-01\nslug: pinpage\ntitle: Pin Page Subject\nentity_kind: person\nneeds_classification: true\n---\n\n## For future agent\n\n人工 pin 页\n',
    );
    const io: FakeCliIO = fakeCliIO();
    // adopt：预置 pin 页无基线记录（M15 D3 存量语义），采纳现状后测 pin 行为
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) }, { io, adopt: true });

    expect(io.errLines.some((l) => l.includes('[KIND_PIN_CONFLICT]'))).toBe(true);
    expect(tv.exists('wiki/projects/pinpage.md')).toBe(false);
    const page = await tv.read('wiki/notes/pinpage.md');
    const { frontmatter } = parseNote(page);
    expect(frontmatter.entity_kind).toBe('person'); // pin 保留
    expect(frontmatter.suggested_kind).toBe('project'); // 新建议写入
  });

  it('T13.4-07 来源并存（notes/ 与 kind/）→ 不升级不迁移 + io.err 打印 KIND_SOURCE_CONFLICT（可 grep）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await tv.write('wiki/notes/zenithflow.md', MIN_FM);
    await tv.write(
      'wiki/projects/zenithflow.md',
      '---\ntype: project\ndate: 2026-09-01\nslug: zenithflow\ntitle: ZenithFlow\nentity_kind: project\n---\n\n## For future agent\n\n确认页\n',
    );
    const notesBefore = await tv.read('wiki/notes/zenithflow.md');
    const kindBefore = await tv.read('wiki/projects/zenithflow.md');

    const io: FakeCliIO = fakeCliIO();
    const res = await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) }, { io });

    expect(io.errLines.some((l) => l.includes('[KIND_SOURCE_CONFLICT]'))).toBe(true);
    expect(io.errLines.some((l) => l.includes('zenithflow'))).toBe(true);
    // 两侧原样保留：不升级不迁移
    expect(await tv.read('wiki/notes/zenithflow.md')).toBe(notesBefore);
    expect(await tv.read('wiki/projects/zenithflow.md')).toBe(kindBefore);
    // plan 里没有 zenithflow 的写操作
    expect(res!.changedPaths.some((p) => p.includes('zenithflow'))).toBe(false);
  });

  it('T13.4-08 来源并存 → resolveLinks 报 duplicateEntitySlug（error 级）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await tv.write('wiki/notes/zenithflow.md', MIN_FM);
    await tv.write(
      'wiki/projects/zenithflow.md',
      '---\ntype: project\ndate: 2026-09-01\nslug: zenithflow\ntitle: ZenithFlow\nentity_kind: project\n---\n\n## For future agent\n\n确认页\n',
    );
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) });

    const report = await resolveLinks(tv.root);
    const dup = report.duplicateEntitySlug.find((d) => d.slug === 'zenithflow');
    expect(dup).toBeDefined();
    expect(dup!.paths.length).toBe(2);
  });

  it('T13.4-09 迁移事务任一步失败 → 整体回滚（不双份不零份，I-a）', async () => {
    tv = await makeVault();
    const base = createVault(tv.root);
    await ingest(fileA, { vault: base, gateway: gwFor(EXTRACT_A) });
    expect(tv.exists('wiki/notes/zenithflow.md')).toBe(true);

    // 故障注入：delete op（迁移的旧页删除）前失败
    const { applyBundle } = await import('../../src/vault/transaction');
    const failingVault = {
      ...base,
      async apply(plan, opts) {
        const idx = plan.writes.findIndex((w) => w.operationType === 'delete');
        return applyBundle(tv!.root, plan, {
          approvedPlanSha256: opts?.approvedPlanSha256,
          failBeforeWrite: idx >= 0 ? { index: idx + 1, error: new Error('boom') } : undefined,
        });
      },
    } as typeof base;

    await expect(ingest(fileB, { vault: failingVault, gateway: gwFor(EXTRACT_B) })).rejects.toThrowError(/boom/);

    // 不双份不零份：notes 页原样在，目标目录页不存在
    expect(tv.exists('wiki/notes/zenithflow.md')).toBe(true);
    expect(tv.exists('wiki/projects/zenithflow.md')).toBe(false);
  });

  it('T13.4-10 slug 不变 → 既有 [[slug]] 链接迁移后仍解析（I-b）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await tv.write(
      'wiki/topic-page.md',
      '---\ntype: project\ndate: 2026-09-01\nai-first: true\nconfidence: high\nslug: topic-page\n---\n\n## For future agent\n\n提到 [[zenithflow]]。\n',
    );
    // adopt：预置页无基线（M15 存量语义同步）
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) }, { adopt: true });
    await ingest(fileB, { vault, gateway: gwFor(EXTRACT_B) });

    expect(tv.exists('wiki/projects/zenithflow.md')).toBe(true);
    const report = await resolveLinks(tv.root);
    expect(report.deadLinks.some((d) => d.target === 'zenithflow')).toBe(false);
    expect(report.backlinks['wiki/projects/zenithflow.md']).toContain('wiki/topic-page.md');
  });

  it('T13.4-11 分类模块异常 → 降级 kind:null 落 notes/ 且 ingest 成功（I-h）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    const original = _classifySeam.impl;
    _classifySeam.impl = () => {
      throw new Error('classify boom');
    };
    try {
      const res = await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) });
      expect(res).not.toBeNull();
      // 全部降级为未分类 → notes/ 裸未定
      expect(tv.exists('wiki/notes/acme.md')).toBe(true);
      expect(tv.exists('wiki/notes/zenithflow.md')).toBe(true);
      expect(tv.exists('wiki/companies/acme.md')).toBe(false);
      const acme = await tv.read('wiki/notes/acme.md');
      expect(acme).toContain('needs_classification: true');
      expect(acme).not.toContain('suggested_kind');
    } finally {
      _classifySeam.impl = original;
    }
  });

  it('T13.4-12 stub 与目录正交：notes/ 下可存在整页与 stub 两种（I-g）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) });
    const zen = await tv.read('wiki/notes/zenithflow.md');
    const pg = await tv.read('wiki/notes/pgvector.md');
    expect(zen).not.toContain('stub: true'); // 整页
    expect(pg).toContain('stub: true'); // stub
  });

  it('T13.4-13 named 提名新建 → 建页但无 suggested_kind', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_NAMED) });
    expect(tv.exists('wiki/notes/zenithflow.md')).toBe(true);
    const zen = await tv.read('wiki/notes/zenithflow.md');
    expect(zen).toContain('needs_classification: true');
    expect(zen).not.toContain('suggested_kind');
  });

  it('T13.4-14 页有建议值 + named 提名判出不同 kind → 建议值不变（票级保险②：不更新）', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_A) }); // 建议态：project / article-a
    const before = await tv.read('wiki/notes/zenithflow.md');

    await ingest(fileB, { vault, gateway: gwFor(EXTRACT_NAMED) }); // named 票判 concept

    const after = await tv.read('wiki/notes/zenithflow.md');
    const { frontmatter } = parseNote(after);
    expect(frontmatter.suggested_kind).toBe('project');
    expect(String(frontmatter.suggested_source)).toContain('article-a');
    // 票级保险② 的真实不变量：**建议值与正文**不变。
    // M20 工单 03 之后唯一允许的变化是代码掌管的溯源指针并集——第二篇文档也提到了
    // 这个实体，页面必须记得它（I47 已按裁决收窄为「frontmatter 允许增减溯源键」）。
    const stripRefs = (s: string) => s.replace(/^source_refs: .*\n/m, '').replace(/^raw_source: .*\n/m, '');
    expect(stripRefs(after)).toBe(stripRefs(before));
    expect(readSourceRefs(frontmatter as unknown as Record<string, unknown>)).toHaveLength(2);
  });

  it('T13.4-15 三拍毕业路径：named（建页无建议）→ discussed（写建议）→ discussed（一致）→ 毕业', async () => {
    tv = await makeVault();
    const vault = createVault(tv.root);

    // 第一拍：named → notes 裸未定（stub）
    await ingest(fileA, { vault, gateway: gwFor(EXTRACT_NAMED) });
    const beat1 = await tv.read('wiki/notes/zenithflow.md');
    expect(beat1).toContain('needs_classification: true');
    expect(beat1).not.toContain('suggested_kind');

    // 第二拍：discussed（不同 source）→ 写建议 + stub→page promotion
    await ingest(fileB, { vault, gateway: gwFor(EXTRACT_B) });
    const beat2 = await tv.read('wiki/notes/zenithflow.md');
    expect(beat2).toContain('suggested_kind: project');
    expect(beat2).not.toContain('stub: true'); // 内容升级照旧（与分类正交）
    expect(beat2).toContain('status: active');
    expect(tv.exists('wiki/projects/zenithflow.md')).toBe(false);

    // 第三拍：discussed 一致（再换 source）→ 毕业
    await ingest(fileC, { vault, gateway: gwFor(EXTRACT_B) });
    expect(tv.exists('wiki/notes/zenithflow.md')).toBe(false);
    expect(tv.exists('wiki/projects/zenithflow.md')).toBe(true);
    const final = await tv.read('wiki/projects/zenithflow.md');
    const { frontmatter } = parseNote(final);
    expect(frontmatter.entity_kind).toBe('project');
    expect(frontmatter.needs_classification).toBeUndefined();
    expect(frontmatter.suggested_kind).toBeUndefined();
  });
});
