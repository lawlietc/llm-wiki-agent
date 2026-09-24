/**
 * 人工裁决的归因标签（evals 用）。
 *
 * **为什么需要固定标签**：`y`/`n` 只告诉你「变差了」；标签才告诉你「往哪个方向修」。
 * 自由文本理由无法聚合（"这次 7 个噪声里 5 个是哪一类"），标签可以。
 * 标签是「从指标到行动」的桥。
 *
 * 标签设计原则：**每个标签直接对应一个可执行的修复动作**。选不出标签，说明问题还没定位清楚。
 */

export interface ReasonTag {
  /** 标签字面量（写进 compare.md 的那个词） */
  tag: string;
  /** 含义 */
  desc: string;
  /** 该标签指向的修复动作（这是标签的价值所在） */
  fix: string;
}

export const REASON_TAGS: readonly ReasonTag[] = [
  // —— 抽多了（标 n 时常见）——
  {
    tag: '非实体',
    desc: '这个名字根本不该是实体（文件名、路径、变量名、代码片段等）',
    fix: '改抽取后处理：对形如 *.md / a-b-c 的令牌做过筛',
  },
  {
    tag: '通用概念',
    desc: '是个真实概念，但过于通用、非本文专有（如"健康检查""最佳实践"），建页对本文无增量',
    fix: '改抽取 prompt：加"只抽本文有具体论述的、非通用名词"的约束',
  },
  {
    tag: '标题误切',
    desc: '把标题/句子片段误当成了实体名（超长名）',
    fix: '改抽取后处理：过滤超长名（如 > 30 字）；或改 prompt 禁止整句提名',
  },
  {
    tag: '重复提名',
    desc: '同一实体被提了多次（不同 slug 或别名未归并）',
    fix: '改对齐或抽取：同一身份的多次提名在门控前归并',
  },

  // —— 抽少了（标 y 但系统 drop/stub 时常见）——
  {
    tag: '门控过严',
    desc: '实体确实在正文里被讨论，但位置判据（aside/absent）把它误杀了',
    fix: '改代码：classifyCandidate 的括号/短列表规则（location 是代码算的）',
  },
  {
    tag: '深度误判',
    desc: '实体确实展开了讨论，但模型把 coverage 报低了（如报成 named 实际是 discussed）',
    fix: '改 prompt：让模型更准地报 defined/discussed/named（coverage 是模型说的）',
  },
  {
    tag: '链接缺失',
    desc: '本该 hand-linked 保活，但 LLM 写页时没加 wikilink',
    fix: '改 prompt：要求对关键实体加 [[wikilink]]',
  },

  // —— 兜底 ——
  {
    tag: '其他',
    desc: '以上都不贴切（请在 —— 后用文字说明）',
    fix: '（需人工判断；若反复出现同类，考虑新增标签）',
  },
] as const;

/** 标签字面量集合（校验用） */
export const REASON_TAG_SET: ReadonlySet<string> = new Set(REASON_TAGS.map((t) => t.tag));

export function isReasonTag(s: string): boolean {
  return REASON_TAG_SET.has(s.trim());
}
