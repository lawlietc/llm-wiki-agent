# Howto：用 trace 建立评测集（evals）

> 目标：把「参数调优靠感觉」变成「参数调优看数字」。
> 一份 golden + 一次提取 = 一组可比较的指标。
>
> **阅读顺序**：先读「一、标注标准」与「一之二、先读懂你看到的记号」——后者解释 compare.md 里的
> 四组组合、page/stub/drop、`fN` 各是什么意思，以及判决的判据。**不看一之二就标注，会把系统判决误当事实。**

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

## 一之二、先读懂你看到的记号（判决 / 四组 / fN）

标注前必须先读懂 compare.md 里的三类记号，否则会把「系统判决」误当「事实」。

### 2.1 四组参数组合是什么意思

它们是两个**正交参数**的 2×2 排列：

| 组合 | `granularity` | `extractMode` |
|---|---|---|
| `standard-single` | `standard`（默认档） | `single`（默认模式） |
| `standard-cited` | `standard` | `cited`（引用式） |
| `exhaustive-single` | `exhaustive`（穷尽档） | `single` |
| `exhaustive-cited` | `exhaustive` | `cited` |

- **参数 1 `granularity`（想抽多少）**：`standard` = 抽有实质段落的实体（默认）；`exhaustive` = 连**仅被点名**的命名技术/概念也建页。
- **参数 2 `extractMode`（怎么抽）**：`single` = 一次调用同时产出实体+关系；`cited` = 两阶段（先识别骨架 → 再分块引用 → 用原文片段组装事实）。

`standard-single` 是**基线**（两个参数都用默认），其余三组各动一个或两个变量 —— 这样能归因：「召回涨了」是粒度的功劳还是模式的功劳。

> `cited` 与 `single` 的关键区别：`single` 的事实是**模型转述**，`cited` 的事实是**逐字原文**。这也是 `cited` 更贵（多次调用）但 `factsCoverage` 更高的原因。

### 2.2 page / stub / drop 是什么意思

这是每个实体**经过门控后的判决结果**（源码：`applyOutcomeTable`，S135 路由）：

| 判决 | 含义 | 后果 |
|---|---|---|
| `page` ✅ | 建**完整页** | 实体在正文有成段讨论 → 生成完整实体页 |
| `stub` ⚠️ | 建**桩页** | 只被点名/浅提 → 建占位页（一句话摘要，正文待补） |
| `drop` ❌ | **丢弃** | 不该建页 → 连桩都不建 |

对比表中的计数（如 `page 18 / stub 2 / drop 0`）= 该组参数下的判决分布。

### 2.3 判据详解：三个输入 + 判决表

判决需要三个输入，来源**完全不同**（这点对归因至关重要）：

| 输入 | 值域 | 谁算的 | 怎么算 |
|---|---|---|---|
| **`location`** | `prose` / `aside` / `absent` | **代码**（确定性，可复核） | 实体名（含别名）在原文中的出现形态 |
| **`coverage`** | `defined` / `discussed` / `named` | **LLM**（模型自报，可能不准） | 抽取回稿里模型填的字段 |
| **`handLinked`** | `true` / `false` | **代码**（确定性，可复核） | 该名字是否出现在生成页的 `[[...]]` 里 |

**`location` 怎么算**（`classifyCandidate`）：对名字（或任一别名）在原文里找所有出现位置 ——

```
每个出现位置：
  在括号内？           ┐
  或在短列表项里？      ┘ → 记为 aside
（短列表项 = 行首是 - * · 或 1. 2) 这类标记，且该行长度 ≤ 阈值）

所有出现位置都是 aside → location = 'aside'
至少一个在正文          → location = 'prose'
一个都找不到            → location = 'absent'
```

**`coverage` 怎么来**：由 LLM 在抽取回稿里自报（`defined`=原文给出定义；`discussed`=展开讨论；`named`=仅提及）。**它会随 prompt 变化** —— 同一实体在 `standard` 与 `exhaustive` 下可能报不同的 coverage，这不是判决逻辑不稳。

**判决表**（⚠️ 注意顺序：`handLinked` 最先判且直接短路）：

| 优先级 | `location` | `coverage` | 判决 | 理由串 |
|---|---|---|---|---|
| **1** | *任意* | *任意* | **page** | `hand-linked` |
| 2 | `absent` | *任意* | **drop** | `absent` |
| 3 | `prose` | `defined` / `discussed` | **page** | `prose+defined` |
| 4 | `prose` | `named` | **stub** | `prose+named（分歧 → stub）` |
| 5 | `aside` | `defined` / `discussed` | **stub** | `aside+defined（分歧 → stub）` |
| 6 | `aside` | `named` | **drop** | `aside+named（一致否决）` |

