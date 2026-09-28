/**
 * 实体名形态过滤单测（工单 01）。
 *
 * 规则只做**形态判定**（句级标点 / 文件名令牌 / 长度兜底），不做语义判定。
 * 真实数据依据见 `docs/specs/ingest-noise-filter/spec.md`：
 * 长度与「是否噪声」不相关——20 字的 `Obsidian Web Clipper` 是真值，
 * 10 字的 `人的判断权不能交出去` 是噪声。故**不采用长度阈值**做主判据。
 */
import { describe, it, expect } from 'vitest';

import { extractEntities, isPlausibleEntityName, MAX_NAME_FILTER_WARNINGS } from '../../src/ingest/extract';
import { FakeGateway } from '../fakes/fake-gateway';

describe('工单 01：实体名形态过滤', () => {
  describe('应判否（形态上不可能是实体名）', () => {
    it('含句级标点（顿号/冒号）→ 判否', () => {
      // 真实噪声样本（首个 golden）
      expect(isPlausibleEntityName('向量检索、知识图谱与 LLM Wiki：RAG 被嘲笑了三年，但企业还是离不开它')).toBe(false);
      expect(isPlausibleEntityName('甲、乙')).toBe(false);
      expect(isPlausibleEntityName('标题：副标题')).toBe(false);
    });

    it('含问号/感叹号/分号 → 判否', () => {
      expect(isPlausibleEntityName('这是什么？')).toBe(false);
      expect(isPlausibleEntityName('太棒了！')).toBe(false);
      expect(isPlausibleEntityName('第一；第二')).toBe(false);
    });

    it('文件名令牌（含扩展名）→ 判否', () => {
      // 真实噪声样本（首个 golden）
      expect(isPlausibleEntityName('hot.md')).toBe(false);
      expect(isPlausibleEntityName('index.md')).toBe(false);
      expect(isPlausibleEntityName('notes.txt')).toBe(false);
      expect(isPlausibleEntityName('data.json')).toBe(false);
    });

    it('含路径分隔符 → 判否', () => {
      expect(isPlausibleEntityName('src/ingest')).toBe(false);
      expect(isPlausibleEntityName('wiki\\concepts')).toBe(false);
    });

    it('超长兜底（约 40 字以上）→ 判否', () => {
      expect(isPlausibleEntityName('一'.repeat(60))).toBe(false);
    });
  });

  describe('应放行（防误杀回归，同等重要）', () => {
    it('含空格的多词名词短语 → 放行', () => {
      // 真实真值样本：20 字，比上面某条噪声更长，但不能因长度误杀
      expect(isPlausibleEntityName('Obsidian Web Clipper')).toBe(true);
      expect(isPlausibleEntityName('Model Context Protocol')).toBe(true);
      expect(isPlausibleEntityName('LLM wiki')).toBe(true);
    });

    it('短缩写（形态像"代码令牌"但合法）→ 放行', () => {
      expect(isPlausibleEntityName('BM25')).toBe(true);
      expect(isPlausibleEntityName('MCP')).toBe(true);
      expect(isPlausibleEntityName('RAG')).toBe(true);
      expect(isPlausibleEntityName('Pi')).toBe(true);
    });

    it('含连字符的合法名 → 放行', () => {
      expect(isPlausibleEntityName('karpathy')).toBe(true);
      expect(isPlausibleEntityName('claude-obsidian')).toBe(true);
      expect(isPlausibleEntityName('autoresearch')).toBe(true);
    });

    it('中文短术语（含中文后缀"层"）→ 放行', () => {
      expect(isPlausibleEntityName('raw层')).toBe(true);
      expect(isPlausibleEntityName('wiki层')).toBe(true);
      expect(isPlausibleEntityName('渐进式披露')).toBe(true);
      expect(isPlausibleEntityName('增量编译')).toBe(true);
      expect(isPlausibleEntityName('健康检查')).toBe(true);
    });

    it('驼峰/多词英文 → 放行', () => {
      expect(isPlausibleEntityName('NotebookLM')).toBe(true);
      expect(isPlausibleEntityName('Agentic RAG')).toBe(true);
      expect(isPlausibleEntityName('Claude Code')).toBe(true);
      expect(isPlausibleEntityName('WorkBuddy')).toBe(true);
    });

    it('大写文件名式但无扩展名 → 放行（AGENTS.md 是特例，另见下）', () => {
      expect(isPlausibleEntityName('AGENTS')).toBe(true);
    });
  });

  describe('边界', () => {
    it('空串/纯空白 → 判否', () => {
      expect(isPlausibleEntityName('')).toBe(false);
      expect(isPlausibleEntityName('   ')).toBe(false);
    });

    it('句级标点仅出现在长度兜底边界内也判否（标点规则优先）', () => {
      expect(isPlausibleEntityName('短、句')).toBe(false);
    });
  });
});

