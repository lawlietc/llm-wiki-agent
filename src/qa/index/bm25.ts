/**
 * BM25 索引（06 §1.3，纯 JS 自实现、零第三方依赖）。
 *
 * 不变量：
 * - I1（索引新鲜度）：`.index/bm25/.dirty` 存在时 bm25Query 先 buildIndex 再查（禁止写完不刷索引）。
 * - I2（索引原子性）：index.json 与 chunk 文件均经临时文件 + rename 原子替换；
 *   重建经 `.index/.bm25.lock`（mkdir 原子性）串行化，读方不持锁、永远读到完整文件。
 * - I3（参数锁死）：k1=1.5, b=0.75。
 *
 * chunk 存储 id = `<slug>:<chunkIndex>`（落 `.index/chunks/<id>.json`）；
 * Ranked.id 用锚点形态 `<slug>#chunk-<NNN>`（见 06 §2.3 与 types.ts）。
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ValidationError } from '../../errors';
import { parseNote } from '../../notes/frontmatter';
import { tokenize } from '../tokenizer';
import { DIRTY_MARKER_REL } from '../../vault/transaction';
import { walkMarkdown } from '../../vault/scan';
import type { Ranked } from '../../reasoning/types';

/* ----------------------------- 常量（I3 锁死） ----------------------------- */

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;
/** chunk 目标字符数（约 300–500 token；中文 1 token≈1 字，注释：可调） */
export const CHUNK_TARGET_CHARS = 400;
/** snippet 最大字符数 */
export const SNIPPET_MAX = 200;
const INDEX_SCHEMA_VERSION = 1;
const INDEX_DIR_REL = path.join('.index', 'bm25');
const INDEX_FILE_REL = path.join(INDEX_DIR_REL, 'index.json');
const CHUNKS_DIR_REL = path.join('.index', 'chunks');
const INDEX_LOCK_REL = path.join('.index', '.bm25.lock');

/**
 * chunk 落盘文件名（Windows 文件名禁含 `:`，故逻辑 id 的 `:` 转义为 `__`）。
 * 逻辑存储 id 仍是 `<slug>:<chunkIndex>`（用于 vocab/docs 键与 Ranked.id 锚点推导）；
 * 仅文件系统路径用此安全名。
 */
function chunkRelPath(chunkId: string): string {
  return path.join(CHUNKS_DIR_REL, `${chunkId.replace(/:/g, '__')}.json`);
}

/* ----------------------------- 索引 schema ----------------------------- */

interface ChunkMeta {
  path: string; // .index/chunks/<id>.json
  dl: number; // 该 chunk 的 token 数（文档长度）
  slug: string;
  /** 【M12】wiki 页相对 vault 的路径（读正文寻址用）；旧格式索引缺省 */
  source?: string;
  confidence?: string;
  snippet: string;
}
interface IndexFile {
  schema_version: number;
  params: { k1: number; b: number };
  doc_count: number;
  avg_dl: number;
  updated_at: string;
  vocab: Record<string, { df: number; postings: Array<[string, number]> }>;
  docs: Record<string, ChunkMeta>;
}
interface CollectedChunk {
  chunkId: string;
  slug: string;
  chunkIndex: number;
  text: string;
  confidence?: string;
  snippet: string;
  source: string;
}

/* ----------------------------- 索引锁（I2） ----------------------------- */

/**
 * 索引重建互斥锁（mkdir 原子性，与 M1 MutationLock 同范式）。
 * 仅用于串行化多次 buildIndex；bm25Query 读方不持锁（原子 rename 保证读到完整文件）。
 */
