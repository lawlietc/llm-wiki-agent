/**
 * 来源适配器注册表（05 §4 定稿）。
 *
 * MVP 两类内置适配器：file（本地文件）/ url（网页）。连接器可插拔——
 * 新增 `SourceAdapter` 实现并在 `selectAdapter` 注册即可，编排不动（05 §4 末段）。
 *
 * `SourceMeta` 唯一定义在 `notes/template.ts`（02 §1/M2），此处仅复用，禁止重复定义。
 */

import { existsSync, readFileSync } from 'node:fs';
import { ConfigError, TransientError, ValidationError } from '../errors';
import { normalizeGatewayError } from '../reasoning/gateway-backend';
import type { SourceMeta } from '../notes/template';

export type { SourceMeta } from '../notes/template';

export interface SourceAdapter {
  id: string;
  /** 能否处理该输入 */
  detect(input: string): boolean;
  /** 抽取纯文本正文 + 来源元数据 */
  extract(input: string): Promise<{ body: string; meta: import('../notes/template').SourceMeta }>;
}

/** 去掉 `file://` 前缀（可能单/三斜杠） */
function stripFileProto(input: string): string {
  return input.replace(/^file:\/\//, '');
}

export const FILE_ADAPTER: SourceAdapter = {
  id: 'file',
  detect: (i) => i.startsWith('file://') || (/\.\w+$/.test(i) && existsSync(i)),
  async extract(i) {
    const p = stripFileProto(i);
    const body = readFileSync(p, 'utf8');
    return { body, meta: { sourceUrl: i, fetchedAt: new Date().toISOString() } };
  },
};

/**
 * URL 适配器抓取接缝（SPEC-0 §2.5 同模式：模块级可替换，默认走全局 fetch）。
 * 测试经 `_urlAdapterSeam.fetchImpl` 注入假 fetch，零真实网络（T4.2-05）。
 */
export const _urlAdapterSeam: { fetchImpl?: typeof fetch } = {};

function getFetch(): typeof fetch {
  return _urlAdapterSeam.fetchImpl ?? (globalThis.fetch as typeof fetch);
}

/**
 * URL 抓取错误归一化（复用 M3 normalizeGatewayError 策略：4xx→Config、5xx/408/429→Transient）。
 * 网络层错误（无 statusCode，如 DNS/连接失败、TypeError "fetch failed"）归一为 TransientError，
 * 不裸抛——否则 T4.2-03 会泄漏底层 fetch 错误。
 */
function normalizeFetchError(err: unknown): never {
  const e = err as { statusCode?: number; message?: string } | null;
  if (e && typeof e.statusCode === 'number') {
    throw normalizeGatewayError(err);
  }
  const msg = err instanceof Error ? err.message : String(err);
  throw new TransientError('TRANSIENT', `URL 抓取失败：${msg}`);
}

export const URL_ADAPTER: SourceAdapter = {
  id: 'url',
  detect: (i) => /^https?:\/\//.test(i),
  async extract(i: string): Promise<{ body: string; meta: SourceMeta }> {
    let res: Response;
    try {
      res = await getFetch()(i);
    } catch (e) {
      throw normalizeFetchError(e); // 网络层错误 → TransientError
    }
    if (!res.ok) {
      // 注入 statusCode 让 normalizeGatewayError 按 HTTP 语义映射（4xx→Config / 5xx→Transient）
      const httpErr = Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), {
        statusCode: res.status,
      });
      throw normalizeGatewayError(httpErr);
    }

    const html = await res.text();
    const { Readability } = await import('@mozilla/readability');
    const { parseHTML } = await import('linkedom');
    const { document } = parseHTML(html, i);
    const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
    const text = article?.textContent?.trim();
    if (!text) {
      throw new ValidationError('EXTRACT_EMPTY', `正文抽取为空：${i}`);
    }
    return {
      body: text,
      meta: { sourceUrl: i, fetchedAt: new Date().toISOString(), mime: res.headers.get('content-type') ?? undefined },
    };
  },
};

const ADAPTERS: readonly SourceAdapter[] = [FILE_ADAPTER, URL_ADAPTER];

/** 注册表式分发：返回首个 detect 命中者（file 优先于 url） */
export function selectAdapter(input: string): SourceAdapter {
  for (const a of ADAPTERS) {
    if (a.detect(input)) return a;
  }
  throw new ConfigError('NO_SOURCE_ADAPTER', `无适配器可处理输入：${input}`);
}
