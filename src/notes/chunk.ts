/**
 * 中立分块能力（M20 工单 02 prefactor）。
 *
 * **为什么在这里**：`chunkPage` 原住 `src/qa/index/bm25.ts`（检索索引层），切的是
 * wiki 页、为 BM25 服务。引用式抽取（工单 04）需要把**原始正文**切成稳定编号的
 * 片段交给模型引用，而 `src/ingest/*` 从不依赖 `src/qa/*`（分层方向是 qa → notes）。
 * 若抽取层直接引用检索层，就把「抽取 → 检索」这条反方向的边固化下来。
 * 故上移到 `notes/` —— 双方共享的低层，两个消费者同指一个实现。
 *
 * **纯搬迁**：算法与输出逐字不变（golden 见 `test/notes/chunk.test.ts`）；
 * 检索索引层的分块输出与 chunk id 生成规则不受影响。
 */

/** chunk 目标字符数（约 300–500 token；中文 1 token≈1 字，注释：可调） */
export const CHUNK_TARGET_CHARS = 400;

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
