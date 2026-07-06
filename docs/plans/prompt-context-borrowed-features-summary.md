# Prompt 工程结构优化执行清单

> 日期：2026-07-05
> 用途：把当前分散的提示词、结构化输出、上下文控制和调试能力整理成可执行改造清单。
> 原则：**先统一 Prompt 工程结构，再在结构上做 token/context 优化。**

## 0. 总目标

把当前散落在 Rust 代码和单个模板文件里的提示词，整理成一套可维护、可测试、可观测的 Prompt 工程体系。

最终每一次 Pi RPC 调用前，都应该能回答：

- 这次调用使用了哪个角色 prompt？
- prompt 由哪些层组成？
- 每一层来源是什么？
- 每一层占多少字符 / 估算 token？
- 哪些内容被截断、摘要或跳过？
- 输出应该符合哪个结构化契约？
- prompt 修改是否有 snapshot/diff 可审查？

## 1. P0：建立 Prompt 工程基础设施

### 1.1 新增 prompt 模块

新增：

```text
src/prompt/
├── mod.rs
├── renderer.rs
├── sources.rs
├── sections.rs
├── contracts.rs
└── diagnostics.rs
```

需要实现：

- [ ] `RenderedPrompt`
- [ ] `PromptSource`
- [ ] `PromptDiagnostics`
- [ ] prompt renderer
- [ ] section parser
- [ ] contract loader
- [ ] prompt source 统计与预览

建议核心类型：

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
    pub truncated: bool,
    pub preview: String,
}
```

### 1.2 新增 prompt 文件目录

新增：

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
```

每个 skill 文件需要包含：

- [ ] `name`
- [ ] `role`
- [ ] `inputs`
- [ ] `outputs`
- [ ] `boundaries`
- [ ] `stop conditions`
- [ ] `validation`
- [ ] `output contract`

示例：

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

### 1.3 迁移现有 prompt 构建函数

优先迁移：

- [ ] `src/chat/mod.rs`
  - `build_project_chat_prompt`
- [ ] `src/requirement/analysis.rs`
  - `build_requirement_prompt`
  - `format_requirement_context`
- [ ] `src/requirement/execution.rs`
  - `build_requirement_plan_prompt`
  - `build_requirement_task_prompt`
  - `build_recovery_guidance_prompt`
  - `build_*_json_repair_prompt`
- [x] `prompts/skills/requirement_coordinator.md`
  - 已完成迁移并作为当前生效模板保留

迁移目标：

- [ ] 所有 `build_*_prompt` 返回 `RenderedPrompt`
- [ ] Pi RPC 最终只发送 `RenderedPrompt.markdown`
- [ ] SQLite 或 trace 中保存 `PromptDiagnostics` 摘要
- [ ] 不保存完整 prompt 到日志

### 1.4 实现 Section Marker

使用统一 marker：

```markdown
<!-- raccoon:managed:start requirement-context -->
...
<!-- raccoon:managed:end requirement-context -->

<!-- raccoon:user:start notes -->
...
<!-- raccoon:user:end notes -->
```

需要实现：

- [ ] parse section
- [ ] format section
- [ ] replace section
- [ ] boundary diagnostics
- [ ] 缺失 start/end 报错
- [ ] mismatched marker 报错
- [ ] section name 限制为 `[a-z0-9-]+`

暂不做复杂嵌套语义；嵌套 marker 先按普通文本处理。

### 1.5 建立 Prompt Snapshot / Diff 测试

新增测试：

- [ ] requirement analysis prompt snapshot
- [ ] execution planning prompt snapshot
- [ ] implementation task prompt snapshot
- [ ] review prompt snapshot
- [ ] recovery prompt snapshot
- [ ] JSON repair prompt snapshot

验收要求：

- [ ] 重构前后 prompt 语义一致
- [ ] prompt 修改必须体现在 snapshot diff 中
- [ ] diff 中能看出是哪个 PromptSource 变化
- [ ] 测试覆盖缺失 skill、缺失 contract、section 边界错误

## 2. P1：角色化执行流程

### 2.1 Requirement Coordinator

对应：需求澄清与确认草案。

需要做：

- [x] 已建立 `prompts/skills/requirement_coordinator.md`
- [ ] 明确只负责需求分析、澄清问题、确认草案
- [ ] 明确不生成执行 DAG
- [ ] 明确不承诺代码实现
- [ ] 输出继续走受管 Pi extension 结构化工具
- [ ] 禁止恢复文本 JSON 提取

输入层：

- [ ] 用户原始需求
- [ ] 本轮补充
- [ ] rolling summary
- [ ] 上一版确认草案摘要
- [ ] 澄清历史摘要
- [ ] 引用文件/图片 source

### 2.2 Execution Planner

对应：确认需求后生成执行 DAG。

需要做：

- [ ] 建立 `prompts/skills/execution_planner.md`
- [ ] 建立 `prompts/contracts/execution_plan.schema.json`
- [ ] 规划 prompt 明确任务拆分原则
- [ ] 默认少拆任务
- [ ] 只按数据流、契约边界、风险、独立验证拆分
- [ ] 生成 review profile 建议：`minimal` / `standard` / `strict`

