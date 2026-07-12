# Prompt 工程与上下文结构优化建议

> **状态（2026-07-12）**：此旧计划已由当前实现收敛。Prompt renderer、sources、sections、contracts、分页 session 和统一时间线已经完成；剩余可取部分已落实为集中预算、引用 path-only、operation usage 和单 Review 父会话。本文中的 Plan Auditor、review profile、rolling summary、thinking 强制覆盖和完整 prompt 复制不再属于实施范围。

> 日期：2026-07-05
> 范围：`raccoon_node` 的需求澄清、执行规划、任务 DAG、Review/Recovery、Pi Agent RPC 会话、React Flow 节点与会话展示。
> 主线：**优先优化提示词工程结构，其次才是 token/context 消耗控制**。
> 硬约束：运行时所有 LLM、模型列表、模型选择和 Agent 能力仍必须通过 Pi Agent RPC；不绕过 `pi --mode rpc`；不读写 Pi Agent 的 auth/settings 文件。

## 1. 结论摘要

此前文档把优先级放在 token 止血：引用总量、session 截断、context guard、token 统计。这些仍然必要，但不是根因级优化。

本轮补充研究 `GaosCode/PlanWeave` 后，结论调整为：

1. **当前项目最需要先建立 Prompt 工程骨架**：把分散在 `src/chat/mod.rs`、`src/requirement/analysis.rs`、`src/requirement/execution.rs`、`prompts/skills/requirement_coordinator.md` 等位置的提示词，汇总成可版本化、可审计、可测试、可调试的 Prompt/Skill 系统。
2. **token 消耗高是结构混乱的结果之一**：同一需求上下文、草案、澄清、review feedback、recovery guidance 被多处拼接；没有统一 Prompt Surface，就很难知道每一层为什么进入 prompt、占多少、是否重复。
3. **PlanWeave 的核心启发不是“更省 token”，而是“把工作流变成可执行的提示词图”**：角色化 Skill、分层 Prompt Composition、block 级 prompt、review/audit/recovery 一等公民、Prompt Source metadata、结构化提交契约。
4. **重排优先级**：
   - **P0：Prompt 工程化基础设施** — skill 文件化、prompt layer、RenderedPrompt sources、section parser、contract 目录、diff 测试。
   - **P1：Plan / Run / Review / Recovery 角色化汇总** — 将需求分析、DAG 规划、实现、审核、恢复拆成明确角色和稳定输入/输出契约。
   - **P2：结构驱动的 token/context 控制** — 在 Prompt Surface 上做预算、去重、摘要、引用限制，而不是散落在各函数里临时截断。
   - **P3：UI/session/trace 降噪** — task session 分页、thinking/tool output 折叠、token/cache chip、统一时间线。

一句话目标：**先让 raccoon_node 知道“每次发给 Pi 的 prompt 由哪些层组成、每层为什么存在、输入输出契约是什么”，再在这个结构上做 token 降耗。**

## 2. PlanWeave 核心借鉴

来源：<https://github.com/GaosCode/PlanWeave>

### 2.1 可核查事实

通过 GitHub API、README、raw skill 文件和 runtime 源码核查到：

- 仓库描述：PlanWeave 是 file-backed loop engineering system，用于长期 coding agent，把模糊计划变成可 claim 的任务，通过 implementation/review agents 路由，记录每次 run，并保持 loop 可恢复。
- 顶层包含 `skills/`，其中有 7 个角色化 skill：
  - `plan-maker`
  - `plan-importer`
  - `plan-auditor`
  - `plan-coordinator`
  - `plan-runner`
  - `plan-reviewer`
  - `plan-recovery`
- README 强调 “Files are nodes, documents are blocks”；block 是可 claim 的工作单元。
- CLI 有 `planweave prompt T-001#B-001`，说明 prompt 可按具体 block ref 渲染。
- Runtime prompt renderer 会按层读取并输出 markdown：
  - global prompt
  - project/canvas prompt
  - project canvas context
  - PlanGraph claim context
  - task prompt
  - block prompt
