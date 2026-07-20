# Raccoon Node 后端开发需求

> 状态：实施基线
> 关联文档：[产品需求](./01-product-requirements.md) · [前端需求](./02-frontend-requirements.md) · [技术决策](./04-architecture-decisions.md)

## 1. 目标与硬边界

后端是 Raccoon Node 的业务事实服务、对话图服务、Agent 运行时、仓库安全边界和发布协调器。它必须在不依赖 Pi 或 Provider 持久 session 的前提下完成节点化问答、规格、规划、执行、验证、审核、恢复和发布。

硬边界：

- 一个进程实例只服务启动时确定的一个 Git 根目录。
- 业务文件只写入 `<git_root>/.raccoon-node/`，凭据只写系统密钥库。
- JSONL 是唯一业务事实源；`state.json`、内存状态、API 快照和前端状态都是 reducer 投影。
- 所有业务写入进入单写入器，获得项目级单调 sequence。
- Agent 不能直接操作主工作区、Git 写命令、发布 API 或 worktree 外路径。
- 同一仓库最多一个写入型 Run；问答和需求分析不持有仓库写锁。
- 外部输入、模型输出、路径、命令、事件和恢复动作都必须验证。
- Windows、macOS、Linux 使用同一业务语义，不依赖 Bash 专用流程。
- 检测到旧版不兼容布局时拒绝写入，不覆盖、不自动转换也不自动删除。

## 2. 技术基线与模块

### 2.1 技术栈

