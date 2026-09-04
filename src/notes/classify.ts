/**
 * F13.2 分类判定树与 basis（M13 D3/C2，纯函数零 I/O）。
 *
 * 顺序判定、命中即停。设计要点：
 * - pin（人工 frontmatter entity_kind）优先级最高（I-i）；
 * - 泛化名单（规则 10）紧随其后——stop-list 语义，声明 kind 也不能把导航/罗列词救成页面；
 * - 代码词表（规则 2 的组织后缀 / ADR 正则 / 称谓，规则 4 的别名后缀、规则 6 的决策结构）
 *   在声明 kind **之前**——否则模型声明恒命中、词表永不触发迁移（D3：lexicon ✅ 可触发迁移）；
 * - declaredKind 合法 → basis 'model'（拍板 1.1：declared 并入 model，不设 'declared' 档）；
 * - 规则 3/5/7/8/9/11 的启发式结论同归 'model'（D3：由 prompt 注入产出，天然非确定性）；
 * - rejected 是独立布尔（评审 A1：不建页通道不污染 basis 四档）。
 */

import { ENTITY_KINDS, type EntityKind } from '../ingest/candidate-gate';

export type ClassificationBasis = 'lexicon' | 'model' | 'pin' | 'none';

export interface Classification {
  kind: EntityKind | null; // null = 未确认分类
  basis: ClassificationBasis;
  reason: string;
  /** 规则 10（泛化名单）命中 → 不建页。独立布尔，不并入 basis（basis 保持四档） */
  rejected?: boolean;
}

export interface ClassifyInput {
  name: string;
  aliases?: string[];
  /** 抽取回稿声明的 kind（LLM 产出，可能非法）→ basis 'model' 的信源 */
  declaredKind?: string;
  /** M10 门已算出的信号，喂判定树规则 5/8/9/11 */
  coverage?: 'defined' | 'discussed' | 'named';
  location?: 'prose' | 'aside' | 'absent';
  handLinked?: boolean;
  /** 名字在正文 prose 中的出现次数（主体判据） */
  proseOccurrences?: number;
  /** 人工锁定值（frontmatter entity_kind）→ basis 'pin'，优先级最高 */
  pinnedKind?: string;
}

/* ------------------------------ 词表（代码侧确定性） ------------------------------ */

/** 组织后缀（ASCII / CJK）→ company */
const ORG_SUFFIX_RE =
  /(?:Inc\.?|Ltd\.?|Corp\.?|LLC|GmbH|Co\.|Corporation|Company|Company|公司|集团|银行|大学|研究院|研究所|实验室|基金会|协会|部委)$/i;

/** 称谓（ASCII 前缀 / CJK 后缀）→ person */
const PERSON_TITLE_RE = /^(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sir\.)|女士$|先生$|博士$|教授$|老师$|院士$/;

/** ADR 形态 → decision（规则 2 的正则部分） */
const ADR_NAME_RE = /^(?:ADR[- ]?\d+|决策记录[- ]?\d*)/i;

/** 决策结构词（规则 6 正则）→ decision */
const DECISION_STRUCTURE_RE = /^(?:决定|决议|决策|拍板)/;

/** 泛化名单（规则 10 stop-list）：导航/罗列/常规栏目词，绝不建页 */
const GENERIC_NAME_RE =
  /^(?:其他|其它|相关|相关工具|相关条目|常见|常见问题|参考|参考资料|参见|另见|外部链接|注释|备注|附录|杂项|目录|导航|misc|others?|related|references?|see also|external links|faq|tools?)$/i;

/** prose 出现次数超过该阈值视为样板文本（页脚/导航重复），按泛化名单拒绝 */
const GENERIC_OCCURRENCE_THRESHOLD = 50;

/** 抽象术语后缀（规则 7 词表）→ concept（结论归 model，D3） */
const ABSTRACT_SUFFIX_RE =
  /(?:性|论|学|主义|原则|机制|策略|模式|方法|算法|框架|协议|架构|范式|理论|思想|体系|ism|ology|pattern|principle|framework|protocol|paradigm)$/i;

/** ASCII 产品名形态（规则 9）：CamelCase 或连字小写产品名 */
const PRODUCT_NAME_RE = /^(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:[-_][a-z0-9]+)+|\w+v\d+(?:\.\d+)*)$/;

/** 主体判据（规则 5）：coverage 非 named 且 prose 且出现次数达标 */
const SUBJECT_MIN_OCCURRENCES = 2;

/** 自然人名形态（规则 3）：CJK 2–4 字且无组织/称谓标记 */
const CJK_PERSON_NAME_RE = /^[\u4e00-\u9fff]{2,4}$/;

