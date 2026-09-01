/**
 * F4.4 summarizeToWiki + slug 校验（T4.4-01/02/03/06）。
 * T4.4-04/05（slug 命中已存在 → update + approve 注入）依赖 vault 与编排，见 ingest.test.ts。
 */
import { describe, it, expect } from 'vitest';

import { summarizeToWiki } from '../../src/ingest/summarize';
import { ValidationError } from '../../src/errors';
import { FakeGateway } from '../../test/fakes/fake-gateway';

const COMPLIANT = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: vector-db
---

## For future agent

整理自外部原文。

## 正文

向量数据库用于存储高维向量，常见于 RAG 与推荐系统。
`;

const BAD = `---
type: project
date: 2026-09-01
confidence: high
slug: bad
---

# 缺少前言与 ai-first

正文。
`;

const MALICIOUS_SLUG = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: ../../etc/passwd
---

## For future agent

x

## 正文

y
`;

const BACKSLASH_SLUG = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: a\\b
---

## For future agent

x

## 正文

y
`;

describe('F4.4 summarizeToWiki + slug 校验', () => {
  it('T4.4-01 FakeGateway 固定回稿（合规 wiki 页）→ parseNote 出 frontmatter + 正文', async () => {
    const gw = new FakeGateway({ defaultReply: COMPLIANT });
    const note = await summarizeToWiki('外部原文', 'https://example.com/vec', gw);
    expect(note.slug).toBe('vector-db');
    expect(note.content).toContain('## For future agent');
    expect(note.content).toContain('向量数据库');
  });

  it('T4.4-02 LLM 回稿 lint 有 error（坏稿 fixture）→ AI_FIRST_LINT 拒绝', async () => {
    const gw = new FakeGateway({ defaultReply: BAD });
    await expect(summarizeToWiki('外部原文', 'https://example.com/bad', gw)).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'AI_FIRST_LINT',
    });
  });

  it('T4.4-03 LLM 生成的恶意 slug 过白名单被拒（.. 与反斜杠）', async () => {
    const gw1 = new FakeGateway({ defaultReply: MALICIOUS_SLUG });
    await expect(summarizeToWiki('外部原文', 'https://example.com/x', gw1)).rejects.toThrow(ValidationError);

    const gw2 = new FakeGateway({ defaultReply: BACKSLASH_SLUG });
    await expect(summarizeToWiki('外部原文', 'https://example.com/y', gw2)).rejects.toThrow(ValidationError);
  });

  it('T4.4-06 回稿含 markdown 代码块包裹 → 去围栏后正确解析', async () => {
    const wrapped = '```markdown\n' + COMPLIANT + '\n```';
    const gw = new FakeGateway({ defaultReply: wrapped });
    const note = await summarizeToWiki('外部原文', 'https://example.com/w', gw);
    expect(note.slug).toBe('vector-db');
    expect(note.content).toContain('## For future agent');
  });
});
