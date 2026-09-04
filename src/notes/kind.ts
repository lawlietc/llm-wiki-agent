/**
 * F13.1 kind → 目录映射与实体页路径（M13 D1/D2，纯函数零 I/O）。
 *
 * - 五类确认目录（people/companies/projects/decisions/concepts）+ 待确认层 wiki/notes/。
 * - entityPagePath：唯一实体页路径出口（ingest 建页 / gate slugIsValid / stub 占位共用，
 *   消灭 M10 时代三处 `wiki/concepts/<slug>.md` 硬编码）；构造即过路径白名单（fail-closed）。
 * - kindOfPath / isEntityDir：路径反推 kind；isEntityDir 区分「未分类（notes/）」与「未知目录」。
 * - noteTypeFor：kind → 02 §5 封闭表 NoteType（company/concept 无专型 → idea）；
 *   实现必须判 `kind != null` 后再索引（null 直接索引 KIND_NOTE_TYPE 会 TS 报错）。
 */

import type { NoteType } from './types';
import type { EntityKind } from '../ingest/candidate-gate';
import { assertPortableWritePath } from '../vault/paths';

/** kind → 确认态目录（M13 D2） */
export const KIND_DIR: Record<EntityKind, string> = {
  person: 'wiki/people',
  company: 'wiki/companies',
  project: 'wiki/projects',
  decision: 'wiki/decisions',
  concept: 'wiki/concepts',
};

/** 五类 kind 的固定枚举顺序（既有页探测顺序：五 kind 目录 → notes/） */
export const ALL_KINDS: readonly EntityKind[] = ['person', 'company', 'project', 'decision', 'concept'];

/** 待确认层目录（M13 C3）：未确认分类的实体页落点 */
export const UNCLASSIFIED_DIR = 'wiki/notes';

/** kind → 页面 type（02 §5 封闭表内对齐；company/concept 记 idea，靠 entity_kind 表达真实类别） */
export const KIND_NOTE_TYPE: Record<EntityKind, NoteType> = {
  person: 'person',
  project: 'project',
  decision: 'adr',
  company: 'idea',
  concept: 'idea',
};

/** 五类确认目录 → kind 的反推表（由 KIND_DIR 派生，保持单一事实源） */
const DIR_KIND = new Map<string, EntityKind>(Object.entries(KIND_DIR).map(([k, dir]) => [dir, k as EntityKind]));

/**
 * 实体页相对路径：确认 kind → `wiki/<kind>/<slug>.md`；未确认（null）→ `wiki/notes/<slug>.md`。
 * 构造即过 assertPortableWritePath（slug 非法直接抛，T13.1-05）。
 */
export function entityPagePath(kind: EntityKind | null, slug: string): string {
  if (typeof slug !== 'string' || slug.trim() === '') {
    throw new Error('实体页 slug 不能为空');
  }
  const dir = kind != null ? KIND_DIR[kind] : UNCLASSIFIED_DIR;
  const rel = `${dir}/${slug}.md`;
  assertPortableWritePath(rel);
  return rel;
}

/** 路径 → kind 反推：五类目录下返回对应 kind；notes/、raw/、wiki 顶层、未知目录 → null */
export function kindOfPath(rel: string): EntityKind | null {
  const posix = rel.split('\\').join('/');
  for (const [dir, kind] of DIR_KIND) {
    if (posix.startsWith(`${dir}/`)) return kind;
  }
  return null;
}

/** 是否在实体页目录下（五类确认目录或 wiki/notes/）——区分「未分类」与「未知目录」（T13.1-04） */
export function isEntityDir(rel: string): boolean {
  const posix = rel.split('\\').join('/');
  if (posix.startsWith(`${UNCLASSIFIED_DIR}/`)) return true;
  return kindOfPath(posix) !== null;
}

/** kind（可为 null=未分类）→ 页面 type；null 时直接索引会报 TS 错，必须显式分支 */
export function noteTypeFor(kind: EntityKind | null): NoteType {
  return kind != null ? KIND_NOTE_TYPE[kind] : 'idea';
}
