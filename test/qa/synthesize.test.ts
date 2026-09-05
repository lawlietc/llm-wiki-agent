/**
 * F5.4 综合层 synthesize（06 §2）。
 * T5.4-01~06。经 FakeGateway 注入回稿，零真实 LLM。
 */
import { describe, it, expect } from 'vitest';
import { buildThinkSystemPrompt, buildThinkUserMessage, synthesize, extractJson, THINK_HARD_RULES } from '../../src/qa/synthesize';
import { FakeGateway } from '../../test/fakes/fake-gateway';
import { ValidationError } from '../../src/errors';
import type { RetrievalContext } from '../../src/qa/synthesize';

const ctx: RetrievalContext = {
  pages: [{ slug: 'vector-db', body: '向量数据库用于高维检索。' }],
  takes: [],
  edges: [],
};

describe('F5.4 综合层 synthesize', () => {
  it('T5.4-01 系统提示含 6 条硬规则全文（快照断言）', () => {
    const p = buildThinkSystemPrompt({ mode: 'answer' });
    for (const rule of THINK_HARD_RULES) {
      expect(p).toContain(rule);
    }
    expect(THINK_HARD_RULES.length).toBe(6);
  });

  it('T5.4-02 user 消息含 <pages>/<takes>/<graph> 三段标签（空段也保留）', () => {
    const u = buildThinkUserMessage({
      question: '什么是向量数据库？',
      pages: '[[vector-db]]\n向量数据库用于高维检索。',
      takes: '',
      graph: '',
    });
    expect(u).toContain('<pages>');
    expect(u).toContain('</pages>');
    expect(u).toContain('<takes>');
    expect(u).toContain('</takes>');
    expect(u).toContain('<graph>');
    expect(u).toContain('</graph>');
    // 空段仍保留（哪怕是空内容）
    expect(u).toContain('<takes>\n\n</takes>');
  });

  it('T5.4-03 FakeGateway 返回标准 JSON → parse 出 {answer, citations, gaps}', async () => {
    const gw = new FakeGateway({
      defaultReply: JSON.stringify({
        answer: '向量数据库用于存储高维向量。',
        citations: ['[vector-db]'],
        gaps: [],
      }),
    });
    const res = await synthesize('什么是向量数据库？', ctx, gw);
    expect(res.answer).toContain('向量数据库');
    expect(res.citations).toEqual(['[vector-db]']);
    expect(res.gaps).toEqual([]);
  });

  it('T5.4-04 返回带 ```json 围栏的文本 → 容错解析成功（M12：引用需在 pages 白名单内）', async () => {
    const gw = new FakeGateway({
      defaultReply: '```json\n' + JSON.stringify({ answer: 'A', citations: ['[x]'], gaps: ['g'] }) + '\n```',
    });
    const res = await synthesize('q', { ...ctx, pages: [{ slug: 'x', body: 'x 页正文' }] }, gw);
    expect(res.answer).toBe('A');
    expect(res.citations).toEqual(['[x]']);
  });

  it('T5.4-05 返回非法 JSON → 明确 ValidationError，不静默空结果', async () => {
    const gw = new FakeGateway({ defaultReply: '这不是 JSON 也不是代码块' });
    await expect(synthesize('q', ctx, gw)).rejects.toThrow(ValidationError);
  });

  it('T5.4-06 citations 去重且为合法锚点形态（[slug] / [slug#chunk-N] 正则校验；M12：裸 slug 修复）', async () => {
    const gw = new FakeGateway({
      defaultReply: JSON.stringify({
        answer: 'a',
        citations: ['[vector-db]', '[vector-db]', '[vector-db#chunk-3]'],
        gaps: [],
      }),
    });
    const res = await synthesize('q', ctx, gw);
    expect(res.citations).toEqual(['[vector-db]', '[vector-db#chunk-3]']); // 去重

    // 裸 slug → M12 确定性修复为方括号形态
    const gwBare = new FakeGateway({
      defaultReply: JSON.stringify({ answer: 'a', citations: ['vector-db'], gaps: [] }),
    });
    const resBare = await synthesize('q', ctx, gwBare);
    expect(resBare.citations).toEqual(['[vector-db]']);

    // 真正非法（含空格，修复不了）→ ValidationError
    const gw2 = new FakeGateway({
      defaultReply: JSON.stringify({ answer: 'a', citations: ['[bad citation]'], gaps: [] }),
    });
    await expect(synthesize('q', ctx, gw2)).rejects.toThrow(ValidationError);
  });

  it('extractJson 单测：嵌套花括号/字符串内花括号不影响平衡截取', () => {
    const text = '前言 {"answer": "a {b} c", "citations": [], "gaps": []} 后缀';
    expect(JSON.parse(extractJson(text))).toMatchObject({ answer: 'a {b} c' });
  });
});
