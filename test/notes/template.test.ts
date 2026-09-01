/**
 * M2-F2.4 页模板
 *
 * T2.4-01 renderWikiNote 三段结构；T2.4-02 renderRawNote 免前言 + 三字段；
 * T2.4-03 raw body verbatim；T2.4-04 renderWikiNote 产物过 lint 0 error（模板自身合规）。
 */

import { describe, expect, it } from 'vitest';

import { lintNote } from '../../src/notes/lint';
import { parseNote, parseFrontmatter } from '../../src/notes/frontmatter';
import { renderRawNote, renderWikiNote, type SourceMeta } from '../../src/notes/template';
import type { NoteFrontmatter } from '../../src/notes/types';

/** 合规 wiki 页 frontmatter（lint 0 error 用） */
const GOOD_FM: NoteFrontmatter = {
  date: '2026-08-31',
  type: 'idea',
  tags: ['test'],
  'ai-first': true,
  confidence: 'high',
  status: 'seedling',
};

describe('F2.4 页模板', () => {
  it('T2.4-01 renderWikiNote 产物含 frontmatter + ## For future agent + 正文三段', () => {
    const out = renderWikiNote(GOOD_FM, '这是测试页前言', '这是正文内容');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('ai-first: true');
    expect(out).toContain('## For future agent');
    expect(out).toContain('## 正文');
    expect(out).toContain('这是测试页前言');
    expect(out).toContain('这是正文内容');
  });

  it('T2.4-02 renderRawNote 产物不含前言、frontmatter 仅三字段（I3）', () => {
    const meta: SourceMeta = { sourceUrl: 'https://example.com/article', fetchedAt: '2026-09-01T08:00:00Z' };
    const out = renderRawNote('原文内容', meta);

    expect(out).not.toContain('## For future agent');

    const fm = parseFrontmatter(out);
    expect(fm.type).toBe('source');
    expect(fm.source_url).toBe('https://example.com/article');
    expect(fm.fetched_at).toBe('2026-09-01T08:00:00Z');
    // 无 date / ai-first / confidence / tags（source 页免这些）
    expect(fm.date).toBeUndefined();
    expect(fm['ai-first']).toBeUndefined();
    expect(fm.confidence).toBeUndefined();
    expect(fm.tags).toBeUndefined();
  });

  it('T2.4-03 renderRawNote 的 body verbatim（不 trim 不改写，逐字节比对）', () => {
    const meta: SourceMeta = { sourceUrl: 'https://x.com', fetchedAt: '2026-09-01T00:00:00Z' };
    // 刁钻 body：前导空格、空行、特殊字符、尾随换行
    const body = '\n  原始文本  "引号"  \n\n第二段\n$特殊#字符%\n';
    const out = renderRawNote(body, meta);
    expect(out.endsWith(body)).toBe(true);
    expect(parseNote(out).body).toBe(body);
  });

  it('T2.4-04 renderWikiNote 产物过 lint → 0 error（模板自身合规）', () => {
    const out = renderWikiNote(GOOD_FM, '这是合规前言。', '合规正文，没有外部事实词。');
    const issues = lintNote('wiki/idea-test.md', out);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});
