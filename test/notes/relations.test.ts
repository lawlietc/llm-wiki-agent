/**
 * F10.1 relations inverse 表单测（07 规划 D3，T10.0-*）。
 */
import { describe, it, expect } from 'vitest';

import {
  RELATION_INVERSE,
  isRelationType,
  inverseOf,
  isSymmetric,
  invertEdges,
  groupRelationsBySlug,
  mergeRelationMaps,
} from '../../src/notes/relations';

describe('F10.1 relations inverse 表', () => {
  it('T10.0-01 inverse 表与 obsidian-second-brain 约定逐项一致', () => {
    expect(RELATION_INVERSE['supersedes']).toBe('superseded_by');
    expect(RELATION_INVERSE['superseded_by']).toBe('supersedes');
    expect(RELATION_INVERSE['depends_on']).toBe('required_by');
    expect(RELATION_INVERSE['required_by']).toBe('depends_on');
    expect(RELATION_INVERSE['caused']).toBe('caused_by');
    expect(RELATION_INVERSE['caused_by']).toBe('caused');
    expect(RELATION_INVERSE['decided_by']).toBe('decides');
    expect(RELATION_INVERSE['decides']).toBe('decided_by');
  });

  it('T10.0-02 对称类型 relates_to/contradicts 的 inverse 为自身', () => {
    expect(isSymmetric('relates_to')).toBe(true);
    expect(isSymmetric('contradicts')).toBe(true);
    expect(isSymmetric('supersedes')).toBe(false);
    expect(inverseOf('relates_to')).toBe('relates_to');
  });

  it('T10.0-03 非法类型被 isRelationType 拒绝', () => {
    expect(isRelationType('supersedes')).toBe(true);
    expect(isRelationType('loves')).toBe(false);
    expect(isRelationType('')).toBe(false);
    expect(isRelationType('__proto__')).toBe(false);
  });

  it('T10.0-04 invertEdges 补全反向边且幂等去重', () => {
    const edges = [
      { from: 'a', type: 'supersedes' as const, to: 'b' },
      { from: 'b', type: 'superseded_by' as const, to: 'a' }, // 已有反向边，不重复补
      { from: 'a', type: 'relates_to' as const, to: 'c' },
    ];
    const once = invertEdges(edges);
    expect(once).toContainEqual({ from: 'a', type: 'supersedes', to: 'b' });
    expect(once).toContainEqual({ from: 'b', type: 'superseded_by', to: 'a' });
    expect(once).toContainEqual({ from: 'a', type: 'relates_to', to: 'c' });
    expect(once).toContainEqual({ from: 'c', type: 'relates_to', to: 'a' });
    expect(once.filter((e) => e.type === 'relates_to' && e.from === 'a')).toHaveLength(1);

    const twice = invertEdges(once);
    expect(twice).toEqual(once); // 幂等
  });

  it('T10.0-05 groupRelationsBySlug 按声明页分组，值为 [[wikilink]] 约定形', () => {
    const grouped = groupRelationsBySlug([{ from: 'a', type: 'depends_on', to: 'b' }]);
    expect(grouped.get('a')?.get('depends_on')).toEqual(['[[b]]']);
    expect(grouped.get('b')?.get('required_by')).toEqual(['[[a]]']);
    expect(grouped.get('c')).toBeUndefined();
  });

  it('T10.0-06 mergeRelationMaps 保留旧边并去重合入新边', () => {
    const merged = mergeRelationMaps(
      { supersedes: ['[[old]]'], junk: ['not-a-link'] },
      new Map([
        ['supersedes', ['[[old]]', '[[new]]']],
        ['relates_to', ['[[x]]']],
      ]),
    );
    expect(merged.get('supersedes')).toEqual(['[[old]]', '[[new]]']);
    expect(merged.get('relates_to')).toEqual(['[[x]]']);
    expect(merged.has('junk')).toBe(false);
  });

  it('T10.0-07 无 existing 时 mergeRelationMaps 只含新边', () => {
    const merged = mergeRelationMaps(undefined, new Map([['decides', ['[[d1]]']]]));
    expect(merged.get('decides')).toEqual(['[[d1]]']);
  });
});
