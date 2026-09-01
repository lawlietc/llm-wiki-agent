/**
 * 全产品唯一错误定义处（00 §7 / SPEC-0 §2.2）。
 *
 * 四类语义与上层处理策略：
 * - ConfigError    配置错（key 缺失、model 解析失败、vault 选到非法目录）→ 明确报给用户，提示改正配置
 * - TransientError 可重试（网络抖动、ACP 子进程短暂不可用、超时）      → 自动退避重试，超限上抛
 * - ValidationError 内容/契约错（路径非法、plan 被改、lint 不通过）    → 拒绝本次操作，不改任何文件
 * - SafetyError    安全边界被触（写越界、symlink 逃逸、平台不支持）    → fail-closed，整事务回滚
 *
 * M1–M7 一律 import 本文件，禁止在别处重复定义这四个类。
 */

export class ConfigError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class TransientError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransientError';
  }
}

export class ValidationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class SafetyError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SafetyError';
  }
}