/* ------------------------------ 判定树 ------------------------------ */

/**
 * 实体分类判定树（顺序判定、命中即停）。
 * 入参 → 规则映射见 M13 §2.1 表。
 */
export function classifyEntity(input: ClassifyInput): Classification {
  const { name, aliases = [], declaredKind, coverage, location, handLinked, proseOccurrences = 0, pinnedKind } = input;
  const norm = name.trim();

  // 规则 0（pin，I-i）：人工锁定值合法 → 直接采信，优先级高于一切
  if (pinnedKind != null && ENTITY_KINDS.has(pinnedKind)) {
    return { kind: pinnedKind as EntityKind, basis: 'pin', reason: `frontmatter entity_kind pin（${pinnedKind}）` };
  }

  // 规则 10 前置（stop-list 语义）：泛化名单绝不建页，声明 kind 也救不回
  if (GENERIC_NAME_RE.test(norm) || proseOccurrences > GENERIC_OCCURRENCE_THRESHOLD) {
    return {
      kind: null,
      basis: 'none',
      reason: proseOccurrences > GENERIC_OCCURRENCE_THRESHOLD ? `prose 出现 ${proseOccurrences} 次，视为样板文本` : '泛化名单命中',
      rejected: true,
    };
  }

  // 规则 2：词表——组织后缀 / ADR 形态 / 称谓（代码侧确定性，✅ 可触发迁移）
  if (ORG_SUFFIX_RE.test(norm)) {
    return { kind: 'company', basis: 'lexicon', reason: '组织后缀命中' };
  }
  if (PERSON_TITLE_RE.test(norm)) {
    return { kind: 'person', basis: 'lexicon', reason: '称谓命中' };
  }
  if (ADR_NAME_RE.test(norm)) {
    return { kind: 'decision', basis: 'lexicon', reason: 'ADR 形态命中' };
  }

  // 规则 1：声明 kind 合法 → model（declared 并入 model，拍板 1.1）
  if (declaredKind != null && ENTITY_KINDS.has(declaredKind)) {
    return { kind: declaredKind as EntityKind, basis: 'model', reason: '抽取回稿声明 kind' };
  }

  // 规则 4：别名中的组织后缀 → lexicon（D3「规则 4 的后缀」）
  if (aliases.some((a) => ORG_SUFFIX_RE.test(a.trim()))) {
    return { kind: 'company', basis: 'lexicon', reason: '别名组织后缀命中' };
  }

  // 规则 3：自然人启发式（model）——CJK 短名 + prose 主体
  if (CJK_PERSON_NAME_RE.test(norm) && location === 'prose' && proseOccurrences >= SUBJECT_MIN_OCCURRENCES) {
    return { kind: 'person', basis: 'model', reason: 'CJK 短名 + prose 主体' };
  }

  // 规则 5：项目/产品且是主体（model）——coverage 非 named + prose + 出现达标
  const isSubject = coverage != null && coverage !== 'named' && location === 'prose' && proseOccurrences >= SUBJECT_MIN_OCCURRENCES;
  if (PRODUCT_NAME_RE.test(norm) && isSubject) {
    return { kind: 'project', basis: 'model', reason: '产品形态名 + 主体判据' };
  }

  // 规则 6：决策结构（正则部分 → lexicon，D3）
  if (DECISION_STRUCTURE_RE.test(norm)) {
    return { kind: 'decision', basis: 'lexicon', reason: '决策结构词命中' };
  }

  // 规则 7：抽象术语（词表；结论归 model，D3）
  if (ABSTRACT_SUFFIX_RE.test(norm)) {
    return { kind: 'concept', basis: 'model', reason: '抽象术语后缀命中' };
  }

  // 规则 8：工具型产品（非主体，coverage=named）→ concept（model）
  if (coverage === 'named') {
    return { kind: 'concept', basis: 'model', reason: 'coverage=named（点名式提及，非主体）' };
  }

  // 规则 9：产品 vs 架构（model）——产品形态名 → project，否则 concept
  if (PRODUCT_NAME_RE.test(norm)) {
    return { kind: 'project', basis: 'model', reason: '产品形态名（非主体）' };
  }

  // 规则 11：wiki-link 测试（model）——作者亲手链接的话题页 → concept
  if (handLinked === true && location === 'prose') {
    return { kind: 'concept', basis: 'model', reason: 'hand-linked 话题页' };
  }

  // 规则 12：兜底——全部未命中，裸未定
  return { kind: null, basis: 'none', reason: '全部规则未命中' };
}
