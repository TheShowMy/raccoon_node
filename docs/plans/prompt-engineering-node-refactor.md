# 计划文档：借鉴 PlanWeave 的提示词工程与节点化改造

> 版本：v0.1
> 日期：2026-07-03
> 关联研究：[PlanWeave](https://github.com/GaosCode/PlanWeave)、raccoon_node 现有架构

---

## 1. 背景与目标

### 1.1 背景

PlanWeave 是一个文件驱动的长期编码 agent 循环系统，核心亮点在于：

- **角色化 Skill Prompts**：每个 agent 角色对应一份 `SKILL.md`（plan-maker / plan-coordinator / plan-runner / plan-reviewer / plan-auditor / plan-recovery）。
- **分层 Prompt Composition**：Global → Project/Canvas → Project Graph Context → Task Node → Block。
- **审核即一等公民**：实现 → 多视角子审核 → 审核汇总 → 合并 → 最终审核。
- **结构化输出与 JSON Repair**：每个 block 都有固定 JSON 契约和修复 prompt。
- **负面约束与边界**：大量 `Do not...`、`must not...`、stop condition。

raccoon_node 当前已实现 FIFO 队列、自动 DAG 扩展、失败恢复、多档模型，但 prompt 仍以 inline 字符串或单文件模板为主，DAG 中 review 子节点语义偏固定，计划审计尚未显式节点化。

### 1.2 目标

在不破坏现有 FIFO 自动执行、Pi RPC 约束、SQLite 主存储的前提下：

1. 把 PlanWeave 的提示词工程方法（角色化、分层、section marker、结构化契约）落地到 raccoon_node。
2. 将「DAG 生成 + 计划审计」合并为一个显式节点，并引入 Pi 插件化 sub-agent。
3. 失败任务生成显式 `RecoveryNode`，并优化高档模型接管任务的视觉表现。
4. 为后续 prompt 调试、Flow Coverage 表、可复用 skill 库打下基础。

---

## 2. 设计原则

- **节点画布优先**：所有新功能必须在 React Flow 画布上有明确节点/边表达。
- **不改变执行语义**：后端仍是 FIFO + 自动 DAG 执行；新节点主要增强可视化和可审计性。
- **保持 Pi RPC 唯一入口**：所有 LLM 调用仍走 `pi --mode rpc`；sub-agent 通过 Pi 插件或社区插件完成，不绕过后端。
- **SQLite 是唯一业务主存储**：节点位置、状态、边仍由后端生成并持久化；Pi session 只保留模型上下文。
- **向后兼容**：旧需求/旧 execution_plan 在不触发新功能时保持原行为。

---

## 3. 关键设计决策

### 3.1 计划审计并入 DAG 生成节点

**决策**：不新增独立「审计节点」，而是把审计作为「DAG 生成节点」的内部步骤。

理由：

- raccoon_node 的执行流程是 `DraftReady → Planning → PlanReady → Running`。
- 审计应当在生成执行计划后立即发生，不占用额外画布层级。
- 用户希望减少节点数量，避免画布过于复杂。

**新语义**：

- `PlanReady` 之前，后端调用高档模型对生成的 DAG 做审计。
- 审计结论写入 `RequirementExecutionPlan.audit_result`。
- 若审计不通过，需求状态停留在 `PlanReady`（或新增 `AuditFailed`），用户在画布上点击「重新规划」或「强制执行」。

### 3.2 ReviewSummary 改为「审核节点」，sub-agent 插件化

**当前问题**：

- `ReviewSubAgent` 和 `ReviewSummary` 是当前实现任务组内部的子节点，session 分散，用户难以在 ReviewSummary 中查看子审核过程。

**改造方案**：

- 将三个审核角度（正确性 / 边界与安全 / 代码质量与测试）交给 Pi 插件（或社区插件）统一执行。
- Pi 插件把子审核过程记录到同一个 session；`ReviewSummary` 节点读取该 session，展示完整审核过程。
- **ReviewSummary 不再叫「审核汇总」**，改名为 **Review / 审核节点**；它代表「以 sub-agent 方式完成的代码审核」。
- 后端保留 `RequirementTaskKind::ReviewSummary`，但前端文案和图标统一为「审核」。

**依赖**：

- 需要确认/实现 Pi 插件：`raccoon-review`（或复用社区同类插件）。
- 插件输入：task ref、审核角度、diff 路径、验收标准。
- 插件输出：每个角度的 verdict + feedback + trace。

### 3.3 失败任务生成显式 RecoveryNode

**当前问题**：

- 任务失败后，`GuidedRetry` 会生成 `recovery_guidance`，但仅在 task detail / trace 中可见。

**改造方案**：

- 当任务进入 `GuidedRetry` 且成功生成恢复方案时，后端在 execution_plan 中插入一个 **RecoveryNode**。
- RecoveryNode 不是真正可执行任务，而是**可视化占位节点**，显示恢复方案内容，并提供一个「按方案执行」按钮。
- 用户点击后，原实现任务重置为 `Fixing` 并注入 recovery_guidance 重新执行。

**布局**：

- RecoveryNode 位于原实现任务下方同一列，或右下方，用虚线框表示。
- 原实现任务 → RecoveryNode 用虚线箭头（指导关系）。
- 高档模型接管后（`HighTierExecution`）：
  - 断开 实现任务 → RecoveryNode 的指导线。
  - 新增 RecoveryNode → Review（原 ReviewSummary）的实线，表示高档模型代替原任务直接进入审核。
  - 在 实现任务 → Review 的原连线上画 **X**（或红色禁用样式），表示该实现路径已失败。

### 3.4 Prompt 工程基础改造

- **Skill 文件化**：已将需求澄清 prompt 迁移到 `prompts/skills/requirement_coordinator.md`，并继续把 `execution.rs` 中的 inline prompt 拆成 `prompts/skills/` 下的独立文件，带 YAML frontmatter。
- **Section Markers**：引入 `<!-- raccoon:managed:start section-name -->` 标记，允许系统注入动态上下文而不污染用户手写 prompt。
- **Prompt Surface**：后端渲染最终 prompt 时返回 `sources` 数组，前端可展示分层贡献。
- **JSON 契约统一**：所有 task kind 的 JSON schema 集中到一个 `prompts/contracts/` 目录，便于维护和修复。

---

## 4. 实施阶段

### Phase 1：Prompt 工程基础（低风险，可独立发布）

#### 4.1.1 拆分 prompt 模板

新增目录结构：

```text
prompts/
├── skills/
│   ├── requirement_coordinator.md      # 当前生效的需求澄清 prompt
│   ├── execution_planner.md            # 原 build_requirement_plan_prompt
│   ├── implementation_runner.md        # 原 implementation 部分
│   ├── code_review.md                  # 原 Review / ReviewSummary
│   ├── branch_merge.md
│   ├── merge_review.md
│   └── recovery_guide.md               # 原 build_recovery_guidance_prompt
├── contracts/
│   ├── task_output.json
│   ├── review_result.json
│   ├── recovery_guidance.json
│   └── execution_plan.json
└── global/
    └── default.md                      # 可选全局提示词
```

每个 skill 文件格式：

```markdown
---
name: execution_planner
description: 根据确认草案生成可执行 DAG
role: 执行规划 Agent
boundaries:
  - 不修改代码
  - 不生成审核/合并任务
---

你是当前项目的{{role}}。
...
```

#### 4.1.2 引入 Section Marker

在 skill 模板中预留 managed section：

```markdown
## 当前需求草案
<!-- raccoon:managed:start requirement-draft -->
{{REQUIREMENT_DRAFT}}
<!-- raccoon:managed:end requirement-draft -->
```

新增 `crates/raccoon-requirement/src/prompt/sections.rs` 负责解析、校验、替换 section。

#### 4.1.3 Prompt Surface

`build_requirement_prompt` / `build_requirement_task_prompt` 返回：

```rust
pub struct RenderedPrompt {
    pub markdown: String,
    pub sources: Vec<PromptSource>,
}
```

其中 `PromptSource` 包含 kind、label、included、empty、missing、preview。

#### 4.1.4 验收标准

- [ ] 所有现有测试通过。
- [ ] `npm run check` 无新增错误。
- [ ] 最终 prompt 内容与改造前保持一致（diff 对比）。
- [ ] 新增 section parser 单元测试覆盖边界不匹配、缺失、替换。

#### 4.1.5 涉及文件

- 新增：`prompts/skills/*`、`prompts/contracts/*`、`crates/raccoon-requirement/src/prompt/*`
- 修改：`crates/raccoon-requirement/src/analysis.rs`、`crates/raccoon-requirement/src/execution.rs`、`crates/raccoon-requirement/src/lib.rs`

---

### Phase 2：DAG 生成/审计节点 + Sub-Agent 插件化

#### 4.2.1 DAG 生成节点可视化

当前 `execution_planning_started → execution_plan_ready` 是后端自动完成，前端只渲染最终 DAG。

改造：

- 在 `PlanReady` 状态的 DAG 最左侧增加一个 **PlanNode**（或复用 `requirement-dag` 节点），标题为「执行规划」，点击可查看生成的 plan JSON 和审计结论。
- PlanNode 不参与实际执行，只作为入口/元信息节点。

#### 4.2.2 计划审计

在 `parse_requirement_plan` 成功后，调用高档模型执行审计：

- prompt：基于 PlanWeave `plan-auditor/SKILL.md` 改造，输入为 requirement draft + execution plan + project context。
- 输出：`PASS / NEEDS_REVISION / BLOCKED` + findings + Flow Coverage 表。
- 结果存入 `RequirementExecutionPlan.audit_result: Option<PlanAuditResult>`。

若审计结论为 `BLOCKED`：

- 需求状态保持 `PlanReady`，但标记 `audit.blocked = true`。
- 画布上 PlanNode 显示红色，展示 blocker。

若审计结论为 `NEEDS_REVISION`：

- PlanNode 显示黄色，展示 findings；用户可点击「按建议重试规划」。

#### 4.2.3 Sub-Agent 插件化

**目标**：把当前 backend-driven 的 `ReviewSubAgent` 改为由 Pi 插件编排的独立 sub-agent 会话；审核节点（Review / 原 ReviewSummary）能看到执行过程，但**不污染审核节点自身的上下文**。

**方案**：

- 不删除后端 `ReviewSubAgent` 调度逻辑，而是把具体审核执行交给 Pi 插件。
- 新增/复用 Pi extension：`raccoon-sub-agent`（它不是代码审核逻辑本身，而是 sub-agent 编排器）。
  - 输入：父任务 ref、审核角度、工作区路径、diff 范围、验收标准、输出契约。
  - 行为：启动一个独立 Pi 子会话（`--no-session` 或独立 session 文件），在该会话中运行代码审核 sub-agent；记录完整工具调用、思考过程和 verdict。
  - 输出：标准化的 `{angle, approved, feedback, result_summary, sub_session_file}`。
- 后端仍生成 3 个 `ReviewSubAgent` task，但每个 task 的 `pi_session_file` 是 sub-agent 插件生成的**独立 session**，不再是主任务 session。
- `ReviewSummary`（审核节点）不直接运行 sub-agent，而是：
  - 收集 3 个 `ReviewSubAgentResult`；
  - 按需读取每个 `sub_session_file`，将子审核过程事件按时间线合并展示；
  - 自身只做最终汇总判断：`approved = all(sub.approved)`，生成汇总 feedback。

**上下文隔离**：

- 审核节点自身 session 只包含「汇总指令 + 3 个子审核结果摘要」，不引入子审核的详细思考或完整 diff。
- 子审核的详细过程保存在各自 `sub_session_file`，前端通过 `getTaskSession` 按需读取并渲染到时间线。

**代码审核标准化**：

- 可以自研一个轻量 `raccoon-code-review` extension，用于标准化 sub-agent 的输入（diff、角度、验收标准）和输出（verdict、feedback）。
- 该 extension 只负责单次审核判定，不感知 DAG 或节点语义；DAG 编排仍由 raccoon_node 后端完成。

**数据模型调整**：

```rust
pub struct RequirementExecutionTask {
    // 新增
    pub review_sub_agents: Vec<ReviewSubAgentResult>,
    pub audit_result: Option<PlanAuditResult>,
}

pub struct ReviewSubAgentResult {
    pub angle: String,
    pub approved: bool,
    pub feedback: Option<String>,
    pub result_summary: String,
    pub sub_session_file: Option<String>, // sub-agent 独立会话文件
}
```

#### 4.2.4 ReviewSummary 语义变更

- 前端 `taskKindText` 中 `review_summary` 改为「审核」。
- `RequirementTaskNode` 中 `review_summary` 图标使用 `ShieldCheck`（保持）。
- TaskDetailDialog 中，implementation 任务的审核时间线读取 `review_sub_agents` 的 `sub_session_file`，与审核节点自身的汇总 session 合并展示。

#### 4.2.5 验收标准

- [ ] 生成 plan 后自动触发审计；审计结果可在 PlanNode 查看。
- [ ] BLOCKED 时无法开始执行；NEEDS_REVISION 时可一键重试规划。
- [ ] Sub-agent 审核过程可在 Review（原 ReviewSummary）节点时间线中查看。
- [ ] 审核节点自身 session 不包含子审核详细 diff/思考，仅包含汇总指令和子审核结果。
- [ ] 旧需求无 `sub_session_file` 时回退到现有 backend-driven 展示，保持兼容。

#### 4.2.6 涉及文件

- 后端：`crates/raccoon-requirement/src/execution.rs`、`crates/raccoon-store/src/store/mod.rs`、`crates/raccoon-api/src/handlers.rs`、`crates/raccoon-core/src/models.rs`
- 前端：`frontend/src/components/nodes/RequirementTaskNode.tsx`、`frontend/src/canvas/buildProjectNodes.ts`、`frontend/src/canvas/edges.ts`、`frontend/src/types/api.ts`
- 插件：
  - `.raccoon-node/extensions/raccoon-sub-agent.mjs`：sub-agent 编排插件。
  - `.raccoon-node/extensions/raccoon-code-review.mjs`：可选，标准化单次代码审核输入输出。

---

### Phase 3：RecoveryNode 与高档模型接管可视化

#### 4.3.1 RecoveryNode 数据模型

当任务进入 `GuidedRetry` 并生成 `recovery_guidance` 时：

- 后端在 execution_plan.tasks 中追加一个特殊 task：

```rust
RequirementExecutionTask {
    id: format!("recovery-{task_id}"),
    kind: RequirementTaskKind::Recovery, // 新增 kind
    depends_on: vec![task_id.clone()],
    review_for: Some(task_id.clone()),
    status: RequirementTaskStatus::Pending, // 可视化态，不参与调度
    result_summary: Some(recovery_guidance),
    ...
}
```

- 新增 `RequirementTaskKind::Recovery`。

#### 4.3.2 RecoveryNode UI

- 节点尺寸：宽度 220，高度自适应（最多 180）。
- 样式：虚线边框、⚡ 图标、标题「恢复方案」。
- 内容：展示 root_cause / strategy / steps / verification 摘要。
- 操作按钮：
  - 「按方案执行」：重置原任务为 `Fixing` 并继续。
  - 「高档模型接管」：直接触发 `HighTierExecution`。

#### 4.3.3 高档模型接管可视化

当任务从 `GuidedRetry` 进入 `HighTierExecution`：

- 后端事件：`execution_task_high_tier_takeover`。
- 前端边变更：
  - 原 实现任务 → RecoveryNode（虚线）消失。
  - 新增 RecoveryNode → Review 节点（实线，表示高档模型执行结果进入审核）。
  - 原 实现任务 → Review 的连线保留但样式变为红色 + 末端 X 标记，表示实现失败。
- 实现任务节点本身显示「失败 / 已接管」状态。

React Flow 边样式：

```typescript
{
  id: "...",
  style: { stroke: "#ef4444", strokeDasharray: "4 2" },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#ef4444" },
  label: "×",
  labelStyle: { fill: "#ef4444", fontSize: 16, fontWeight: "bold" },
  labelBgStyle: { fill: "transparent" },
  labelShowBg: false,
}
```

#### 4.3.4 布局算法调整

当前 `layout.ts` 只对外部 task（implementation / branch_merge / merge_review）做分层布局。

调整：

- RecoveryNode 跟随其 `review_for` 的实现任务，放在下一层偏右。
- 当高档模型接管后，Review 节点位置不变，RecoveryNode 向右移动作为 Review 的前置。
- 避免 RecoveryNode 与实现任务组内部 review 节点重叠：把 RecoveryNode 放在实现任务组外部、右下方。

实现建议：

- 在 `getTaskLayout` 之前，先把 RecoveryNode 视作 `review_for` 任务的依赖节点，但不影响实际执行拓扑。
- 或在 `buildProjectNodes` 中给 RecoveryNode 单独计算 `position`，不经过 `getTaskLayout`。

#### 4.3.5 验收标准

- [ ] 实现任务失败后，画布上出现 RecoveryNode。
- [ ] RecoveryNode 展示高档模型恢复方案摘要。
- [ ] 点击「按方案执行」后原任务进入 Fixing 并继续。
- [ ] 高档模型接管后，实现任务 → Review 连线变红并带 X，RecoveryNode → Review 出现实线。
- [ ] 多个实现任务失败时，各自 RecoveryNode 不重叠。

#### 4.3.6 涉及文件

- 后端：`crates/raccoon-store/src/store/mod.rs`、`crates/raccoon-store/src/store/helpers.rs`、`crates/raccoon-core/src/models.rs`、`crates/raccoon-api/src/handlers.rs`、`crates/raccoon-pi-rpc/src/lib.rs`
- 前端：`frontend/src/components/nodes/RequirementTaskNode.tsx`、`frontend/src/canvas/buildProjectNodes.ts`、`frontend/src/canvas/edges.ts`、`frontend/src/canvas/layout.ts`、`frontend/src/types/api.ts`

---

### Phase 4：UI 增强与工程债务

#### 4.4.1 Prompt Layers 调试面板

在 TaskDetailDialog 中新增「Prompt」标签页：

- 列出 Global / Project / Task / Block 各层。
- 显示每层长度、是否为空/缺失。
- 提供「复制最终 prompt」按钮。

#### 4.4.2 Flow Coverage 表

在 PlanNode 或 TaskDetailDialog 中展示审计生成的 Flow Coverage 表：

| Flow | Trigger | Processing | State | Output | Failure Path | Verification | Gaps |
|---|---|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... | ... | Gap: ... |

#### 4.4.3 Skill 市场基础

- `prompts/skills/` 支持按名称加载。
- 后端启动时校验所有 skill 文件 frontmatter。
- Skill 仅作用于现有 `RequirementTaskKind` 的 prompt 渲染，不引入新的自定义节点类型。

#### 4.4.4 验收标准

- [ ] Prompt Layers 面板可正确展示分层来源。
- [ ] Flow Coverage 表可渲染审计结论中的 gaps。
- [ ] Skill 文件缺失或 frontmatter 非法时启动报错。

---

## 5. 数据模型变更

### 5.1 `RequirementExecutionPlan`

```rust
pub struct RequirementExecutionPlan {
    pub summary: String,
    pub tasks: Vec<RequirementExecutionTask>,
    pub audit_result: Option<PlanAuditResult>, // 新增
}

pub struct PlanAuditResult {
    pub verdict: PlanAuditVerdict,
    pub flow_coverage: Vec<FlowCoverageRow>,
    pub findings: Vec<PlanFinding>,
    pub reviewed_at: DateTime<Utc>,
}

pub enum PlanAuditVerdict { Pass, NeedsRevision, Blocked }

pub struct PlanFinding {
    pub severity: FindingSeverity, // P1 / P2 / P3
    pub title: String,
    pub evidence: String,
    pub impact: String,
    pub plan_change: String,
}
```

### 5.2 `RequirementTaskKind`

```rust
pub enum RequirementTaskKind {
    Implementation,
    Review,
    ReviewSummary,
    ReviewSubAgent,
    BranchMerge,
    MergeReview,
    Recovery,        // 新增
}
```

### 5.3 `RequirementExecutionTask`

```rust
pub struct RequirementExecutionTask {
    // 现有字段...
    pub review_sub_agents: Vec<ReviewSubAgentResult>, // 新增
}

pub struct ReviewSubAgentResult {
    pub angle: String,
    pub approved: bool,
    pub feedback: Option<String>,
    pub result_summary: String,
    pub sub_session_file: Option<String>, // sub-agent 独立会话文件
}
```

### 5.4 前端类型同步

同步更新 `frontend/src/types/api.ts`。

---

## 6. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| Pi 插件开发/选型失败 | Phase 2 受阻 | 保留当前 backend-driven ReviewSubAgent 作为 fallback，先实现 audit 和 RecoveryNode |
| 节点布局变复杂 | RecoveryNode 重叠、边混乱 | 先在 `layout.ts` 中给 RecoveryNode 预留一列，逐步迭代 |
| Prompt 拆分后语义漂移 | 测试失败、LLM 输出变化 | Phase 1 必须通过「改造前后 prompt diff 完全一致」的测试 |
| 数据模型变更导致旧需求无法加载 | 兼容性 | 所有新增字段加 `serde(default)`；旧 plan 无 audit_result 时 UI 隐藏相关面板 |
| 高档模型接管后用户困惑 | UX | 用红色 X 线和明确文案「实现失败，已由高档模型接管」 |

---

## 7. 不做清单

- 不实现 PlanWeave 的手动 `claim-next / submit-result` 流程。
- 不改变 `data.db` 是唯一业务主存储的约束。
- 不引入多 canvas / project-graph.json（当前单项目 `current`）。
- 不绕开 Pi Agent RPC 直接调用其他 LLM。
- 不删除现有 `ReviewSubAgent` 后端逻辑，直到 Pi 插件验证稳定。

---

## 8. 测试计划

### 8.1 单元测试

- prompt section 解析与替换。
- skill frontmatter 校验。
- PlanAuditResult 序列化/反序列化。
- RecoveryNode 插入与布局坐标计算。
- 高档模型接管后的边状态转换。

### 8.2 集成测试

- 生成 plan → 审计 → 执行完整流程。
- 实现任务失败 → GuidedRetry → RecoveryNode → HighTierExecution → 审核通过。
- 旧需求加载不崩溃。

### 8.3 手工测试

- React Flow 画布上 RecoveryNode 不重叠。
- 红色 X 边在深色/浅色主题下可见。
- Prompt Layers 面板复制内容正确。

---

## 9. 里程碑

| 里程碑 | 交付物 | 预计周期 |
|---|---|---|
| M1 | Phase 1 完成：prompt skill 化、section marker、Prompt Surface | 1 周 |
| M2 | Phase 2 完成：PlanNode + 审计、Review 语义变更、sub-agent 插件 PoC | 1.5 周 |
| M3 | Phase 3 完成：RecoveryNode、高档模型接管可视化 | 1 周 |
| M4 | Phase 4 完成：Prompt Layers、Flow Coverage、skill 校验 | 0.5 周 |

---

## 10. 下一步行动

1. 确认是否接受本计划范围与优先级。
2. 确认 Pi 插件策略：
   - 选项 A：自行开发 `raccoon-review` extension。
   - 选项 B：调研并集成现有 Pi 社区审核插件。
   - 选项 C：Phase 2 先用 backend-driven sub-agent，插件化放到 M2 后期。
3. 批准后开始 Phase 1，先迁移 prompt 模板并保持行为不变。
