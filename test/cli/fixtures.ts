/**
 * M6 CLI 测试共享 fixtures（零真实 LLM / 零真实网络）。
 *
 * COMPLIANT 系列是能通过 ai-first lint 闸门的 wiki 回稿（frontmatter 含
 * type/date/ai-first:true/confidence/slug + "## For future agent" 前言）。
 * ASK_JSON 是 synthesize 能解析的综合层 JSON 回稿。
 */

/** 单 slug 合规回稿（slug=vector-db） */
export const COMPLIANT = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: vector-db
---

## For future agent

整理自外部原文。

## 正文

向量数据库用于存储高维向量，常见于 RAG 与推荐系统。
`;

/** slug=alpha-topic 的合规回稿（用于主链路造两页） */
export const COMPLIANT_A = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: alpha-topic
---

## For future agent

alpha 主题页。

## 正文

Alpha 是高维向量检索的代表性场景。
`;

/** slug=beta-topic 的合规回稿 */
export const COMPLIANT_B = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: beta-topic
---

## For future agent

beta 主题页。

## 正文

Beta 是推荐系统的代表性场景。
`;

/** 缺 "## For future agent" 前言 → lint 报 error（AI_FIRST_LINT） */
export const LINT_DIRTY = `---
type: project
date: 2026-09-01
ai-first: true
confidence: high
slug: vector-db
---

没有前言的脏页。
`;

/** ask 综合层 JSON 回稿（synthesize.extractJson 可解析；citations 须为 [[]] 锚点形式） */
export const ASK_JSON = JSON.stringify({
  answer: '巴黎是法国的首都。',
  citations: ['[alpha-topic]', '[vector-db]'],
  gaps: ['需要人口数据'],
});
