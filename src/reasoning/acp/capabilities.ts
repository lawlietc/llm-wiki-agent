/**
 * ACP 能力声明（04 §3 / M7 I1）。
 *
 * ⚠️ 安全底线：host 声明给 agent 的能力。本地 agent 默认**拿不到**你的文件读写权，
 * 写入必须经 Vault（M1）。无论走 ACP 还是专用 SDK 后端，文件权都不交给 agent。
 *
 * `fs.readTextFile` 若需开放（让 agent 只读 vault 供参考）可置 true，但
 * **writeTextFile 永远 false** —— 写入统一走 Vault（04 §3 注释）。
 */

/** host 向 agent 声明的能力（clientCapabilities，由 host 填写） */
export interface ACPClientCapabilities {
  fs?: { readTextFile: boolean; writeTextFile: boolean };
  terminal?: boolean;
}

/** agent 在 initialize 返回时自报的能力（运行时探测用，对应 Paseo AgentCapabilityFlags） */
export interface ACPAgentCapabilities {
  supportsStreaming?: boolean;
  supportsSessionPersistence?: boolean;
  supportsToolInvocations?: boolean;
}

/**
 * 构造 host 侧 clientCapabilities —— fs 读写全关、terminal 关。
 * 这是不可妥协的安全默认值（I1 / T7.3-02 安全回归门）。
 */
export function buildACPClientCapabilities(): Required<ACPClientCapabilities> {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  };
}