- Prompt renderer 有 fuller API，可返回 markdown 和 source metadata。source metadata 包含 source kind、label、included、empty、missing、disabled reason、preview。
- Review block 会注入 review-result JSON shape；implementation block 会注入建议 report outline。
- Section marker 实现使用 HTML comment：`<!-- planweave:{kind}:{start|end} {name} -->`，section kind 包括 `managed` 和 `user`，section name 只允许小写字母、数字、连字符。
- 当前 `renderManagedSections` 已标记 managed section renderer removed，但 section parser、format、replace、boundary validation 仍存在并有测试。
- `plan-auditor` 输出要求包含 verdict、Flow Coverage table、severity-ordered findings、recommended revision order。
- `plan-reviewer` 要求输出 machine-readable JSON，包含 review block ref、task ID、verdict、concrete feedback。
- `plan-recovery` 明确只处理状态/引用/结果漂移，不做实现或 review；输出 verdict 为 `RECOVERED` / `NEEDS_PLAN_UPDATE` / `BLOCKED`。

### 2.2 PlanWeave 的提示词工程模式

#### 2.2.1 角色化 Skill，而不是一个超大系统 prompt

PlanWeave 把 agent loop 拆成稳定角色：

| Skill | 职责 | 对 raccoon_node 的对应 |
|---|---|---|
| `plan-maker` | 从模糊目标生成计划草案 | 需求确认草案后的执行规划 |
| `plan-importer` | 把 PRD/roadmap/docs 转成 plan package | 从需求草案、引用文件、项目上下文生成 DAG |
| `plan-auditor` | 审计计划是否覆盖流程、契约、失败路径 | PlanNode / DAG 审计 |
| `plan-coordinator` | 调度 block，不亲自实现/review | FIFO/DAG scheduler 的提示词表达 |
| `plan-runner` | 执行一个 implementation block | implementation task prompt |
| `plan-reviewer` | 执行一个 review gate | ReviewSubAgent / ReviewSummary |
| `plan-recovery` | 修复 stale refs、drift、blocked 等异常状态 | GuidedRecovery / HighTier takeover 前的恢复诊断 |

关键启发：**每个角色要有自己的边界、输入包、输出契约、停止条件**。当前 raccoon_node 的 `execution.rs` 中多个 prompt 由 Rust inline string 临时拼装，角色边界不够显式。

#### 2.2.2 分层 Prompt Composition

PlanWeave 的 prompt renderer 不是把所有内容塞进一个字符串，而是有明确层次：

```text
Global Prompt
Project / Canvas Prompt
Generated Canvas Context
Generated Claim / Graph Context
Task Prompt
Block Prompt
Block-type Submission Instructions
```

对 raccoon_node 应迁移为：

```text
Global / Product Constraints
Project Context(current Git repo)
Requirement Context(active requirement)
DAG / Task Graph Context
Task Kind Skill(analysis/planning/implementation/review/recovery)
Block / Node Specific Prompt
Output Contract
Budget / Trace Metadata
```

这样可以回答：

- 哪些内容是全局稳定指令？
- 哪些内容是当前项目事实？
- 哪些内容来自用户需求？
- 哪些内容来自 DAG 依赖和前置节点输出？
- 哪些内容是 task kind 的固定契约？
- 哪些内容是本轮动态输入？

#### 2.2.3 Prompt Source metadata 是工程抓手

PlanWeave 会追踪 source 是否 included、empty、missing、disabled，并保留 preview。raccoon_node 应实现类似：

```rust
pub struct RenderedPrompt {
    pub markdown: String,
    pub sources: Vec<PromptSource>,
    pub diagnostics: PromptDiagnostics,
}

pub struct PromptSource {
    pub kind: PromptSourceKind,
    pub label: String,
    pub included: bool,
    pub empty: bool,
    pub missing: bool,
    pub disabled_reason: Option<String>,
    pub chars: usize,
    pub estimated_tokens: Option<usize>,
    pub preview: String,
}
```

