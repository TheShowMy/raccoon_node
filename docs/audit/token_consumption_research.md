# Token 消耗优化调研报告

> **实施状态（2026-07-12）**：本报告中的原始建议已结合当前代码修订并落地。项目问答原本已经在 session 复用时省略历史；Pi 原本已经提供真实 session usage/cache。当前实现进一步使用 operation 差值避免重复累计，并将新任务的外部 3 个 ReviewSubAgent + 1 个 ReviewSummary 收敛为一个 Review 父 session。父 session 内通过受管 Pi RPC 工具并发运行三个无持久化、上下文隔离的审核子代理。

> 调研范围：`raccoon_node` 后端提示词组装、Pi Agent RPC 调用、需求/任务/聊天流程。
> 目标：定位当前不合理的 token 消耗点，参考社区实践，给出可落地的优化建议。本报告不修改代码。

## 1. 摘要

当前 `raccoon_node` 通过持久 Pi Agent RPC 子进程与 LLM 交互。提示词由 `src/prompt` 模块的
`PromptRenderer` 将多个 source（Global / Skill / Contract / RequirementContext / TaskContext /
ExecutionContext / ReferenceContext / InlinePolicy）拼接成单一大段 markdown 后一次性注入。

主要问题：

1. **首次提示词体积大**：每个阶段都把 Global、Skill、Contract 等稳定内容与动态上下文一起全量发送。
2. **多轮澄清重复发送**：需求分析每轮都把原始需求、上一版确认草案、全部澄清答案重新拼进 prompt。
3. **修复轮次重载完整上下文**：任务进入 `Fixing` 状态时，仍重新注入完整任务描述、Skill、Contract。
4. **前置任务输出未摘要**：Review / Merge / ReviewSummary 节点把依赖任务的完整 `result_summary` 拼入。
5. **缺乏真实 token 估算与监控**：当前使用 `chars / 4` 的粗糙 heuristic，难以精确预算。

本报告参考了 Aider、Claude Code、gollm、prompt-caching、rtk、Cline 等项目的做法，给出按
“见效快 → 架构调整”排序的建议清单。

## 2. 当前代码现状与 Token 消耗点

### 2.1 提示词组装机制

- `src/prompt/renderer.rs`：
  - `PromptRenderer` 通过 `add_source` / `add_optional_source` 收集多个内容块。
  - `render()` 把所有 `included` 的 `content` 按顺序用 `\n` 连接成单一字符串 `markdown`。
  - 没有“稳定/动态”分层，也没有显式缓存断点。
- `src/prompt/sources.rs`：
  - `PromptSource` 记录 `chars`、`estimated_tokens`（`chars / 4`）。
  - 估算方式粗糙，对中英文、JSON、代码的 token 密度差异不敏感。
- `src/pi/mod.rs`：
  - `prompt_with_images` 把组装好的 markdown 通过 `{"type": "prompt", "message": ...}` 发送给 Pi Agent。
  - `restore_or_new_session` 负责 session 复用，但**每一轮仍发送完整 prompt**。

### 2.2 已识别的 Token“大户”

| # | 位置 | 触发场景 | 当前行为 | 主要问题 |
|---|------|----------|----------|----------|
| 1 | `src/requirement/analysis.rs:16` `build_requirement_prompt` | 需求分析/澄清每轮 | 发送 `GLOBAL_PROMPT` + `requirement_coordinator skill` + 完整 `requirement_context` + `reference_context` | 原始需求、上一版草案、已有澄清等半静态内容被重复发送 |
| 2 | `src/requirement/execution.rs:179` `build_requirement_task_prompt` | 每个任务节点执行 | 发送 `GLOBAL_PROMPT` + skill/role + JSON contract + `context_sections` + `current_task` + `failure_context` | 修复轮次仍重发完整任务描述与 contract |
| 3 | `src/requirement/execution.rs:319` `build_context_sections` | Review / ReviewSummary / BranchMerge / MergeReview | 包含完整需求草案 + 所有直接依赖任务的完整 `result_summary` | 前置输出未摘要，随 DAG 增长 |
| 4 | `src/requirement/execution.rs:435` `build_json_repair_prompt` | JSON 解析失败后的同会话修复 | 重发完整 JSON contract + 4000 字符输出摘录 | contract 在同 session 已存在，重复发送 |
| 5 | `src/chat/mod.rs:3` `build_project_chat_prompt` | 项目问答新 session | 发送完整历史消息 | 未做滑动窗口或摘要 |
| 6 | `src/prompt/sources.rs:84` `estimate_tokens` | 所有 prompt | `chars / 4` | 估算误差大，无法精确预算 |