输出要求：

- [ ] DAG task 列表
- [ ] task dependencies
- [ ] task kind
- [ ] acceptance criteria
- [ ] likely files
- [ ] validation expectation
- [ ] review profile

### 2.3 Plan Auditor

对应：执行规划后的计划审计。

需要做：

- [ ] 建立 `prompts/skills/plan_auditor.md`
- [ ] 建立 plan audit 数据结构
- [ ] planning 完成后自动执行 audit
- [ ] audit 结果写入 execution plan metadata

Plan Auditor 输出：

- [ ] verdict：`PASS` / `NEEDS_REVISION` / `BLOCKED`
- [ ] Flow Coverage table
- [ ] findings
- [ ] recommended revision order

Flow Coverage 至少覆盖：

- [ ] trigger
- [ ] processing
- [ ] dependency
- [ ] storage/state
- [ ] interface
- [ ] output
- [ ] failure handling
- [ ] verification
- [ ] gaps

### 2.4 Implementation Runner

对应：实现任务。

需要做：

- [ ] 建立 `prompts/skills/implementation_runner.md`
- [ ] 建立 `prompts/contracts/task_result.schema.json`
- [ ] 每次只执行一个 implementation task
- [ ] 输入包必须完整
- [ ] scope 不清时返回需要协调，而不是强行执行

输入包：

- [ ] requirement draft summary
- [ ] assigned task id
- [ ] task objective
- [ ] direct dependency summaries
- [ ] reference context
- [ ] allowed / expected file scope
- [ ] validation commands or evidence
- [ ] output contract

输出包：

- [ ] changed files
- [ ] behavior changed
- [ ] behavior preserved
- [ ] validation run/result
- [ ] risks or none
- [ ] coordinator issues if any

### 2.5 Code Reviewer

对应：审核子任务。

需要做：

- [ ] 建立 `prompts/skills/code_reviewer.md`
- [ ] 建立 `prompts/contracts/review_result.schema.json`
- [ ] review 输入必须包含实现报告和验证证据
- [ ] review 只看指定 gate，不自主扩展范围
- [ ] mock / dry run / fixture-only 不算完成证据

输出：

- [ ] verdict：`passed` / `needs_changes` / `needs_coordinator`
- [ ] concrete feedback
- [ ] evidence
- [ ] affected upstream task

### 2.6 Review Summarizer

对应：审核汇总。

需要做：

- [ ] 建立 `prompts/skills/review_summarizer.md`
- [ ] 建立 `prompts/contracts/review_summary.schema.json`
- [ ] 汇总多个 reviewer 输出
- [ ] 判断是否通过
- [ ] 生成给 implementation runner 的最小反馈

Review profile：

- [ ] `minimal`：1 个综合 reviewer
- [ ] `standard`：多个角度 reviewer
- [ ] `strict`：多个 reviewer + 更严格 merge review

### 2.7 Recovery Guide

对应：失败恢复。

需要做：

- [ ] 建立 `prompts/skills/recovery_guide.md`
- [ ] 建立 `prompts/contracts/recovery_guidance.schema.json`
- [ ] recovery 只做诊断和恢复建议
- [ ] 不直接做实现
- [ ] 不直接做 review

输出 verdict：

- [ ] `RECOVERED`
- [ ] `NEEDS_PLAN_UPDATE`
- [ ] `BLOCKED`
- [ ] `HIGH_TIER_RECOMMENDED`

Recovery 需要区分：

- [ ] session / retry 状态问题
- [ ] plan 设计问题
- [ ] prompt 缺陷
- [ ] dependency 缺失
- [ ] 实现失败
- [ ] review feedback 不清晰

## 3. P2：基于 PromptSource 做上下文与 token 控制

### 3.1 PromptSource 预算策略

为每类 source 定预算：

| Source | 默认策略 |
|---|---|
| Global | 稳定，启动时校验 |
| RequirementContext | 超长后 rolling summary |
| ReferenceFile | 单文件 32KB，总 128KB |
| ImageReference | 限数量和总大小 |
| DependencyOutput | 单依赖约 1KB |
| ReviewFeedback | 约 2KB |
| RecoveryGuidance | 约 3KB |
| JSONRepairExcerpt | 1.5–2KB |

需要做：

- [ ] 每类 source 有 chars 统计
- [ ] 每类 source 有截断策略
- [ ] 截断必须写入 diagnostics
- [ ] UI 能展示截断原因

### 3.2 引用文件和图片预算

涉及：`src/file_refs.rs`

建议限制：

```text
MAX_REFERENCE_FILES = 8
MAX_REFERENCE_CONTEXT_BYTES = 128 KiB
MAX_REFERENCE_FILE_INLINE_BYTES = 32 KiB
MAX_PROMPT_IMAGE_COUNT = 3
MAX_PROMPT_IMAGE_TOTAL_BYTES = 10 MiB
```