**「两道门」的含义**：`location`（代码据原文位置判）与 `coverage`（模型据理解程度判）是两道独立的门：

```
一致认可（prose + defined/discussed） → page
分歧     （prose + named）           → stub（位置说重要，模型说浅）
分歧     （aside + defined/discussed）→ stub（位置说旁注，模型说深）
一致否决（aside + named）            → drop
位置门否决（absent）                  → drop
```

**分歧时给 `stub` 而非直接砍**是保守设计：两边有一个说「重要」就留桩，避免误杀。`stub` 的意义就是「拿不准，先占位」。

### 2.4 `fN` 是什么意思

`f` = **facts（逐字事实）条数**。`f11` = 该实体在该组下有 11 条逐字原文事实。

- `single` 模式**不产出** facts → 该列显示 `✅`（无 `fN`）
- `cited` 模式产出 facts → 显示 `✅ f11`

**为什么这个记号重要**：`single` 与 `cited` 的 page/stub/drop 计数几乎相同（如都 18 page），光看判决**看不出 cited 多花 2~3 倍成本换来了什么**。`fN` 就是答案 —— `cited` 给每个实体补上了逐字原文事实，`single` 一条都没有（实测：single 0/20 候选有 facts，cited 22/22 候选共 101 条）。

### 2.5 怎么读一整行（完整例子）

```
| 实体       | ss    | sc     | es    | ec     | 门理由                      | 裁决 |
| LLM wiki   | ✅    | ✅ f11 | ✅    | ✅ f11 | prose+defined/hand-linked  | y    |
```

读法：该实体 4 组都判 `page`；在 `cited` 两组各有 11 条逐字事实；门理由为 `prose+defined`（正文成段定义）或 `hand-linked`（原文手工链接）；你的裁决 = `y`。

对照行：

```
| BM25       | ·     | ❌ f1  | ❌    | ❌ f1  | aside+named（一致否决）      | y    |
```

读法：该实体在 `standard-single` 下 **`·` = 根本没被提名**；其余三组判 `drop`（`location=aside`——只出现在短列表项；`coverage=named`——模型认为仅点名）；你标 `y` → 意味着「三组都判错了，该抽」→ **指向改门控规则**。

**图例速查**（compare.md 正文也有）：

```
✅ page ｜ ⚠️ stub ｜ ❌ drop ｜ · 未提名 ｜ fN = 带 N 条逐字原文事实
```

### 2.6 为什么要先读懂判决 —— 它决定你「该改代码还是改 prompt」

你的标注（`y`/`n`）和系统判决（page/stub/drop）是**两个独立的东西**：

- **判决** = 系统按规则算的（上面 2.3 的表）
- **标注** = 你按「未来有用吗」判的

两者的**差集**才是有价值的信息：

| 你的标注 | 系统判决 | 含义 |
|---|---|---|
| `y` | `page` | 一致，没问题 |
| `y` | `stub` / `drop` | **系统漏了** → 召回损失 |
| `n` | `stub` / `drop` | 一致，没问题 |
| `n` | `page` | **系统多了** → 精确损失 |

而**归因**（这是 trace 最值钱的地方）：

| 出错的门 | 判据来源 | 该改什么 |
|---|---|---|
| `location` 判错（如 BM25 被当 aside） | **代码**（`classifyCandidate` 的括号/短列表规则） | **改代码** |
| `coverage` 判错（模型报错 defined/named） | **LLM**（随 prompt 变） | **改 prompt** |

**所以标注时看到一条 `drop`，要问自己**：是名字**出现的位置**不该被判 aside（改代码），还是模型**对深度的判断**错了（改 prompt）？两种结论指向完全不同的修复动作。

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
6. **别把「系统判决」当「事实」** —— `page`/`stub`/`drop` 是系统按规则算的**结论**，不是真理。你的 `y`/`n` 才是标准。两者不一致正是你要找的信号（见 2.6）。
7. **判决变化 ≠ 逻辑不稳** —— 同一实体在不同组判决不同（如 stub↔page），通常是因为**模型报的 `coverage` 变了**（`coverage` 来自 LLM，随 prompt 变），而非判决规则不稳。`location` 与 `handLinked` 是确定性的。