这比单纯加 `MAX_PROMPT_CHARS` 更重要：它让 token 降耗有结构依据。

#### 2.2.4 Audit / Review / Recovery 是一等流程

PlanWeave 不把 review 当成“实现之后随便看一下”，而是：

- `plan-auditor`：执行前审计计划覆盖、契约、依赖、失败路径。
- `plan-reviewer`：review gate，使用结构化 verdict 和 feedback。
- `plan-recovery`：异常状态处理，避免 coordinator 或 runner 胡乱修复状态。

raccoon_node 当前已有 ReviewSubAgent、ReviewSummary、GuidedRecovery，但 prompt 工程上还不够一等：

- review 角度写死，输入契约分散。
- recovery guidance 是 trace 中的辅助内容，不是显式节点/角色。
- planning 后没有结构化 plan audit。

### 2.3 不应照搬的点

- PlanWeave 是 file-backed plan package + CLI/runtime；raccoon_node 的业务主存储是 SQLite，不能改成以 plan package 文件为主存储。
- PlanWeave 支持多 canvas/project graph；raccoon_node 当前项目 ID 固定 `current`，不能引入项目列表、克隆或删除能力。
- PlanWeave 可路由 Codex/Claude Code/OpenCode/Pi 等执行器；raccoon_node 运行时必须只通过 Pi Agent RPC。
- PlanWeave 当前 managed section renderer 已 removed；raccoon_node 可以借鉴 section parser/marker/validation，但不应假设完全相同的 managed replacement 机制可直接复制。

## 3. 其他外部仓库的次级借鉴

### 3.1 `jmfederico/pi-web`

来源：<https://github.com/jmfederico/pi-web>

可借鉴点：

- Machine → Project → Workspace → Session 的层级，适合帮助 raccoon_node 表达 Project(current) → Worktree → Pi Session。
- 浏览器断开后 session 继续运行，UI 是监督面板。
- idle session 可刷新 extensions、skills、prompt templates、themes、context/system prompt files。

在本计划中定位为 **session/workspace 解释模型**，不是 prompt 工程主线。

### 3.2 `Losomz/AgentFramework`

来源：<https://github.com/Losomz/AgentFramework>

可借鉴点：

- 把 agent materials 分为 `agents/`、global config、project config、docs。
- Pi 全局配置中包含 extensions、prompts、skills、themes，但维护说明强调不要整体替换 `~/.pi/agent/`，避免删除 `auth.json`、`sessions/`。
- `/init` 模板作为检查清单，目标项目事实必须重新验证。

在本计划中定位为 **配置/模板分层与边界提醒**。

### 3.3 `ayuayue/PiDeck`

来源：<https://github.com/ayuayue/PiDeck>

可借鉴点：

- 一个 Agent Tab = 一个 `pi --mode rpc` 进程。
- `@路径`、`/命令` chip 输入，文件 chip 可点击，IME 保护。
- SessionStatus token/cache chip。
- thinking/tool calls/answer fragments 聚合成 activity trail。
- 每次 answer 后显示本轮变更文件名与行数。

在本计划中定位为 **Prompt 输入可视化和 session 状态 UI**，属于 P3 支撑。

### 3.4 Pi compaction 文档

来源：

- <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md>
- <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/usage.md>
- <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md>

可借鉴点：

- context window 有限时通过 compaction 总结旧消息。
- 文档中的自动触发条件为 `contextTokens > contextWindow - reserveTokens`。
- `reserveTokens` 默认 16384。
- `/compact [prompt]` 或 `/compact [instructions]` 可手动触发。

在本计划中定位为 **P2 context guard 的阈值参考**，不是结构优化主线。

## 4. raccoon_node 当前提示词分散现状

