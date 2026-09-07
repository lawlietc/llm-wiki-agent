/**
 * M17 批量 ingest（F17.1–F17.7）。
 *
 * 设计基调（spec §2）：**批量不引入新的写入通道** —— 每一项仍是一次完整的 `ingest()`
 * 调用，M14 短路 / M15 基线·指针·碰撞·冲突 / M16 可见性逐字保留（I32）。本模块只负责
 * 枚举、去重、预算、调度、报告。
 *
 * 关键约束：
 * - I33 批内去重：文件按字节 sha256、URL 按原始输入；第二次起零 LLM。
 * - I34 失败隔离：单项失败记入报告并继续。
 * - I35 must-abort：配置 / 安全 / 预算类错误整批停机（继续也无意义）。
 * - I36 预算闸门：先于任何 LLM 调用。
 * - I38 枚举排除：绝不把 vault 产出（wiki/、raw/）与忽略目录当输入。
 * - I39 v1 顺序执行：并发为何不安全、未来安全形态见 spec D2。
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError, SafetyError } from '../errors';
import { SKIP_DIRS } from '../vault/scan';
import { collectRawSourceKeys, ingest, type IngestDeps } from './ingest';
import { normalizeSourceUrl } from './source-url';
import type { VaultPlan } from '../vault/vault';

// ── 类型 ────────────────────────────────────────────────────────────

export type BatchItemKind = 'file' | 'url';

export interface BatchInput {
  /** 原始输入字符串（原样透传给 ingest()，I32） */
  input: string;
  kind: BatchItemKind;
  /** I33 去重键：文件=字节 sha256，URL=原始输入 */
  dedupKey: string;
  /** 体积；URL 为 0（D7） */
  sizeBytes: number;
}

export interface BatchSourceSpec {
  /** 位置参数 */
  inputs?: string[];
  /** --dir：递归目录 */
  dir?: string;
  /** --glob */
  glob?: string;
  /** --from-file：清单文件（每行一条，# 注释） */
  fromFile?: string;
  /** --ext（默认 md） */
  ext?: string[];
}

export interface BatchBudget {
  maxItems: number;
  maxBytes: number;
}

export const DEFAULT_BATCH_BUDGET: BatchBudget = {
  maxItems: 200,
  maxBytes: 50 * 1024 * 1024,
};

/** 与 ingest.ts 一致的最小 IO 形状（不引入 CLI 依赖，保持分层） */
export interface BatchIO {
  out(text: string): void;
  err(text: string): void;
}

export interface BatchEnumeration {
  inputs: BatchInput[];
  /** 被 I38 排除的条数 */
  excluded: number;
}

export interface BatchPlan {
  totalInputs: number;
  excluded: number;
  duplicates: number;
  todo: number;
  /** 已有 raw 页指向该来源（最终是否跳过由内容指纹决定，预演不断言） */
  existingRaw: number;
  newRaw: number;
  totalBytes: number;
  budget: BatchBudget;
}

export interface PreparedBatch {
  plan: BatchPlan;
  todos: BatchInput[];
}

export type BatchItemStatus =
  | 'ingested'
  | 'skipped-shortcut'
  | 'skipped-duplicate'
  | 'conflict'
  | 'failed';

export interface BatchItemResult {
  input: string;
  status: BatchItemStatus;
  changedPaths: string[];
  created: number;
  updated: number;
  reason?: string;
}

export interface BatchReport {
  total: number;
  ingested: number;
  skippedShortcut: number;
  skippedDuplicate: number;
  conflicts: number;
  failed: number;
  created: number;
  updated: number;
  changedPaths: string[];
  items: BatchItemResult[];
  elapsedMs: number;
}

export interface BatchOptions {
  io?: BatchIO;
  cwd?: string;
  force?: boolean;
  adopt?: boolean;
  overwrite?: boolean;
  budget?: Partial<BatchBudget>;
}

// ── I35 must-abort 分类 ────────────────────────────────────────────

const MUST_ABORT_CODES = new Set([
  'NON_INTERACTIVE',
  'UNSUPPORTED_PLATFORM',
  'BATCH_BUDGET_EXCEEDED',
  'BATCH_NO_INPUT',
]);

/**
 * 是否属于「继续也无意义」的错误 → 整批停机（I35）。
 * ConfigError（配置/凭证/NON_INTERACTIVE）与 SafetyError（平台/越界，fail-closed）
 * 整类必停；其余（LLM 失败、lint、WIKI_CONTENT_CONFLICT）按 I34 逐项容错继续。
 */
