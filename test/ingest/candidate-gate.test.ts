/**
 * F10.2 候选质量门单测（07 规划 D2/D4 细化，T10.1-*）。
 * 纯函数、零 IO：分类与三结果路由全部确定性。
 */
import { describe, it, expect } from 'vitest';

import {
  classifyCandidate,
  isHandLinked,
  gateCandidates,
  type EntityCandidate,
} from '../../src/ingest/candidate-gate';

const RAW = `
Model Context Protocol（MCP）是 Anthropic 提出的工具调用协议。
LangChain 是一个流行框架。它依赖 PostgreSQL 存状态。
备选组件：
- Redis
- Kafka
这是一个很长的列表项，讨论了 RabbitMQ 在金融级消息队列场景下的可靠性保障与顺序语义等深度内容。
`;

const WIKI = `---
type: project
---

## For future agent

正文提及 [[langchain]] 与 [[Model Context Protocol]]。
`;

function ent(partial: Partial<EntityCandidate> & { name: string }): EntityCandidate {
  return { slug: 'x', kind: 'concept', coverage: 'discussed', ...partial };
}

describe('F10.2 候选质量门', () => {
  it('T10.1-01 正文 prose + discussed → page', () => {
    expect(classifyCandidate(RAW, 'LangChain').location).toBe('prose');
    const g = gateCandidates(
      { entities: [ent({ name: 'LangChain', slug: 'langchain' })], relations: [] },
      RAW,
      WIKI,
    );
    expect(g.candidates[0]!.outcome).toBe('page');
  });

  it('T10.1-02 作者亲手 [[链接]] 的名字保活（coverage named 也建整页）', () => {
    expect(isHandLinked(WIKI, 'Model Context Protocol')).toBe(true);
    const g = gateCandidates(
      {
        entities: [ent({ name: 'Model Context Protocol', slug: 'mcp', coverage: 'named' })],
        relations: [],
      },
      RAW,
      WIKI,
    );
    expect(g.candidates[0]!.outcome).toBe('page');
  });

  it('T10.1-03 prose + named（两道门分歧）→ stub', () => {
    const g = gateCandidates(
      { entities: [ent({ name: 'PostgreSQL', slug: 'postgresql', coverage: 'named' })], relations: [] },
      RAW,
      WIKI,
    );
    expect(g.candidates[0]!.outcome).toBe('stub');
  });

  it('T10.1-04 括号内 aside + discussed → stub', () => {
    expect(classifyCandidate(RAW, 'MCP').location).toBe('aside');
    const g = gateCandidates(
      { entities: [ent({ name: 'MCP', slug: 'mcp-abbr' })], relations: [] },
      RAW,
      WIKI,
    );
    expect(g.candidates[0]!.outcome).toBe('stub');
  });

  it('T10.1-05 短列表项 aside + named → drop（两道门一致否决）', () => {
    expect(classifyCandidate(RAW, 'Redis').location).toBe('aside');
    const g = gateCandidates(
      { entities: [ent({ name: 'Redis', slug: 'redis', coverage: 'named' })], relations: [] },
      RAW,
      WIKI,
    );
    expect(g.candidates[0]!.outcome).toBe('drop');
  });

  it('T10.1-06 长列表项不算 aside：prose + discussed → page', () => {
    expect(classifyCandidate(RAW, 'RabbitMQ').location).toBe('prose');
  });

  it('T10.1-07 absent（raw 无此名，防幻觉）→ drop', () => {
    expect(classifyCandidate(RAW, '不存在的实体').location).toBe('absent');
    const g = gateCandidates(
      { entities: [ent({ name: '不存在的实体', slug: 'ghost' })], relations: [] },
      RAW,
      WIKI,
    );
    expect(g.candidates[0]!.outcome).toBe('drop');
  });

  it('T10.1-08 alias 命中正文时按 alias 分类', () => {
    expect(classifyCandidate(RAW, 'PG', ['PostgreSQL']).location).toBe('prose');
  });

  it('T10.1-09 slug 非法（路径逃逸/反斜杠/空）→ drop', () => {
    const g = gateCandidates(
      {
        entities: [
          ent({ name: 'LangChain', slug: '../escape' }),
          ent({ name: 'PostgreSQL', slug: 'a\\b' }),
          ent({ name: 'Redis', slug: '' }),
        ],
        relations: [],
      },
      RAW,
      WIKI,
    );
    expect(g.candidates.every((c) => c.outcome === 'drop')).toBe(true);
  });

  it('T10.1-10 同 slug 去重：保留首个，后续丢弃', () => {
    const g = gateCandidates(
      {
        entities: [
          ent({ name: 'LangChain', slug: 'langchain' }),
          ent({ name: 'LangChain 框架', slug: 'langchain', coverage: 'named' }),
        ],
        relations: [],
      },
      RAW,
      WIKI,
    );
    expect(g.candidates).toHaveLength(2);
    expect(g.candidates[0]!.outcome).toBe('page');
    expect(g.candidates[1]!.outcome).toBe('drop');
  });

  it('T10.1-11 引用被 drop 实体的边被剪除（门绝不制造死链）', () => {
    const g = gateCandidates(
      {
        entities: [
          ent({ name: 'LangChain', slug: 'langchain' }),
          ent({ name: '不存在的实体', slug: 'ghost' }),
        ],
        relations: [
          { from: 'langchain', type: 'depends_on', to: 'ghost' },
          { from: 'langchain', type: 'relates_to', to: 'postgresql' }, // postgresql 未提名 → 剪
        ],
      },
      RAW,
      WIKI,
    );
    expect(g.edges).toHaveLength(0);
  });

  it('T10.1-12 存活端点的合法边保留；自环与非法类型边被过滤', () => {
    const g = gateCandidates(
      {
        entities: [ent({ name: 'LangChain', slug: 'langchain' }), ent({ name: 'PostgreSQL', slug: 'postgresql' })],
        relations: [
          { from: 'langchain', type: 'depends_on', to: 'postgresql' },
          { from: 'langchain', type: 'relates_to', to: 'langchain' }, // 自环
          { from: 'langchain', type: 'loves', to: 'postgresql' }, // 非法类型
        ],
      },
      RAW,
      WIKI,
    );
    expect(g.edges).toEqual([{ from: 'langchain', type: 'depends_on', to: 'postgresql' }]);
  });

  it('T10.1-13 kind 非法容错为 concept；coverage 非法保守降为 named', () => {
    const g = gateCandidates(
      {
        entities: [
          ent({ name: 'PostgreSQL', slug: 'postgresql', kind: 'alien' as never, coverage: 'maybe' as never }),
        ],
        relations: [],
      },
      RAW,
      WIKI,
    );
    expect(g.candidates[0]!.candidate.kind).toBe('concept');
    expect(g.candidates[0]!.outcome).toBe('stub'); // named + prose
  });
});