- Rust 2024、Tokio、Axum、Tower/Tower HTTP。
- Serde、`serde_json`、schemars、utoipa。
- [`rig-core = 0.40.0`](https://docs.rs/rig-core/0.40.0/rig_core/)，仅通过自有适配层使用。
- Reqwest + rustls 用于 Provider 辅助请求和 GitHub/GitLab API。
- Git CLI 作为 Git 语义来源。
- `portable-pty` 提供跨平台 PTY。
- 系统密钥库 crate 保存 Provider 与发布凭据。
- tracing + 日滚动文件日志。
- 编译期嵌入前端静态资源，正式包不要求 Node.js。

### 2.2 逻辑模块

| 模块            | 职责                                                      |
| --------------- | --------------------------------------------------------- |
| `bootstrap`     | CLI、Git 根、运行目录、旧格式检测、监听和安全             |
| `domain`        | 领域类型、状态机、不变量、reducer 和错误分类              |
| `event_store`   | 单写入器、JSONL 分段、快照、重放、压缩、备份和只读诊断    |
| `api`           | `/api/v1`、OpenAPI、JSON Schema、NDJSON、WebSocket 和鉴权 |
| `models`        | Provider Registry、模型能力、凭据引用和角色配置           |
| `agent`         | `ModelGateway`、`AgentRuntime`、上下文、工具循环和用量    |
| `conversation`  | 对话 DAG、分支、流式节点、过程投影和上下文选择            |
| `requirements`  | 意图、澄清、规格 revision 和确认                          |
| `workflow`      | WorkPlan、队列、写锁、worktree、尝试和恢复                |
| `quality`       | 基线、最终验证、审核、修复和质量结论                      |
| `publication`   | readiness、本地合并、GitHub PR、GitLab MR 和清理          |
| `notifications` | 通知生命周期、优先级、来源工作台/节点和 GrayDango 投影    |
| `repo`          | 文件、路径、Git 状态和仓库扫描                            |
| `terminal`      | PTY 生命周期、授权和 WebSocket                            |
| `security`      | 命令、网络、脱敏、访问令牌和审计                          |

v1 默认使用一个后端 crate 的清晰模块，不为单个函数创建独立 crate。

## 3. 运行目录与格式

### 3.1 唯一目录布局

```text
<git_root>/.raccoon-node/
├── state.json
├── events/
│   ├── active.jsonl
│   └── <sequence-range>.jsonl
├── backups/
├── attachments/
├── artifacts/
├── logs/
├── worktrees/
└── tmp/
```

- **BE-BOOT-001**（PRD-PROJ-004）：除系统密钥库外，业务事实、非敏感设置和运行资源只能位于上述目录。
- **BE-BOOT-002**：`events/active.jsonl` 是当前可追加段；`<sequence-range>.jsonl` 是不可变封存段，文件名范围必须与段内元数据一致。
- **BE-BOOT-003**：`state.json` 是唯一完整物化快照；不得创建第二套业务状态文件。
- **BE-BOOT-004**：`backups/` 保存格式升级、压缩和人工恢复前的有限滚动备份；备份不能代替活动事实源。
- **BE-BOOT-005**：`attachments/` 保存用户附件，`artifacts/` 保存报告与截断输出引用，`tmp/` 只保存可重建内容。
- **BE-BOOT-006**：启动时检查 `.raccoon-node/` 是否被 Git 忽略；缺失条目时产生 ActionRequired 通知，用户经确认节点同意后追加，不自动 commit（兼容浏览器未开启的场景）。
- **BE-BOOT-007**（PRD-PROJ-006、PRD-NFR-009）：v1 不提供自动格式迁移；发现旧布局、未知 `format_version` 或旧协议标记时拒绝写入、进入只读诊断，给出移动到用户指定归档目录的显式归档指引，不复用或覆盖；未来版本的格式升级必须先发布显式迁移器，并在升级前自动备份。
- **BE-BOOT-008**（PRD-PROJ-002）：显式路径不是 Git 根时，TTY 交互启动可询问是否 `git init`；服务器模式（浏览器 UI）下正常启动，但仅暴露 `POST /api/v1/project/initialize` 与只读诊断，初始化完成前其他业务命令拒绝。

### 3.2 非敏感配置

监听、日志、Provider 非敏感字段、模型角色、验证命令、默认任务预算、发布偏好、GitLab 主机、终端限制、网络策略（默认 `offline`，`package_registry`、`git_remote`、`readonly_fetch` 三档可选策略）和外观默认值都是事件化业务设置，投影到 `state.json`。默认任务预算只为新需求确认提供初始值，不与累计历史费用比较；凭据不得进入事件或快照。CLI 和环境变量只用于启动覆盖。

无效安全配置必须启动失败。未知可选字段保留原事实并报告兼容性问题，不静默丢弃。

## 4. 事件存储、reducer 与快照

### 4.1 EventEnvelope 与提交顺序

```rust
struct EventEnvelope<T> {
    schema_version: u32,
    sequence: u64,
    event_id: EventId,
    occurred_at: DateTime<Utc>,
    aggregate_type: AggregateType,
    aggregate_id: AggregateId,
    event_type: EventType,
    payload: T,
}
```

- **BE-DATA-001**（PRD-EVENT-001）：所有命令把经过领域校验的 `DomainEvent` 提交给单写入器；只有该写入器分配 sequence 和 event ID。
- **BE-DATA-002**（PRD-EVENT-002）：严格顺序为：序列化完整行 → 追加换行 → flush/fsync → reducer 应用 → 发布给在线订阅者 → 按策略生成快照。单写入器允许 ≤5ms 窗口微批：同批事件保序追加后一次 fsync，整批落盘后才 reducer 投影与推送；里程碑事件（需求确认、计划、质量、发布、阻断、通知）逐条 fsync，不参与微批。
- **BE-DATA-003**：API 只有在事件落盘成功后才返回 accepted；落盘失败时不得提前改变内存状态或推送前端。
- **BE-DATA-004**：同一命令产生多个事件时，使用一个 `command_id` 和连续 sequence；每个已落盘事件都必须是 reducer 可接受的独立事实，恢复时从最后事实继续，不假设多行原子写入，也不回滚已持久化事件。
- **BE-DATA-005**：领域事件使用 Rust tagged enum 和按事件版本定义的 payload，不允许业务模块直接写任意 JSON 值。
- **BE-DATA-006**：不持久化 Rig 类型、Provider 原始响应、框架 session 或进程内句柄。

### 4.2 StateFile

```rust
struct StateFile {
    format_version: u32,
    last_sequence: u64,
    written_at: DateTime<Utc>,
    state_hash: String,
    state: ApplicationState,
}
```

- **BE-DATA-007**（PRD-EVENT-003）：`ApplicationState` 是完整可启动投影，包含项目、设置、对话、需求、计划、Run、质量、发布、Provider 非敏感配置、用量和未解决通知。
- **BE-DATA-008**：`state_hash` 对规范化序列化后的 `state` 计算；键顺序、数字和可选字段规则固定，`written_at` 不参与哈希。
- **BE-DATA-009**：快照写入同目录唯一临时文件，flush/fsync 文件后原子替换 `state.json`，并按平台能力同步目录元数据。
- **BE-DATA-010**：快照可按事件数、时间和阶段里程碑合并生成；推迟快照不能推迟事件确认。
- **BE-DATA-011**（AC-14）：启动时验证格式、哈希和 last sequence，再从更高 sequence 重放；快照缺失、落后或临时文件残留不能丢失已完成事件。

### 4.3 分段与恢复

- **BE-DATA-012**：active 段达到大小或事件数阈值后，写入包含范围、数量和内容哈希的封存记录，fsync 后原子改名为 `<first>-<last>.jsonl`，再创建新的 active 段。
- **BE-DATA-013**：恢复时按 sequence 范围排序封存段，再读取 active；封存段/active 中出现重复 sequence 时，若两份 envelope 字节完全相同则按重复副本自动去重并在诊断中记录；仅字节不同的重复才阻止写入、进入只读诊断。
- **BE-DATA-014**：active 最后一条没有换行且无法解析时，可在保留备份后截断到最后完整换行；中间坏行、完整但无效的末行、未知缺口和封存段损坏都进入只读诊断。
- **BE-DATA-015**：只读诊断公开最后可信 sequence、损坏文件、字节偏移、期望范围、可用备份和归档/恢复步骤；禁止任何业务 mutation。
- **BE-DATA-016**：恢复备份必须由显式 CLI 操作发起，先保存当前损坏副本；不能在普通启动中自动回退到更旧状态。

### 4.4 语义压缩

- **BE-DATA-017**（PRD-EVENT-006～007）：只压缩已完成节点的高频 delta 和已结束工具的中间状态；需求确认、计划、质量、发布、阻断、通知、用户原文和最终回答永久保留。
- **BE-DATA-018**：压缩输出包含 `conversation.node.checkpoint` 或 `tool.activity.checkpoint`，足以重建最终内容、状态、计数、错误、成员和引用。
- **BE-DATA-019**：被折叠 sequence 范围由显式 `system.compaction.checkpoint` 声明；重放器只把该声明覆盖的范围视为合法跳跃，其他缺口仍是损坏。
- **BE-DATA-020**：压缩在临时目录构建替换段，对原段和替换段分别重放并比较最终 `state_hash`；一致后才原子替换，原段先进入有限备份。
- **BE-DATA-021**：压缩下限是最早可供增量客户端续传的 sequence；客户端游标更旧时不得拼接不完整增量。

## 5. 公共领域类型与契约

以下类型由 Rust 定义。REST 类型进入 OpenAPI；事件 envelope、`event_type` 联合和 payload 进入 JSON Schema。

```rust
enum IntentMode { Auto, Question, Change }
enum DetectedIntent { Question, Change, Ambiguous }
enum ConversationNodeKind { UserMessage, Process, Tool, AssistantAnswer, ClarificationQuestion, ClarificationAnswer, RequirementSpec, RequirementConfirmation }
enum ConversationNodeState { Streaming, Running, Completed, Failed, Aborted }
enum ModelRole { Qa, Clarifier, Planner, Implementer, Reviewer }
enum RequirementState { Drafting, Clarifying, SpecReady, Confirmed, Queued, Cancelled, Superseded }
enum RunPhase { Queued, WaitingWorkspace, Planning, Executing, Validating, Reviewing, Publishing, Pausing, Paused, Blocked, Terminal }
enum RunOutcome { Delivered, Blocked, Cancelled, Failed }
enum VerificationVerdict { Clean, BaselineIssuesOnly, NewRegression, Unavailable }
enum ReviewVerdict { Approved, ApprovedWithAdvisories, BlockingFindings, Unavailable }
enum PublicationState { NotStarted, Preparing, Pushed, ReviewOpen, WaitingRemote, Merged, SyncingLocal, Completed, Failed }
enum FindingPriority { P0, P1, P2, P3 }
enum NotificationSeverity { Error, ActionRequired, Warning, Success, Info }
enum NotificationLifecycle { Active, Acknowledged, Resolved }
```

`RequirementSpec`、`RequirementRevision`、`Run`、`WorkPlan`、`ProviderCapability`、`UsageEntry`、`UsageState`、`UsageSummary`、`EventEnvelope`、`StateFile` 和 `Notification` 是必须稳定的公共类型。

```text
Notification {
  id, severity, message, source_workbench, source_node_id,
  lifecycle, raised_at, acknowledged_at, resolved_at
}

RequirementRevision {
  requirement_id, revision, spec, semantic_hash,
  created_at, source_graph_id, source_branch_id, source_node_ids[],
  confirmation { confirmed_at, task_budget_usd }
}

Run {
  id, requirement_id, requirement_revision, phase, outcome,
  task_budget_usd, created_at, updated_at
}

UsageEntry {
  id, provider_id, model_id, role, run_id, occurred_at,
  input_tokens, output_tokens, cache_tokens, known_cost_usd
}

ConversationSession {
  id, graph_id, root_branch_id, created_at, updated_at
}

ConversationNode {
  id, graph_id, kind, state, content, node_sequence,
  intent, parent_ids[], branch_ids[], created_at, completed_at,
  requirement_id, requirement_revision, tool_activity
}

ClarificationRound {
  id, requirement_id, question,
  mode: single_choice | multiple_choice | free_text,
  options[] { id, label, description, recommended }, allow_custom,
  answer { selected_option_ids[], custom_text },
  state: pending | answered | cancelled, asked_at, answered_at
}
```

- `Notification.source_workbench` 取值固定为 `conversation | delivery | files | git | terminal | usage | settings | system`。模型配置问题使用 `settings`，累计用量信息使用 `usage`，任务预算告警使用 `delivery` 并关联 Run 节点。`source_node_id` 仅对 `conversation` 和 `delivery` 具有内部节点定位语义；普通工作台通知允许为 `null`，前端只打开对应工作台且不得把该字段解释成内部 pane 或控件定位 ID。
- 对话状态是多会话容器，保存 `active_session_id`、`ConversationSession[]` 与各自独立的 graph。每个 session 只有一个 `graph_id` 和 root branch；分支只能共享同一 graph 内的祖先。旧 session 不因激活新 session 被删除。
- Composer 是未提交 UI 投影，不进入事件。
- `ProcessGroup` 引用连续 process/tool 成员，不删除原事实。
- `ProviderCapability` 的每项能力包含 `supported | unsupported | unknown` 和证据来源。
- `UsageState` 只保存 `entries`，模型配置独立保存在 `models { providers, roles, last_result }`；`run_id = null` 归为对话消耗，否则归为任务消耗。
- `UsageSummary` 的总 Token 只计算 `input_tokens + output_tokens`，缓存单独统计；未知 token 或价格保留为空，不用零代替。
- API 不返回绝对 worktree 路径、凭据、完整 Prompt 或隐藏推理。

## 6. Provider Registry 与 Agent Runtime

### 6.1 Rig 隔离

```rust
trait ModelGateway {
    async fn list_models(&self, provider: ProviderId) -> Result<ModelCatalog>;
    async fn probe(&self, target: ModelTarget) -> Result<ProviderCapability>;
    async fn stream(&self, request: AgentModelRequest) -> Result<AgentModelStream>;
}

trait AgentRuntime {
    async fn run(&self, request: AgentRunRequest) -> Result<AgentRunResult>;
    async fn abort(&self, run_id: AgentRunId) -> Result<()>;
}
```

Rig Provider、Agent、message、memory、tool 和 stream 类型只能存在于 `models`/`agent` 适配模块。领域层使用自有类型。

### 6.2 Registry 与角色

- **BE-MODEL-001**（PRD-MODEL-001）：枚举固定 Rig 版本编译进来的全部 Provider，并声明内部 ID、鉴权字段、默认端点、模型发现和能力探测。
- **BE-MODEL-002**：无法列举模型时返回 `manual_model_id=true`，手填后执行最小非破坏探测。
- **BE-MODEL-003**：能力至少覆盖文本、图片、流式、工具、并行工具、结构化输出、推理强度、用量、缓存用量和模型列表。
- **BE-MODEL-004**（PRD-MODEL-003～004）：角色保存 primary 与可选 fallback；所有角色模型必须支持工具调用（submit_* 提交规格、计划、结果、审核均为工具调用），implementer/reviewer 另要求结构化输出与长上下文能力（按 ProviderCapability 校验）。
- **BE-MODEL-005**：错误归一为鉴权、限流、暂时不可用、不支持、无效响应、内容拒绝和未知。
- **BE-MODEL-006**：Provider session/response ID 可作为重试提示，但不是恢复条件；上下文从业务投影重建。
- **BE-MODEL-007**（PRD-MODEL-006）：主模型发生可重试错误（限流、超时、暂时不可用、无效响应）时，单次调用内自动切换 fallback；鉴权失败与内容拒绝不切换，直接报错。

### 6.4 用量与任务预算

- **BE-USAGE-001**（PRD-USAGE-001～003）：每次模型调用产生带 `occurred_at` 的 `UsageEntry`；`models.updated` 只携带 Provider、角色与操作结果，`usage.updated` 独立携带 `UsageState`，事件聚合类型包含 `usage`。
- **BE-USAGE-002**：累计统计按全部已保存记录计算，Token 总量为输入加输出，缓存不重复计入；按 `run_id` 区分对话与任务，并按 Provider/模型聚合。
- **BE-USAGE-003**（PRD-USAGE-004～005、AC-09）：`AppSettings.default_task_budget_usd` 只作为需求确认默认值；确认命令允许覆盖并把最终 `task_budget_usd` 写入确认事实，Run 创建时复制冻结该值。
- **BE-USAGE-004**：按 Run 聚合已知费用；达到冻结预算 80% 时产生来源为 `delivery`、关联 Run 节点的软告警，但不暂停、取消或切换模型。缺失价格只改变完整性说明，不按零估算。

### 6.3 凭据

- 系统密钥库 key 使用应用命名空间、Provider ID 和配置 ID。
- API 只返回 `missing | configured | invalid`，不回显密钥片段。
- 环境变量是无可用密钥库环境的显式、只读回退，不复制进事件、状态或日志。
- 删除 Provider 前检查角色引用和活动调用。

## 7. 对话、意图、规格与公开过程

- **BE-CHAT-001**（PRD-CHAT-001）：发送命令校验文本、八个引用、三张图片、单图 5 MiB 和图片总计 10 MiB。
- **BE-CHAT-002**（PRD-CHAT-002）：意图分类返回 detected intent、置信区间、公开原因摘要和用户覆盖；`ambiguous` 按 question 处理，并携带“意图识别不确定”提示，用户可随时覆盖为 change。
- **BE-CHAT-003**（PRD-CHAT-003）：问答转需求保存来源 graph/branch/node、引用和附件关系。
- **BE-CHAT-004**（PRD-CHAT-004）：对话与规格命令不获取仓库写锁；同一 branch 最多一个活动响应。
- **BE-CHAT-005**：发送命令携带 `branch_id`、`parent_node_id` 和幂等键；先持久化用户节点，再启动响应 operation。
- **BE-CHAT-006**（PRD-CHAT-008）：process 或 answer 在首个 delta 前提交 `conversation.node.created`；增量通过 `conversation.node.delta` 追加，并周期性产生 checkpoint。
- **BE-CHAT-007**：工具调用创建 tool 节点并提交 waiting/running/completed/failed/aborted 状态、安全输入摘要、截断输出、耗时和错误。
- **BE-CHAT-008**（PRD-CHAT-009）：分支只接受历史用户节点锚点；其他节点显式归一到最近祖先用户节点。
- **BE-CHAT-009**（PRD-CHAT-011）：回答完成后产生 `conversation.process_group.ready`，只引用成员、聚合摘要、工具数和耗时。
- **BE-CHAT-010**（PRD-CHAT-005）：abort 保留已持久化 delta，活动节点转为 `aborted`。
- **BE-CHAT-011**（PRD-CHAT-006）：不请求、保存或输出 Provider 隐藏推理；Provider reasoning stream 不能映射为 process。
- **BE-CHAT-012**（PRD-CHAT-013）：意图判定为 `change` 时自动创建需求草稿并启动澄清流程，用户可取消；手动“整理为需求”路径保留，用于从问答节点转换。
- **BE-CHAT-013**（PRD-CHAT-014）：redact 是危险操作，经 prepare/confirm 两阶段执行；提交 `conversation.node.redacted` 事件后节点内容替换为“已删除”标记，节点 ID、结构与分支关系保留，附件引用同步失效；redact 是永久事实，同步进入压缩与快照。
- **BE-CHAT-014**（PRD-CHAT-010）：同一 branch 最多存在一个 `drafting | clarifying | spec_ready` 需求。重复转换返回现有 requirement；确认、取消或取代后才释放该分支的通用输入权。
- **BE-CHAT-015**（PRD-CHAT-015、AC-19）：`POST /api/v1/conversations/project/sessions` 使用 `Idempotency-Key` 创建并激活独立空 session，同时提交 `conversation.session.created`；payload 包含 session、root branch、空 graph 与激活语义。旧 graph、活动节点增量、草稿关联和未完成需求事实保持不变。
- **BE-CHAT-016**：发送消息、停止响应、创建分支和从对话生成需求都显式携带 `session_id`；后端校验 branch/node/graph 属于该 session。当前不提供 activate、list-history 或 search-history 命令，后续历史功能需单独扩展。
- **BE-SPEC-001**（PRD-SPEC-001～004）：规格 schema、证据存在性、场景唯一性和约束来源在事件提交前验证。
- **BE-SPEC-002**（PRD-SPEC-005～006）：保存和确认使用 optimistic revision；冲突返回当前 revision 和字段差异。只有已经持久化 `requirement.confirmed` 事实的 revision 可以入队和创建 Run；草拟、澄清与 `spec_ready` 状态不得出现在交付队列查询中。
- **BE-SPEC-003**（PRD-SPEC-007～008）：语义哈希区分语义修改与证据修正；语义修改撤销确认、自动取消关联的未终态 Run（保留其现场事实与取消原因）并使旧计划失效，需求回到 `spec_ready`，重新确认后生成新 Run；证据修正不触发。
- **BE-SPEC-004**：无效结构化输出最多一次同上下文纠正；仍无效则形成可重试错误事实。

Agent 上下文从活动 branch 祖先、最新规格、计划、仓库证据和最近工具 checkpoint 重建；压缩保留用户证据、分支锚点、未完成计划和关键结果。

## 8. 内置工具、命令与网络

| 工具          | 能力                       | 主要限制                            |
| ------------- | -------------------------- | ----------------------------------- |
| `list_files`  | 列出安全相对路径           | 跳过内部、依赖、构建和符号链接      |
| `read_file`   | 分段读取文本               | 大小、编码和路径限制                |
| `search_text` | 仓库内搜索                 | 固定 worktree、结果上限             |
| `apply_patch` | 应用统一补丁               | 仅 worktree，拒绝受限目录           |
| `run_command` | 程序 + 参数                | 无自由 shell 字符串，受网络策略限制 |
| `git_inspect` | status/diff/show           | 只读 Git                            |
| `submit_*`    | 提交规格、计划、结果、审核 | JSON Schema 和领域校验              |

- **BE-TOOL-001**：canonicalize 前后校验路径归属，拒绝绝对路径、`..`、符号链接逃逸、硬链接风险和受限目录。
- **BE-TOOL-002**（PRD-PUB-005）：Agent 不能 commit、push、merge、rebase、reset、checkout、写 branch/worktree 或调用托管平台。
- **BE-TOOL-003**：工具输入、开始、截断结果、结束和错误形成产品事件；完整输出只在安全上限内成为 artifact。
- **BE-TOOL-004**：工具支持取消、超时、输出上限和进程树终止。
- **BE-TOOL-005**（PRD-NFR-002）：`run_command` 固定 cwd 为分配的 worktree；维护危险程序 denylist（如 rm/mkfs/dd 写盘设备、shutdown 等）；与 BE-NET-003 对齐，这是应用层策略，不构成 OS 级文件系统沙箱，进程理论上可写 worktree 外用户路径，依托 denylist、最小环境与工具审计降低风险。
- **BE-NET-001**：默认 `offline`；`package_registry`、`git_remote`、`readonly_fetch` 使用独立策略。
- **BE-NET-002**：命令环境采用 allowlist，不继承 Provider token、发布 token、通用代理或其他凭据。
- **BE-NET-003**：应用策略不宣称提供 OS 级网络沙箱；包管理器生命周期脚本风险必须可见。

## 9. 队列、worktree 与恢复

### 9.1 写锁与计划

- **BE-RUN-001**（PRD-RUN-001）：仓库 writer lease 是 ApplicationState 中的事件化事实，在 Run 进入 `planning` 时获取（含 `waiting_workspace` 期间持锁），严格 FIFO；后续需求可问答、澄清、确认并入队，但不能开始 `planning`。启动时核对 Run、PID、worktree 和 Git 后决定继续、释放或阻断。
- **BE-RUN-002**（PRD-RUN-002～003、PRD-RUN-011～013）：Planner 输出行为切片、依赖、场景引用、范围提示和验证目标；持久化前确定性校验依赖存在、无环、并行批上限、批内无依赖、显式合并任务完整和验收场景覆盖。任一失败都拒绝执行并保存问题清单，前端不得把未经校验的计划绘制为正常 DAG。
- **BE-RUN-003**（PRD-RUN-004～005）：用户请求暂停后，正在进行中的工作项不中断、不可编辑，继续完成；该工作项完成后调度器停止启动后续工作项，Run 进入 `paused`；暂停后只接受 pending 工作项、依赖和验证目标编辑，生成新 plan revision；恢复后继续执行。

### 9.2 Worktree

- 每个 Run 创建一个 integration branch/worktree；并行工作项创建 item branch/worktree；item branch/worktree 在合并任务完成后由后端清理；完成全部层次后只剩 integration 一个分支进入验证、审核与发布（成功交付前清理受管资源的既有原则不变）。
- 所有路径位于 `.raccoon-node/worktrees/`，创建后验证 Git common dir、工作目录和 base commit。
- **BE-RUN-004**（AC-03）：执行前主工作区必须干净；不自动 stash。
- **BE-RUN-005**（PRD-RUN-006）：同层最多三个独立工作项并行；WorkPlan 是 DAG，计划在每个并行批之后自动插入显式合并任务节点。
- **BE-RUN-008**（PRD-RUN-006）：合并任务由后端在 integration worktree 中按工作项 position 顺序执行 git merge；无冲突则后端直接创建受管提交；有冲突时由 implementer 角色在 integration worktree 内编辑文件解决冲突（这是合并任务的 Agent 尝试），后端验证 diff 后创建受管提交。合并任务尝试上限 2 次，超限 blocked。Agent 不直接执行任何 Git 写命令，merge 由后端发起。
- Agent 不提交 Git；后端验证 Diff 后使用固定身份创建受管提交。

### 9.3 外部副作用与恢复

- **BE-RUN-006**（PRD-EVENT-005、AC-07）：Git、发布和其他外部副作用依次提交 `operation.intent_recorded → external action → operation.result_observed`。
- intent 包含幂等键、目标、预期前置指纹和允许观察的结果；不得包含凭据。
- 重启看到未完成 intent 时先读取 Git 或远端事实；已发生则只补写 observed result，未发生且前置条件仍匹配才重试。
- 外部事实与 intent 不一致时进入 blocked，不猜测或覆盖。
- **BE-RUN-007**（PRD-RUN-008）：取消终止活动调用和子进程，保存提交、Diff 和摘要，再异步清理；清理失败不改变 cancelled。

暂时性 Provider/网络错误最多自动重试三次；每个工作项最多 3 次 attempt = 1 次实现 + 2 次修复，第 3 次 attempt（第二次修复）升级到更强模型；integration/合并任务修复最多 2 次；审核发现修复复用工作项 attempt 上限。确定性安全、路径、事件损坏和数据错误不调用模型重试。

- phase 级 `blocked` 永远可通过 resume/restart 恢复；修复上限耗尽时 Run 保持 `blocked` 并发出 ActionRequired 通知，用户选择“重试”（重置相关修复上限继续）或“放弃”才进入终态（`RunOutcome=blocked`）；只有用户显式放弃才转终态。
- **BE-RUN-009**（PRD-RUN-009）：常规实现与修复仍不收敛时，整个 Run 最多一次 rescue——使用更强模型、全新上下文会话重新开始该工作项；技术故障（Provider/网络/进程错误）不消耗 rescue 次数；rescue 失败进入 `blocked`。

## 10. 验证、审核与发布

- **BE-QUAL-001**（PRD-QUAL-001）：从 manifest、CI 配置和用户设置产生验证目录，命令使用 program/args/cwd。
- **BE-QUAL-002**（PRD-QUAL-002～004）：同一 command spec 比较 baseline/final；`pass→fail`、`pass→unavailable` 或显著恶化为新回归。
- **BE-QUAL-003**：输出使用确定性截断与脱敏；模型摘要不能改变 verdict。
- **BE-QUAL-004**（PRD-QUAL-005、PRD-QUAL-007）：P0/P1 阻断，P2/P3 形成 advisory；修复后只复查受影响角度。审核角度按风险自适应 1–3 个：`correctness` 恒有；存在非文档源码改动加 `quality`；涉及敏感路径（auth/permission/session/security/network/process/shell/git/filesystem/database/migration/config/dependency/build/release/ci/concurr（匹配 concurrent/concurrency）/platform 等）或 diff 含敏感代码（unsafe、进程创建、shell、chmod、凭据、SQL、路径、符号链接等）加 `security`。每个角度一次独立 reviewer 调用；输入隔离——correctness 可见 RequirementSpec 对照验收场景，quality/security 只看 diff 与中性证据，不看需求意图。
- **BE-QUAL-005**（PRD-QUAL-008）：reviewer 不可用或输出无效导致 `ReviewVerdict=unavailable` 时默认阻断自动发布，Run 进入 `blocked`；不得伪造 approved；用户可经 prepare/confirm 两阶段显式确认“未经审核交付”，该确认形成永久事实。
- **BE-PUB-001**（PRD-PUB-001～003）：识别 GitHub、GitLab、自托管 GitLab 或不支持主机，返回实际模式、ready、issues 和 notes。
- **BE-PUB-002**（PRD-PUB-005）：发布只消费已批准且指纹匹配的 integration commit。
- **BE-PUB-003**：远端模式幂等推送受管分支、查找/创建 PR/MR、等待必要检查并请求合并。
- **BE-PUB-004**（PRD-PUB-004）：本地回退在 Run 开始前冻结并记录，质量门槛不改变。
- **BE-PUB-005**（PRD-PUB-006）：远端 merged 后记录权威 merge commit；本地同步失败产生 warning 和恢复操作。
- **BE-PUB-006**（PRD-PUB-007）：PR/MR 创建后远端必要检查失败时，implementer 在受管分支上最多一次 CI 修复推送。
- **BE-PUB-007**（PRD-PUB-007）：CI 修复后仍失败、或远端拒绝合并（保护分支策略等）时进入 `blocked` 并发出 ActionRequired 通知，保留 PR/MR 链接与恢复操作；恢复操作走 prepare/confirm 两阶段。

## 11. 通知领域

- **BE-NOTIFY-001**（PRD-NOTIFY-001～003）：领域模块根据阻断、错误、待操作、警告、完成和信息事件决定是否产生 `Notification`；前端不能自行合成关键通知。
- **BE-NOTIFY-002**：`notification.raised` 创建 active 通知并包含 `source_workbench`；对话和需求来源可附带 `source_node_id`，普通工作台来源允许为 `null`。
- **BE-NOTIFY-003**：`notification.acknowledged` 记录用户已读/确认，不等同问题解除。
- **BE-NOTIFY-004**：`notification.resolved` 只能由对应领域状态解除或明确解决命令产生。
- **BE-NOTIFY-005**（PRD-NOTIFY-006）：未解决的 ActionRequired、Warning 和 Error 进入 ApplicationState；快照重载后可重建 GrayDango 队列。
- **BE-NOTIFY-006**：Success/Info 可按保留策略从快照投影移除，但其里程碑事件在压缩策略允许范围内保留。
- **BE-NOTIFY-007**：同一来源问题使用稳定去重键，重复 raised 更新计数和最近时间，不制造通知风暴。

## 12. API、NDJSON 与终端

### 12.1 契约

- **BE-API-001**（PRD-NFR-010）：所有接口位于 `/api/v1`；错误统一为 `code`、`message`、`details`、`request_id` 和可选 `retry_after_ms`。
- **BE-API-002**：Rust OpenAPI 是 REST DTO 的唯一契约源；Rust JSON Schema 是 EventEnvelope 联合类型的唯一契约源。
- **BE-API-003**：所有命令支持 `Idempotency-Key` 或聚合 revision；确认、发布、恢复、通知确认和队列重排必须幂等。
- **BE-API-004**（PRD-CANVAS-008）：危险命令采用 prepare/confirm 两阶段契约。prepare 返回动作摘要、目标、影响和绑定来源上下文的短期确认 token；画布操作可记录 `source_node_id`，普通工作台操作允许为 `null`。confirm 必须回传 token 与幂等键，过期、目标变化或上下文不匹配时拒绝执行。

### 12.2 路由基线

```text
GET    /api/v1/snapshot
GET    /api/v1/events?after=<sequence>

GET    /api/v1/project
POST   /api/v1/project/initialize
POST   /api/v1/conversations/project/sessions
GET    /api/v1/conversations/project/branches/{branch_id}
POST   /api/v1/conversations/project/messages
POST   /api/v1/conversations/project/branches
POST   /api/v1/conversations/project/responses/{response_id}/abort
POST   /api/v1/conversations/project/nodes/{node_id}/redact
POST   /api/v1/conversations/project/requirements

GET    /api/v1/requirements
GET    /api/v1/requirements/{id}
PUT    /api/v1/requirements/{id}/spec
POST   /api/v1/requirements/{id}/confirm
POST   /api/v1/requirements/{id}/clarifications
POST   /api/v1/requirements/{id}/cancel
PUT    /api/v1/requirements/queue

GET    /api/v1/runs/{id}
POST   /api/v1/runs/{id}/pause
POST   /api/v1/runs/{id}/resume
POST   /api/v1/runs/{id}/cancel
PUT    /api/v1/runs/{id}/plan
GET    /api/v1/runs/{id}/artifacts
POST   /api/v1/runs/{id}/publication/retry

GET    /api/v1/files/tree
GET    /api/v1/files/search
GET    /api/v1/files/content
POST   /api/v1/attachments
GET    /api/v1/attachments/{file}

GET    /api/v1/git/status
GET    /api/v1/git/diff
POST   /api/v1/git/actions/prepare
POST   /api/v1/git/actions/confirm

GET    /api/v1/providers
POST   /api/v1/providers/{id}/credentials
DELETE /api/v1/providers/{id}/credentials
POST   /api/v1/providers/{id}/probe
GET    /api/v1/providers/{id}/models
GET    /api/v1/model-profiles
PUT    /api/v1/model-profiles
GET    /api/v1/usage

GET    /api/v1/settings
PUT    /api/v1/settings
GET    /api/v1/publication/readiness
POST   /api/v1/notifications/{id}/acknowledge
POST   /api/v1/diagnostics/export
POST   /api/v1/system/restart

GET    /api/v1/terminals
POST   /api/v1/terminals
POST   /api/v1/terminal-access
DELETE /api/v1/terminals/{id}
GET    /api/v1/terminals/{id}/ws
```

其他危险命令（redact、生成中切换新会话、强制发布、终端关闭运行中会话、发布重试）复用与 `POST /api/v1/git/actions/prepare` + `POST /api/v1/git/actions/confirm` 相同的 prepare/confirm 两阶段模式与 `…/prepare` + `…/confirm` 路由形态（BE-API-004）。生成中切换确认后先 abort 旧响应并持久化 `aborted`，再幂等创建 session；草稿和未完成需求不取消、不复制。计划编辑走既有 `PUT /api/v1/runs/{id}/plan`，不单设 pause-edits 端点。

`POST /api/v1/requirements/{id}/clarifications` 请求体携带问题节点 ID、`selected_option_ids[]` 与 `custom_text`。后端按 `single_choice | multiple_choice | free_text` 校验数量、自定义权限和 ID 存在性；澄清回答作为独立 ClarificationAnswer 节点沿来源分支生成。`POST /api/v1/requirements/{id}/cancel` 将未确认需求和待回答轮次置为 `cancelled`，不得入队。

`POST /api/v1/requirements/{id}/confirm` 请求体携带 revision 与最终 `task_budget_usd`；响应的确认预览同时返回设置默认预算和当前有效预算。Run 创建后预算不可被后续设置或需求修改回写。

### 12.3 HTTP NDJSON 事件流

- **BE-EVT-001**（PRD-EVENT-009）：`GET /api/v1/events` 返回 `Content-Type: application/x-ndjson`，每行一个完整 `EventEnvelope`。
- **BE-EVT-002**：事件只有 durable append 后才能进入在线流；单连接按 sequence 串行发送。
- **BE-EVT-003**：`after` 是客户端最后已应用 sequence；服务端发送所有更大且仍可续传的事件。
- **BE-EVT-004**：当 `after` 小于压缩下限时，发送一个 `system.resync_required` envelope，payload 包含当前 snapshot sequence 和 compaction floor，然后关闭响应。
- **BE-EVT-005**：慢消费者超过缓冲上限时发送可用的重连提示并关闭；不无限缓存，也不跳过中间事件。
- **BE-EVT-006**：事件类型至少覆盖 `conversation.*`、`requirement.*`、`run.*`、`work_item.*`、`validation.*`、`review.*`、`publication.*`、`usage.*`、`notification.*`、`system.*`。
- **BE-EVT-007**：node delta 包含 `node_id`、`node_sequence`、`field`、`append` 和 `content_length`；节点 checkpoint 是最终可重建事实。
- **BE-EVT-008**：不透传 Rig/Provider 事件、reasoning、凭据、绝对路径、终端字节或无限工具输出。

终端使用独立、鉴权、版本化 WebSocket，因为 PTY input/output/resize 是双向字节流，不是业务状态事件。

## 13. 文件、Git 与终端

- **BE-FILE-001**：文件 API 拒绝 `.git`、`.raccoon-node`、依赖/构建目录、路径逃逸和符号链接逃逸；文本预览默认上限 128 KiB。
- **BE-GIT-001**：Git 状态基于 `git status --porcelain=v2 -z --branch`，按字节安全解析路径。
- **BE-GIT-002**：stage/unstage 接受去重后的 `paths[]`，必须在获取写锁后先校验全部路径，再作为一个批次应用；任一路径不存在、状态不匹配或存在冲突时整批不执行。未跟踪文件允许 stage，unstage 后必须恢复未跟踪状态；成功结果返回实际变化路径并只产生一次 `git.updated`。commit、fetch、pull、push、switch、create 继续属于 v1 Git 写动作；危险动作要求 prepare/confirm 两阶段产生的确认 token，前端是画布确认节点还是普通工作台 Dock 不改变后端契约，批量丢弃不在 v1 范围。
- **BE-TERM-001**：PTY cwd 固定 Git 根；限制终端数、尺寸、缓冲和闲置时间，关闭时终止完整进程树。
- **BE-TERM-002**：终端消息为版本化 input/output/resize/exit/error；终端正文不进入事件、状态或常规日志。

## 14. 安全、隐私与平台

- **BE-SEC-001**：loopback 启动生成随机 nonce：自动打开的浏览器 URL 携带一次性 token 换取 SameSite session；手动访问时用户从终端输出复制一次性 token；token 一次性且短期有效。
- **BE-SEC-002**：非 loopback 必须配置访问凭据，REST、NDJSON 和 WebSocket 全部鉴权，CORS 只允许配置 origin。
- **BE-SEC-003**：终端在非 loopback 下需要额外短期授权。
- **BE-SEC-004**：错误、日志、事件、状态、审计和诊断共用集中脱敏。
- **BE-SEC-005**：不记录 Prompt、澄清答案全文、凭据、隐藏推理、完整工具输出或终端正文。
- **BE-PLAT-001**：Windows 使用 `PathBuf`，拒绝 UNC、扩展 UNC、保留设备名和路径逃逸。
- **BE-PLAT-002**：传给外部进程前移除普通本地盘的 `\\?\` 前缀；内部使用规范路径比较。
- **BE-PLAT-003**：外部命令使用 program + args；`.cmd`/`.bat` 经显式 Windows 适配。
- **BE-PLAT-004**：macOS/Linux 终止进程组，Windows 终止 Job Object 或等价进程树。
- **BE-PLAT-005**（PRD-NFR-007）：三平台分别验证快照临时文件、flush/fsync、原子替换、active 尾行截断和封存段改名。
- **BE-PLAT-006**（PRD-NFR-011）：每个平台只发布一个嵌入前端的 Raccoon Node 可执行文件；复制到空目录后仍能启动 UI。

## 15. 可观测性

- 日志按日滚动，默认保留七天；诊断包由用户显式生成。
- 指标覆盖 API 延迟、NDJSON 连接、事件追加/fsync、快照、重放、压缩、队列、Agent、用量、worktree、验证、通知和发布。
- request、command、conversation、requirement、run、operation 和 publication 使用不同关联 ID。
- 工具原始输出、模型原始响应、事件 payload 正文和终端正文不进入常规日志。

## 16. 测试与验收

### 16.1 事件存储与恢复

- **BE-TEST-DATA-001**（AC-14）：每个“事件落盘后、reducer 前/推送前/快照前/替换前”崩溃点都能从 JSONL 补齐。
- **BE-TEST-DATA-002**（AC-15）：覆盖快照临时文件、错误哈希、active 尾部半行、完整坏行、重复 sequence、未知缺口、范围错误和封存段损坏。
- **BE-TEST-DATA-003**：只读诊断拒绝全部 mutation，并能导出损坏范围、最后可信 sequence 和备份恢复步骤。
- **BE-TEST-DATA-004**：语义压缩前后从 sequence 0 重放得到同一 state hash，且需求确认、质量、发布、阻断和未解决通知不丢失。
- **BE-TEST-DATA-005**：三个平台完成真实文件系统 kill/restart、原子替换和目录同步测试。

### 16.2 Agent、仓库与安全

- Provider Registry 全量无凭据契约测试；仅对当前环境有凭据的 Provider 运行 live smoke。
- Rig mock 覆盖流式、工具、无效输出、中断、fallback、限流、取消和上下文重建。
- 临时 Git 仓库覆盖脏工作区、worktree、并行批与合并任务、冲突、主分支移动、取消和恢复。
- 路径覆盖普通盘符、`\\?\` 路径、UNC 拒绝、保留名、超长组件和符号链接逃逸。
- 命令策略、网络策略、凭据环境剥离、全链路脱敏、loopback nonce 和非 loopback 全接口鉴权。
- GitHub/GitLab fake server 覆盖 readiness、幂等创建/合并、远端失败、本地回退和本地同步。

### 16.3 接口、通知与端到端

- **BE-TEST-EVT-001**（AC-16）：NDJSON 覆盖任意 chunk、重复事件、断线续传、压缩下限、重新同步和慢消费者。
- **BE-TEST-NOTIFY-001**（AC-17）：通知优先级、去重、acknowledged/resolved、重启恢复，以及对话/需求节点定位与普通工作台仅打开语义完整。
- **BE-E2E-001**（AC-01～03）：从规格确认到自动交付，活动 Run 不阻塞问答，脏工作区不被修改。
- **BE-E2E-002**（AC-04～06）：验证基线、新回归和审核门槛。
- **BE-E2E-003**（AC-07）：在每个外部副作用阶段强制退出，不重复提交、推送或合并。
- **BE-E2E-004**（AC-08～09）：角色能力、默认预算、确认覆盖、Run 冻结、80% 软告警和未知价格行为正确。
- **BE-E2E-005**（AC-12～13）：流式过程/工具/回答、历史分支和节点化确认保持事实完整。
- **BE-E2E-006**（AC-18）：三平台单二进制在无源码、无 Node.js 目录完成首屏、事件流、PTY 和重启恢复。
- **BE-E2E-007**（AC-19）：生成中确认新会话先持久化旧活动节点 `aborted`，再幂等创建并激活只有 root branch 的空 graph；旧 session 重启后仍可重建。

## 17. 完成定义

- 所有 `BE-*` 与 `PRD-*`、`AC-*` 建立测试追踪。
- OpenAPI、JSON Schema、生成客户端、生成事件类型和实现无漂移。
- 领域层不依赖 Rig、Axum 或 Provider DTO。
- 断电/kill 测试证明事件可重放、外部副作用不重复，损坏时明确阻止写入。
- 安全测试证明 Agent 不能越过 worktree、执行 Git 写动作、读取凭据或调用发布 API。
- 三平台 CI 和独立单二进制打包验收通过。

## 18. 需求追踪矩阵

| 后端需求                             | 产品需求 / 验收                                          |
| ------------------------------------ | -------------------------------------------------------- |
| `BE-BOOT-*`                          | PRD-PROJ-001～006、PRD-NFR-007～009                      |
| `BE-DATA-*`                          | PRD-EVENT-001～011、PRD-NFR-001、AC-14～16               |
| `BE-MODEL-*`                         | PRD-MODEL-001～006、PRD-USAGE-001～003、AC-08～09        |
| `BE-CHAT-*`                          | PRD-CHAT-001～015、AC-02、AC-12～13、AC-19               |
| `BE-SPEC-*`                          | PRD-SPEC-001～008、AC-01、AC-13                          |
| `BE-TOOL-*`、`BE-NET-*`              | PRD-PUB-005、PRD-NFR-002～004                            |
| `BE-RUN-*`                           | PRD-RUN-001～013、PRD-EVENT-005、AC-02～03、AC-07、AC-11 |
| `BE-QUAL-*`                          | PRD-QUAL-001～008、AC-04～06                             |
| `BE-PUB-*`                           | PRD-PUB-001～007、AC-01、AC-07                           |
| `BE-NOTIFY-*`                        | PRD-NOTIFY-001～007、AC-09、AC-17                        |
| `BE-API-*`、`BE-EVT-*`               | PRD-EVENT-009～011、PRD-NFR-010、AC-16                   |
| `BE-FILE-*`、`BE-GIT-*`、`BE-TERM-*` | PRD-CANVAS-008～009、PRD-NFR-002                         |
| `BE-SEC-*`、`BE-PLAT-*`              | PRD-NFR-002～007、PRD-NFR-011、AC-18                     |
| `BE-TEST-*`、`BE-E2E-*`              | AC-01～19                                                |
