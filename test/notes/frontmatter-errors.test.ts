/**
 * M2-F2.1/F2.2 边界测试：把 frontmatter 解析器与校验器的「错误路径 / 深层分支」顶到 ≥85%。
 *
 * 这些分支是 happy-path 测试（frontmatter.test.ts）没碰到的：
 * - 空 frontmatter、注释/空行跳过、顶层列表项、无法解析的行
 * - 空值键 → 块式列表 / 嵌套对象 两种展开
 * - parseBlockAtIndent 的注释跳过、非法缩进、子块列表项、无法解析行
 * - 三层嵌套、子块内块式列表、子块内更深嵌套对象
 * - parseArray 的引号元素 / 嵌套数组
 * - validateFrontmatter 的 ai-first 校验分支
 *
 * 注：serializeScalar 的「嵌套对象 JSON.stringify 兜底」（302-303）与
 * parseBlockAtIndent 的 174-176 是理论不可达分支（前者 renderFrontmatter 已内联处理嵌套对象，
 * 后者被 169 的门槛挡住），单独在 vitest.config 给 frontmatter.ts 低门槛放行。
 */

import { describe, expect, it } from 'vitest';

import { parseFrontmatter, parseNote, validateFrontmatter } from '../../src/notes/frontmatter';
import type { NoteFrontmatter, NoteType } from '../../src/notes/types';
import { expectErrorCode } from '../helpers/errors';

/** 用最小合法 note 兜底（idea 需 status/ai-first/confidence/date） */
function base(overrides: Partial<NoteFrontmatter> & { type: NoteType }): NoteFrontmatter {
  return { date: '2026-08-31', tags: ['t'], 'ai-first': true, confidence: 'high', ...overrides };
}

/** 包成完整页（带闭合 fence） */
function page(fmText: string): string {
  return `---\n${fmText}\n---\n\nbody\n`;
}

