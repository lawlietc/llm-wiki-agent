/**
 * ACP 错误归一化（04 §7 / M7 I5）。
 *
 * 对应 HAPI `summarizeACPRequestError` / Paseo `toACPRequestError`：
 * 把子进程/协议层错误归一成 `TransientError`（可重试）/ `ConfigError`（配置错）。
 *
 * 错误码：
 * - ACP_SPAWN_FAILED   （Transient）子进程启动失败（ENOENT / spawn 错误）
 * - ACP_TIMEOUT        （Transient）一般超时
 * - ACP_INITIALIZE_TIMEOUT（Transient）initialize 握手超时（initializeTransport 专用）
 * - ACP_ERROR          （Config）agent 返回业务错误 / 其它配置问题
 */

import { ConfigError, TransientError } from '../../errors';

/** 把未知错误归一化为 ConfigError / TransientError */
export function toACPRequestError(err: unknown): Error {
  const e = err as { code?: string; message?: string } | null;
  const msg = String(e?.message ?? err);

  if (e?.code === 'ENOENT' || /spawn|ENOENT/i.test(msg)) {
    return new TransientError('ACP_SPAWN_FAILED', `agent 子进程启动失败：${msg}`);
  }
  if (/timed out|timeout/i.test(msg)) {
    return new TransientError('ACP_TIMEOUT', msg);
  }
  return new ConfigError('ACP_ERROR', `agent 返回错误：${msg}`);
}
