/**
 * Fake ACP agent —— M7 F7.1 测试替身。
 *
 * 一个最小 NDJSON JSON-RPC 服务端，跑在子进程里（被 `ACPAgentBackend` 经
 * `spawnTransport` 拉起）。它说的协议子集与 `src/reasoning/acp/transport.ts`
 * 的 `AcpConnection` 完全对称，因此全链路零网络、确定性可测。
 *
 * 支持的 JSON-RPC 方法：
 *   - initialize      → 返回 { protocolVersion, agentCapabilities, agentInfo }
 *   - session/new     → 返回 { sessionId }
 *   - session/prompt  → 返回 { content, usage? }
 *
 * 剧本经 argv[2] 指向的 JSON 文件控制（避免 Windows 环境变量编码坑）：
 *   { delayMs, malformed, exitBeforeResponse, exitAfterInit,
 *     agentCapabilities, usage, sessionError, initError, ignoreTerm, promptText }
 *
 * 收到的 initialize 握手参数会按 env.ACP_ECHO_INIT_FILE 回写，供 T7.3-01/02 断言。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { argv, env, stdin, stdout, exit } from 'node:process';

const scriptPath = argv[2];
let scenario = {};
try {
  if (scriptPath) scenario = JSON.parse(readFileSync(scriptPath, 'utf8'));
} catch {
  scenario = {};
}

const {
  delayMs = 0,
  malformed = false,
  exitBeforeResponse = false,
  exitAfterInit = false,
  agentCapabilities = { supportsStreaming: false, supportsSessionPersistence: false, supportsToolInvocations: false },
  usage = { inputTokens: 0, outputTokens: 0 },
  sessionError = null,
  initError = null,
  ignoreTerm = false,
  promptText = null,
  omitUsage = false,
} = scenario;

if (ignoreTerm) {
  // 捕获 SIGTERM 但不退出 —— 用于测试 dispose 的超时强杀分支（I5）。
  process.on('SIGTERM', () => {});
}

// 启动标记：写入 env.ACP_STARTED_FILE 表示子进程已拉起（供 T7.4-02 证明未启动）
if (env.ACP_STARTED_FILE) {
  try {
    writeFileSync(env.ACP_STARTED_FILE, '1');
  } catch {
    /* 非致命 */
  }
}

const echoFile = env.ACP_ECHO_INIT_FILE;
let sessionSeq = 0;
let buf = '';

function send(obj) {
  stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function handle(msg) {
  if (delayMs) await sleep(delayMs);
  const id = msg.id;

  if (msg.method === 'initialize') {
    // 每次 initialize 调用累加计数（供 T7.4-05 证明 lazy connect 只初始化一次）
    if (env.ACP_COUNT_FILE) {
      let n = 0;
      try {
        n = Number(readFileSync(env.ACP_COUNT_FILE, 'utf8')) || 0;
      } catch {
        n = 0;
      }
      try {
        writeFileSync(env.ACP_COUNT_FILE, String(n + 1));
      } catch {
        /* 非致命 */
      }
    }
    if (echoFile) {
      try {
        writeFileSync(
          echoFile,
          JSON.stringify({
            protocolVersion: msg.params?.protocolVersion,
            clientCapabilities: msg.params?.clientCapabilities,
            clientInfo: msg.params?.clientInfo,
          }),
        );
      } catch {
        /* 测试环境写入失败不致命 */
      }
    }
    if (initError) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: initError } });
      return;
    }
    if (malformed) {
      // 畸形行：必须被客户端 warn-and-skip，不中断连接（I4 前置）
      stdout.write('this is not valid json :::\n');
    }
    if (exitBeforeResponse) {
      // 收到 initialize 但不回包直接退出 —— 触发「子进程提前退出 → 请求拒绝」
      setTimeout(() => exit(1), 20);
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? 1,
        agentCapabilities,
        agentInfo: { name: 'fake-acp-agent', version: '0.0.0' },
      },
    });
    if (exitAfterInit) setTimeout(() => exit(0), 30);
    return;
  }

  if (msg.method === 'session/new') {
    sessionSeq += 1;
    send({ jsonrpc: '2.0', id, result: { sessionId: `sess-${sessionSeq}` } });
    return;
  }

  if (msg.method === 'session/prompt') {
    if (sessionError) {
      send({ jsonrpc: '2.0', id, error: { code: -32001, message: sessionError } });
      return;
    }
    const text = promptText != null ? promptText : `PONG:${msg.params?.prompt ?? ''}`;
    if (omitUsage) {
      send({ jsonrpc: '2.0', id, result: { content: text } }); // 缺省 usage → 触发后端 ?? 0 分支
    } else {
      send({ jsonrpc: '2.0', id, result: { content: text, usage } });
    }
    return;
  }

  // 未知方法：回一个 result 占位，不致命
  send({ jsonrpc: '2.0', id, result: { note: 'unknown-method' } });
}

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // 客户端发来的畸形行：忽略（服务端同样健壮）
      continue;
    }
    void handle(msg);
  }
});

stdin.on('end', () => {
  // 父进程关闭 stdin：优雅退出
  exit(0);
});
