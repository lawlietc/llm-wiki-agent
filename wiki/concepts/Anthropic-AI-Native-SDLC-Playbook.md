---
date: 2026-08-26
type: concept
slug: anthropic-ai-native-sdlc-playbook
tags: [concept, sdlc, ai-native, agentic-coding, anthropic, playbook]
ai-first: true
confidence: stated
source: "https://mp.weixin.qq.com/s/3Mh8CNQewKmU2I8nePnxrA"
source-title: "Anthropic 官方指南：AI Native 开发手册"
source-author: "金色传说大聪明"
source-date: 2026-08-26
original-author: "Louis Claxton (Anthropic)"
original-source: "The AI-Native SDLC Playbook (Anthropic blog, 2026-08-21)"
---

## For future agent

Distilled from Anthropic's official "AI-Native SDLC Playbook" (published 2026-08-21, Chinese translation via WeChat 2026-08-26). The source argues that traditional [[SDLC]]s are bottlenecked by human-speed processes surrounding the now-AI-accelerated build phase, and proposes a re-engineered cyclic flow where AI is embedded in every stage while humans remain at approval gates. Core pattern: each stage commits an artifact (`.md` or code diff) to version control; the next stage begins by reading that artifact. Key concepts include `intent.md` as the universal handoff artifact, [[CLAUDE.md]] as institutional knowledge, skills as executable policy, hooks as deterministic guardrails, and eval suites as regression traps. All claims below are sourced directly from the original text (confidence: stated).

---

## Core Thesis

- Traditional [[SDLC]] design assumed writing and implementing code was the most expensive phase; that premise no longer holds — the source cites App Store revenue declining for the first time in a decade as evidence the "vanilla era" is over (source: Anthropic blog, 2026-08-21)
- When [[Agentic AI]] accelerates the build phase, three consequences follow:
  1. **Bottlenecks shift** to adjacent stages (planning, review/testing, deployment) that still run at human speed
  2. **Governance controls disconnect from reality** — line-by-line review cannot keep pace with agent-generated diffs
  3. **Governance cost rises** because exception-handling still runs on weekly/monthly meeting cadence
- The source uses the security review bottleneck as a concrete example: security teams are staffed for human output levels; when agents multiply code output, either the review queue grows unboundedly or code ships unreviewed — regulated organizations can tolerate neither

## What Is AI-Native SDLC

- A redesigned [[SDLC]] loop that embeds AI at every node while keeping humans in the loop for judgment calls
- Flows from linear to cyclic: each stage ends by committing an artifact to version control; the next stage begins by reading that artifact
- The committed artifact chain itself becomes the audit trail — who requested what, what the agent produced, who approved it
- The source frames this as a one-time platform/engineering investment; once the repository is set up, non-technical users interact via connectors (e.g. a GitHub connector that lets [[Claude]] submit Markdown on their behalf)

## The Committed Artifact Pattern

The central handoff mechanism. Every stage ends with a version-controlled artifact:

1. `intent.md` (approved) triggers requirements and design
2. `spec.md` (approved) triggers plan mode
3. `plan.md` (approved) triggers implementation
4. Code diff + tests (merged) triggers CI/CD
5. Monitoring metric breach writes the next `intent.md` — closing the loop

Early-stage artifacts are `.md` files because both product owners and agents can read them. From the build phase onward, artifacts are code and its records.

Human attention shifts from reviewing every edit to **reviewing agent-flagged content at each gate**.

## Stage-by-Stage Play

The source describes six non-linear stages, each as a "Play" with: what changed, how to start, concrete steps, governance considerations, and measurement. Plays are modular — organizations can prioritize different stages independently. A stage ends when it commits its artifact; that commit simultaneously triggers the next stage.

### 1. Intent (`intent.md`)

- Origin: idea, ticket, or alert
- Process: initiator describes the problem to [[Claude]] in plain language (no formal language required), iterates via brainstorming until the idea crystallizes, Claude drafts `intent.md` per org template (the template can be encoded as a skill)
- The source specifies a five-step flow: (1) describe in own words → (2) brainstorm until concrete — Claude asks scope/user/constraint/success questions → (3) Claude writes `intent.md` per template → (4) initiator corrects misunderstandings → (5) submit to shared repo; author + timestamp recorded
- Governance: author and timestamp are embedded in the commit; product owner approves or rejects via merge/close
- No git experience needed from initiator — a GitHub connector can submit on their behalf in [[Claude]]/Cowork
- The source provides a sample `intent.md` (claims status self-service) showing: Author, Status, Problem, Proposed Outcome, Affected Users and Systems, Constraints — though the sample is truncated in the source

### 2. Requirements and Design (`spec.md`)

- Product owner attaches `intent.md` to a [[Claude]] session loaded with org skills (brand, security, compliance, UX)
- Claude generates `spec.md`; product owner reviews (but does not write) the spec
- Product owner resolves flagged concerns with relevant policy owners before engineering sees the spec
- Governance: skills are applied at write time, not discovered weeks later in review; spec + prompt + skill versions are all version-controlled

### 3. Build Phase

#### Claude Code Plan Mode (default entry)

- Engineer gives `spec.md` + `intent.md` to [[Claude Code]] in plan mode
- Iterates until the plan is clear enough that an engineer who never saw the conversation could execute it
- Submits approved plan as `plan.md`
- Governance: design review happens before any code generation; [[Claude Code]] cannot edit files until plan is accepted

