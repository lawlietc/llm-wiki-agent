/**
 * must-abort 分类器（M17 I35；M20 工单 04 抽到中立模块）。
 *
 * **为什么单独一个模块**：`ingest()` 内部对「实体抽取失败」有 I28 的降级 catch，
 * 而 `executeBatch()` 依赖 I35 的「整批停机」——若抽取层的 catch 把 ConfigError
 * （凭证缺失 / NON_INTERACTIVE / 预算超限）一并吞掉，批量就再也收不到停机信号：
 * 一个本该立刻停下的错误会被降级成 N 次无意义的重复失败。
 *
 * 分类器必须被**两条腿**共用（写侧编排 `ingest` 与批量调度 `batch`），
 * 而 `batch.ts` 已经 import `ingest.ts`（反向依赖会成环）→ 故落下到此中立处。
 * `batch.ts` 保留同名 re-export，M17 的公开面不变。
 */

import { ConfigError, SafetyError } from '../errors';

/** 需要识别为 must-abort 的错误码（配置/安全/预算类：继续也无意义） */
export const MUST_ABORT_CODES = new Set([
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
