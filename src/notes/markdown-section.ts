/**
 * 二级标题（`## `）段落的定位 / 摘取 / 替换（M20 工单 05 与 08 共用的文本层底座）。
 *
 * 「按固定标题找到段落区间 → 读它的原文 → 用新内容原位替换（或以空内容整段移除）」
 * 这套动作被事实段（`facts.ts`）与矛盾段（`contradictions.ts`）各实现了一遍，
 * `sectionEnd` 一度逐字重复。上提为单一来源，避免两份实现日后漂移。
 *
 * 纯文本层：不解析 frontmatter、不动段落之外的字节。
 */

/** 找到标题行下标（容忍行尾空白）；无 → -1 */
export function findSectionHeading(lines: readonly string[], heading: string): number {
  return lines.findIndex((l) => l.replace(/\s+$/, '') === heading);
}

/** 段落结束位置：下一个二级标题（`## `）行；无则到文件末 */
export function sectionEnd(lines: readonly string[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) return i;
  }
  return lines.length;
}

/**
 * 段落原文（含标题；尾部空行已去）。用于「新渲染结果与现存字节是否一致」的幂等判定。
 * 无该段 → null。
 */
export function sectionTextOf(content: string, heading: string): string | null {
  const lines = content.split('\n');
  const head = findSectionHeading(lines, heading);
  if (head === -1) return null;
  return lines.slice(head, sectionEnd(lines, head)).join('\n').replace(/\n+$/, '');
}

/**
 * 用新段落替换标题段：无该段则追加到文末；`section` 为空串 → **整段移除**
 * （并归一化文件尾部空行）。段落之外的字节不变。
 */
export function replaceSection(content: string, heading: string, section: string): string {
  const lines = content.split('\n');
  const head = findSectionHeading(lines, heading);
  if (head === -1) {
    if (section === '') return content;
    const sep = content.endsWith('\n') ? '\n' : '\n\n';
    return `${content}${sep}${section}\n`;
  }
  if (section === '') {
    const kept = [...lines.slice(0, head), ...lines.slice(sectionEnd(lines, head))];
    return kept.join('\n').replace(/\n{3,}$/, '\n');
  }
  return [...lines.slice(0, head), ...section.split('\n'), ...lines.slice(sectionEnd(lines, head))].join('\n');
}
