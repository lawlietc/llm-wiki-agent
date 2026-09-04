/**
 * F10.3 extractEntities 单测（T10.2-*）。零真实网络：FakeGateway 注入回稿。
 */
import { describe, it, expect } from 'vitest';

import { extractEntities, extractJson, MAX_ENTITIES } from '../../src/ingest/extract';
import { SOURCE_FENCE } from '../../src/ingest/fence';
import { ValidationError } from '../../src/errors';
import { FakeGateway } from '../../test/fakes/fake-gateway';

const GOOD_JSON = JSON.stringify({
  entities: [
    { name: 'Model Context Protocol', slug: 'mcp', kind: 'concept', coverage: 'discussed', summary: '工具调用协议', aliases: ['MCP'] },
    { name: 'Anthropic', slug: 'anthropic', kind: 'company', coverage: 'defined', summary: 'AI 公司' },
  ],
  relations: [{ from: 'mcp', type: 'depends_on', to: 'anthropic' }],
});

const BODY = 'Model Context Protocol（MCP）是 Anthropic 提出的工具调用协议。';

describe('F10.3 extractEntities', () => {
  it('T10.2-01 正常回稿：解析出实体与边；prompt 含 fence 与硬化指令', async () => {
    const gw = new FakeGateway({ replies: new Map([['实体抽取', GOOD_JSON]]) });
    const res = await extractEntities(BODY, 'file:///a.txt', gw);

    expect(res.entities).toHaveLength(2);
    expect(res.entities[0]!.slug).toBe('mcp');
    expect(res.relations).toEqual([{ from: 'mcp', type: 'depends_on', to: 'anthropic' }]);

    const flat = gw.lastPrompt;
    expect(flat).toContain('实体抽取助手');
    expect(flat).toContain('严禁');
    expect(flat).toContain(SOURCE_FENCE);
    expect(flat).toContain('(source: file:///a.txt)');
  });

  it('T10.2-02 回稿带 ```json 围栏与前缀说明 → 仍可解析', async () => {
    const wrapped = '以下是抽取结果：\n```json\n' + GOOD_JSON + '\n```';
    const gw = new FakeGateway({ replies: new Map([['实体抽取', wrapped]]) });
    const res = await extractEntities(BODY, 'u', gw);
    expect(res.entities).toHaveLength(2);
  });

  it('T10.2-03 回稿无 JSON → ValidationError(EXTRACT_PARSE_FAILED)', async () => {
    const gw = new FakeGateway({ defaultReply: '文件已生成：notes/mcp.md' });
    await expect(extractEntities(BODY, 'u', gw)).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'EXTRACT_PARSE_FAILED',
    });
  });

  it('T10.2-04 非法 relation 类型 / 自环 / 缺字段 → 解析层剪除', async () => {
    const bad = JSON.stringify({
      entities: [{ name: 'A', slug: 'a', kind: 'concept', coverage: 'discussed' }],
      relations: [
        { from: 'a', type: 'loves', to: 'a' }, // 非法类型 + 自环
        { from: 'a', type: 'relates_to', to: 'a' }, // 自环
        { from: 'a', type: 'supersedes', to: '' }, // 缺 to
        { from: 'a', type: 'depends_on', to: 'b' }, // 合法（端点由 gate 把关）
      ],
    });
    const gw = new FakeGateway({ replies: new Map([['实体抽取', bad]]) });
    const res = await extractEntities(BODY, 'u', gw);
    expect(res.relations).toEqual([{ from: 'a', type: 'depends_on', to: 'b' }]);
  });

  it('T10.2-05 实体超预算截断', async () => {
    const many = JSON.stringify({
      entities: Array.from({ length: MAX_ENTITIES + 10 }, (_, i) => ({
        name: `E${i}`,
        slug: `e${i}`,
        kind: 'concept',
        coverage: 'named',
      })),
      relations: [],
    });
    const gw = new FakeGateway({ replies: new Map([['实体抽取', many]]) });
    const res = await extractEntities(BODY, 'u', gw);
    expect(res.entities).toHaveLength(MAX_ENTITIES);
  });

  it('T10.2-06 数组中混入标量/空对象 → 跳过不崩', async () => {
    const mixed = JSON.stringify({
      entities: [null, 'junk', { name: 'A', slug: 'a', kind: 'concept', coverage: 'discussed' }, {}],
      relations: [42, null, { from: 'a', type: 'caused', to: 'b' }],
    });
    const gw = new FakeGateway({ replies: new Map([['实体抽取', mixed]]) });
    const res = await extractEntities(BODY, 'u', gw);
    expect(res.entities).toHaveLength(1);
    expect(res.relations).toEqual([{ from: 'a', type: 'caused', to: 'b' }]);
  });

  it('T10.2-07 extractJson 直接单测：首 { 到末 } 贪心片段', () => {
    expect(extractJson('x {"a":1} y')).toEqual({ a: 1 });
    expect(() => extractJson('x {"a":1} y {"b":2}')).toThrowError(ValidationError); // 贪心片段非合法 JSON → 明确报错
    expect(() => extractJson('no json here')).toThrowError(ValidationError);
  });
});