关键位置：

| 领域 | 当前位置 | 问题 |
|---|---|---|
| 项目问答 | `src/chat/mod.rs` | prompt 与历史拼接逻辑耦合在代码中 |
| 需求分析 | `src/requirement/analysis.rs`、`prompts/skills/requirement_coordinator.md` | 模板文件和 Rust 拼接混合，显式历史与 Pi session 可能重复 |
| 执行规划 | `src/requirement/execution.rs` | plan prompt、JSON repair、task prompt、review prompt、recovery prompt 混在一个文件 |
| 引用上下文 | `src/file_refs.rs` | 文件/图片进入 prompt 的策略与 prompt layer 没有关联 |
| Pi RPC 调用 | `src/pi/mod.rs` | 负责 session 恢复、模型/thinking 设置和 prompt 发送，但缺少统一 RenderedPrompt metadata |
| 任务会话展示 | `src/store/mod.rs`、前端任务详情 | 读取完整 session，而不是围绕 Prompt Source / Run Artifact 展示 |
| token usage | `TokenUsageNode.tsx`、`aggregate_project_token_usage` | 更像聚合结果，不解释 prompt 结构来源 |

根因：

1. **Prompt 没有统一中间表示**：调用 Pi 前只有最终字符串，没有 sources、layer、预算、去重信息。
2. **角色没有文件化**：planner、runner、reviewer、recovery 等角色边界靠函数名和注释维持。
3. **输出契约散落**：JSON schema/repair 指令散在 prompt 字符串里，无法集中测试。
4. **DAG 节点和 prompt 节点没有对齐**：React Flow 有任务节点，但 prompt 工程没有对应的 task kind skill 节点。
5. **token 优化没有结构抓手**：只能按总字符、总文件数做粗暴限制。

## 5. 新优先级与方案

## P0：Prompt 工程化基础设施

目标：让所有 Pi RPC 调用都通过统一 prompt renderer，输出 `RenderedPrompt`。

### P0.1 建立 prompt 目录结构

建议新增：

```text
prompts/
├── global/
│   └── raccoon.md
├── skills/
│   ├── requirement_coordinator.md
│   ├── execution_planner.md
│   ├── plan_auditor.md
│   ├── implementation_runner.md
│   ├── code_reviewer.md
│   ├── review_summarizer.md
│   ├── branch_merger.md
│   ├── merge_reviewer.md
│   └── recovery_guide.md
├── contracts/
│   ├── requirement_analysis.schema.json
│   ├── execution_plan.schema.json
│   ├── task_result.schema.json
│   ├── review_result.schema.json
│   ├── review_summary.schema.json
│   └── recovery_guidance.schema.json
└── examples/
    └── ...
```

每个 skill 文件建议使用 frontmatter：

```markdown
---
name: implementation_runner
role: Executes exactly one implementation task
inputs:
  - requirement_draft
  - task
  - direct_dependencies
  - reference_context
outputs:
  - task_result
boundaries:
  - Do not run review gates
  - Do not coordinate other tasks
  - Do not change files outside assigned scope unless required
---

## Role
...

## Required input packet
...

## Stop conditions
...

## Output contract
See prompts/contracts/task_result.schema.json
```

### P0.2 引入 `RenderedPrompt` / `PromptSource`

建议新增模块：

```text
src/prompt/
├── mod.rs
├── renderer.rs
├── sources.rs
├── sections.rs
├── contracts.rs
└── diagnostics.rs
```

核心类型：

```rust
pub struct RenderedPrompt {
    pub markdown: String,
    pub sources: Vec<PromptSource>,
    pub diagnostics: PromptDiagnostics,
}

pub enum PromptSourceKind {
    Global,
    ProjectContext,
    RequirementContext,
    DagContext,
    TaskContext,
    DependencyOutput,
    ReferenceFile,
    ImageReference,
    Skill,
    Contract,
    SubmissionInstruction,
}
```

