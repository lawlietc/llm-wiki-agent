/**
 * F15.4 raw_source 指针注入（M15 D9/D10，文本层幂等）。
 *
 * 沿用 withFrontmatterRelations 的文本层惯例——不用 parse + render 重写
 * （renderFrontmatter 会给 date 加引号、破坏 DATE_RE）。只动 raw_source 一个键：
 * 已有则移除再写（幂等），页面其余部分字节不变。
 *
 * 指针值 = 来源 raw 页相对路径（本次 ingest 由代码计算注入，LLM 不参与）。
 */

/** 把 raw_source 注入页面 frontmatter（幂等；rawRel 空 → 原样返回） */
export function withFrontmatterSource(content: string, rawRel: string): string {
  if (rawRel === '') return content;
  if (!content.startsWith('---\n')) return content;

  const lines = content.split('\n');
  let fenceEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      fenceEnd = i;
      break;
    }
  }
  if (fenceEnd === -1) return content;

  // 移除既有顶层 raw_source 行（幂等），其余 frontmatter 行原样保留
  const kept: string[] = [];
  for (let i = 1; i < fenceEnd; i++) {
    if (/^raw_source:/.test(lines[i]!)) continue;
    kept.push(lines[i]!);
  }

  return ['---', `raw_source: ${rawRel}`, ...kept, '---', ...lines.slice(fenceEnd + 1)].join('\n');
}