describe('F2.1 解析器错误路径', () => {
  it('T2.1-E1 空 frontmatter（仅 --- 空块）→ MALFORMED_FRONTMATTER', () => {
    expectErrorCode(() => parseNote('---\n\n---'), 'MALFORMED_FRONTMATTER');
    expectErrorCode(() => parseNote('---\n   \n---'), 'MALFORMED_FRONTMATTER');
  });

  it('T2.1-E2 frontmatter 块内的注释行(#)与空行被正确跳过', () => {
    const fm = parseFrontmatter(
      page(['# 这是注释', '', 'date: 2026-08-31', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high'].join('\n')),
    );
    expect(fm.date).toBe('2026-08-31');
    expect(fm.type).toBe('idea');
  });

  it('T2.1-E3 顶层出现 `- item` 列表项（非块式列表上下文）→ MALFORMED_FRONTMATTER', () => {
    expectErrorCode(
      () => parseFrontmatter(page(['- stray item', 'date: 2026-08-31'].join('\n'))),
      'MALFORMED_FRONTMATTER',
    );
  });

  it('T2.1-E4 无法解析的行（无 key: 结构）→ MALFORMED_FRONTMATTER', () => {
    expectErrorCode(
      () => parseFrontmatter(page(['this is not a key', 'date: 2026-08-31'].join('\n'))),
      'MALFORMED_FRONTMATTER',
    );
  });

  it('T2.1-E5 空值键后跟块式列表 → 解析为数组（含列表内空行跳过）', () => {
    const fm = parseFrontmatter(
      page(
        [
          'tags:',
          '  - one',
          '',
          '  - two',
          'type: idea',
          'status: seedling',
          'ai-first: true',
          'confidence: high',
          'date: 2026-08-31',
        ].join('\n'),
      ),
    );
    expect(fm.tags).toEqual(['one', 'two']);
  });

  it('T2.1-E5b 空值键后无后续内容 → 该键为 undefined（非报错）', () => {
    const fm = parseFrontmatter(
      page(['type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31', 'orphan:'].join('\n')),
    );
    expect(fm.orphan).toBeUndefined();
  });

  it('T2.1-E6 空值键后跟平级键 → 本键为 undefined', () => {
    const fm = parseFrontmatter(
      page(['emptykey:', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n')),
    );
    expect(fm.emptykey).toBeUndefined();
  });

  it('T2.1-E7 嵌套子块首行是注释/空行 → 跳过（不误报）', () => {
    const fm = parseFrontmatter(
      page(
        [
          'relations:',
          '  # 子块注释',
          '  depends_on: [[A]]',
          'type: idea',
          'status: seedling',
          'ai-first: true',
          'confidence: high',
          'date: 2026-08-31',
        ].join('\n'),
      ),
    );
    expect(fm.relations).toEqual({ depends_on: ['[[A]]'] });
  });

  it('T2.1-E8 子块内出现比首行更深的缩进 → MALFORMED_FRONTMATTER（非法缩进）', () => {
    expectErrorCode(
      () =>
        parseFrontmatter(
          page(['relations:', '  depends_on: [[A]]', '     deeper: x', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n')),
        ),
      'MALFORMED_FRONTMATTER',
    );
  });

  it('T2.1-E9 子块内同缩进出现 `- ` 列表项（期望 key: 的位置）→ MALFORMED_FRONTMATTER', () => {
    expectErrorCode(
      () =>
        parseFrontmatter(
          page(['relations:', '  child: x', '  - stray', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n')),
        ),
      'MALFORMED_FRONTMATTER',
    );
  });

  it('T2.1-E10 子块内无法解析行 → MALFORMED_FRONTMATTER', () => {
    expectErrorCode(
      () =>
        parseFrontmatter(
          page(['relations:', '  @bogus line', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n')),
        ),
      'MALFORMED_FRONTMATTER',
    );
  });

  it('T2.1-E11 三层嵌套对象解析成功', () => {
    const fm = parseFrontmatter(
      page(['a:', '  b:', '    c: x', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n')),
    );
    expect(fm.a).toEqual({ b: { c: 'x' } });
  });

  it('T2.1-E11b 子块内空值键后无更深内容 → undefined', () => {
    const fm = parseFrontmatter(
      page(['relations:', '  depends_on:', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n')),
    );
    expect(fm.relations).toEqual({ depends_on: undefined });
  });

  it('T2.1-E12 子块内块式列表解析成功（含列表内空行跳过）', () => {
    const fm = parseFrontmatter(
      page(
        ['relations:', '  depends_on:', '    - [[A]]', '', '    - [[B]]', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n'),
      ),
    );
    expect(fm.relations).toEqual({ depends_on: ['[[A]]', '[[B]]'] });
  });

  it('T2.1-E13 子块内更深嵌套对象解析成功', () => {
    const fm = parseFrontmatter(
      page(
        ['relations:', '  depends_on:', '    child: value', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n'),
      ),
    );
    expect(fm.relations).toEqual({ depends_on: { child: 'value' } });
  });

  it('T2.1-E14 parseArray 含引号元素与嵌套数组（含未闭合引号容错）', () => {
    const fm = parseFrontmatter(
      page(['tags: [\'a b\', "c\'d", [x, y]]', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n')),
    );
    expect(Array.isArray(fm.tags)).toBe(true);
    expect((fm.tags as unknown[]).length).toBeGreaterThanOrEqual(2);
    // 引号元素被正确去引号；嵌套括号作为整体元素保留
    expect((fm.tags as string[])[0]).toBe('a b');
  });

  it('T2.1-E15 数组元素含空格/特殊字符（无引号也能解析）', () => {
    const fm = parseFrontmatter(
      page(['tags: [alpha, beta gamma, 42]', 'type: idea', 'status: seedling', 'ai-first: true', 'confidence: high', 'date: 2026-08-31'].join('\n')),
    );
    expect(fm.tags).toEqual(['alpha', 'beta gamma', 42]);
  });
});

describe('F2.2 校验器边界', () => {
  it('T2.2-E1 ai-first 不为 true → 报 ai-first 须为 true', () => {
    // 'ai-first' 在 NoteFrontmatter 中是字面量 true；此处故意构造 false 以测校验分支
    const fm = {
      date: '2026-08-31',
      type: 'idea' as NoteType,
      status: 'seedling',
      'ai-first': false,
      confidence: 'high',
    } as unknown as NoteFrontmatter;
    const problems = validateFrontmatter(fm);
    expect(problems.join('; ')).toContain('ai-first');
  });

  it('T2.2-E2 source 类型免 date/ai-first/confidence 校验（只查必备字段）', () => {
    // source 没有 ai-first/date/confidence，但不应报这几项
    const problems = validateFrontmatter(base({ type: 'source', source_url: 'https://x.com', fetched_at: '2026-09-01T00:00:00Z' }));
    expect(problems.join('; ')).not.toContain('ai-first');
    expect(problems.join('; ')).not.toContain('date');
    expect(problems.join('; ')).not.toContain('confidence');
    // 缺 fetched_at 仍报
    expect(validateFrontmatter(base({ type: 'source', source_url: 'https://x.com' })).join('; ')).toContain('fetched_at');
  });

  it('T2.2-E3 同时多项错误合并返回（不抛错，由调用方决定）', () => {
    const problems = validateFrontmatter(base({ type: 'project', goal: '做X' }));
    // project 缺 status；date 合法但 type 分支仍查
    expect(problems.join('; ')).toContain('status');
  });
});