所有现有 `build_*_prompt` 先迁移为返回 `RenderedPrompt`，再由 `PiRpcClient` 发送 `rendered.markdown`。

### P0.3 Section Marker 与边界校验

借鉴 PlanWeave section parser，但使用 raccoon 命名空间：

```markdown
<!-- raccoon:managed:start requirement-context -->
...
<!-- raccoon:managed:end requirement-context -->

<!-- raccoon:user:start notes -->
...
<!-- raccoon:user:end notes -->
```

约束：

- section name 只允许 `[a-z0-9-]+`。
- mismatched/missing start/end 在测试和启动校验时报错。
- nested marker 默认作为外层内容，不做递归替换，降低复杂度。
- managed section 由 renderer 注入；user section 保留给用户/项目自定义补充。

### P0.4 Prompt diff 测试

迁移初期必须保证行为不漂移：

- 为现有 requirement analysis / planning / implementation / review / recovery 构造 fixture。
- 旧 `build_*_prompt` 与新 renderer 输出做 normalized diff。
- 允许新增 source metadata，但 markdown 语义应一致。
- 后续修改 prompt 时必须更新 snapshot，并在 PR 中解释变更意图。

### P0.5 Contract 集中管理

把执行计划、任务结果、review result、recovery guidance 的 JSON 契约放到 `prompts/contracts/`。

收益：

- JSON repair prompt 可以引用同一 contract。
- 前后端类型、SQLite 序列化、Pi extension 输出可以对齐。
- 后续可用 schema 测试发现 contract drift。

## P1：Plan / Run / Review / Recovery 角色化汇总

目标：用 PlanWeave 的角色拆分重构 raccoon_node 的提示词体系。

### P1.1 Requirement Coordinator

对应当前：`prompts/skills/requirement_coordinator.md` + `src/requirement/analysis.rs`

职责：

- 只做需求澄清、问题生成、确认草案。
- 不生成执行 DAG。
- 不承诺代码实现。
- 输出必须通过受管 Pi extension 的结构化工具，不回退文本 JSON 提取。

优化：

- 将“连续上下文”“上一版草案”“澄清历史”“引用上下文”变成 PromptSource。
- session 复用时只注入本轮 delta + summary，避免重复。

### P1.2 Execution Planner / Plan Importer

对应当前：`build_requirement_plan_prompt`

职责：

- 从确认草案生成 DAG。
- 区分 task prompt 和 block/task kind prompt。
- 默认少拆任务：按数据流、契约边界、风险、独立验证拆分，而不是为了并行而拆。
- 生成 review profile 建议：minimal / standard / strict。

输出：`execution_plan.schema.json`

### P1.3 Plan Auditor

新增或并入 planning 后置步骤。

职责借鉴 PlanWeave `plan-auditor`：

- 先识别主要生命周期/value flows。
- 输出 Flow Coverage table：trigger、processing、dependency、storage、interface、output、failure handling、verification、gaps。
- 检查 prompt 是否缺少 goal、references、scope、forbidden actions、done criteria、validation method。
- 检查 execution graph 是否用显式依赖表达顺序，而不是只靠 prose。
- 给出 `PASS` / `NEEDS_REVISION` / `BLOCKED`。

在 raccoon_node 中：

- 可先作为 planning 的内部审计，不急于新增前端 PlanNode。
- 审计结果存入 execution plan metadata，前端后续展示。

### P1.4 Implementation Runner

对应当前：implementation task prompt。

输入包必须包含：

- assigned task id/ref
- requirement draft summary
- direct dependency summaries
- allowed file scope / expected files
- reference context
- validation commands or expected evidence
- output contract

边界：

- 不运行 review gates。
- 不协调其他任务。
- 不修改无关文件。
- prompt 为空、矛盾、引用缺失、scope 不清时返回 `NEEDS_COORDINATOR` 风格结果，而不是硬做。

