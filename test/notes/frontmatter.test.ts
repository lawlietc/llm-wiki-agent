/**
 * M2-F2.1 frontmatter 解析/渲染 + F2.2 note type 注册表
 *
 * T2.1-01~04：完整 frontmatter 解析（含 relations 嵌套 wikilinks 数组）、损坏 fence 明确报错、
 * render→parse round-trip 无损、date 格式校验（validate 层）。
 * T2.2-01~04：9 类型参数化可解析、未知 type 拒、类型必备字段、confidence 取值域。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../src/errors';
import { assertValidFrontmatter, parseFrontmatter, parseNote, renderFrontmatter, validateFrontmatter } from '../../src/notes/frontmatter';
import type { NoteFrontmatter, NoteType } from '../../src/notes/types';
import { expectErrorCode } from '../helpers/errors';

function fm(overrides: Partial<NoteFrontmatter> & { type: NoteType }): NoteFrontmatter {
  return { date: '2026-08-31', tags: ['test'], 'ai-first': true, confidence: 'high', ...overrides };
}

/** 完整页：frontmatter（含 relations）+ 前言 + 正文 */
const COMPLETE_PAGE = `---
date: 2026-08-29
type: project
tags: [llm, wiki, agent]
ai-first: true
confidence: high
as_of: 2026-08
sources:
  - https://example.com/some-fact
relations:
  depends_on: [[01-存储层与文件安全]]
  supersedes: []
---

## For future agent

这是「LLM Wiki Agent」项目的存储层设计页。

## 正文

存储层用事务化原子替换。`;

const COMPLETE_FM: NoteFrontmatter = {
  date: '2026-08-29',
  type: 'project',
  tags: ['llm', 'wiki', 'agent'],
  'ai-first': true,
  confidence: 'high',
  as_of: '2026-08',
  sources: ['https://example.com/some-fact'],
  relations: { depends_on: ['[[01-存储层与文件安全]]'], supersedes: [] },
};

describe('F2.1 frontmatter 解析/渲染', () => {
  it('T2.1-01 完整 frontmatter（含 relations 嵌套 wikilinks 数组）解析成功，正文分离', () => {
    const parsed = parseNote(COMPLETE_PAGE);
    expect(parsed.frontmatter).toEqual(COMPLETE_FM);
    expect(parsed.body).toContain('## For future agent');
    expect(parsed.body).toContain('存储层用事务化原子替换');
    // 正文不含 frontmatter 残留
    expect(parsed.body).not.toContain('confidence: high');
  });

  it('T2.1-01b 流式数组与块式列表等价（tags 流式 / sources 块式都解析成数组）', () => {
    const fm1 = parseFrontmatter(COMPLETE_PAGE);
    expect(fm1.tags).toEqual(['llm', 'wiki', 'agent']);
    expect(fm1.sources).toEqual(['https://example.com/some-fact']);
    expect(fm1.relations).toEqual({ depends_on: ['[[01-存储层与文件安全]]'], supersedes: [] });
  });

  it('T2.1-02 无 frontmatter → 明确错误（不静默空对象）', () => {
    expect(() => parseFrontmatter('## 纯正文\n没有 frontmatter')).toThrow(ValidationError);
    try {
      parseFrontmatter('## 纯正文');
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as ValidationError).code).toBe('MALFORMED_FRONTMATTER');
    }
  });

  it('T2.1-02b 损坏 fence（开不闭）→ 明确错误', () => {
    expectErrorCode(() => parseFrontmatter('---\ndate: 2026-08-31\ntype: idea\n正文没有闭合'), 'MALFORMED_FRONTMATTER');
    // 首行不是 --- 也不算 frontmatter
    expectErrorCode(() => parseFrontmatter('正文开头\ntype: idea'), 'MALFORMED_FRONTMATTER');
  });

  it('T2.1-03 render → parse round-trip 无损（3 组属性化 fixture）', () => {
    const fixtures: NoteFrontmatter[] = [
      fm({ type: 'idea', tags: ['a', 'b'], confidence: 'medium' }),
      fm({
        type: 'task',
        status: 'todo',
        as_of: '2026-08',
        sources: ['https://a.com/x', 'https://b.com/y'],
      }),
      fm({
        type: 'adr',
        status: 'accepted',
        context: '背景',
        decision: '采用 X',
        consequences: ['更快', '更复杂'],
        relations: {
          depends_on: ['[[00-总览与接口契约]]'],
          supersedes: ['[[旧决策]]'],
          contradicts: [],
        },
      }),
    ];
    for (const f of fixtures) {
      const rendered = renderFrontmatter(f);
      // renderFrontmatter 只产出不含围栏的块，round-trip 需组装完整页面
      expect(parseFrontmatter(`---\n${rendered}\n---`)).toEqual(f);
    }
  });

  it('T2.1-04 date 非 YYYY-MM-DD → validate 层明确报错（INVALID_FRONTMATTER）', () => {
    const bad = fm({ type: 'idea', date: '2026/08/31' });
    expect(validateFrontmatter(bad).join('; ')).toContain('YYYY-MM-DD');
    expect(() => assertValidFrontmatter(bad)).toThrow(ValidationError);
    try {
      assertValidFrontmatter(bad);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as ValidationError).code).toBe('INVALID_FRONTMATTER');
    }
    // 合法日期放行（idea 需带必备字段 status）
    expect(validateFrontmatter(fm({ type: 'idea', status: 'seedling' }))).toHaveLength(0);
  });

  it('T2.1-05 引号/特殊字符值 round-trip（wikilink 双括号、冒号、井号）', () => {
    const f = fm({
      type: 'idea',
      status: 'seedling',
      sources: ['https://x.com/a#frag', "it's fine"],
      relations: { depends_on: ['[[A:B]]'] },
    });
    expect(parseFrontmatter(`---\n${renderFrontmatter(f)}\n---`)).toEqual(f);
  });
});

