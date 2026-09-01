/**
 * F6.3 edit / lint / status / index rebuild（T6.3-01~06）。
 * 零真实 LLM/网络：FakeGateway 注入合规回稿；lint 纯 CPU。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { runEdit } from '../../src/cli/edit';
import { runLint } from '../../src/cli/lint';
import { runStatus } from '../../src/cli/status';
import { runIndexRebuild } from '../../src/cli/index-rebuild';
import { createVault } from '../../src/vault/vault';
import { makeVault, type TempVault } from '../helpers/make-vault';
import { fakeCliIO } from '../../src/cli/io';
import { FakeGateway } from '../fakes/fake-gateway';
import { DIRTY_MARKER_REL } from '../../src/vault/transaction';
import type { AIGatewayConfig } from '../../src/reasoning/gateway-config';
import { COMPLIANT, LINT_DIRTY } from './fixtures';

const OLD_NOTE = `---
type: project
date: 2026-01-01
ai-first: true
confidence: high
slug: vector-db
---

## For future agent

旧内容占位。
`;

describe('F6.3 edit', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.3-01 修订已存在 wiki 页（--yes）→ 更新落盘，changedPaths 含该页', async () => {
    tv = await makeVault();
    await tv.write('wiki/vector-db.md', OLD_NOTE);
    const gw = new FakeGateway({ defaultReply: COMPLIANT }); // 回稿含新正文
    const res = await runEdit('vector-db', { vault: createVault(tv.root), gateway: gw }, { io: fakeCliIO({ isTTY: false }), autoApprove: true });
    expect(res).not.toBeNull();
    expect(res!.changedPaths).toContain('wiki/vector-db.md');
    const content = await tv.read('wiki/vector-db.md');
    expect(content).toContain('向量数据库用于存储高维向量'); // 新正文落地
  });

  it('T6.3-02 编辑不存在的 slug → ValidationError WIKI_PAGE_NOT_FOUND', async () => {
    tv = await makeVault();
    const gw = new FakeGateway({ defaultReply: COMPLIANT });
    let err: unknown;
    try {
      await runEdit('nope', { vault: createVault(tv.root), gateway: gw }, { io: fakeCliIO(), autoApprove: true });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('WIKI_PAGE_NOT_FOUND');
  });

  it('T6.3-03 LLM 回稿 lint 有 error → ValidationError AI_FIRST_LINT（闸门拒）', async () => {
    tv = await makeVault();
    await tv.write('wiki/vector-db.md', OLD_NOTE);
    const gw = new FakeGateway({ defaultReply: LINT_DIRTY });
    let err: unknown;
    try {
      await runEdit('vector-db', { vault: createVault(tv.root), gateway: gw }, { io: fakeCliIO(), autoApprove: true });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('AI_FIRST_LINT');
    const content = await tv.read('wiki/vector-db.md');
    expect(content).toContain('旧内容占位'); // 未覆盖
  });

  it('T6.3-04 approve 拒绝(n) → 返回 null，文件未变（无静默覆盖）', async () => {
    tv = await makeVault();
    await tv.write('wiki/vector-db.md', OLD_NOTE);
    const gw = new FakeGateway({ defaultReply: COMPLIANT });
    const res = await runEdit('vector-db', { vault: createVault(tv.root), gateway: gw }, { io: fakeCliIO({ isTTY: true, answers: ['n'] }) });
    expect(res).toBeNull();
    const content = await tv.read('wiki/vector-db.md');
    expect(content).toContain('旧内容占位');
  });
});

describe('F6.3 lint', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.3-04（lint）error 级 → exitCode=1；干净 → 0；绝不修改文件', async () => {
    tv = await makeVault();
    const dirtyRel = 'wiki/dirty.md';
    const cleanRel = 'wiki/clean.md';
    await tv.write(dirtyRel, LINT_DIRTY);
    await tv.write(cleanRel, COMPLIANT);

    const beforeDirty = await tv.read(dirtyRel);
    const r1 = await runLint(dirtyRel, { io: fakeCliIO({ isTTY: false }), cwd: tv.root });
    expect(r1.exitCode).toBe(1);
    expect(r1.issues.some((i) => i.severity === 'error')).toBe(true);

    const r2 = await runLint(cleanRel, { io: fakeCliIO({ isTTY: false }), cwd: tv.root });
    expect(r2.exitCode).toBe(0);

    // 文件未被修改
    const afterDirty = readFileSync(tv.abs(dirtyRel), 'utf8');
    expect(afterDirty).toBe(beforeDirty);
  });
});

describe('F6.3 status', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  function cfg(): { gateway: AIGatewayConfig; raw: Record<string, unknown> } {
    return {
      gateway: { chat_model: 'a:b', embedding_model: 'c:d', providers: { anthropic: { apiKey: 'x' }, openai: { apiKey: 'y' } } },
      raw: {},
    };
  }

  it('T6.3-05 输出 wiki 页数 / dirty / providers；非 TTY 无 ANSI 颜色', async () => {
    tv = await makeVault();
    await tv.write('wiki/page-a.md', COMPLIANT);
    await tv.write('wiki/page-b.md', COMPLIANT);
    await tv.write(DIRTY_MARKER_REL, '');

    const io = fakeCliIO({ isTTY: false });
    const info = await runStatus({ vaultRoot: tv.root, source: 'explicit', config: cfg() }, { io });
    expect(info.pages).toBe(2);
    expect(info.dirty).toBe(true);
    expect(info.providers).toEqual(['anthropic', 'openai']);
    const out = io.outLines.join('\n');
    expect(out).not.toContain('\x1b['); // 非 TTY 纯文本（I2 零泄漏检查友好）
  });

  it('T6.3-05b 无 dirty 标记 → dirty=false', async () => {
    tv = await makeVault();
    await tv.write('wiki/page-a.md', COMPLIANT);
    const info = await runStatus({ vaultRoot: tv.root, source: 'explicit', config: cfg() }, { io: fakeCliIO() });
    expect(info.dirty).toBe(false);
    expect(info.pages).toBe(1);
  });
});

describe('F6.3 index rebuild', () => {
  let tv: TempVault | null = null;
  afterEach(async () => {
    if (tv) await tv.cleanup();
    tv = null;
  });

  it('T6.3-06 全量重建索引并清除 dirty 标记', async () => {
    tv = await makeVault();
    await tv.write('wiki/vector-db.md', COMPLIANT);
    await tv.write(DIRTY_MARKER_REL, '');
    expect(tv.exists(DIRTY_MARKER_REL)).toBe(true);

    await runIndexRebuild({ vaultRoot: tv.root }, { io: fakeCliIO() });

    expect(tv.exists(DIRTY_MARKER_REL)).toBe(false); // 重建后清除
    const chunksDir = path.join(tv.root, '.index', 'chunks');
    const entries = readdirSync(chunksDir);
    expect(entries.length).toBeGreaterThan(0); // 索引已生成
  });
});
