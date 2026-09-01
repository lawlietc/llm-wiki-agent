/**
 * M2-F2.3 lint 规则集（02 §6 修正版正则）
 *
 * T2.3-01~09：error 级（no-date-today/preamble/ai-first-flag/confidence）；
 * warn 级（recency/sources/no-curly-quotes/wikilinks）；
 * 中文正文豁免与 markdown 链接不误判两条回归。
 */

import { describe, expect, it } from 'vitest';

import { lintNote, type LintIssue } from '../../src/notes/lint';
import { renderFrontmatter } from '../../src/notes/frontmatter';
import type { NoteType } from '../../src/notes/types';

function byRule(issues: LintIssue[], rule: string): LintIssue[] {
  return issues.filter((i) => i.rule === rule);
}

/** 构造测试页：默认合规（0 issue 的基线），可覆盖 frontmatter 与正文 */
function page(overrides: Record<string, unknown> = {}, body?: string): string {
  const fm = {
    date: '2026-08-31',
    type: 'idea' as NoteType,
    tags: ['t'],
    'ai-first': true,
    confidence: 'high',
    status: 'seedling',
    ...overrides,
  };
  const defaultBody = '## For future agent\n\n这是合规前言。\n\n## 正文\n\n合规正文。';
  return `---\n${renderFrontmatter(fm as never)}\n---\n\n${body ?? defaultBody}`;
}

describe('F2.3 lint 规则集', () => {
  it('T2.3-01 no-date-today：date: today → error；date: 2026-08-31 → 通过', () => {
    const bad = byRule(lintNote('wiki/a.md', page({ date: 'today' })), 'no-date-today');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe('error');

    expect(byRule(lintNote('wiki/a.md', page()), 'no-date-today')).toHaveLength(0);
  });

  it('T2.3-02 preamble：缺 ## For future agent → error', () => {
    const issues = lintNote('wiki/a.md', page({}, '没有前言的正文'));
    const bad = byRule(issues, 'preamble');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe('error');
  });

  it('T2.3-03 ai-first-flag：ai-first 非 true → error', () => {
    const issues = lintNote('wiki/a.md', page({ 'ai-first': false }));
    const bad = byRule(issues, 'ai-first-flag');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe('error');
  });

  it('T2.3-04 confidence：缺失 → error', () => {
    const issues = lintNote('wiki/a.md', page({ confidence: undefined }));
    const bad = byRule(issues, 'confidence');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe('error');
  });

  it('T2.3-05 recency：疑似外部事实（(as of）无 as_of → warn，不 error', () => {
    // 02 §6 正则用半角 (as of（全角括号不匹配）；正文保留前言避免污染断言
    const issues = lintNote(
      'wiki/a.md',
      page({}, '## For future agent\n\n前言。\n\n## 正文\n\n这条结论 (as of 2026-08 的报道) 不再更新。'),
    );
    const bad = byRule(issues, 'recency');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe('warn');
    // 不 error
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('T2.3-05b 有 as_of 的外部事实不再报 recency', () => {
    const issues = lintNote(
      'wiki/a.md',
      page({ as_of: '2026-08' }, '该公司（据报道）融资 1 亿。'),
    );
    expect(byRule(issues, 'recency')).toHaveLength(0);
  });

  it('T2.3-06 sources：疑似外部事实缺 sources → warn', () => {
    const issues = lintNote('wiki/a.md', page({ as_of: '2026-08' }, '据报道，该产品发布了新版本。'));
    const bad = byRule(issues, 'sources');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe('warn');
  });

  it('T2.3-06b 带 sources 不再报 sources', () => {
    const issues = lintNote(
      'wiki/a.md',
      page({ as_of: '2026-08', sources: ['https://x.com/news'] }, '据报道，该产品发布了新版本。'),
    );
    expect(byRule(issues, 'sources')).toHaveLength(0);
  });

  it('T2.3-07 no-curly-quotes：中文正文弯引号 → 不报（I4 回归）', () => {
    const issues = lintNote('wiki/a.md', page({}, '他说“你好”——这是强调。'));
    expect(byRule(issues, 'no-curly-quotes')).toHaveLength(0);
  });

  it('T2.3-07b 英文语境弯引号紧邻 ASCII → warn', () => {
    const issues = lintNote('wiki/a.md', page({}, 'He said "don’t worry" about it.'));
    const bad = byRule(issues, 'no-curly-quotes');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe('warn');
  });

  it('T2.3-07c em-dash 紧邻 ASCII → warn；中文语境 em-dash → 不报', () => {
    // 规则要求紧邻 \w：'great—really'（无空格）才触发；'great — really' 两侧是空格不触发
    expect(byRule(lintNote('wiki/a.md', page({}, 'It was great—really.')), 'no-curly-quotes')).toHaveLength(1);
    expect(byRule(lintNote('wiki/a.md', page({}, '结果很好——真的。')), 'no-curly-quotes')).toHaveLength(0);
  });

  it('T2.3-08 wikilinks：≥2 处大写实体且全文无 [[ → warn', () => {
    const issues = lintNote('wiki/a.md', page({}, 'Alpha 与 Beta 都是重要的概念。'));
    const bad = byRule(issues, 'wikilinks');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe('warn');
  });

  it('T2.3-08b 实体正则不误判 markdown 链接 [Title](url)（P1-2 修正回归）', () => {
    // 单链接：Title 命中 1 处 < 2，不触发 wikilinks（原稿 `[[A-Z]...` 会把 '[Title' 整体误判为实体）
    const issues = lintNote('wiki/a.md', page({}, '[Title](https://example.com) 这是说明。'));
    expect(byRule(issues, 'wikilinks')).toHaveLength(0);
  });

  it('T2.3-08c 已有 [[wikilink]] 时不报 wikilinks', () => {
    const issues = lintNote('wiki/a.md', page({}, '参见 [[Alpha]] 与 Beta。'));
    expect(byRule(issues, 'wikilinks')).toHaveLength(0);
  });

  it('T2.3-09 合规 fixture → 0 issue', () => {
    expect(lintNote('wiki/a.md', page())).toHaveLength(0);
  });
});