### P1.5 Code Reviewer / Review Summarizer

对应当前：`ReviewSubAgent` + `ReviewSummary`

借鉴 PlanWeave：

- review 是 gate，不是普通建议。
- reviewer 输入必须包含 upstream report、changed files、acceptance criteria、validation evidence。
- 不能把 mock、dry run、fixture-only 当作完成证据。
- 输出 machine-readable verdict：`passed` / `needs_changes` / `needs_coordinator`。

建议：

- `ReviewSubAgent` 的三个角度改成 skill 配置，而不是硬编码在 Rust prompt 中。
- `ReviewSummary` 改为 Review Gate 的聚合节点，使用 `review_summary.schema.json`。
- minimal profile 可只跑一个综合 reviewer。

### P1.6 Recovery Guide

对应当前：`build_recovery_guidance_prompt` 和失败恢复逻辑。

借鉴 PlanWeave `plan-recovery`：

- recovery 只诊断和恢复异常，不做实现或 review。
- 明确区分：
  - 可自动恢复的 runtime drift / stale session / retry confusion。
  - 需要修改 plan/prompt/dependency 的 design defect。
  - 真正实现失败，需要 high-tier takeover。
- 输出：`RECOVERED` / `NEEDS_PLAN_UPDATE` / `BLOCKED` / `HIGH_TIER_RECOMMENDED`。

## P2：结构驱动的 token/context 控制

目标：所有 token 降耗都挂在 Prompt Surface 上，而不是散落在业务函数中。

### P2.1 Prompt budget policy

为每类 PromptSource 定预算：

| Source | 默认预算 | 超限策略 |
|---|---:|---|
| Global | 稳定，不频繁变 | 启动时校验 |
| RequirementContext | 8–16KB | rolling summary |
| ReferenceFile | 单文件 32KB，总 128KB | 片段化/拒绝 |
| DependencyOutput | 单依赖 1KB | result_summary 压缩 |
| ReviewFeedback | 2KB | 结构化摘要 |
| RecoveryGuidance | 3KB | 分节摘要 |
| JSONRepairExcerpt | 1.5–2KB | 只保留错误附近 |

### P2.2 引用上下文预算化

涉及：`src/file_refs.rs`

建议：

```text
MAX_REFERENCE_FILES = 8
MAX_REFERENCE_CONTEXT_BYTES = 128 KiB
MAX_REFERENCE_FILE_INLINE_BYTES = 32 KiB
MAX_PROMPT_IMAGE_COUNT = 3
MAX_PROMPT_IMAGE_TOTAL_BYTES = 10 MiB
```

引用文件作为 `PromptSourceKind::ReferenceFile` 进入 renderer，超限时 renderer 可以解释哪个 source 被截断。

### P2.3 session 复用去重

需求分析和项目问答应在 PromptSource 层标记：

- `already_in_session: true`
- `included_as_delta_only: true`
- `covered_by_summary_id`

当 Pi session 成功恢复时，不再重复注入完整历史；只注入本轮 delta 和 summary。

### P2.4 thinking level 按角色覆盖

| 角色 | 默认档位 | 默认 thinking |
|---|---|---|
| Requirement Coordinator | high | medium |
| Execution Planner | high | medium/high |
| Plan Auditor | high | medium/high |
| Implementation Runner | medium/high | medium |
| JSON Repair | low/medium | minimal/off |
| Code Reviewer | medium | low/medium |
| Review Summarizer | medium | low |
| Branch Merger | high | low/medium |
| Merge Reviewer | high | medium/high |
| Recovery Guide | high | high |

### P2.5 token usage 分阶段、分 source 归因

TokenUsageNode 不应只展示累计 token，应展示：

- 按角色：coordinator / planner / auditor / runner / reviewer / recovery。
- 按 source：reference files / requirement context / dependency outputs / feedback / repair excerpt。
- max context percent，而不是累计 context percent。
- 最贵的 top 5 prompt render。