export function isMustAbort(err: unknown): boolean {
  if (err instanceof ConfigError || err instanceof SafetyError) return true;
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && MUST_ABORT_CODES.has(code)) return true;
  }
  return false;
}

// ── F17.1 输入枚举 ──────────────────────────────────────────────────

/** 非 file 的 scheme:// 视为 URL（含 file:// 走文件分支） */
function classifyInput(input: string): BatchItemKind {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(input);
  if (m && m[1]!.toLowerCase() !== 'file') return 'url';
  return 'file';
}

/** vault 产出目录（顶层）：绝不当输入，否则重跑会吃掉自己的产出（I38） */
const VAULT_OUTPUT_TOP_LEVEL = new Set(['wiki', 'raw']);

function isExcluded(absPath: string, vaultRoot: string): boolean {
  const rel = path.relative(vaultRoot, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false; // 不在 vault 内 → 不适用
  const parts = rel.split(path.sep).join('/').split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  return parts.length > 1 && VAULT_OUTPUT_TOP_LEVEL.has(parts[0]!);
}

/** 递归收集文件；exts 为 null 表示不筛选后缀。目录级剪掉 SKIP_DIRS */
async function walkFiles(root: string, exts: string[] | null): Promise<string[]> {
  const suffixes = exts?.map((e) => `.${e.toLowerCase().replace(/^\./, '')}`) ?? null;
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(abs);
      } else if (e.isFile() && (suffixes === null || suffixes.some((s) => e.name.toLowerCase().endsWith(s)))) {
        out.push(abs);
      }
    }
  };
  await walk(root);
  return out;
}

