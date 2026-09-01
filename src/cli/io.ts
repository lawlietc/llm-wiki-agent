/**
 * CLI I/O 抽象（M6 §4 实现指引：命令处理函数依赖注入）。
 *
 * 把 stdout/stderr/stdin 与「是否 TTY」抽出来，单测注入假 IO（自动应答 approve、
 * 捕获输出做断言），E2E 用真实 IO。关键不变量 I1（审批归属 CLI 层）即落在 `confirm`。
 */

import * as readline from 'node:readline';

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

/** 真实 IO：直连 process.stdout/stderr + readline */
export function realCliIO(): CliIO {
  return {
    out: (t) => process.stdout.write(t + '\n'),
    err: (t) => process.stderr.write(t + '\n'),
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