## P3：UI/session/trace 展示优化

### P3.1 Prompt Layers 调试面板

在 TaskDetailDialog 增加 Prompt 标签页：

- 展示 `RenderedPrompt.sources`。
- 每层显示 chars、estimated tokens、included/empty/missing/truncated。
- 支持复制最终 prompt。
- 支持只复制某一层。

### P3.2 `@file` / `/command` chip 化输入

借鉴 PiDeck：

- references/images 以 chip 方式展示。
- chip 显示大小、是否完整内联、是否超预算。
- `/compact`、`/plan`、`/review-profile minimal` 等未来可作为命令入口，但不能绕过后端规则。

### P3.3 Task session API 分页与截断

涉及：`src/store/mod.rs`、`src/api/handlers.rs`、前端任务详情。

默认：

```text
?limit_messages=80
&max_text_chars=4000
&max_tool_output_chars=2000
&max_diff_chars=12000
&include_thinking=false
```

完整 session 仍保留在 `.raccoon-node/sessions/`，但 UI 默认不全量拉取。

### P3.4 统一 activity timeline

借鉴 PiDeck：

- thinking、tool call、answer、file changes、validation、review verdict 统一时间线。
- 默认折叠 detail。
- 每次 answer 后展示本轮变更文件名和行数。

## 6. 推荐实施里程碑

### M1：Prompt Renderer 与 Source Metadata（最高优先级）

文件落点：

- 新增 `src/prompt/*`
- 新增 `prompts/skills/*`
- 新增 `prompts/contracts/*`
- 修改 `src/requirement/analysis.rs`
- 修改 `src/requirement/execution.rs`
- 修改 `src/chat/mod.rs`
- 修改 `src/pi/mod.rs`

交付：

- `RenderedPrompt` / `PromptSource` / `PromptDiagnostics`。
- 迁移 requirement coordinator、execution planner、implementation runner 三类 prompt。
- prompt diff/snapshot 测试。
- 所有 Pi RPC 调用至少能记录 prompt source metadata。

验收：

- 生成的 markdown 与旧 prompt 语义一致。
- 每次调用能输出 sources 列表。
- 缺失 skill/contract 启动或测试失败。

### M2：Plan / Review / Recovery 角色化

交付：

- `plan_auditor.md` 和 Flow Coverage 输出契约。
- `code_reviewer.md` / `review_summarizer.md` 分离。
- `recovery_guide.md` 使用明确 verdict。
- review profile：minimal / standard / strict。

验收：

- 简单需求可以走 minimal review。
- planning 后可生成 audit result。
- recovery 能区分 `NEEDS_PLAN_UPDATE` 与实现失败。

### M3：结构化 token/context 控制

交付：

- PromptSource budget policy。
- reference file/image 预算化。
- session 复用去重与 rolling summary。
- result_summary / feedback / recovery / repair excerpt 限长。

验收：

- 大引用文件会在 Prompt Surface 中显示被截断/拒绝原因。
- 多轮需求澄清 prompt 不再线性重复全部历史。
- TokenUsageNode 能显示最贵 source 和最大 session context。

### M4：UI 与 session 降噪

交付：

- Prompt Layers 面板。
- task session 分页和截断。
- `@file` chip 预算提示。
- activity timeline 默认折叠 detail。

验收：

- 打开长任务详情不卡顿。
- 用户能看到每个引用对 prompt 的贡献。
- session trace 不再默认展示完整 thinking/tool output。

## 7. 可直接拆分的开发任务

### Prompt 工程主线