describe('F2.2 note type 注册表', () => {
  it('T2.2-01 9 个类型全部可解析且校验通过（参数化）', () => {
    const minimal: Array<{ type: NoteType; extra: Partial<NoteFrontmatter> }> = [
      { type: 'source', extra: { source_url: 'https://x.com', fetched_at: '2026-09-01T00:00:00Z' } },
      { type: 'project', extra: { status: 'active', goal: '做知识整理' } },
      { type: 'person', extra: { role: '作者', affiliation: '某司' } },
      { type: 'idea', extra: { status: 'seedling' } },
      { type: 'task', extra: { status: 'todo' } },
      { type: 'adr', extra: { status: 'accepted', context: '背景', decision: '决定', consequences: ['影响'] } },
      { type: 'daily', extra: {} },
      { type: 'review', extra: { period: '2026-08' } },
      { type: 'meeting', extra: { attendees: ['甲', '乙'] } },
    ];
    for (const { type, extra } of minimal) {
      const f = fm({ type, ...extra }) as NoteFrontmatter;
      expect(() => assertValidFrontmatter(f)).not.toThrow();
    }
  });

  it('T2.2-02 未知 type → ValidationError', () => {
    const bad = fm({ type: 'unknown' as never });
    expect(() => assertValidFrontmatter(bad)).toThrow(ValidationError);
    try {
      assertValidFrontmatter(bad);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as ValidationError).code).toBe('INVALID_FRONTMATTER');
      expect((err as ValidationError).message).toContain('unknown');
    }
  });

  it('T2.2-03 类型必备字段校验：project/adr/source 缺字段 → 报缺字段', () => {
    // 注意：validateFrontmatter 返回问题数组，toContain 是元素匹配；子串断言用 join
    expect(validateFrontmatter(fm({ type: 'project', status: 'active' })).join('; ')).toContain('goal');
    expect(validateFrontmatter(fm({ type: 'project', goal: 'x' })).join('; ')).toContain('status');

    const badAdr = fm({ type: 'adr', status: 'accepted', context: 'c' });
    const adrProblems = validateFrontmatter(badAdr);
    expect(adrProblems.join('; ')).toContain('decision');
    expect(adrProblems.join('; ')).toContain('consequences');

    const badSource = fm({ type: 'source', source_url: 'https://x.com' });
    expect(validateFrontmatter(badSource).join('; ')).toContain('fetched_at');
    expect(validateFrontmatter(fm({ type: 'source', fetched_at: '2026-09-01' })).join('; ')).toContain('source_url');
  });

  it('T2.2-03b 满足必备字段后不再报缺', () => {
    expect(
      validateFrontmatter(
        fm({ type: 'adr', status: 'accepted', context: 'c', decision: 'd', consequences: ['c1'] }),
      ),
    ).toHaveLength(0);
  });

  it('T2.2-04 confidence 取值域校验（stated/high/medium/speculation）', () => {
    for (const ok of ['stated', 'high', 'medium', 'speculation'] as const) {
      expect(validateFrontmatter(fm({ type: 'idea', status: 'seedling', confidence: ok }))).toHaveLength(0);
    }
    const bad = fm({ type: 'idea', status: 'seedling', confidence: 'guess' as never });
    expect(validateFrontmatter(bad).join('; ')).toContain('confidence');
    expectErrorCode(() => assertValidFrontmatter(bad), 'INVALID_FRONTMATTER');
  });
});
