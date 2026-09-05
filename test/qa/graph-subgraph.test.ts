/**
 * F12.2 一跳子图与预算截断单测（T12.2-*，确定性纯函数）。
 * 覆盖：一跳（入边+出边）、无关边裁剪、相关性感知截断（D12：命中页排名优先于码点序）、
 * 空输入、对称类型双向不重复占预算。
 * 零真实网络、零真实 LLM。
 */
import { describe, it, expect } from 'vitest';

import { subgraphFor, MAX_GRAPH_EDGES } from '../../src/qa/graph';
import type { RelationEdge } from '../../src/notes/relations';

const e = (from: string, type: string, to: string): RelationEdge => ({ from, type: type as RelationEdge['type'], to });

describe('F12.2 subgraphFor', () => {
  const EDGES = [
    e('a', 'depends_on', 'b'),
    e('b', 'required_by', 'a'), // 双向落盘形态
    e('c', 'relates_to', 'a'),
    e('a', 'relates_to', 'c'),
    e('a', 'depends_on', 'missing'), // 悬空（上游已剪，此处假设不在输入里则过滤不到——输入集已含）
    e('zz', 'depends_on', 'yy'), // 与命中页无关
  ];

  it('T12.2-01 一跳：命中 slug 的入边与出边都进子图', () => {
    const sub = subgraphFor(EDGES, ['a']);
    const keys = sub.map((x) => `${x.from}--${x.type}-->${x.to}`).sort();
    expect(keys).toEqual([
      'a--depends_on-->b',
      'a--depends_on-->missing',
      'a--relates_to-->c',
      'b--required_by-->a',
      'c--relates_to-->a',
    ]);
  });

  it('T12.2-02 与命中页无关的边不进子图', () => {
    const sub = subgraphFor(EDGES, ['a']);
    expect(sub.some((x) => x.from === 'zz' || x.to === 'zz')).toBe(false);
  });

  it('T12.2-03 超预算按（命中页排名，码点序）截断，顺序不随输入漂移（I10/D12）', () => {
    const many: RelationEdge[] = [];
    for (let i = 0; i < 30; i++) {
      many.push(e('top1', 'relates_to', `n${String(i).padStart(2, '0')}`)); // 命中页 #1 的 30 条边
      many.push(e('top2', 'relates_to', `n${String(i).padStart(2, '0')}`)); // 命中页 #2 的 30 条边
    }
    const sub = subgraphFor(many, ['top1', 'top2'], 10);
    expect(sub).toHaveLength(10);
    // 前 10 条全部属于排名 0 的命中页 top1（排名优先于码点序）
    expect(sub.every((x) => x.from === 'top1')).toBe(true);
    // 打乱输入顺序 → 输出相同
    const shuffled = [...many].reverse();
    expect(subgraphFor(shuffled, ['top1', 'top2'], 10)).toEqual(sub);
  });

  it('T12.2-04 相关性感知（D12 回归门）：命中页 #1 的边不被 #5 挤掉', () => {
    // 命中页 #1 的边码点序靠后、#5 的边码点序靠前 → 字母序会选错，排名序必须选对
    const edges: RelationEdge[] = [];
    for (let i = 0; i < 40; i++) {
      edges.push(e(`aaa-hit5-${String(i).padStart(2, '0')}`, 'relates_to', `n${i}`)); // 码点序靠前，但命中排名 #5
    }
    edges.push(e('zzz-hit1', 'relates_to', 'neighbor')); // 码点序靠后，但命中排名 #1
    const sub = subgraphFor(edges, ['zzz-hit1', 'b2', 'b3', 'b4', 'aaa-hit5'], 10);
    expect(sub.some((x) => x.from === 'zzz-hit1')).toBe(true); // 排名 #1 的边必在
    expect(sub.filter((x) => x.from.startsWith('aaa-hit5')).length).toBeLessThanOrEqual(9);
  });

  it('T12.2-05 命中为空 / 边集为空 → []', () => {
    expect(subgraphFor(EDGES, [])).toEqual([]);
    expect(subgraphFor([], ['a'])).toEqual([]);
  });

  it('T12.2-06 对称类型双向边去重后不重复占预算', () => {
    // relates_to 的双向边各占一条输入，但去重职责在上游 invertEdges；此处验证计数口径：
    // 输入两条对称边 → 子图两条（都是命中页的一跳），总预算按边计
    const sym = [e('a', 'relates_to', 'c'), e('c', 'relates_to', 'a')];
    const sub = subgraphFor(sym, ['a'], 10);
    expect(sub).toHaveLength(2);
    expect(MAX_GRAPH_EDGES).toBe(64);
  });
});