### 2.3 Session 复用现状

| 流程 | Session 复用情况 | 是否每轮仍发完整 prompt |
|------|------------------|------------------------|
| 需求分析 | `project_clients` 缓存 PiRpcClient，session 可复用 | 是 |
| 执行规划 | 每次调用 `new_session`（`src/pi/mod.rs:932`） | 是（且无法复用） |
| 任务执行 | `restore_or_new_session` 复用 task 的 session file | 是 |
| 项目问答 | `restore_or_new_session` 复用 session | `session_reused=false` 时发完整历史 |

结论：**session 复用机制已存在，但 prompt 组装策略没有利用这一点做“增量发送”**。

## 3. GitHub 参考项目与做法

### 3.1 Aider — RepoMap / 代码地图

- 项目：[paul-gauthier/aider](https://github.com/paul-gauthier/aider)
- 核心做法：
  - 用 Tree-sitter 解析代码结构，提取函数、类、方法、引用。
  - 构建文件/符号关系图，按 PageRank 排序重要性。
  - 根据可用 context window 动态决定放入多少代码地图，而不是把原始文件全文塞进 prompt。
- 对本项目启示：
  - 如果 Pi Agent 需要读取大量代码，可以先用结构化的 repo map 代替全文。
  - 尤其适合“实现 Agent 初识仓库”这一场景，避免一次性把大段源码塞进上下文。

### 3.2 Claude Code / claude-gode — 稳定前缀 + Prompt Caching

- 项目：[xorespesp/claude-code](https://github.com/xorespesp/claude-code)、[Lachine1/claude-gode](https://github.com/Lachine1/claude-gode)
- 核心做法：
  - 将 prompt 拆分为**稳定系统提示**与**动态用户消息**。
  - 利用 Anthropic 的 prompt caching，对稳定前缀加 `cache_control` 断点。
  - 将时间、运行时等动态信息从 system prompt 移到 user message，避免破坏前缀缓存。
- 对本项目启示：
  - `GLOBAL_PROMPT`、各 `Skill`、JSON `Contract` 属于稳定内容，应放在缓存断点前。
  - `current_task`、`failure_context`、`reference_context` 属于动态内容，应放在断点后。
  - 需要 Pi Agent / 底层模型支持 cache_control 或多段消息。

### 3.3 prompt-caching — 自动缓存断点

- 项目：[flightlesstux/prompt-caching](https://github.com/flightlesstux/prompt-caching)
- 核心做法：
  - 自动识别稳定 content block，在后面注入 `cache_control` 断点。
  - 动态内容放在最后一个断点之后。
  - 宣称可降低 90% 的重复 token 成本。
- 对本项目启示：
  - 可以在 `PromptRenderer` 层增加 `stability` 标记，渲染时自动决定断点位置。
  - 即使 Pi 当前不支持 `cache_control`，先打好“稳定/动态”分层元数据，未来升级即可启用。

### 3.4 gollm — 结构化消息与 Memory

- 项目：[teilomillet/gollm](https://github.com/teilomillet/gollm)
- 核心做法：
  - 使用结构化消息数组（非单一大 prompt）。
  - 开启 memory 后，API 级缓存生效，减少重复上下文成本。
- 对本项目启示：
  - 当前 Pi RPC 使用单一 `prompt` 字符串，若改为多段消息，可更自然地支持缓存与增量更新。

### 3.5 rtk — CLI 输出压缩

- 项目：[rtk-ai/rtk](https://github.com/rtk-ai/rtk)
- 核心做法：
  - 作为 CLI 代理，将命令行大输出压缩后再喂给 LLM。
  - 宣称可降低 60–90% token。
- 对本项目启示：
  - Pi Agent 在执行 `Read`、`git diff`、`npm run check` 等工具时，可能返回大量文本。
  - 对工具输出做摘要/截断/结构化后再进入主上下文，可显著降低 token。

### 3.6 Cline / camel-ai / semantic-router — Context Engineering

- 讨论：[cline/cline#3078](https://github.com/cline/cline/discussions/3078)
- Issue：[camel-ai/camel#3675](https://github.com/camel-ai/camel/issues/3675)
- Issue：[vllm-project/semantic-router#806](https://github.com/vllm-project/semantic-router/issues/806)
- 核心做法：
  - **Summarization**：自动摘要较早的对话轮次。
  - **Sliding window**：只保留最近 N 轮。
  - **Hierarchical summary**：多层级摘要（轮次 → 主题 → 会话）。
  - **Semantic relevance scoring**：用向量相似度选择最相关的历史消息。
  - **Summarization tool**：长工具输出主动摘要，而非直接缓存。
- 对本项目启示：
  - 项目聊天历史、需求分析历史、前置任务输出都可以用摘要/滑动窗口替代全量。
  - 对长工具输出增加“摘要工具”或截断策略。

## 4. 针对 raccoon_node 的优化建议

按“不依赖 Pi 协议改动 → 依赖 Pi 协议扩展”排序。

### 4.1 立即可做：Prompt 组装策略优化

#### 4.1.1 需求分析多轮去重

- 在 `RequirementAnalysisInput` 增加 `session_reused` 标志（类似 `ProjectChatInput` 的处理）。
- 当 session 复用时，`build_requirement_prompt` 只发送：
  - 本轮用户输入；
  - 与上一版草案的差异/修订摘要；
  - 新增澄清答案（如果有）。
- 不再重复发送完整的原始需求、上一版草案、全部澄清答案。
- **预期收益**：第 2+ 轮需求澄清输入 token 降低 30–50%。

#### 4.1.2 修复轮次轻量 Prompt

- 当 `task.status == Fixing` 且 Pi session 可复用时：
  - 不重发完整 `implementation_runner` skill 和 JSON contract。
  - 只发送：`当前处于修复模式` + `审核反馈` + `最小边界提示`。
- 依赖：Pi session 已保存了之前的完整上下文。
- **预期收益**：修复轮次输入 token 降低 40–60%。

#### 4.1.3 前置任务输出摘要

- 修改 `direct_dependency_outputs`（`src/requirement/execution.rs:563`）：
  - 对 `result_summary` 做截断（如保留前 200 字符 + 修改的关键文件列表）。
  - 避免 Review / Merge / ReviewSummary 节点把长输出全量拼入。
- **预期收益**：Review/Merge 任务 `context_sections` 降低 20–40%。

#### 4.1.4 JSON Repair 去 Contract

- 修改 `build_json_repair_prompt`：
  - 同 session 内 contract 已发送，不再重发完整 JSON schema。
  - 改为引用 contract ID + parse_error + 输出摘录。
- **预期收益**：每次 JSON repair 减少几百至几千 token。

#### 4.1.5 项目聊天历史滑动窗口 + 摘要

- 当历史消息超过阈值（如 10 条或 4000 字符）时：
  - 保留最近 N 条完整消息；
  - 对更早消息做摘要（或简单截断）。
- **预期收益**：长会话问答减少 30–50% 历史 token。

### 4.2 中等投入：稳定/动态分层 + Token 监控

#### 4.2.1 PromptRenderer 增加 Stability 标记

- 给 `PromptSource` / `PromptPart` 增加 `stability: Stable | Dynamic`。
- Stable：`GLOBAL_PROMPT`、Skill、Contract。
- Dynamic：`RequirementContext`、`TaskContext`、`ExecutionContext`、`ReferenceContext`、`failure_context`。
- 渲染输出仍为单一 markdown（兼容现有 Pi RPC），但元数据保留在 `PromptDiagnostics` 中。
- 价值：先建立分层基础，便于后续接入缓存；同时可监控稳定/动态 token 占比。

#### 4.2.2 真实 Token 估算

- 当前 `estimate_tokens` 为 `chars / 4`，误差较大。
- 建议：
  - 优先复用 Pi Agent 的 `get_session_stats` 返回的真实 `tokens.input` 做校准。
  - 或在 Rust 端引入 `tiktoken-rs` / `tokenizers` 做更准的估算。
- 价值：精确预算、发现异常增长、指导截断策略。

### 4.3 长期/依赖 Pi 能力：Prompt Caching + 结构化消息

#### 4.3.1 调研 Pi Agent 是否支持 cache_control / 多段消息

- 检查 `pi-rpc-rs` / Pi Agent 协议是否支持：
  - 类似 Anthropic 的 `cache_control`；
  - 或 system / user 多段消息。
- 若支持：
  - 将 Stable block 放在 cache breakpoint 之前；
  - Dynamic block 放在断点之后；
  - 多轮调用可命中稳定前缀缓存。
- **预期收益**：多轮会话稳定前缀 token 成本降低 70–90%（参考 prompt-caching 项目）。

#### 4.3.2 执行规划 Session 复用

- 当前 `plan_requirement_execution` 每次调用 `new_session`。
- 若规划阶段可复用 project client 的 session，则 Global + Skill + Contract 可长期缓存。
- 仅在模型/设置变更时切换 session。

#### 4.3.3 工具输出压缩

- 参考 `rtk`、camel-ai 的 summarization tool：
  - Pi Agent 读取大文件 / 大 diff / 长命令输出后，先用低档模型做摘要或截断。
  - 摘要后的内容再进入主上下文。
- 适合场景：
  - 大文件 `Read`；
  - `npm run check` 大段输出；
  - `git diff` 长差异。

## 5. 优先级矩阵

| 优先级 | 建议 | 难度 | 预期收益 | 依赖 |
|--------|------|------|----------|------|
| P0 | 需求分析多轮去重 | 低 | 高 | 无 |
| P0 | 修复轮次轻量 prompt | 低 | 高 | 无 |
| P1 | 前置任务输出摘要 | 低 | 中 | 无 |
| P1 | JSON repair 去 contract | 低 | 中 | 无 |
| P1 | 项目聊天历史滑动窗口 | 低 | 中 | 无 |
| P2 | PromptRenderer stability 标记 | 中 | 中（长期） | 无 |
| P2 | 真实 token 估算/监控 | 中 | 中 | 可选 tiktoken-rs |
| P3 | Pi cache_control / 结构化消息 | 高 | 很高 | 需 Pi Agent 协议支持 |
| P3 | 工具输出压缩 | 中 | 高（大输出场景） | 需 Pi Agent 或低档模型 |

## 6. 结论

`raccoon_node` 的 token 消耗问题主要不是单次 prompt 写得太长，而是**在多轮、修复、审核等重复场景中，稳定内容和历史上下文被反复全量注入**。社区（Aider、Claude Code、prompt-caching、rtk、Cline 等）的主流解法集中在三点：

1. **增量/摘要化上下文**：多轮对话只发变化，历史做摘要。
2. **稳定/动态分层 + 缓存**：让不变的前缀被模型/平台缓存。
3. **工具输出压缩**：大段命令/文件输出先入摘要。

## 7. 已采用的实现边界

- 引用文件最多 8 个；单文件 32 KiB、总计 128 KiB 内联，超出大小只传安全仓库相对路径，由 Agent 按需读取。图片最多 3 张、总计 10 MiB。
- DependencyOutput、ReviewFeedback、RecoveryGuidance 和 JSON repair excerpt 使用集中预算；PromptSource 记录 bytes 和 inline/path_only，但不保存正文 preview。
- 需求、项目问答和 Fixing 在恢复 session 后只发送本轮 delta；新 session 仍发送完整业务上下文。
- usage 使用调用前后 `get_session_stats` 差值，父 Review usage 合并三个临时子代理 usage；Token 工作台显示实际调用热点和估算 source 贡献。
- 不新增 Plan Auditor、rolling-summary LLM 调用、review profile 或角色级 thinking 覆盖。

---

*报告生成时间：2026-07-12*
*范围：后端提示词组装与 Pi RPC 调用；不涉及前端、构建、发布流程。*
