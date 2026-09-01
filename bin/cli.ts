/**
 * `wiki` CLI 真入口（M6 §4 / F6.4）。
 *
 * 仅负责：env 测试接缝（零网络 E2E 用）+ 装配真实 IO/环境 + 调 runCli。
 * 命令逻辑全在 src/cli/，单测与真实进程共用同一条 runCli 分发路径。
 *
 * 测试接缝（仅当以下 env 变量被设置时激活；生产从不设置）：
 * - LLM_WIKI_FAKE_REPLIES=<json 路径>：安装假 chat transport（关键词→预制回稿）
 * - LLM_WIKI_FAKE_FETCH=<json 路径>：安装假 fetch（url→html body），用于 URL ingest 的零网络 E2E
 * env 读取只发生在启动加载期（与 M3 I1 一致：调用时不读 env）。
 */

import { readFileSync } from 'node:fs';

import { runCli } from '../src/cli/run';
import { realCliIO } from '../src/cli/io';
import { __setChatTransportForTests } from '../src/reasoning/gateway-backend';
import type { ReasoningRequest, ReasoningResult } from '../src/reasoning/backend';

/** 把一次请求摊平成可匹配文本（与 test/fakes/fake-gateway 同款） */
function flattenRequest(req: ReasoningRequest): string {
  const parts: string[] = [];
  if (req.system) parts.push(String(req.system));
  if (req.prompt) parts.push(req.prompt);
  for (const m of req.messages ?? []) {
    if (typeof m.content === 'string') parts.push(m.content);
    else for (const b of m.content) if (b.type === 'text') parts.push(b.text);
  }
  return parts.join('\n');
}

function installFakeTransport(jsonPath: string): void {
  const table = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, string>;
  const entries = Object.entries(table);
  const defaultReply = table[''] ?? '';
  __setChatTransportForTests(async (req): Promise<ReasoningResult> => {
    const flat = flattenRequest(req);
    let text = defaultReply;
    for (const [kw, reply] of entries) {
      if (kw && flat.includes(kw)) {
        text = reply;
        break;
      }
    }
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'fake:fake-model',
      providerId: 'fake',
    };
  });
}

function installFakeFetch(jsonPath: string): void {
  const table = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, string>;
  const fake: typeof fetch = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = table[url] ?? table[''] ?? '<html></html>';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  (globalThis as { fetch: typeof fetch }).fetch = fake;
}

function main(): void {
  const env = process.env;
  if (env.LLM_WIKI_FAKE_REPLIES) installFakeTransport(env.LLM_WIKI_FAKE_REPLIES);
  if (env.LLM_WIKI_FAKE_FETCH) installFakeFetch(env.LLM_WIKI_FAKE_FETCH);

  runCli(process.argv.slice(2), { cwd: process.cwd(), env, io: realCliIO() })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`${String(e)}\n`);
      process.exit(1);
    });
}

main();
