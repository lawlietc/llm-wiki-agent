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

import { configureGateway } from '../reasoning/gateway-config';
import type { ReasoningBackend } from '../reasoning/backend';
import { resolveReasoningBackend, type ACPAgentConfig } from '../reasoning/acp/router';
import { createVault, type Vault } from '../vault/vault';
import { resolveVaultRoot } from '../vault/resolve-root';
import { loadConfig, type LoadedConfig } from './config';
import type { CliIO } from './io';
import { runInit } from './init';
import { runIngest, runIngestBatch } from './ingest';
import { parseByteSize } from '../ingest/batch';
import { runAsk } from './ask';
import { runEdit } from './edit';
import { runLint } from './lint';
import { runLink } from './link';
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

/**
 * 按配置 + CLI 标志构建推理后端（M8 F8.2）。
 * - `--agent <id>` → 强制走 ACP 腿（acp:<id>），provider 取标志值并继承配置里的 command/args/env 覆盖
 * - 否则若配置 reasoning.agent.routeDefault → 默认也走 ACP
 * - 否则走网关腿（GatewayBackend）
 * ACP 腿不读网关配置；网关不可用时 ACP 仍独立可用（T7.5-05）。
 */
function buildReasoningBackend(
  config: LoadedConfig,
  flags: Record<string, string | boolean>,
): ReasoningBackend {
  if (config.gateway) configureGateway(config.gateway);
  const baseAcp = config.acp;
  let acpConfig: ACPAgentConfig | undefined;
  let model: string | undefined;
  if (typeof flags.agent === 'string' && flags.agent.trim() !== '') {
    const provider = flags.agent.trim();
    acpConfig = {
      enabled: true,
      provider,
      ...(baseAcp?.command !== undefined ? { command: baseAcp.command } : {}),
      ...(baseAcp?.args !== undefined ? { args: baseAcp.args } : {}),
      ...(baseAcp?.env !== undefined ? { env: baseAcp.env } : {}),
      ...(baseAcp?.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: baseAcp.initializeTimeoutMs } : {}),
    };
    model = `acp:${provider}`;
  } else {
    acpConfig = baseAcp;
    if (baseAcp?.routeDefault) model = `acp:${baseAcp.provider ?? 'cursor'}`;
  }
  return resolveReasoningBackend(model, { gatewayConfig: config.gateway, acpConfig });
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
    io.err('用法：wiki <init|ingest|ask|edit|lint|link|index|status> [...]');
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
        const inputs = positionals;
        const dir = typeof flags.dir === 'string' ? flags.dir : undefined;
        const glob = typeof flags.glob === 'string' ? flags.glob : undefined;
        const fromFile = typeof flags['from-file'] === 'string' ? flags['from-file'] : undefined;
        const hasBatchSource = Boolean(dir || glob || fromFile);
        if (inputs.length === 0 && !hasBatchSource) {
          io.err(
            '用法：wiki ingest <path|url> [<path|url> ...] [--dir <d>] [--glob <p>] [--from-file <f>]\n' +
              '                 [--ext md,txt] [--plan] [--max-items N] [--max-bytes 50M]\n' +
              '                 [--yes] [--agent <id>] [--adopt] [--overwrite] [--force]',
          );
          return 2;
        }
        const root = deps.vaultRoot ?? resolveVaultRoot({ explicit: flags.vault as string, env, cwd }).root;
        const vault: Vault = createVault(root);
        const built = !deps.gateway;
        const gateway = deps.gateway ?? buildReasoningBackend(loadConfig(root, env), flags);
        try {
          // M17 F17.8：多输入或显式批量来源 → 批量路径；
          // 单条位置参数仍走原 runIngest，行为与 M16 完全一致（I32）
          if (inputs.length > 1 || hasBatchSource) {
            const maxItemsRaw = flags['max-items'];
            const maxBytesRaw = flags['max-bytes'];
            const maxItems = typeof maxItemsRaw === 'string' ? Number(maxItemsRaw) : undefined;
            const maxBytes = typeof maxBytesRaw === 'string' ? parseByteSize(maxBytesRaw) : undefined;
            if (maxItems !== undefined && !Number.isFinite(maxItems)) {
              io.err('--max-items 必须是数字');
              return 2;
            }
            if (maxBytes !== undefined && !Number.isFinite(maxBytes)) {
              io.err('--max-bytes 必须是体积（如 50M、200KB、1048576）');
              return 2;
            }
            await runIngestBatch(
              {
                inputs,
                dir,
                glob,
                fromFile,
                ext:
                  typeof flags.ext === 'string'
                    ? flags.ext
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    : undefined,
              },
              { vault, gateway },
              {
                io,
                cwd,
                autoApprove: flags.yes === true,
                adopt: flags.adopt === true,
                overwrite: flags.overwrite === true,
                force: flags.force === true,
                planOnly: flags.plan === true,
                maxItems,
                maxBytes,
              },
            );
            return 0;
          }

          const res = await runIngest(
            inputs[0]!,
            { vault, gateway },
            {
              io,
              autoApprove: flags.yes === true,
              adopt: flags.adopt === true,
              overwrite: flags.overwrite === true,
              force: flags.force === true,
            },
          );
          return res ? 0 : 0; // 用户取消也是正常退出（exit 0）
        } finally {
          if (built) await gateway.dispose();
        }
      }

      case 'ask': {
        const question = positionals.join(' ').trim();
        if (!question) {
          io.err('用法：wiki ask "<question>" [--agent <id>]');
          return 2;
        }
        const root = deps.vaultRoot ?? resolveVaultRoot({ explicit: flags.vault as string, env, cwd }).root;
        const built = !deps.gateway;
        const gateway = deps.gateway ?? buildReasoningBackend(loadConfig(root, env), flags);
        try {
          await runAsk(question, { vaultRoot: root, gateway }, { io });
          return 0;
        } finally {
          if (built) await gateway.dispose();
        }
      }

      case 'edit': {
        const slug = positionals[0];
        if (!slug) {
          io.err('用法：wiki edit <slug> [--yes] [--agent <id>]');
          return 2;
        }
        const root = deps.vaultRoot ?? resolveVaultRoot({ explicit: flags.vault as string, env, cwd }).root;
        const vault: Vault = createVault(root);
        const built = !deps.gateway;
        const gateway = deps.gateway ?? buildReasoningBackend(loadConfig(root, env), flags);
        try {
          const res = await runEdit(slug, { vault, gateway }, { io, autoApprove: flags.yes === true });
          return res ? 0 : 0;
        } finally {
          if (built) await gateway.dispose();
        }
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

      case 'link': {
        const root = deps.vaultRoot ?? resolveVaultRoot({ explicit: flags.vault as string, env, cwd }).root;
        const r = await runLink({ vaultRoot: root }, { io, fix: flags.fix === true });
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
