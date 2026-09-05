/**
 * 端到端问答（06 §4 MVP 形态）。
 *
 * 流程：expand(可选多子查询) → hybridRetrieve(每子查询) → 按 slug 聚合 pages → synthesize。
 * 索引查询纯 CPU（无 LLM）；仅 synthesize/expand 触发 gateway（DoD）。
 * MVP：RetrievalContext 仅填 pages，takes/edges 恒为 []（第三刀 GATHER 后才有）。
 * M12 F12.0：pages 正文按命中项的 source（页相对路径）读取——实体页自 M10 起在
 * wiki/ 子目录，平铺拼路径的假设使其从未可读；source 缺失（旧格式索引）时回退
 * 按 slug 在 wiki/** 中解析，再缺失返回空串（不拖垮问答）。
 * M12 F12.3：edges 接 relations 图的命中页一跳子图（07 §4 M12.2，替换硬编码 []）。
 */

import type { ReasoningBackend } from '../reasoning/backend';
import type { Ranked } from '../reasoning/types';
import { findPageBySlug, readPageBodyByRel } from '../vault/scan';
import { bm25Query } from './index/bm25';
import { buildEdgesFromVault, subgraphFor } from './graph';
import { hybridRetrieve } from './retrieve';
import { synthesize, type RetrievalContext, type SynthesisResult } from './synthesize';

export interface AskDeps {
  vaultRoot: string;
  gateway: ReasoningBackend;
  /** 取前 k（透传 hybridRetrieve） */
  k?: number;
  /** 可选多子查询展开（M3 GatewayBackend.expand 或注入）；缺席则单查询 */
  expand?: (query: string) => Promise<string[]>;
}

/** 跨子查询合并：同 id 分数求和、重新排序（T5.5-04 融合） */
function mergeByScore(lists: Ranked[][]): Ranked[] {
  const m = new Map<string, Ranked>();
  for (const list of lists) {
    for (const item of list) {
      const prev = m.get(item.id);
      if (prev) m.set(item.id, { ...prev, score: prev.score + item.score });
      else m.set(item.id, { ...item });
    }
  }
  return [...m.values()].sort((a, b) => b.score - a.score);
}

/** 读 wiki 页正文（供综合层 pages 上下文）：优先按命中项 source 寻址，回退 slug 解析；读不到返回空串 */
async function readPageBody(root: string, hit: Ranked): Promise<string> {
  if (hit.source) return readPageBodyByRel(root, hit.source);
  const rel = await findPageBySlug(root, hit.slug);
  return rel ? readPageBodyByRel(root, rel) : '';
}

/**
 * 端到端问答。
 * @param question 用户问题
 * @param deps vault 根 + 推理后端 + 可选 expand/k
 */
export async function ask(question: string, deps: AskDeps): Promise<SynthesisResult> {
  const subqueries = deps.expand ? await deps.expand(question) : [question];

  const hitLists: Ranked[][] = [];
  for (const sq of subqueries) {
    const hits = await hybridRetrieve(sq, {
      bm25: (q, k) => bm25Query(deps.vaultRoot, q, k),
      k: deps.k,
    });
    hitLists.push(hits);
  }
  const merged = mergeByScore(hitLists);

  // 按 slug 聚合 pages 上下文；正文按 source 寻址（F12.0）
  // M12 I15：slugs 保持融合分数降序且去重，同一份序列同时喂 <pages> 与 subgraphFor。
  const slugs = [...new Set(merged.map((h) => h.slug))];
  const bySlug = new Map(merged.map((h) => [h.slug, h]));
  const pages = await Promise.all(
    slugs.map(async (slug) => ({ slug, body: await readPageBody(deps.vaultRoot, bySlug.get(slug)!) })),
  );

  // M12 E5：relations 图 → 命中页一跳子图（替换 MVP 硬编码 []）。
  // 图构建纯读零 LLM（I7）；无 relations 库 → 空子图，<graph> 段为空（I12 回归安全）。
  const graphEdges = await buildEdgesFromVault(deps.vaultRoot);
  const ctx: RetrievalContext = { pages, takes: [], edges: subgraphFor(graphEdges, slugs) };
  return synthesize(question, ctx, deps.gateway);
}