- [ ] 新增 `src/prompt/` 模块，定义 `RenderedPrompt`、`PromptSource`、`PromptDiagnostics`。
- [ ] 新增 `prompts/skills/`，先迁移 requirement coordinator、execution planner、implementation runner。
- [ ] 新增 `prompts/contracts/`，集中 execution plan、task result、review result、recovery guidance JSON schema。
- [ ] 实现 `raccoon` section parser：parse / format / replace / boundary diagnostics。
- [ ] 为旧 prompt 与新 renderer 增加 snapshot/diff 测试。
- [ ] 修改 `src/pi/mod.rs`，Pi RPC 发送接口接受 `RenderedPrompt` 或记录其 metadata。

### 角色化与 DAG 质量

- [ ] 增加 `plan_auditor` skill 和 Flow Coverage 数据结构。
- [ ] planning 完成后执行 plan audit，并将结果写入 execution plan metadata。
- [ ] 将 ReviewSubAgent 角度移入 prompt skill 配置，支持 minimal/standard/strict review profile。
- [ ] 将 recovery guidance 改成结构化 verdict，区分 plan 更新、blocked、可恢复、高档接管。

### 结构化 token 控制

- [ ] `src/file_refs.rs` 输出 `PromptSourceKind::ReferenceFile`，并执行总量预算。
- [ ] Requirement analysis 复用 Pi session 时只注入 delta + summary。
- [ ] Project chat 增加 rolling summary。
- [ ] 对 dependency output、review feedback、recovery guidance、repair excerpt 做 prompt-level 限长。

### UI 与观测

- [ ] TaskDetailDialog 增加 Prompt Layers 标签页。
- [ ] TokenUsageNode 按 role/source/session 展示 token/context。
- [ ] task session API 支持分页、截断、`include_thinking`。
- [ ] references/images 改为 chip 化输入并显示预算状态。

## 8. 事实来源与研究说明

主要来源：

- `GaosCode/PlanWeave`：<https://github.com/GaosCode/PlanWeave>
- PlanWeave skills：
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/skills/plan-maker/SKILL.md>
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/skills/plan-importer/SKILL.md>
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/skills/plan-auditor/SKILL.md>
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/skills/plan-coordinator/SKILL.md>
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/skills/plan-runner/SKILL.md>
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/skills/plan-reviewer/SKILL.md>
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/skills/plan-recovery/SKILL.md>
- PlanWeave runtime prompt files：
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/packages/runtime/src/taskManager/promptRenderer.ts>
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/packages/runtime/src/prompt/sections.ts>
  - <https://raw.githubusercontent.com/GaosCode/PlanWeave/main/packages/runtime/src/__tests__/promptSections.test.ts>
- 次级参考：
  - `jmfederico/pi-web`：<https://github.com/jmfederico/pi-web>
  - `Losomz/AgentFramework`：<https://github.com/Losomz/AgentFramework>
  - `ayuayue/PiDeck`：<https://github.com/ayuayue/PiDeck>
  - Pi compaction docs：<https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md>

未验证或仅作为设计灵感：

- PlanWeave 内部所有 schema 的完整字段未逐项展开核验，本文只引用已 fetch 的 README、skill、prompt renderer、section parser 可核查内容。
- 外部仓库 release note 中的 UI 行为未本地运行验证。
- raccoon_node 的真实 token 降幅需要在 Prompt Surface 接入后用实际 usage 校准。

## 9. 与旧版文档的变化

旧版优先级：

```text
P0 引用限制 / context guard / session 截断
P1 需求分析去重 / chat summary / review fanout
P2 thinking / usage / Prompt Surface
```

新版优先级：

```text
P0 Prompt 工程化基础设施
P1 Plan / Run / Review / Recovery 角色化汇总
P2 基于 Prompt Surface 的 token/context 控制
P3 UI/session/trace 降噪
```

原因：

- 如果不先汇总和分层提示词，token 优化只能做粗暴截断，容易损失任务质量。
- PlanWeave 证明长期 agent loop 的核心是“任务图 + block prompt + role skill + review/recovery contract”。
- raccoon_node 已经有 DAG、ReviewSubAgent、Recovery、Pi session，只差把这些能力的 prompt 工程结构显式化。