describe('工单 02：过滤接入抽取路径 + 被拒可见', () => {
  const BODY = '这是一段测试正文。';

  it('单调用路径：形态不合法的提名不出现在结果里，且出现在告警里', async () => {
    const reply = JSON.stringify({
      entities: [
        { name: '正常实体', slug: 'ok', kind: 'concept', coverage: 'discussed' },
        { name: 'hot.md', slug: 'hot-md', kind: 'concept', coverage: 'named' },
        { name: '甲、乙', slug: 'jia-yi', kind: 'concept', coverage: 'named' },
      ],
      relations: [],
    });
    const gw = new FakeGateway({ replies: new Map([['实体抽取', reply]]) });
    const res = await extractEntities(BODY, 'u', gw);

    expect(res.entities.map((e) => e.name)).toEqual(['正常实体']);
    const warnings = res.warnings ?? [];
    expect(warnings.some((w) => w.includes('NAME_SHAPE_FILTERED') && w.includes('hot.md'))).toBe(true);
    expect(warnings.some((w) => w.includes('NAME_SHAPE_FILTERED') && w.includes('甲、乙'))).toBe(true);
  });

  it('告警有上限：超出只列前 N 条 + 一行计数', async () => {
    const many = Array.from({ length: MAX_NAME_FILTER_WARNINGS + 5 }, (_, i) => ({
      name: `x${i}.md`,
      slug: `x${i}`,
      kind: 'concept',
      coverage: 'named',
    }));
    const reply = JSON.stringify({ entities: many, relations: [] });
    const gw = new FakeGateway({ replies: new Map([['实体抽取', reply]]) });
    const res = await extractEntities(BODY, 'u', gw);

    expect(res.entities).toHaveLength(0);
    const warnings = res.warnings ?? [];
    const detail = warnings.filter((w) => w.includes('NAME_SHAPE_FILTERED') && w.includes('「'));
    expect(detail).toHaveLength(MAX_NAME_FILTER_WARNINGS);
    expect(warnings.some((w) => w.includes('另有 5 条'))).toBe(true);
  });

  it('无被拒项时不产生告警（不引入噪音）', async () => {
    const reply = JSON.stringify({
      entities: [{ name: '正常实体', slug: 'ok', kind: 'concept', coverage: 'discussed' }],
      relations: [],
    });
    const gw = new FakeGateway({ replies: new Map([['实体抽取', reply]]) });
    const res = await extractEntities(BODY, 'u', gw);
    expect(res.entities).toHaveLength(1);
    expect((res.warnings ?? []).some((w) => w.includes('NAME_SHAPE_FILTERED'))).toBe(false);
  });

  it('引用式（骨架）路径同样过滤', async () => {
    const reply = JSON.stringify({
      entities: [
        { name: '正常实体', slug: 'ok', kind: 'concept', coverage: 'discussed', oneLiner: 'x' },
        { name: 'index.md', slug: 'index-md', kind: 'concept', coverage: 'named', oneLiner: 'y' },
      ],
      relations: [],
    });
    const gw = new FakeGateway({ replies: new Map([['骨架', reply]]) });
    const res = await extractEntities(BODY, 'u', gw, { extractMode: 'cited' });

    expect(res.entities.map((e) => e.name)).toEqual(['正常实体']);
    expect((res.warnings ?? []).some((w) => w.includes('NAME_SHAPE_FILTERED') && w.includes('index.md'))).toBe(true);
  });
});

