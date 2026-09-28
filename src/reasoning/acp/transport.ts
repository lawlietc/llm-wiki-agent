/**
 * ACP 传输层（04 §2 / M7 F7.2+F7.3）。
 *
 * 子进程拉起 + stdio 上的 NDJSON JSON-RPC。本实现是 `@agentclientprotocol/sdk`
 * 的 `ClientSideConnection` 形态的最小、确定性子集（见 M7 汇报的取舍说明）：
 * 协议我们自己掌控，fake agent 说同一套，全链路零网络、沙箱可 TDD。
 *
 * 关键能力：
 * - `spawnTransport`：spawn + 断言三管道 + 累积 stderr（用于错误诊断）
 * - `createLoggedNdJsonStream`：按 \n 切行、畸形行 warn-and-skip（I4）、半行留 buffer（T7.2-04）
 * - `AcpConnection`：JSON-RPC 请求/响应按 id 关联；子进程提前退出 → 拒绝在途请求
 * - `initializeTransport`：握手 + 超时 + spawnError 竞速
 * - `terminate`：SIGTERM 优雅 + 超时 SIGKILL（I5）
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { type Readable } from 'node:stream';

import { TransientError } from '../../errors';
import { buildACPClientCapabilities, type ACPAgentCapabilities } from './capabilities';
import { toACPRequestError } from './errors';

/** 协议版本（本产品子集固定为 1；真实 ACP 协商会更复杂，此处按 MVP 收敛） */
export const ACP_PROTOCOL_VERSION = 1;

export const CLIENT_INFO = { name: 'LLM-Wiki-Agent', version: '0.1.0' } as const;

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: ACPAgentCapabilities;
  agentInfo: { name: string; version: string };
}

export interface SpawnedAgent {
  child: ChildProcess;
  connection: AcpConnection;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** 客户端能收到的服务端消息：请求响应（有 id）或通知（有 method 无 id） */
type AcpServerMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: {
    update?: {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    };
  };
};

function assertChildWithPipes(child: ChildProcess): boolean {
  return !!(child.stdin && child.stdout && child.stderr);
}

/**
 * 把 Node Readable 切成 NDJSON 行，逐行 JSON.parse。
 * 畸形行仅 warn 跳过（不中断连接，I4）；半行（无换行截断）留在 buffer 等下一块。
 */
export async function* createLoggedNdJsonStream(
  readable: Readable,
  onWarn: (msg: string) => void,
): AsyncIterableIterator<unknown> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of readable) {
    buf += dec.decode(chunk as Buffer, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        onWarn(`ACP 畸形 NDJSON 行已跳过: ${line.slice(0, 120)}`);
      }
    }
  }
}

