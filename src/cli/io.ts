/**
 * CLI I/O 抽象（M6 §4 实现指引：命令处理函数依赖注入）。
 *
 * 把 stdout/stderr/stdin 与「是否 TTY」抽出来，单测注入假 IO（自动应答 approve、
 * 捕获输出做断言），E2E 用真实 IO。关键不变量 I1（审批归属 CLI 层）即落在 `confirm`。
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';

export interface CliIO {
  /** 写一行到 stdout（自动补换行） */
  out(text: string): void;
  /** 写一行到 stderr（自动补换行） */
  err(text: string): void;
  /** 是否交互终端（非 TTY 环境不能向 stdin 提问，必须 --yes） */
  isTTY: boolean;
  /** 向用户确认（返回 true=确认）；真实实现走 readline 读 'y'/'n' */
  confirm(prompt: string): Promise<boolean>;
}

/** 真实 IO：直连 process.stdout/stderr + readline。
 * out/err 用同步 writeSync：spawn 本地 agent 子进程（Windows shell:true）后，
 * 异步的 process.stderr.write 缓冲可能被子进程干扰而丢失，导致错误输出不可见；
 * 同步写 fd 1/2 最稳（F9.5 真实 CLI 端到端修复）。 */
export function realCliIO(): CliIO {
  return {
    out: (t) => fs.writeSync(1, t + '\n'),
    err: (t) => fs.writeSync(2, t + '\n'),
    isTTY: Boolean(process.stdin.isTTY),
    confirm: async (prompt) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = await new Promise<string>((resolve) => rl.question(prompt, resolve));
        return ans.trim().toLowerCase() === 'y';
      } finally {
        rl.close();
      }
    },
  };
}

/** 测试用假 IO：捕获输出，confirm 按队列返回预设答案 */
export interface FakeCliIO extends CliIO {
  outLines: string[];
  errLines: string[];
  /** 待消费的 confirm 答案队列（'y'/'n'）；用完默认 false */
  answers: string[];
}

export function fakeCliIO(opts: { isTTY?: boolean; answers?: string[] } = {}): FakeCliIO {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const answers = [...(opts.answers ?? [])];
  return {
    out: (t) => outLines.push(t),
    err: (t) => errLines.push(t),
    isTTY: opts.isTTY ?? false,
    confirm: async () => {
      const a = answers.shift();
      return a === 'y' || a === 'Y';
    },
    outLines,
    errLines,
    answers,
  };
}
