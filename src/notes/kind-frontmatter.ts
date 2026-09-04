/**
 * F13.4a kind frontmatter 文本层重写（M13 D6）。
 *
 * withFrontmatterKind：只改写 type / entity_kind / needs_classification /
 * suggested_kind / suggested_source 五个键，正文与其他 frontmatter 字节不变。
 * 沿用 M10 withFrontmatterRelations 的文本层惯例——不用 parse + render 重写
 * （renderFrontmatter 会给 date 加引号、破坏 DATE_RE）。
 *
 * target 语义：undefined = 不动该键；null = 移除该键；具体值 = 写入/改写。
 */

import type { NoteType } from './types';

export interface KindFrontmatterTarget {
  type?: NoteType;
  entityKind?: string | null;
  needsClassification?: boolean | null;
  suggestedKind?: string | null;
  suggestedSource?: string | null;
}

/** 五键的写入行生成（null 值不生成行 = 移除） */
function lineFor(target: KindFrontmatterTarget): string[] {
  const lines: string[] = [];
  if (target.type !== undefined && target.type !== null) lines.push(`type: ${target.type}`);
  if (target.entityKind) lines.push(`entity_kind: ${target.entityKind}`);
  if (target.needsClassification) lines.push('needs_classification: true');
  if (target.suggestedKind) lines.push(`suggested_kind: ${target.suggestedKind}`);
  if (target.suggestedSource) lines.push(`suggested_source: ${target.suggestedSource}`);
  return lines;
}

/**
 * 文本层重写 frontmatter 五个分类键。
 * frontmatter 结构非法（无围栏）时原样返回（防御性）。
 */
export function withFrontmatterKind(content: string, target: KindFrontmatterTarget): string {
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

  // 待移除的顶层键（五键都是标量键，各占一行；匹配顶层行首，不误伤 relations 的 2 空格缩进子键）
  const removeKeys = new Set<string>();
  if (target.type !== undefined) removeKeys.add('type');
  if (target.entityKind !== undefined) removeKeys.add('entity_kind');
  if (target.needsClassification !== undefined) removeKeys.add('needs_classification');
  if (target.suggestedKind !== undefined) removeKeys.add('suggested_kind');
  if (target.suggestedSource !== undefined) removeKeys.add('suggested_source');

  const kept: string[] = [];
  for (let i = 1; i < fenceEnd; i++) {
    const line = lines[i]!;
    const m = /^([A-Za-z0-9_-]+):/.exec(line);
    if (m && removeKeys.has(m[1]!)) continue;
    kept.push(line);
  }

  const fmLines = [...kept, ...lineFor(target)];
  return ['---', ...fmLines, '---', ...lines.slice(fenceEnd + 1)].join('\n');
}