/** 极简 glob → 正则：支持 `**`、`*`、`?`（不引入依赖） */
function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < p.length) {
    if (p.startsWith('**/', i)) {
      re += '(?:[^/]+/)*';
      i += 3;
      continue;
    }
    if (p.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }
    const c = p[i]!;
    if (c === '*') {
      re += '[^/]*';
      i += 1;
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** glob 的通配符之前的最长确定前缀（作为遍历起点） */
function globBase(pattern: string): string {
  const parts = pattern.replace(/\\/g, '/').split('/');
  const keep: string[] = [];
  for (const part of parts) {
    if (/[*?]/.test(part)) break;
    keep.push(part);
  }
  return keep.length > 0 ? keep.join('/') : '.';
}

async function readListFile(file: string, cwd: string): Promise<string[]> {
  const raw = await readFile(path.resolve(cwd, file), 'utf8');
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * F17.1：把四种来源解析为去重后的输入列表（字典序稳定排序，D8）。
 * 只读；不做任何写入、不调用 LLM。
 */
export async function resolveBatchInputs(
  spec: BatchSourceSpec,
  opts: { vaultRoot: string; cwd?: string },
): Promise<BatchEnumeration> {
  const cwd = opts.cwd ?? process.cwd();
  const exts = spec.ext && spec.ext.length > 0 ? spec.ext : ['md'];
  const candidates: string[] = [];

  for (const input of spec.inputs ?? []) candidates.push(input);

  if (spec.dir) {
    const root = path.resolve(cwd, spec.dir);
    for (const f of await walkFiles(root, exts)) candidates.push(f);
  }

  if (spec.glob) {
    const base = path.resolve(cwd, globBase(spec.glob));
    const re = globToRegExp(path.resolve(cwd, spec.glob));
    for (const f of await walkFiles(base, null)) {
      if (re.test(f.replace(/\\/g, '/'))) candidates.push(f);
    }
  }

  if (spec.fromFile) {
    for (const line of await readListFile(spec.fromFile, cwd)) candidates.push(line);
  }

  // I38：排除 vault 产出与忽略目录
  const kept = candidates.filter((c) => !isExcluded(path.resolve(cwd, c), opts.vaultRoot));

  const inputs: BatchInput[] = [];
  for (const c of kept) {
    const kind = classifyInput(c);
    if (kind === 'url') {
      // dedupKey 用原始输入：normalizeSourceUrl 对常规 URL 恒等，但形如
      // https://x/a.md 会被其 isFileInput 启发式误判为文件去 realpath，故不经过它
      inputs.push({ input: c, kind, dedupKey: c, sizeBytes: 0 });
      continue;
    }
    try {
      const buf = await readFile(path.resolve(cwd, c));
      inputs.push({
        input: c,
        kind,
        dedupKey: createHash('sha256').update(buf).digest('hex'),
        sizeBytes: buf.length,
      });
    } catch {
      // 读不到（不存在/无权限）→ 仍放入，由 ingest() 报错并计入 failed（不静默丢弃）
      inputs.push({ input: c, kind, dedupKey: `unreadable:${normalizeSourceUrl(c, cwd)}`, sizeBytes: 0 });
    }
  }

  inputs.sort((a, b) => (a.input < b.input ? -1 : a.input > b.input ? 1 : 0));
  return { inputs, excluded: candidates.length - kept.length };
}

// ── F17.2–F17.4 预演：去重 + 预算 + 已有来源页 ───────────────────────

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 解析体积参数：纯数字=字节，支持 K/M/G 后缀（`50M`、`200KB`，大小写不敏感）。
 * 解析失败返回 NaN，由调用方报错。 */
export function parseByteSize(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMG]?)B?$/i.exec(value.trim());
  if (!m) return Number.NaN;
  const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  return Math.round(Number(m[1]) * (mult[m[2]!.toUpperCase()] ?? 1));
}

/**
 * 枚举 → 批内去重（I33）→ 预算闸门（I36）→ 预演统计。
 * 全程零 LLM、零写入；抛 BATCH_NO_INPUT / BATCH_BUDGET_EXCEEDED（均属 must-abort）。
 */
export async function prepareBatch(
  spec: BatchSourceSpec,
  deps: IngestDeps,
  opts: BatchOptions = {},
): Promise<PreparedBatch> {
  const budget: BatchBudget = { ...DEFAULT_BATCH_BUDGET, ...opts.budget };
  const cwd = opts.cwd ?? process.cwd();
  const { inputs, excluded } = await resolveBatchInputs(spec, { vaultRoot: deps.vault.root, cwd });

  const seen = new Set<string>();
  const todos: BatchInput[] = [];
  let duplicates = 0;
  for (const item of inputs) {
    if (seen.has(item.dedupKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(item.dedupKey);
    todos.push(item);
  }

  if (inputs.length === 0) {
    throw new ConfigError('BATCH_NO_INPUT', '没有可处理的来源：输入为空，或全部被排除（vault 产出 / 忽略目录）');
  }

  // I36：预算闸门先于任何 LLM 调用
  const totalBytes = todos.reduce((s, i) => s + i.sizeBytes, 0);
  if (todos.length > budget.maxItems) {
    throw new ConfigError(
      'BATCH_BUDGET_EXCEEDED',
      `待处理 ${todos.length} 个来源，超过上限 ${budget.maxItems}（可用 --max-items 调整）`,
    );
  }
  if (totalBytes > budget.maxBytes) {
    throw new ConfigError(
      'BATCH_BUDGET_EXCEEDED',
      `待处理体积 ${fmtBytes(totalBytes)}，超过上限 ${fmtBytes(budget.maxBytes)}（可用 --max-bytes 调整；URL 不计体积，只计入条目数）`,
    );
  }

  // F17.2：单次收集 raw 来源标识，判「已有来源页」（O(raw 页数)，非 O(n×m)）
  const keys = await collectRawSourceKeys(deps.vault);
  let existingRaw = 0;
  for (const item of todos) {
    const key = item.kind === 'url' ? item.input : normalizeSourceUrl(item.input, cwd);
    if (keys.has(key)) existingRaw += 1;
  }

  return {
    plan: {
      totalInputs: inputs.length,
      excluded,
      duplicates,
      todo: todos.length,
      existingRaw,
      newRaw: todos.length - existingRaw,
      totalBytes,
      budget,
    },
    todos,
  };
}

// ── F17.5–F17.7 执行：顺序、隔离、报告 ───────────────────────────────

/**
 * 顺序执行（I39）。逐项 try/catch：可容错的错误计入报告继续（I34），
 * must-abort 类直接上抛整批停机（I35）。
 *
 * approve 回调在这里还有第二个用途：读取 plan.writes 统计 create/update，
 * 供聚合报告使用（不需要额外扫盘）。
 */
export async function executeBatch(
  todos: BatchInput[],
  deps: IngestDeps,
  opts: BatchOptions & { autoApprove: boolean },
): Promise<BatchReport> {
  const started = Date.now();
  const io = opts.io;
  const items: BatchItemResult[] = [];
  const changedPaths: string[] = [];
  let ingested = 0;
  let skippedShortcut = 0;
  let skippedDuplicate = 0;
  let conflicts = 0;
  let failed = 0;
  let created = 0;
  let updated = 0;
  const seen = new Set<string>();

  for (let i = 0; i < todos.length; i++) {
    const item = todos[i]!;

    // I33 二次去重（executeBatch 可能被独立调用）
    if (seen.has(item.dedupKey)) {
      skippedDuplicate += 1;
      items.push({
        input: item.input,
        status: 'skipped-duplicate',
        changedPaths: [],
        created: 0,
        updated: 0,
        reason: '批内重复',
      });
      continue;
    }
    seen.add(item.dedupKey);

    io?.out(`[${i + 1}/${todos.length}] ${item.input}`);

    let itemCreated = 0;
    let itemUpdated = 0;
    let shortCircuited = false;

    try {
      const res = await ingest(item.input, deps, {
        io: io ? { err: (text: string) => io.err(text) } : undefined,
        force: opts.force,
        adopt: opts.adopt,
        overwrite: opts.overwrite,
        onSkip: () => {
          shortCircuited = true;
        },
        approve: async (ctx: { plan: VaultPlan }) => {
          itemCreated = ctx.plan.writes.filter((w) => w.operationType === 'create').length;
          itemUpdated = ctx.plan.writes.filter((w) => w.operationType === 'update').length;
          return opts.autoApprove;
        },
      });

      if (!res) {
        // 批量下已一次性确认，走到这里说明该项未被批准 → 按失败计，零写入
        failed += 1;
        items.push({
          input: item.input,
          status: 'failed',
          changedPaths: [],
          created: 0,
          updated: 0,
          reason: '未获批准',
        });
        continue;
      }

      changedPaths.push(...res.changedPaths);

      if (shortCircuited) {
        // M14 短路：只刷新 raw 元数据，不计入新建/更新（保持报告语义干净）
        skippedShortcut += 1;
        items.push({
          input: item.input,
          status: 'skipped-shortcut',
          changedPaths: res.changedPaths,
          created: 0,
          updated: 0,
          reason: '内容未变更（M14 短路）',
        });
      } else {
        ingested += 1;
        created += itemCreated;
        updated += itemUpdated;
        items.push({
          input: item.input,
          status: 'ingested',
          changedPaths: res.changedPaths,
          created: itemCreated,
          updated: itemUpdated,
        });
      }
    } catch (err) {
      if (isMustAbort(err)) throw err; // I35：整批停机
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
      const isConflict = code === 'WIKI_CONTENT_CONFLICT';
      if (isConflict) conflicts += 1;
      else failed += 1;
      io?.err(`  ✗ ${item.input} — ${code ? `[${code}] ` : ''}${message}`);
      items.push({
        input: item.input,
        status: isConflict ? 'conflict' : 'failed',
        changedPaths: [],
        created: 0,
        updated: 0,
        reason: message,
      });
    }
  }

  return {
    total: todos.length,
    ingested,
    skippedShortcut,
    skippedDuplicate,
    conflicts,
    failed,
    created,
    updated,
    changedPaths,
    items,
    elapsedMs: Date.now() - started,
  };
}

// ── 输出格式 ────────────────────────────────────────────────────────

export function formatBatchPlan(plan: BatchPlan): string {
  return [
    '批量 ingest 预演（只读，未写入、未调用 LLM）',
    `  输入来源          ${plan.totalInputs}`,
    `  排除（产出/忽略） ${plan.excluded}`,
    `  批内重复剔除      ${plan.duplicates}`,
    `  预计处理          ${plan.todo}`,
    `  已有来源页        ${plan.existingRaw}   ← 最终是否跳过由内容指纹决定`,
    `  待新建来源页      ${plan.newRaw}`,
    `  体积              ${fmtBytes(plan.totalBytes)} / 上限 ${fmtBytes(plan.budget.maxBytes)}`,
    `  条目数            ${plan.todo} / 上限 ${plan.budget.maxItems}`,
    '  URL 不计体积，只计入条目数（D7）',
  ].join('\n');
}

export function formatBatchReport(report: BatchReport): string {
  const lines = [
    `批量 ingest 完成（${report.total} 个来源）`,
    `  已处理            ${report.ingested}`,
    `  新建              ${report.created}`,
    `  更新              ${report.updated}`,
    `  跳过（内容未变更） ${report.skippedShortcut}`,
    `  剔除（批内重复）   ${report.skippedDuplicate}`,
    `  冲突（未写入）     ${report.conflicts}`,
    `  失败              ${report.failed}`,
  ];
  for (const it of report.items) {
    if (it.status === 'failed' || it.status === 'conflict') {
      lines.push(`    ✗ ${it.input} — ${it.reason ?? it.status}`);
    }
  }
  lines.push(`  写入文件          ${report.changedPaths.length}`);
  lines.push(`  耗时              ${(report.elapsedMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
}
