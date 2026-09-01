/**
 * F4.1 SourceAdapter 注册表 + file 适配器（T4.1-01~04）。
 * F4.2 URL 适配器用例见本文件后续 describe 块（T4.2-01~05）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigError } from '../../src/errors';
import { FILE_ADAPTER, URL_ADAPTER, selectAdapter, _urlAdapterSeam } from '../../src/ingest/sources';

let tmpDir: string;
let mdPath: string;
const MD_BODY = 'line1\nline2\n中文内容\n';

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'm4-src-'));
  mdPath = path.join(tmpDir, 'doc.md');
  await writeFile(mdPath, MD_BODY, 'utf8');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('F4.1 SourceAdapter 注册表 + file 适配器', () => {
  it('T4.1-01 detect：`file://` 前缀与存在的带扩展名路径 → file 适配器', () => {
    expect(FILE_ADAPTER.detect(`file://${mdPath}`)).toBe(true);
    expect(FILE_ADAPTER.detect(mdPath)).toBe(true);
    expect(FILE_ADAPTER.id).toBe('file');
  });

  it('T4.1-02 `http(s)://` → url 适配器；两者皆不匹配 → ConfigError(NO_SOURCE_ADAPTER)', () => {
    expect(URL_ADAPTER.detect('https://example.com/post')).toBe(true);
    expect(URL_ADAPTER.detect('http://example.com/post')).toBe(true);
    expect(URL_ADAPTER.id).toBe('url');

    expect(() => selectAdapter('just-some-plain-text-without-protocol')).toThrow(ConfigError);
    try {
      selectAdapter('just-some-plain-text-without-protocol');
      expect.unreachable('应抛出 NO_SOURCE_ADAPTER');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('NO_SOURCE_ADAPTER');
    }

    // 既非 file 也非 url 形态
    expect(selectAdapter('https://example.com/a.md').id).toBe('url');
  });

  it('T4.1-03 file extract 返回 body verbatim + meta.fetchedAt ISO', async () => {
    const { body, meta } = await FILE_ADAPTER.extract(mdPath);
    expect(body).toBe(MD_BODY); // verbatim，未改写
    expect(meta.sourceUrl).toBe(mdPath);
    expect(meta.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('T4.1-04 适配器选择顺序：file 优先于 url（URL 形态不被 file 误抢）', () => {
    // URL 形态即使结尾像文件（.md）也不应被 file 抢走
    expect(selectAdapter('https://example.com/a.md').id).toBe('url');
    // 真实本地文件 → file
    expect(selectAdapter(mdPath).id).toBe('file');
  });
});

/* -------------------------------------------------------------------------- */
/* F4.2 URL 适配器（Readability + linkedom 正文抽取，零真实网络）              */
/* -------------------------------------------------------------------------- */

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>深入理解向量数据库</title></head>
<body>
<nav>Skip to content</nav>
<script>var tracking=1;</script>
<article>
<h1>深入理解向量数据库</h1>
<p>向量数据库以高维向量存储与检索相似数据，常见于 RAG 与推荐系统。</p>
<p>常见算法包括 IVF、HNSW 与 PQ 量化，各有吞吐与召回权衡。</p>
</article>
</body></html>`;

const BOILERPLATE_HTML = `<!DOCTYPE html><html><head><title>x</title></head>
<body><script>1</script><style>.a{}</style><div></div><div></div></body></html>`;

interface FakeResponseInit {
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: string;
}

function fakeResponse({ status = 200, statusText = 'OK', contentType = 'text/html; charset=utf-8', body = '' }: FakeResponseInit) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  } as unknown as Response;
}

describe('F4.2 URL 适配器（Readability 正文抽取）', () => {
  afterEach(() => {
    _urlAdapterSeam.fetchImpl = undefined; // 复位，避免污染其它用例
  });

  it('T4.2-01 mock fetch + fixture HTML（正常文章）→ 返回正文纯文本 + content-type', async () => {
    let calledUrl: string | undefined;
    _urlAdapterSeam.fetchImpl = async (u) => {
      calledUrl = String(u);
      return fakeResponse({ body: ARTICLE_HTML });
    };
    const { body, meta } = await URL_ADAPTER.extract('https://example.com/vec-db');
    expect(calledUrl).toBe('https://example.com/vec-db'); // T4.2-05：只调注入的 fixture URL
    expect(body).toContain('向量数据库');
    expect(body).toContain('HNSW');
    expect(meta.mime).toBe('text/html; charset=utf-8');
    expect(meta.sourceUrl).toBe('https://example.com/vec-db');
  });

  it('T4.2-02 Readability 抽取为空（boilerplate 页）→ ValidationError(EXTRACT_EMPTY)', async () => {
    _urlAdapterSeam.fetchImpl = async () => fakeResponse({ body: BOILERPLATE_HTML });
    await expect(URL_ADAPTER.extract('https://example.com/empty')).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'EXTRACT_EMPTY',
    });
  });

  it('T4.2-03 mock fetch 网络错误 → 归一化 TransientError（不裸抛 fetch 错误）', async () => {
    _urlAdapterSeam.fetchImpl = async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    };
    await expect(URL_ADAPTER.extract('https://example.com/down')).rejects.toMatchObject({
      name: 'TransientError',
      code: 'TRANSIENT',
    });
  });

  it('T4.2-04 正文不含 nav/script 噪声文本（fixture 含干扰标签，断言被剔除）', async () => {
    _urlAdapterSeam.fetchImpl = async () => fakeResponse({ body: ARTICLE_HTML });
    const { body } = await URL_ADAPTER.extract('https://example.com/vec-db');
    expect(body).not.toContain('Skip to content'); // nav 噪声
    expect(body).not.toContain('var tracking=1'); // script 噪声
  });

  it('T4.2-05 零真实网络：仅注入的 fetchImpl 被调用，全局 fetch 未被触碰', async () => {
    let hit = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      hit++;
      return fakeResponse({ body: ARTICLE_HTML });
    }) as typeof fetch;
    _urlAdapterSeam.fetchImpl = async () => fakeResponse({ body: ARTICLE_HTML });
    await URL_ADAPTER.extract('https://example.com/probe');
    expect(hit).toBe(0); // 适配器用的是注入实现，而非全局 fetch
    globalThis.fetch = realFetch;
  });
});
