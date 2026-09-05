/**
 * vault markdown 扫描的单一来源（M12 I13/D6）。
 *
 * SKIP_DIRS 与 walkMarkdown 原先散在 links.ts（及 bm25 的平铺 readdir），
 * M12 起四个消费者共用本模块：links / bm25 / slugIndex / graph——
 * 防止扫描范围各自漂移。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseNote } from '../notes/frontmatter';

/** 扫描时跳过的目录名（与 M11 links.ts 口径一致） */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['.vault-meta', '.index', '.git', 'node_modules']);

/**
 * 递归收集 base（默认 vault 根；可传子根如 'wiki'）下的全部 .md。
 * 返回相对 vaultRoot 的 posix 路径，稳定排序（码点序）。
 */
export async function walkMarkdown(vaultRoot: string, subdir?: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const rel = path.relative(vaultRoot, path.join(dir, e.name)).split(path.sep).join('/');
        out.push(rel);
      }
    }
  };
  await walk(subdir ? path.join(vaultRoot, subdir) : vaultRoot);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 按 slug（basename）在 wiki/** 中解析页相对路径（路径排序首个胜，M12 D4/D15 简化口径）。
 * 供旧格式索引（Ranked.source 缺失）的回退读取；未命中返回 null。
 */
export async function findPageBySlug(vaultRoot: string, slug: string): Promise<string | null> {
  const pages = await walkMarkdown(vaultRoot, 'wiki');
  const hit = pages.find((rel) => rel.split('/').pop()!.replace(/\.md$/, '') === slug);
  return hit ?? null;
}

/** 读页正文（frontmatter 之后的部分）；读不到返回空串（不拖垮调用方） */
export async function readPageBodyByRel(vaultRoot: string, rel: string): Promise<string> {
  try {
    return parseNote(await readFile(path.join(vaultRoot, rel), 'utf8')).body;
  } catch {
    return '';
  }
}
