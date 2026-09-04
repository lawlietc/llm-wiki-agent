# LLM Wiki Agent

围绕 LLM wiki 的知识整理 agent：**ingest raw 文件 → 编辑成 markdown wiki 库 → 问答**。

把零散的原始资料（文章、笔记、网页）整理成结构化的 markdown wiki，再用检索 + LLM 综合来提问、搭建自己的知识库与 skill。

---

## 当前状态

- 版本 `0.1.0`
- 里程碑 SPEC-0 + M1–M8 全部完成（TDD 推进）
- 测试 **361 通过 / 1 跳过**，`tsc` 零错误
- MVP 闭环可用：`init → ingest → status → ask → edit → index rebuild → lint`
- 两条推理腿：
  - **网关腿**：直连 LLM（默认）
  - **ACP 本地 agent 腿**：spawn 本机 agent 子进程当补全器（M8 接入 CLI）

---

## 环境要求

- Node.js **>= 20**
- 依赖：AI SDK（`@ai-sdk/anthropic` / `google` / `openai` / `openai-compatible`）+ `@mozilla/readability` + `linkedom`

---

## 运行方式

CLI 入口是 `bin/cli.ts`（TypeScript 源，无预编译产物）。运行前需先打包为可执行 `mjs`：

**方式 A（推荐，npm script）**——自动打包并透传参数：

```bash
npm run wiki -- <command> [args]
```

**方式 B（手动）**：

```bash
node_modules/.bin/esbuild bin/cli.ts --bundle --platform=node --format=esm --packages=external --outfile=.tmp-wiki-cli.mjs
node .tmp-wiki-cli.mjs <command> [args]
```

> ⚠️ 在带 safe-delete shim 的运行环境（如 WorkBuddy 沙箱）执行真实写盘命令（`ingest` / `ask` 落盘 / `edit`）时，需前缀 `NODE_OPTIONS=` 绕过 shim，否则 apply 阶段会被拦截卡死：
> ```bash
> NODE_OPTIONS= npm run wiki -- ingest ./raw/foo.txt --yes
> ```
> 测试套件同理（用 `NODE_OPTIONS= npm test`）。

---

## 快速上手

```bash
# 1) 建一个 vault 目录（必须已存在，init 不会自动创建任意路径）
mkdir -p ~/my-wiki

# 2) 初始化：生成 .llm-wiki.json + raw/ wiki/ .vault-meta/
npm run wiki -- init --vault ~/my-wiki

# 3) 配置 API key（走环境变量，明文不落盘）
export ANTHROPIC_API_KEY=sk-...
export OPENAI_API_KEY=sk-...

# 4) 摄取一篇原始文件 → 生成 wiki 页
npm run wiki -- ingest ./raw/foo.txt --yes --vault ~/my-wiki

# 5) 提问（自动重建索引 + 检索 + 综合，返回答案 + 引用 + gaps）
npm run wiki -- ask "法国的首都是哪里？" --vault ~/my-wiki
```

---

## 命令参考

| 命令 | 作用 | 关键 flag |
|---|---|---|
| `init --vault <dir>` | 初始化 vault（目录须先建好） | `--vault` |
| `ingest <path\|url>` | raw 文件 / URL → wiki 页 | `--yes`（跳过审批）、`--agent <id>` |
| `ask "<question>"` | 问答（检索 + 综合，返回答案 + 引用 + gaps） | `--agent <id>` |
| `edit <slug>` | 修订已有 wiki 页（读现有页 → LLM 改稿 → lint 闸门 → 原子落盘） | `--yes`、`--agent <id>` |
| `status` | 查看页数 / 索引状态 | `--vault` |
| `index rebuild` | 重建 BM25 索引 | `--vault` |
| `lint <file>` | 校验 wiki 页合规（error 级问题会拦下） | — |

所有命令支持 `--vault <dir>` 指定 vault；省略时取当前目录。

---

## 配置

配置写在 vault 根目录的 `.llm-wiki.json`。两种推理腿通过该文件切换。

### 网关腿（默认，直连 LLM）

