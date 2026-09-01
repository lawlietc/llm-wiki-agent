/**
 * 错误码断言助手。
 *
 * 本项目的错误码在 `code` 字段上，不在 message 里 —— 断言必须查 `code`，
 * 不能用 `toThrow(/CODE/)` 去匹配 message（message 是给人看的中文描述）。
 */

import { expect } from 'vitest';

import { ConfigError, SafetyError, TransientError, ValidationError } from '../../src/errors';

type WikiError = Error & { code: string };

function isWikiError(err: unknown): err is WikiError {
  return (
    err instanceof ConfigError ||
    err instanceof TransientError ||
    err instanceof ValidationError ||
    err instanceof SafetyError
  );
}

/** 执行 fn 并返回错误码；正常返回则为 null；抛出的不是本项目错误则原样上抛（不被断言吞掉） */
export function errorCodeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (isWikiError(err)) return err.code;
    throw err;
  }
}

/** 断言 fn 抛出指定 code 的项目错误（失败时由 vitest 输出期望值/实际值对比） */
export function expectErrorCode(fn: () => unknown, code: string): void {
  expect(errorCodeOf(fn)).toBe(code);
}
