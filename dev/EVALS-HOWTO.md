# Howto：用 trace 建立评测集（evals）

> 目标：把「参数调优靠感觉」变成「参数调优看数字」。
> 一份 golden + 一次提取 = 一组可比较的指标。

---

## 一、标注标准

对**每一个候选实体**问一个问题：

> **「如果这个实体在知识库里有一个页面，对未来的我 / agent 有用吗？」**

| 标注 | 含义 |
|---|---|
| `y` | 该抽 —— 值得建页或建桩 |
| `n` | 不该抽 —— 噪声，不该建页 |
| `?` | 存疑 —— 现在判不了，不算分 |

**三条原则**

1. **判「该不该存在」，不判「该是什么类型」** —— kind（concept/person）与 outcome（page/stub）是别的问题
2. **以「对未来有用」为准，不以「原文提到了」为准** —— 提到 ≠ 值得建页
3. **边界模糊标 `?`，不要硬猜** —— 硬猜会污染 golden

---

## 二、操作步骤

### 1. 生成对比视图

```bash
cd d:/LFolder/AIProgram/ResearchfotAgent/llm-wiki-agent
npx tsx dev/trace-compare.ts
```

产物：`dev/trace-out/_compare/<文件名>.compare.md`

（前置：该文件已在 `dev/trace-out/<combo>/` 下有 4 组 run。若没有，见第四节「跑一组 run」。）

### 2. 就地填写裁决列

打开 `.compare.md`，找到「候选并排」表，把最后一列 `☐该抽 ☐不该抽` 改成 `y` / `n` / `?`：

```markdown
| 实体 | ss | sc | es | ec | 门理由（各组） | 裁决 |
|---|---|---|---|---|---|---|
| **LLM wiki** | ✅ | ✅ f11 | ✅ | ✅ f11 | prose+defined / hand-linked | y |
| **BM25** | · | ❌ f1 | ❌ | ❌ f1 | aside+named（一致否决） | y |
| **向量检索、知识图谱与 LLM Wiki：RAG 被嘲笑了三年，但企业还是离不开它** | ⚠️ | · | · | · | prose+named（分歧 → stub） | n |
```

**要点**
- 裁决针对**实体本身**（整行），不针对某个参数组 —— 「该不该存在」不随参数变
- 标注时**务必对照「证据片段」节**看原文，别只看门理由
- 拿不准就 `?`

### 3. 提取成 golden（稳定产物）

```bash
npx tsx dev/trace-extract-golden.ts
```

它会读你标好的 `_compare/*.compare.md`，产出 `dev/evals/<文件名>.golden.yaml`：

```yaml
source: raw/我用 WorkBuddy + Obsidian：搭了一套懒人版可进化的AI知识库.md
annotatedAt: 2026-09-23
must_exist: [LLM wiki, Obsidian, BM25, karpathy, ...]
must_not_exist: [向量检索、知识图谱与 LLM Wiki：...]
unsure: [渐进式披露]
```

**为什么要有这一步**：`compare.md` 会被 `trace-compare.ts` 重新生成（覆盖你的标注），而 `golden.yaml` 是稳定的、能进版本、能算分的产物。

### 4. 算分

```bash
npx tsx dev/trace-score.ts
```

输出每个参数组的指标（见第三节）。

---

## 三、标注完成后的指标

| 指标 | 定义 | 回答什么 |
|---|---|---|
| **召回率** | `must_exist` 里被该组抽到的比例 | 该抽的漏了吗 |
| **精确率** | 该组抽出来的里属于 `must_exist` 的比例 | 抽出来的有噪声吗 |
| **factsCoverage** | 带逐字事实的候选占比 | `cited` 值不值它的成本 |

按参数分组输出：

```
standard-single:   召回 18/20=90%  精确 18/24=75%  factsCoverage 0%
standard-cited:    召回 19/20=95%  精确 19/23=83%  factsCoverage 100%
exhaustive-single: ...
```

> **为什么要有 factsCoverage**：`cited` 的计数与 `single` 几乎相同，但成本 ×2~3。
> 它的收益只能从 facts 看出来（实测：single 0 条，cited 101 条）。没有这个指标，`cited` 的收益完全隐形。

---

## 四、跑一组 run（前置操作）

```bash
# 单组（dry-run，不写盘）
npx tsx dev/trace-spike.ts --vault ../TestWiki --out dev/trace-out/<combo> \
  --granularity <standard|exhaustive> --extract-mode <single|cited> "raw/<文件名>.md"

# 4 组全跑（标准对比矩阵）
for combo in "standard single" "standard cited" "exhaustive single" "exhaustive cited"; do
  set -- $combo
  npx tsx dev/trace-spike.ts --vault ../TestWiki --out "dev/trace-out/$1-$2" \
    --granularity "$1" --extract-mode "$2" "raw/<文件名>.md"
done
```

> 注意：ACP 腿**必须串行**（`takeStreamedText` 是共享可变状态，并发会串正文）。
> 单组约 1.5–6 分钟，4 组约 10–16 分钟。

---

## 五、文件地图

```
dev/
├── trace-spike.ts            跑一次 trace（4 组参数由 --granularity/--extract-mode 控制）
├── trace-compare.ts          生成 4 组并排对比视图（← 你标注的地方）
├── trace-extract-golden.ts   从标好的 compare.md 提取 golden.yaml
├── trace-score.ts            用 golden 算各参数组的指标
├── trace-smoke.ts            零网络冒烟（改采集代码后自检）
├── trace/
│   ├── schema.ts             trace 数据模型（单一事实源）
│   ├── align.ts              实体身份对齐（slug 不稳定，必须按 name/aliases 对齐）
│   ├── tracing-backend.ts    LLM 采集装饰器
│   ├── sink.ts               span 树组装 + 确定性序列化
│   ├── render-md.ts          单次 trace 的人读视图
│   └── usage-probe.ts        ACP usage_update 探测
├── evals/
│   └── <file>.golden.yaml    ← 标注产物（稳定、可进版本）
└── trace-out/                运行产物（.gitignore 忽略）
    ├── <combo>/<runId>/      每次 run 的 trace.{json,md} + manifest.json
    └── _compare/<file>.compare.md   ← 你标注的地方
```

---

## 六、常见坑

1. **不要按 slug 比对** —— slug 由 LLM 生成，同一实体可能叫 `raw层`/`raw-ceng`。一切比对走 `align.ts` 的身份键。
2. **`compare.md` 会被覆盖** —— 它由 `trace-compare.ts` 生成。标注完立刻跑 `trace-extract-golden.ts` 存成 golden。
3. **不要硬猜模糊项** —— 标 `?` 比标错好。指标只算 `y`/`n`。
4. **裁决粒度是实体，不是参数组** —— 「BM25 该不该存在」只有一个答案。
5. **对齐有已知边界** —— 同义词（`双向链接` vs `双链`）与拼音（`raw层` vs `raw-ceng`）无法自动归并，compare.md 末尾的「对齐可疑项」会列出来供人工核对。
