/**
 * note type 注册表（02 §5，逐字采用）。
 *
 * 新增类型只改本文件（02 §5 原文）。
 */

export type NoteType =
  | 'source'
  | 'project'
  | 'person'
  | 'idea'
  | 'task'
  | 'adr'
  | 'daily'
  | 'review'
  | 'meeting';

export interface NoteFrontmatter {
  date: string; // YYYY-MM-DD
  type: NoteType;
  tags: string[];
  'ai-first': true;
  confidence: 'stated' | 'high' | 'medium' | 'speculation';
  as_of?: string; // YYYY-MM，外部事实时必填
  sources?: string[]; // 来源 URL
  relations?: Record<string, string[]>; // 类型边 → [[wikilink]]
  [k: string]: unknown; // 类型扩展字段
}

/** 注册表（02 §5 九类型） */
export const NOTE_TYPES: ReadonlySet<string> = new Set<NoteType>([
  'source',
  'project',
  'person',
  'idea',
  'task',
  'adr',
  'daily',
  'review',
  'meeting',
]);

/** confidence 取值域（02 §5） */
export const CONFIDENCE_LEVELS = ['stated', 'high', 'medium', 'speculation'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** 各类型的必备字段（02 §5 表） */
export const NOTE_TYPE_REQUIRED_FIELDS: Record<NoteType, readonly string[]> = {
  source: ['source_url', 'fetched_at'],
  project: ['status', 'goal'],
  person: ['role', 'affiliation'],
  idea: ['status'],
  task: ['status'],
  adr: ['status', 'context', 'decision', 'consequences'],
  daily: [],
  review: ['period'],
  meeting: ['attendees', 'date'],
};