需要做：

- [ ] 文件引用输出为 `PromptSourceKind::ReferenceFile`
- [ ] 图片引用输出为 `PromptSourceKind::ImageReference`
- [ ] 超预算时返回明确错误
- [ ] 支持后续改成摘要/片段化

### 3.3 历史上下文去重

需要做：

- [ ] Requirement analysis 成功复用 Pi session 时，只注入本轮 delta + summary
- [ ] Project chat 增加 rolling summary
- [ ] SQLite 保留完整历史，但 prompt 默认不全量重放
- [ ] PromptSource 标记哪些内容来自 summary，哪些来自本轮输入

### 3.4 后续 prompt 输入限长

需要限长：

- [ ] `result_summary`
- [ ] `review_feedback`
- [ ] `failure_summary`
- [ ] `recovery_guidance`
- [ ] `json_repair_excerpt`

建议：

```text
result_summary <= 1000 chars
review_feedback <= 2000 chars
failure_summary <= 1500 chars
recovery_guidance <= 3000 chars
json_repair_excerpt <= 1500-2000 chars
```

完整内容仍可留在 session/trace，但进入后续 prompt 的必须是压缩版。

### 3.5 按角色调整 thinking level

建议默认：

| 角色 | 默认 thinking |
|---|---|
| Requirement Coordinator | medium |
| Execution Planner | medium/high |
| Plan Auditor | medium/high |
| Implementation Runner | medium |
| JSON Repair | minimal/off |
| Code Reviewer | low/medium |
| Review Summarizer | low |
| Branch Merger | low/medium |
| Merge Reviewer | medium/high |
| Recovery Guide | high |

需要做：

- [ ] 支持按 task kind 覆盖 thinking level
- [ ] 前端高级设置后续可展示该矩阵
- [ ] JSON repair 默认不要使用高 thinking

## 4. P3：调试面板与 UI 降噪

### 4.1 Prompt Layers 面板

在任务详情中新增 Prompt 标签页。

展示：

- [ ] source kind
- [ ] label
- [ ] chars
- [ ] estimated tokens
- [ ] included / empty / missing
- [ ] truncated
- [ ] preview
- [ ] disabled reason

操作：

- [ ] 复制最终 prompt
- [ ] 复制某一层 source
- [ ] 查看 prompt diagnostics

### 4.2 Task session API 分页与截断

默认参数：

```text
?limit_messages=80
&max_text_chars=4000
&max_tool_output_chars=2000
&max_diff_chars=12000
&include_thinking=false
```

需要做：

- [ ] 后端支持分页
- [ ] tool output 默认截断
- [ ] diff 默认截断或按文件懒加载
- [ ] thinking 默认折叠
- [ ] 返回 truncation metadata

### 4.3 引用输入 chip 化

需要做：

- [ ] `@file` chip
- [ ] image chip
- [ ] chip 显示大小
- [ ] chip 显示是否会进入 prompt
- [ ] chip 显示是否超预算

### 4.4 Activity Timeline

需要统一展示：

- [ ] thinking
- [ ] tool call
- [ ] tool result
- [ ] assistant answer
- [ ] changed files
- [ ] validation result
- [ ] review verdict
- [ ] recovery action

默认折叠详细内容，只展示摘要。

## 5. 最小执行顺序

### 第一批：结构先行

- [ ] 新增 `src/prompt/` 基础类型
- [ ] 新增 `prompts/skills/` 和 `prompts/contracts/`
- [ ] 迁移 requirement coordinator
- [ ] 迁移 execution planner
- [ ] 迁移 implementation runner
- [ ] Pi RPC 调用记录 PromptDiagnostics
- [ ] 增加 prompt snapshot/diff 测试

### 第二批：角色闭环

- [ ] 增加 plan auditor
- [ ] 增加 code reviewer skill
- [ ] 增加 review summarizer skill
- [ ] 增加 recovery guide skill
- [ ] 增加 review profile
- [ ] recovery 输出结构化 verdict

### 第三批：上下文控制

- [ ] 引用文件预算化
- [ ] 图片预算化
- [ ] 历史 summary / delta 化
- [ ] dependency output 限长
- [ ] feedback / recovery / repair excerpt 限长
- [ ] token usage 按 source 归因

### 第四批：UI 降噪

- [ ] Prompt Layers 面板
- [ ] task session 分页
- [ ] thinking/tool output/diff 折叠
- [ ] `@file` chip
- [ ] token/cache/context chip
- [ ] activity timeline

## 6. 暂缓事项

以下事项不要抢在 Prompt 工程基础设施之前：

- [ ] RecoveryNode 可视化
- [ ] PlanNode 完整 UI
- [ ] Flow Coverage 表完整前端展示
- [ ] review sub-agent 插件化
- [ ] 多 workspace/session 高级管理
- [ ] 大规模 TokenUsageNode 重做

原因：这些都依赖统一 PromptSource、contract 和 role prompt。先做 UI 容易产生新的状态债务。