#### Claude Code Auto Mode

- After plan approval, Claude applies changes automatically without per-edit confirmation
- As [[CLAUDE.md]], skills, hooks, and test suites mature, auto-accept becomes the default
- Attention shifts from watching every edit to **reviewing outputs after longer autonomous sessions**

#### CLAUDE.md

- Repository-level knowledge file read at session start: conventions, commands, architecture, common mistakes
- Rule of thumb: if Claude makes the same mistake twice, the correction goes into `CLAUDE.md`
- Keep to one page

#### Skills (Institutional Knowledge as Executable Policy)

- Version-controlled instructions in `.claude/skills/` that ship with code
- Applied as constraints during spec/build/review; strategy changes update the skill, engineers get the new version at next session
- Skills are advisory; for policies that must never be violated, back them with a deterministic [[Hook]]

#### Hooks (Deterministic Guardrails)

- Run on every matching operation; must be fast and scoped to changed files in the build phase
- Examples: block edits to protected paths, run formatter/linter after edits, block credentials in diffs
- Heavier checks (full test suites) belong at commit or PR stage

#### Parallel Sessions and Sub-agents

- **Parallel sessions**: separate [[Claude Code]] instances in independent git worktrees for independent tasks; engineer is the only shared state
- **Sub-agents**: run within a single session, own context window + tool permissions; good for repeated verification tasks
- Defined as Markdown in `.claude/agents/`

#### Feedback Loop

- Always give Claude a way to verify its own work (tests, build, screenshot diff)
- Session self-checks, self-corrects, then engineer sees the result
- Bug fix workflow: write failing test first, let Claude reproduce it as a test, confirm expected failure, then fix code (not test)
- Hook protects test files from being weakened during fix

### 4. Test Phase

#### CI Eval

- Eval suite = test suite that runs when agent config changes (model swap, prompt edit)
- Platform engineers collect 20-50 real tasks with expected outcomes; each becomes an eval
- **Every production incident becomes a permanent regression eval**

#### AI-Assisted PR Review

- Claude reviews incoming PRs against org strategy AND handles its own PR review comments
- Technical lead writes review strategy in `REVIEW.md` (bug/security/compliance dimensions, importance definitions)
- Review conclusions feed back into `CLAUDE.md` — second-time-seen errors get corrected inline
- Governance: code-writing agent cannot approve its own code; human approval via branch protection

### 5. Deploy Phase

#### Hooks as Approval Gates

- Unlike build-phase hooks (allow/block without human), deploy hooks can **pause until specific human approval**
- Non-negotiable hooks live in platform-managed settings; individual engineers cannot disable them
- Gate conditions execute every time, for everyone; allow/block decisions are timestamped

#### CI/CD Integration

- Run [[Claude Code]] non-interactively in pipeline (`claude -p`); sandbox for long-running agents
- Agent capabilities exposed via [[MCP]] (Model Context Protocol)
- Graduated autonomy by environment: dev = free deploy, staging = between, prod = agent prepares release, release manager authorizes
- Agent has no direct push-to-main path; everything goes through branch protection as a PR
- **Rollback should be the most-rehearsed path** in any pipeline

### 6. Ops and Loop Closure

- Monitoring agent watches production metrics; deterministic script (no model involvement) detects anomalies via rolling window + Western Electric rules
- Response tiers defined in config (e.g., `bands.yaml`): 1σ = log, 2σ = read-only diagnosis, 3σ = propose PR or trigger runbook
- Agent writes diagnosis as `intent.md` in stage 1 format, entering the normal flow — the loop self-feeds
- Use cases: CI failure rate spike (isolate flaky test or open revert PR), post-deploy 5xx spike (trigger rollback), PR cycle time drift (write leadership report)

#### Claude Tag (Slack/Teams Integration)

- Claude joins incident channel as its own identity; first responder on new incidents
- Conversation + institutional knowledge stay in channel history for auditability
- Small fixes become PRs; larger work becomes `intent.md` entering stage 1 — the loop self-feeds

## Key Design Principles

| Principle | Implementation |
|---|---|
| Human judgment at center | Humans approve every gate; agents flag, never decide |
| Artifact-driven handoff | `intent.md` → `spec.md` → `plan.md` → code → monitoring → next `intent.md` |
| Deterministic > advisory | Skills advise; hooks enforce; branch protection gates |
| Progressive autonomy | Start manual, evolve to auto-accept as guardrails mature |
| Audit trail by construction | Git history of artifacts = complete traceability |
| Self-correcting loop | Eval suite catches regressions; `CLAUDE.md` absorbs lessons; incidents become permanent evals |

## Related Concepts

- [[CLAUDE.md]] — repository knowledge file for [[Claude Code]] sessions; absorbs corrections and conventions
- [[Agentic AI]] — AI systems that take autonomous actions in pursuit of goals
- [[SDLC]] — Software Development Life Cycle; the traditional six-stage linear flow being re-engineered
- [[Claude Code]] — [[Anthropic]]'s agentic coding tool; primary implementation vehicle for this playbook
- [[MCP]] — Model Context Protocol for tool integration; exposes agent capabilities in CI/CD
- [[Anthropic]] — AI safety company; publisher of this playbook