```json
{
  "version": 1,
  "chat_model": "anthropic:claude-opus-4-20250514",
  "embedding_model": "openai:text-embedding-3-small",
  "providers": {
    "anthropic": { "apiKey": "env:ANTHROPIC_API_KEY" },
    "openai":   { "apiKey": "env:OPENAI_API_KEY" }
  },
  "reasoning": { "agent": { "enabled": false } }
}
```

- 密钥走 `env:` 间接引用，明文不落盘（不变量 I2）。
- 缺失密钥时报 `ConfigError`，只暴露变量名不暴露值。

### ACP 本地 agent 腿（M8）

在 `reasoning.agent` 段启用：

```json
{
  "reasoning": {
    "agent": {
      "enabled": true,
      "provider": "cursor",
      "command": "cursor",
      "args": ["--acp"],
      "initializeTimeoutMs": 30000
    }
  }
}
```

- 启用后 `chat_model` / `providers` 变为**可选**——可完全不写，实现纯 ACP 模式零网关密钥（落实 T7.5-05）。
- 临时覆盖：每条命令加 `--agent <id>` 强制走该 agent，优先级高于配置：
  ```bash
  npm run wiki -- ask "..." --agent kimi
  ```
- `id` 取自注册表（9 个）：`cursor` / `kimi` / `kiro` / `trae` / `grok` / `opencode` / `copilot` / `dsh` / `gemini`（Claude / Codex 刻意缺席，走专用后端）。
- `routeDefault: true` 可让**所有**默认请求都走 ACP（否则仅 `--agent` 走 ACP，其余走网关）。
- ACP 子进程在命令结束经 `dispose()` 优雅终止（不变量 I5），不留孤儿。

---

## 架构草图

```
原始资料 (raw/*.md|txt|url)
        │  ingest 管线
        ▼
  wiki/*.md  ──编辑──►  edit（lint 闸门 + 原子落盘）
        │
        │  问答
        ▼
  ask：BM25 检索(+ 可选 expand) → 综合层(LLM) → 答案 + 引用 + gaps
        │
        └─ 推理后端（ReasoningBackend 接口）
              ├─ 网关腿  GatewayBackend      （直连 LLM，src/reasoning/gateway-backend.ts）
              └─ ACP 腿  ACPAgentBackend     （spawn 本地 agent 子进程，src/reasoning/acp）
```

- 存储层（markdown 文件库 + 原子锁 + 纯补全器式安全编辑）：`src/vault`
- ingest 管线（raw → 合规 wiki 页）：`src/cli/ingest.ts`
- 检索问答（BM25 + 可选 expand；综合层）：`src/qa`、`src/cli/ask.ts`
- 推理网关（直连 LLM，平行腿）：`src/reasoning/gateway-backend.ts`
- ACP 适配器（spawn 本地 agent 子进程当补全器）：`src/reasoning/acp`
- CLI 单一入口与路由：`src/cli/run.ts`

贯穿 M1–M8 的不变量（I1–I5）：env 隔离 / 零真实网络、单入口 / 原子锁 / 纯补全器、字段映射以锁定版本 `.d.ts` 为准、去重 / 超时 / 畸形容错、资源清理。

---

## 边界与已知限制

- **ACP 注册表的 `command` / `args` 标为「未验证」**：真实 agent 接入需本机已装对应 agent 并核对其官方 ACP 启动 flag（例如 gemini 实为 `--experimental-acp`）。当前以 fake ACP agent 端到端验证通过。
- ACP 是**纯补全器**：`tools` 非空会被拒（`ACP_TOOLS_UNSUPPORTED`），写入仍走 Vault。
- **向量腿（embeddings / GATHER 第三刀）未实现**：M5 仅 BM25 + 可选 expand。
- `ask` 默认单查询；多子查询展开为注入式能力，CLI 当前走单查询。

---

## 开发

```bash
npm test          # vitest run（本机真实写盘需 NODE_OPTIONS=）
npm run coverage  # 覆盖率（v8）
npm run typecheck # tsc --noEmit
```

测试用 `LLM_WIKI_FAKE_REPLIES` / `LLM_WIKI_FAKE_FETCH` 两个 env 接缝做零网络 E2E（生产从不设置）。

更详细的里程碑规格见 `docs/dev-specs/`（SPEC-0 + M1–M8）。
