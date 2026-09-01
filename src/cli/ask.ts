/**
 * `wiki ask` 命令（M6 F6.2 / 00 §8.1）。
 *
 * 走 M5 端到端问答；输出 answer + citations + gaps 三段（T6.2-05）。零命中时 gaps 段
 * 提示补充来源（透传 M5 synthesize）。纯 CPU 检索 + 一次 synthesize，无副作用。
 */

import { ask } from '../qa/ask';
import type { ReasoningBackend } from '../reasoning/backend';
import type { SynthesisResult } from '../qa/synthesize';
import { formatAskResult } from './format';
import type { CliIO } from './io';

export interface AskDeps {
  vaultRoot: string;
  gateway: ReasoningBackend;
  /** 透传 hybridRetrieve 的取前 k */
  k?: number;
  /** 可选多子查询展开（M3 GatewayBackend.expand 或注入）；缺席则单查询 */
  expand?: (query: string) => Promise<string[]>;
}

export async function runAsk(
  question: string,
  deps: AskDeps,
  opts: { io: CliIO },
): Promise<SynthesisResult> {
  const result = await ask(question, deps);
  opts.io.out(formatAskResult(result));
  return result;
}
