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

import { spawn, type ChildProcess } from 'node:child_process';
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
  spawnError: Promise<never>;
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
      child.once('error', (e: Error) => {
        this.exited = true;
        rej(new Error(`${e}\n${this.stderrChunks.join('')}`));
      });
    });
    child.on('exit', (code, sig) => {
      this.exited = true;
      if (!this.closing) this.failAll(new Error(`ACP 子进程提前退出 code=${code} signal=${sig}`));
    });
    this.stream = createLoggedNdJsonStream(child.stdout!, onWarn);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (!this.stream) return;
    try {
      for await (const msg of this.stream) {
        this.dispatch(msg as { id?: number; result?: unknown; error?: { message?: string } });
      }
    } catch (e) {
      if (!this.closing) this.failAll(e as Error);
    }
  }

  private dispatch(msg: { id?: number; result?: unknown; error?: { message?: string } }): void {
    if (typeof msg.id !== 'number') return; // 通知（无 id）忽略
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`ACP 错误响应: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
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

  /** 关闭子进程：SIGTERM 优雅 + 超时 SIGKILL 强杀（I5） */
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
      child.kill('SIGKILL');
      const force = new Promise<void>((res) => setTimeout(res, timeoutMs));
      await Promise.race([exited, force]);
    }
  }
}

/** 拉起 agent 子进程并建立连接 */
export function spawnTransport(
  command: string,
  args: string[],
  env: Record<string, string>,
  onWarn: (msg: string) => void = () => {},
): SpawnedAgent {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