export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrChunks: string[] = [];
  private closing = false;
  private exited = false;
  /** 已收到任意响应（区分「spawn 即失败」与「连接后中途死亡」，F9.3） */
  private gotAnyResponse = false;
  /** session/update 通知累积的正文（真实 ACP 如 opencode 经此推送，F9.1） */
  private streamedText = '';
  spawnError: Promise<never>;
  private rejectSpawnError: (e: Error) => void = () => {};
  private stream?: AsyncIterableIterator<unknown>;

  constructor(
    private readonly child: ChildProcess,
    onWarn: (msg: string) => void,
  ) {
    if (!assertChildWithPipes(child)) {
      // 管道缺失（如 spawn 失败）→ 不抛，靠 spawnError 竞速归一化（T7.2-02）
      this.spawnError = new Promise<never>((_, rej) => {
        child.once('error', (e: Error) => rej(new Error(`${e}`)));
      });
      return;
    }
    child.stderr!.on('data', (c: Buffer) => this.stderrChunks.push(c.toString()));
    this.spawnError = new Promise<never>((_, rej) => {
      this.rejectSpawnError = rej;
      child.once('error', (e: Error) => {
        this.exited = true;
        rej(new TransientError('ACP_SPAWN_FAILED', `${e}\n${this.stderrChunks.join('')}`));
      });
    });
    child.on('exit', (code, sig) => {
      this.exited = true;
      if (!this.closing) {
        if (!this.gotAnyResponse) {
          // 任何响应前即退出 → 视为启动失败（F9.3：Windows 下 shell 找不到命令是 exit 而非 error 事件）
          this.rejectSpawnError(
            new TransientError('ACP_SPAWN_FAILED', `ACP 子进程启动即退出 code=${code} signal=${sig}`),
          );
        } else {
          this.failAll(new Error(`ACP 子进程提前退出 code=${code} signal=${sig}`));
        }
      }
    });
    this.stream = createLoggedNdJsonStream(child.stdout!, onWarn);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (!this.stream) return;
    try {
      for await (const msg of this.stream) {
        this.dispatch(msg as AcpServerMessage);
      }
    } catch (e) {
      if (!this.closing) this.failAll(e as Error);
    }
  }

  /**
   * 服务端消息分发：
   * - 通知（有 method 且无 id）：真实 ACP 经 session/update 推送正文/思考，须消费（F9.1）
   * - 请求响应（有 id）：按 id 关联
   * - 其它（无 id 无 method）：忽略
   */
  private dispatch(msg: AcpServerMessage): void {
    if (msg.method && msg.id === undefined) {
      this.handleNotification(msg);
      return;
    }
    if (typeof msg.id !== 'number') return;
    this.gotAnyResponse = true;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`ACP 错误响应: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  }

  /** 消费 session/update 通知：累积 agent_message_chunk 正文，排除 agent_thought_chunk（F9.1） */
  private handleNotification(msg: AcpServerMessage): void {
    if (msg.method !== 'session/update') return;
    const upd = msg.params?.update;
    if (!upd || upd.sessionUpdate !== 'agent_message_chunk') return;
    const content = upd.content;
    if (content && content.type === 'text' && typeof content.text === 'string') {
      this.streamedText += content.text;
    }
  }

  /**
   * 取走累积的通知正文（取后清空）。
   * 真实 ACP（opencode）的回答经无 id 的 session/update 推送，response 体无 content；
   * 纯补全器后端在 prompt 响应后调用此方法拿正文，取不到时回退 response.content（F9.2）。
   */
  takeStreamedText(): string {
    const t = this.streamedText;
    this.streamedText = '';
    return t;
  }

  /**
   * 清空流式正文缓冲（**发 prompt 前**调用，见 backend.complete）。
   *
   * 为什么需要：`session/update` 通知**不带请求 id**，无法从协议层判断某个 chunk
   * 属于哪次 prompt。若上一次 prompt 的尾部 chunk 晚于其响应到达，就会滞留在缓冲里，
   * 被下一次 prompt 的 `takeStreamedText()` 取走 —— 症状是回稿里出现
   * **上一条回答的尾巴 + 本次完整回答** 的拼接（实测：skeleton 回稿里前 5268 字节
   * 属上一次、其后是一份完整 JSON，导致 `EXTRACT_PARSE_FAILED` 并触发 CITED_FALLBACK）。
   *
   * 在发 prompt 前清空，保证每次请求的缓冲从空开始：滞留的旧块被**丢弃**而非拼接。
   * 这是「宁可丢尾巴，不可污染下一次」的取舍——旧块本就属于已完成的请求，无价值。
   */
  resetStreamedText(): void {
    this.streamedText = '';
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
  }

  /** 发送一个 JSON-RPC 请求并等待匹配 id 的响应 */
  request<T = unknown>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.exited) return Promise.reject(new Error('ACP 子进程已退出'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} 超时 ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(obj: unknown): void {
    if (!this.child.stdin) return; // 管道缺失（spawn 失败）→ 不抛，靠 spawnError 竞速
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** 关闭子进程：SIGTERM 优雅 + 超时强杀（I5） */
  async terminate(timeoutMs = 2_000): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (child.exitCode != null) return;
    const exited = new Promise<void>((res) => child.once('exit', () => res()));
    child.kill('SIGTERM');
    const grace = new Promise<void>((res) => setTimeout(res, timeoutMs));
    await Promise.race([exited, grace]);
    if (child.exitCode == null) {
      // 优雅窗口内未退出 → 强杀（I5 超时强杀路径）
      if (process.platform === 'win32') {
        // Windows 下 SIGKILL 对部分子进程无效（实测 opencode 残留孤儿），用 taskkill 杀整棵进程树
        try {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        } catch {
          /* 忽略 */
        }
      } else {
        child.kill('SIGKILL');
      }
      const force = new Promise<void>((res) => setTimeout(res, timeoutMs));
      await Promise.race([exited, force]);
    }
  }
}

/** Windows：裸命令（npm 全局 CLI 的 shim，无 .exe 扩展）需经 shell 解析；
 * 绝对路径带扩展名（如 .../opencode.exe、node.exe）可直接 spawn。
 * 非 Windows 一律不启用 shell（POSIX 下 shim 可直接 exec）。 */
function shouldUseShell(command: string): boolean {
  if (process.platform !== 'win32') return false;
  const base = command.replace(/^.*[\\/]/, '');
  return !/\.[a-z0-9]+$/i.test(base);
}

/** 拉起 agent 子进程并建立连接 */
export function spawnTransport(
  command: string,
  args: string[],
  env: Record<string, string>,
  onWarn: (msg: string) => void = () => {},
): SpawnedAgent {
  const opts: SpawnOptions = { env, stdio: ['pipe', 'pipe', 'pipe'] };
  if (shouldUseShell(command)) opts.shell = true; // F9.3：Windows 裸命令经 shell 解析 .cmd shim
  const child = spawn(command, args, opts);
  const connection = new AcpConnection(child, onWarn);
  return { child, connection };
}

/**
 * 与 agent 完成 initialize 握手（能力协商）。
 * 竞速：握手请求 vs spawnError vs 超时。initialize 超时专用 ACP_INITIALIZE_TIMEOUT。
 */
export async function initializeTransport(
  t: SpawnedAgent,
  initializeTimeoutMs = 30_000,
): Promise<InitializeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = initializeTimeoutMs
    ? new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`ACP initialize 超时 ${initializeTimeoutMs}ms`)),
          initializeTimeoutMs,
        );
      })
    : null;
  try {
    return (await Promise.race([
      t.connection.request(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: buildACPClientCapabilities(),
          clientInfo: CLIENT_INFO,
        },
        initializeTimeoutMs || 0,
      ),
      t.connection.spawnError,
      ...(timeoutP ? [timeoutP] : []),
    ])) as InitializeResult;
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (msg.includes('initialize 超时')) {
      throw new TransientError('ACP_INITIALIZE_TIMEOUT', msg);
    }
    throw toACPRequestError(e);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