async function withIndexLock<T>(vaultRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(vaultRoot, INDEX_LOCK_REL);
  await mkdir(path.dirname(lockPath), { recursive: true });
  let acquired = false;
  const deadline = Date.now() + 10_000;
  while (!acquired) {
    try {
      await mkdir(lockPath);
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new ValidationError('INDEX_LOCK_HELD', `索引重建锁等待超时：${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

/* ----------------------------- 原子写 ----------------------------- */

/** 临时文件 + rename 原子替换（I2） */
async function writeAtomic(absPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, absPath);
}

/* ----------------------------- chunking ----------------------------- */

/** 按段落聚合并目标字符数切分；超长段落按句切。返回 chunk 正文数组。 */
export function chunkPage(body: string, target = CHUNK_TARGET_CHARS): string[] {
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) {
      chunks.push(cur);
      cur = '';
    }
  };
  for (const p of paras) {
    if (cur && cur.length + p.length + 1 > target) flush();
    if (p.length > target) {
      // 超长段落按句切（lookbehind 在 Node 20+ 可用）
      const sentences = p.split(/(?<=[。.!?！？\n])/);
      for (const s of sentences) {
        if (cur && cur.length + s.length > target) flush();
        cur += s;
      }
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
  }
  flush();
  return chunks.length ? chunks : [body.trim()];
}

/* ----------------------------- buildIndex ----------------------------- */

/** 全量重建 BM25 索引（I1/I2）。完成后清除 dirty 标记。 */
export async function buildIndex(vaultRoot: string): Promise<void> {
  await withIndexLock(vaultRoot, async () => {
    // M12 F12.0：递归扫 wiki/**（实体页自 M10 起在子目录；平铺扫描假设使它们从未进过索引）
    const mdFiles = await walkMarkdown(vaultRoot, 'wiki');

    const vocab: IndexFile['vocab'] = {};
    const docs: IndexFile['docs'] = {};
    const chunks: CollectedChunk[] = [];
    const docLens: number[] = [];
    const seenSlugs = new Set<string>();

    for (const rel of mdFiles) {
      const slug = rel.split('/').pop()!.slice(0, -'.md'.length);
      // 同名异常态（M13 duplicateEntitySlug）：路径排序首个胜，其余跳过（chunk id 不重复）
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      let content: string;
      try {
        content = await readFile(path.join(vaultRoot, rel), 'utf8');
      } catch {
        continue;
      }
      let body: string;
      let confidence: string | undefined;
      try {
        const parsed = parseNote(content);
        body = parsed.body;
        confidence = parsed.frontmatter.confidence as string | undefined;
      } catch {
        // 单页损坏不拖垮整库索引：跳过
        continue;
      }
      if (!body.trim()) continue;

      const pageChunks = chunkPage(body);
      pageChunks.forEach((text, i) => {
        const chunkId = `${slug}:${i}`;
        const terms = tokenize(text);
        const dl = terms.length;
        docLens.push(dl);

        const snippet = text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
        chunks.push({ chunkId, slug, chunkIndex: i, text, confidence, snippet, source: rel });
        docs[chunkId] = { path: chunkRelPath(chunkId), dl, slug, source: rel, confidence, snippet };

        // 累加到 vocab（term → df/postings）
        const tf = new Map<string, number>();
        for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
        for (const [term, f] of tf) {
          const entry = (vocab[term] ??= { df: 0, postings: [] });
          entry.postings.push([chunkId, f]);
          entry.df += 1;
        }
      });
    }

    // 先写 chunk 文件（幂等覆盖），再原子写 index.json（保证 index 引用的文件已存在）
    for (const c of chunks) {
      const chunkAbs = path.join(vaultRoot, chunkRelPath(c.chunkId));
      await writeAtomic(
        chunkAbs,
        JSON.stringify({
          id: c.chunkId,
          slug: c.slug,
          chunkIndex: c.chunkIndex,
          text: c.text,
          confidence: c.confidence,
          snippet: c.snippet,
          source: c.source,
        }),
      );
    }

    const docCount = docLens.length;
    const avgDl = docCount > 0 ? docLens.reduce((a, b) => a + b, 0) / docCount : 0;
    const index: IndexFile = {
      schema_version: INDEX_SCHEMA_VERSION,
      params: { k1: BM25_K1, b: BM25_B },
      doc_count: docCount,
      avg_dl: avgDl,
      updated_at: new Date().toISOString(),
      vocab,
      docs,
    };
    await writeAtomic(path.join(vaultRoot, INDEX_FILE_REL), JSON.stringify(index));

    // 清 dirty 标记
    await rm(path.join(vaultRoot, DIRTY_MARKER_REL), { force: true });
  });
}

/* ----------------------------- bm25Query ----------------------------- */

/** 读已提交 index.json（不存在返回 null）。不持锁：原子 rename 保证读到完整文件。 */
async function loadIndex(vaultRoot: string): Promise<IndexFile | null> {
  const indexAbs = path.join(vaultRoot, INDEX_FILE_REL);
  try {
    return JSON.parse(await readFile(indexAbs, 'utf8')) as IndexFile;
  } catch {
    return null;
  }
}

/**
 * BM25 检索（I1：dirty 先重建）。返回 topK 个 Ranked。
 * @param vaultRoot vault 根
 * @param text 查询串（经 tokenizer 分词）
 * @param topK 返回条数
 */
export async function bm25Query(vaultRoot: string, text: string, topK: number): Promise<Ranked[]> {
  if (existsSync(path.join(vaultRoot, DIRTY_MARKER_REL))) {
    await buildIndex(vaultRoot); // I1：先重建
  }

  const idx = await loadIndex(vaultRoot);
  if (!idx || idx.doc_count === 0) return [];

  const queryTerms = tokenize(text).filter((t) => idx.vocab[t]);
  if (queryTerms.length === 0) return [];

  const avgDl = idx.avg_dl || 1;
  const scores = new Map<string, number>(); // chunkId → score
  for (const term of queryTerms) {
    const entry = idx.vocab[term]!;
    // BM25 idf（带 +1 平滑，避免 df 高时为负）
    const idf = Math.log(1 + (idx.doc_count - entry.df + 0.5) / (entry.df + 0.5));
    for (const [chunkId, tf] of entry.postings) {
      const dl = idx.docs[chunkId]?.dl ?? 0;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDl));
      const contrib = idf * ((tf * (BM25_K1 + 1)) / denom);
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + contrib);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([chunkId, score]) => {
      const meta = idx.docs[chunkId]!;
      const chunkIndex = Number(chunkId.split(':').pop());
      const slug = meta.slug;
      return {
        id: `${slug}#chunk-${chunkIndex}`, // 锚点形态（types.ts）
        slug,
        score,
        chunkIndex,
        confidence: meta.confidence,
        snippet: meta.snippet,
        source: meta.source,
      } satisfies Ranked;
    });
}
