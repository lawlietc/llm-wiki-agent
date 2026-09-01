/**
 * CLI 命令分发（M6 §4 / F6.4 收口单一入口）。
 *
 * 命令处理函数全部依赖注入（vault/gateway/io 作为参数），本文件负责 argv 解析 +
 * 依赖装配（resolveVaultRoot → createVault → configureGateway → GatewayBackend）+ 错误归一化。
 * `bin/cli.ts` 与单测都调用 `runCli`，保证进程边界与测试使用同一条分发路径。
 *
 * 不变量 I1：审批/确认交互只在各命令处理函数的 CLI 层（经注入的 io.confirm），
 * 本文件不读 stdin。
 */

import { GatewayBackend } from '../reasoning/gateway-backend';
import { configureGateway, type AIGatewayConfig } from '../reasoning/gateway-config';
import type { ReasoningBackend } from '../reasoning/backend';
import { createVault, type Vault } from '../vault/vault';
import { resolveVaultRoot } from '../vault/resolve-root';
import { loadConfig } from './config';
import type { CliIO } from './io';
import { runInit } from './init';
import { runIngest } from './ingest';
import { runAsk } from './ask';
import { runEdit } from './edit';
import { runLint } from './lint';
import { runStatus } from './status';
import { runIndexRebuild } from './index-rebuild';

export interface RunDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io: CliIO;
  /** 测试注入的推理后端（缺省由配置构建真实 GatewayBackend） */
  gateway?: ReasoningBackend;
  /** 测试注入的 vault 根（缺省由 resolveVaultRoot 解析） */
  vaultRoot?: string;
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** 极简 argv 解析：positionals 顺序收集；`--key value` 或 `--key`(bool) */
function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function buildGateway(config: AIGatewayConfig): ReasoningBackend {
  configureGateway(config);
  return new GatewayBackend();
}

function reportError(e: unknown, io: CliIO): void {
  if (e instanceof Error) {
    io.err(`${e.name}: ${e.message}`);
  } else {
    io.err(`Error: ${String(e)}`);
  }
}

/**
 * 执行一条 CLI 命令。返回进程退出码：0 成功 / 1 运行期错误 / 2 用法错误。
 */
export async function runCli(argv: string[], deps: RunDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const io = deps.io;

  if (argv.length === 0) {
    io.err('用法：wiki <init|ingest|ask|edit|lint|index|status> [...]');
    return 2;
  }

  const [cmd, ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);

  try {
    switch (cmd) {
      case 'init': {
        const target = (flags.vault as string) ?? cwd;
        const sel = resolveVaultRoot({ explicit: target, allowUninitialized: true, env, cwd });
        await runInit({ vaultRoot: sel.root, io });
        return 0;
      }

      case 'ingest': {
        const input = positionals[0];
        if (!input) {
          io.err('用法：wiki ingest <path|url> [--yes]');
          return 2;
        }
        const root = deps.vaultRoot ?? resolveVaultRoot({ explicit: flags.vault as string, env, cwd }).root;
        const vault: Vault = createVault(root);
        const gateway = deps.gateway ?? buildGateway(loadConfig(root, env).gateway);
        const res = await runIngest(input, { vault, gateway }, { io, autoApprove: flags.yes === true });
        return res ? 0 : 0; // 用户取消也是正常退出（exit 0）
      }

      case 'ask': {
        const question = positionals.join(' ').trim();
        if (!question) {
          io.err('用法：wiki ask "<question>"');
          return 2;
        }
        const root = deps.vaultRoot ?? resolveVaultRoot({ explicit: flags.vault as string, env, cwd }).root;
        const gateway = deps.gateway ?? buildGateway(loadConfig(root, env).gateway);
        await runAsk(question, { vaultRoot: root, gateway }, { io });
        return 0;
      }

      case 'edit': {
        const slug = positionals[0];
        if (!slug) {
          io.err('用法：wiki edit <slug> [--yes]');
          return 2;
        }
        const root = deps.vaultRoot ?? resolveVaultRoot({ explicit: flags.vault as string, env, cwd }).root;
        const vault: Vault = createVault(root);
        const gateway = deps.gateway ?? buildGateway(loadConfig(root, env).gateway);
        const res = await runEdit(slug, { vault, gateway }, { io, autoApprove: flags.yes === true });
        return res ? 0 : 0;
      }

      case 'lint': {
        const file = positionals[0];
        if (!file) {
          io.err('用法：wiki lint <file>');
          return 2;
        }
        const r = await runLint(file, { io, cwd });
        return r.exitCode;
      }

      case 'index': {
        const sub = positionals[0];
        if (sub !== 'rebuild') {
          io.err('用法：wiki index rebuild');
          return 2;
        }
        const root = deps.vaultRoot ?? resolveVaultRoot({ explicit: flags.vault as string, env, cwd }).root;
        await runIndexRebuild({ vaultRoot: root }, { io });
        return 0;
      }

      case 'status': {
        const root = deps.vaultRoot ?? resolveVaultRoot({ explicit: flags.vault as string, env, cwd }).root;
        const config = loadConfig(root, env);
        const sel = resolveVaultRoot({ explicit: flags.vault as string, env, cwd });
        await runStatus({ vaultRoot: root, source: sel.source, config }, { io });
        return 0;
      }

      default:
        io.err(`未知命令：${cmd}`);
        return 2;
    }
  } catch (e) {
    reportError(e, io);
    return 1;
  }
}
