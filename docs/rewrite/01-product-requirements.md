# Raccoon Node 产品需求文档

> 状态：实施基线
> 目标版本：v1
> 目标用户：使用本地 Git 仓库的独立开发者
> 关联文档：[前端需求](./02-frontend-requirements.md) · [后端需求](./03-backend-requirements.md) · [技术决策](./04-architecture-decisions.md)

## 1. 产品定义

Raccoon Node 是一个单仓库、本地优先、完全节点化的需求到代码自动交付产品。用户在中央对话节点图中提出问题或开发目标，系统把可公开的过程摘要、工具活动、回答、澄清、规格、确认和交付事实表达为可追踪节点，再完成规划、执行、验证、审核与发布。

产品的核心承诺是让用户持续知道：

1. 系统如何理解需求，证据来自哪里。
2. 当前处于哪个阶段，是否需要用户介入。
3. 结果通过了哪些验证，还存在哪些风险。
4. 代码交付到了哪里，下一步是什么。

Raccoon Node 不展示隐藏推理，也不把 Provider 原始日志包装成思考过程。过程节点只展示可公开、可验证、可恢复的理解、动作、工具事实和阶段结论。

## 2. 背景与问题

现有原型已经验证项目问答、需求澄清、任务依赖、隔离 worktree、验证、审核、恢复、发布和空间化工作台的可行性，但新版不沿用旧实现。需要解决的问题包括：

- 对话仍带有线性消息结构，不能自然表达过程、工具和历史分支。
- 部分业务关系仍被压缩进传统列表、固定区域或覆盖层，节点化语言不统一。
- 运行详情容易以底层事件和 Agent 尝试为中心，交付结论、风险和恢复操作不够突出。
- 生命周期、质量和发布结果容易被一个模糊的“完成”合并。
- 外部 Agent 框架与业务状态耦合过深，恢复依赖外部会话。
- 活动需求成为全局交互锁，执行期间难以继续问答和准备后续需求。
- 持久化、实时传输和界面投影之间缺少同一套单调序号与重放语义。
- 通知入口分散，用户难以确认阻断是否仍有效、通知来自哪个节点。

新版保留 Raccoon Node 名称、React Flow 节点风格、单项目视差、工作台射线展开和单二进制体验；不兼容旧数据、Pi 会话、旧事件协议或旧页面结构。

## 3. 用户与核心任务

### 3.1 目标用户

v1 只服务独立开发者：

- 在本机维护一个已有或新建的 Git 仓库。
- 理解代码、Diff、分支和自动化检查，但不希望手工编排多个 Agent。
- 希望从模糊想法得到可运行、可验证、可回退的代码变更。
- 愿意配置模型 Provider，并自行承担模型调用成本。

### 3.2 Jobs to be Done

- 当我不熟悉仓库时，我想直接询问并获得带文件证据的回答。
- 当目标模糊时，我想让系统只提出会改变范围或方案的关键问题。
- 当规格确认后，我想让系统自动完成实现和交付，只在无法安全继续时打断我。
- 当任务运行时，我想快速看到阶段、产出、风险、用量和待办操作。
- 当程序重启或外部操作中断时，我想从已核对的事实继续，不重复提交、推送或合并。
- 当出现通知时，我想从 GrayDango 气泡直接定位到来源工作台和节点。

## 4. 产品原则

1. **全画布承载产品**：首页、对话和工作台都位于同一空间场景，不切换成传统业务页面。
2. **节点是产品语言**：关系、层级、生命周期和操作确认使用节点与边；输入、选择和编辑控件留在所属节点内部。
3. **对话是空间中心**：中央对话节点图拥有最多可用空间，其他能力固定环绕。
4. **GrayDango 是唯一全局通知入口**：全局错误、待操作、告警和完成信息统一进入宠物气泡队列。
5. **事实先于投影**：JSONL 事实事件先持久化，内存状态、`state.json`、实时流和界面都由同一 reducer 投影。
6. **确认需求，自动交付**：用户确认规格后，计划生成即执行；用户可暂停并编辑尚未开始的工作项。
7. **自动不等于越权**：Agent 只能在受管 worktree 内使用内置工具，发布由后端状态机独占执行。
8. **基线决定回归**：历史失败显著展示，但只有新增或恶化失败机械阻断交付。
9. **状态和质量分离**：运行结束、代码已发布、验证干净是不同事实。
10. **单仓库、可恢复**：一个实例只绑定一个仓库；外部副作用必须能够核对并幂等恢复。
11. **过程公开且分层**：默认呈现阶段、产出、风险和下一步；大输出通过详情节点或 artifact 引用按需查看。
12. **软成本边界**：展示 token、可计算费用和阈值告警，不因软阈值自动暂停或换模。

## 5. 范围

### 5.1 v1 范围

- 单个本地 Git 仓库的识别、显式初始化和运行数据管理。
- 项目问答、文件引用和图片附件。
- 中央对话节点图、流式过程/工具/回答节点、不可变分支和可逆过程聚合。
- 问答/开发意图自动识别及用户覆盖。
- 节点化需求澄清、规格编辑、revision 和确认。
- 自动 WorkPlan、同层最多三个独立切片并行与显式合并任务、暂停和待执行项编辑。
- 受管 worktree、内置代码工具、仓库原生验证和风险审核。
- GitHub、GitLab 和本地主分支交付。
- 文件、Git、终端、模型与用量、设置的节点化工作台。
- 环绕节点、射线外侧工作台节点、相机聚焦和精确返回。
- GrayDango 通知队列与来源节点定位。
- JSONL 事实事件、单一状态快照、HTTP NDJSON 实时事件和终端 WebSocket。
- Provider、五种模型角色、软预算阈值和成本观测。
- macOS、Linux、Windows 本地磁盘路径。
- 前后端独立开发与构建，正式产物嵌入为单个 Raccoon Node 可执行文件。
- npm 全局包（按平台分包）、`cargo install --locked` 和 GitHub Releases 三平台单二进制三种分发渠道。

### 5.2 明确不做

- 多项目中心、团队协作权限或远程执行集群。
- 同一仓库多个写入型交付 Run 并行。
- 旧 `.raccoon-node` 数据、Pi session 或旧事件协议迁移。
- 第三方 MCP、技能、钩子、插件市场或自定义 Agent 工具。
- GitHub、GitLab 之外的 PR/MR 平台。
- 移动端专用体验和完整 TUI。
- 传统页面式业务导航、固定全局状态区、独立通知中心或固定详情侧区。
- 使用覆盖整个业务场景的确认层；危险操作必须通过来源节点后的确认节点完成。
- 自动解决所有历史测试失败或 P2/P3 审核建议。
- 不提供对话历史整体删除；敏感内容通过节点级 redact 抹除。

## 6. 核心用户旅程

### 6.1 首次启动

1. 用户在目录中启动 Raccoon Node 单二进制。
2. 系统检查 Git 根、路径类型、运行目录、监听安全性和数据格式。
3. 非 Git 目录时，TTY 交互启动可询问是否 `git init`；服务器模式（浏览器 UI）下正常启动但仅暴露项目初始化接口与只读诊断，初始化前拒绝其他业务命令，不静默初始化。
4. 系统创建新版事件目录和初始状态快照；检测到旧版不兼容数据时拒绝覆盖，并给出显式归档指引。
5. 用户配置至少一个 Provider，为问答、澄清、规划、实现、审核五种模型角色选择主模型和可选回退模型。
6. 系统扫描技术栈、约束文档、默认分支、远端和候选验证命令，然后进入全画布能力地图。

### 6.2 对话到需求

1. 中央对话图初始只包含一个 Composer 节点；六个能力节点紧凑环绕。
2. 用户发送后，Composer 固化为用户消息节点；系统依次创建公开过程、必要工具、回答和新 Composer 节点。
3. 过程与回答在稳定节点中按真实增量流式展示，不能完成后整块出现。
4. 工具节点持续显示等待、运行、完成或失败；回答完成后可把连续过程与工具可逆聚合为过程节点。
5. 用户可从任意历史用户消息节点创建新分支，原分支和共享祖先保持不可变。
6. 意图判定为开发目标时，系统自动创建需求草稿并启动澄清，用户可取消；用户也可手动从连续节点整理为需求，来源消息、引用和附件自动关联，无须重新输入。
7. 活动 Run 不阻止问答、分支或后续需求草拟。

### 6.3 澄清与确认

1. 系统先探索仓库事实，只询问无法推断且会改变规格的问题。
2. 澄清问题、回答、规格 revision 和确认都沿来源对话分支形成节点。
3. 规格包含目标、用户价值、范围、验收场景、约束、非目标、风险、假设和证据。
4. 编辑保存后产生新 revision；只有最新 revision 可以确认。
5. 确认后需求入队，计划生成即开始执行。

### 6.4 打开和关闭工作台

1. 用户点击环绕能力节点。
2. 系统沿“中心到触发节点”的射线，在触发节点外侧生成大型工作台节点。
3. 相机聚焦该工作台；主场景保留为低对比上下文，同一时间只打开一个工作台。
4. 工作台仅保留最小标题和关闭控制，业务内容全部位于节点内部。
5. 用户关闭、按 Escape 或浏览器返回后，精确恢复主画布视口、焦点、对话分支视口、滚动状态和视差目标。

### 6.5 自动执行与交付

1. 队首需求生成 WorkPlan 并立即执行。
2. 用户可请求暂停：进行中的工作项继续完成后调度器停止，Run 进入 `paused` 后可编辑 pending 工作项、依赖和验证目标。
3. 同层最多并行三个独立切片；每个并行批之后由显式合并任务按计划序合并到 integration 分支。
4. 系统比较基线与最终验证；只阻断新增回归和 P0/P1。
5. Run 启动时计算远端 readiness 并冻结发布模式：远端 ready 时自动创建并合并 PR/MR，否则安全交付到本地主分支；运行期间远端状态变化不改变已冻结路径。
6. 最终结果包含交付位置、提交、验收证据、验证、审核、用量、费用和建议。

## 7. 功能需求

### 7.1 项目与启动

- **PRD-PROJ-001**：一个实例只绑定启动时确定的一个 Git 根目录，不提供项目列表。
- **PRD-PROJ-002**：显式路径不是 Git 根时，TTY 交互启动可询问是否执行 `git init`；服务器模式（浏览器 UI）下正常启动，但仅暴露 `POST /api/v1/project/initialize` 与只读诊断，初始化完成前其他业务命令拒绝。
- **PRD-PROJ-003**：Windows v1 只接受普通本地磁盘绝对路径，明确拒绝 UNC。
- **PRD-PROJ-004**：运行数据只能位于 `<git_root>/.raccoon-node/`；清理逻辑不得把 Git 根或用户源码作为目标。
- **PRD-PROJ-005**：主工作区不干净时允许问答、浏览和确认需求，但 Run 停在 `waiting_workspace`。
- **PRD-PROJ-006**：检测到旧布局时拒绝写入，展示只读诊断和显式归档步骤，不覆盖或自动清理。

### 7.2 对话与意图

- **PRD-CHAT-001**：对话支持文本、最多八个仓库文件引用和最多三张图片。
- **PRD-CHAT-002**：系统自动识别 `question | change | ambiguous`；`ambiguous` 按 question 处理，界面提示“意图识别不确定”，用户可在发送前后随时覆盖为 change。
- **PRD-CHAT-003**：从问答生成需求时关联选定节点、引用和附件，无须重复输入。
- **PRD-CHAT-004**：Run 执行期间 Composer、分支和需求草拟保持可用。
- **PRD-CHAT-005**：停止响应后保留已持久化节点和公开内容，活动节点转为 `aborted`。
- **PRD-CHAT-006**：过程节点只包含可公开的理解、证据、动作、阶段结论和下一步，不保存隐藏推理。
- **PRD-CHAT-007**：持久化对话是不可变有向无环图，至少包含用户、过程、工具、回答、澄清、规格和确认节点。
- **PRD-CHAT-008**：过程和回答先创建稳定节点 ID，再以 `node_sequence` 有序增量更新；重连不得重复。
- **PRD-CHAT-009**：从历史用户消息分支时继承根到锚点的祖先，原分支不变；其他节点归一到最近祖先用户节点。
- **PRD-CHAT-010**：每个空闲分支末端只有一个 Composer；未发送草稿不是业务事实。
- **PRD-CHAT-011**：连续过程与工具可投影为可逆 `ProcessGroup`，不得删除原节点、边或恢复事实。
- **PRD-CHAT-012**：澄清、规格和确认使用同一图与分支语义。
- **PRD-CHAT-013**：意图判定为 `change` 时，系统自动创建需求草稿并启动澄清流程，用户可取消；手动“整理为需求”路径保留，用于从问答节点转换。
- **PRD-CHAT-014**：用户可对任意对话节点发起 redact（危险操作，经 `ActionConfirmationNode` 确认）；redact 后节点内容替换为“已删除”标记，节点 ID、结构与分支关系保留，附件引用同步失效；redact 是永久事实，同步进入压缩与快照。

### 7.3 需求规格

- **PRD-SPEC-001**：`RequirementSpec` 包含目标、用户价值、范围内、范围外、验收场景、显式约束、非目标、风险、假设和来源证据。
- **PRD-SPEC-002**：验收场景采用 Given/When/Then，并具有稳定 ID。
- **PRD-SPEC-003**：显式约束引用用户消息或仓库事实；无来源内容只能作为假设或建议。
- **PRD-SPEC-004**：一次默认只问一个关键澄清问题，支持推荐选项和自定义输入。
- **PRD-SPEC-005**：编辑规格后产生单调递增 revision；只有最新 revision 可确认。
- **PRD-SPEC-006**：确认请求携带 revision；过期确认返回冲突和最新规格。
- **PRD-SPEC-007**：确认后发生语义修改时创建新 revision、撤销旧确认、自动取消关联的未终态 Run（保留其现场事实与取消原因）并使旧计划失效，需求回到 `spec_ready`；用户重新确认后生成新 Run。非语义修改（证据修正）不触发上述动作。
- **PRD-SPEC-008**：Requirement、revision 和确认绑定来源 conversation、branch 和证据节点。

### 7.4 队列、计划与运行

- **PRD-RUN-001**：已确认需求进入可重排队列；同一仓库最多一个写入型 Run。仓库 writer lease 在 Run 进入 `planning` 时获取（含 `waiting_workspace` 期间持锁），严格 FIFO；后续需求可问答、澄清、确认并入队，但不能开始 `planning`；`waiting_workspace` 的 Run 视为活动项，队列重排时不可移动。
- **PRD-RUN-002**：WorkPlan 生成后自动执行，不增加计划确认步骤。
- **PRD-RUN-003**：计划包含行为切片、依赖、范围提示、场景引用和验证目标。
- **PRD-RUN-004**：用户可请求暂停：正在进行中的工作项不中断、不可编辑，继续完成；该工作项完成后调度器停止启动后续工作项，Run 进入 `paused`。暂停后用户可编辑 pending 工作项、依赖和验证目标（生成新 plan revision）；恢复后继续执行。
- **PRD-RUN-005**：计划修改生成新 revision，并重新校验 DAG、场景覆盖和并行安全。
- **PRD-RUN-006**：WorkPlan 是 DAG；同层最多三个独立工作项并行，计划在每个并行批之后自动插入一个显式合并任务节点：[task1, task2, task3] → 合并任务 → 后续（串行项或下一并行批及其合并任务）。合并任务由后端在 integration worktree 中按工作项 position 顺序执行 git merge：无冲突则后端直接创建受管提交；有冲突时由 implementer 角色在 integration worktree 内编辑文件解决冲突（这是合并任务的 Agent 尝试），后端验证 diff 后创建受管提交。合并任务尝试上限 2 次，超限 blocked。完成全部层次后只剩 integration 一个分支进入验证、审核与发布。Agent 不直接执行任何 Git 写命令。
- **PRD-RUN-007**：暂停、阻断、取消和退出都保存可恢复事实；恢复必须幂等。phase 级 `blocked` 永远可通过 resume/restart 恢复；修复上限耗尽时 Run 保持 `blocked` 并发出 ActionRequired 通知，仅当用户显式选择“放弃”才进入终态（`RunOutcome=blocked`），选择“重试”则重置相关修复上限继续。
- **PRD-RUN-008**：取消停止模型和子进程，保留提交、Diff、报告和诊断引用。
- **PRD-RUN-009**：常规实现与修复仍不收敛时，整个 Run 最多一次 rescue——使用更强模型、全新上下文会话重新开始该工作项；技术故障（Provider/网络/进程错误）不消耗 rescue 次数；rescue 失败进入 `blocked`，按阻断恢复语义处理。

### 7.5 验证、审核与发布

- **PRD-QUAL-001**：验证命令来自仓库配置、标准 manifest 或用户显式配置。
- **PRD-QUAL-002**：每个阻断命令保存基线、最终状态、退出码、摘要和指纹。
- **PRD-QUAL-003**：`VerificationVerdict` 至少区分 `clean | baseline_issues_only | new_regression | unavailable`。
- **PRD-QUAL-004**：新增或恶化失败阻断；不变的历史失败显著展示但允许继续。
- **PRD-QUAL-005**：审核使用 P0–P3；P0/P1 阻断，P2/P3 作为未解决建议交付。
- **PRD-QUAL-006**：修复后重新运行受影响验证和审核。每个工作项最多 3 次 attempt = 1 次实现 + 2 次修复，第 3 次 attempt（第二次修复）升级到更强模型；integration/合并任务修复最多 2 次；审核发现修复复用工作项 attempt 上限。暂时性 Provider/网络错误自动重试最多 3 次。
- **PRD-QUAL-007**：审核角度按风险自适应 1–3 个：`correctness` 恒有；存在非文档源码改动加 `quality`；涉及敏感路径（auth/permission/session/security/network/process/shell/git/filesystem/database/migration/config/dependency/build/release/ci/concurr（匹配 concurrent/concurrency）/platform 等）或 diff 含敏感代码（unsafe、进程创建、shell、chmod、凭据、SQL、路径、符号链接等）加 `security`。每个角度一次独立 reviewer 调用；输入隔离——correctness 可见 RequirementSpec 对照验收场景，quality/security 只看 diff 与中性证据，不看需求意图；修复后只复查受影响角度。
- **PRD-QUAL-008**：reviewer 不可用或输出无效导致 `ReviewVerdict=unavailable` 时默认阻断自动发布，Run 进入 `blocked`；用户可通过 `ActionConfirmationNode` 显式确认“未经审核交付”，该确认形成永久事实；不得伪造 `approved`。
- **PRD-PUB-001**：支持 `local | github_pull_request | gitlab_merge_request`。
- **PRD-PUB-002**：根据远端实时计算 readiness、问题和建议，用于展示与启动前检查。
- **PRD-PUB-003**：Run 启动时计算 readiness 并冻结发布模式：远端 ready 时自动创建并合并 PR/MR（`github_pull_request | gitlab_merge_request`），否则安全 fast-forward 本地主分支（`local`）；运行期间远端状态变化不改变已冻结路径。
- **PRD-PUB-004**：本地回退必须可见且不得降低质量门槛。
- **PRD-PUB-005**：模型不能直接 commit、push 或 merge；发布由后端状态机独占执行。
- **PRD-PUB-006**：远端已合并但本地同步失败时，结果为“远端已交付 · 本地待同步”。
- **PRD-PUB-007**：PR/MR 创建后远端必要检查失败时，implementer 在受管分支上最多一次 CI 修复推送；仍失败、或远端拒绝合并（保护分支策略等）时进入 `blocked` 并发出 ActionRequired 通知，保留 PR/MR 链接与恢复操作；恢复操作走 prepare/confirm 两阶段。

### 7.6 模型、Provider 与用量

- **PRD-MODEL-001**：Provider Registry 暴露固定 Rig 版本编译进来的全部 Provider，并描述鉴权、模型发现和能力。
- **PRD-MODEL-002**：无法列出模型时允许手填 ID，并在保存前执行最小能力探测。
- **PRD-MODEL-003**：按 `qa | clarifier | planner | implementer | reviewer` 五种角色配置主模型和可选回退模型；`qa` 承担项目问答响应与 question/change/ambiguous 意图分类。
- **PRD-MODEL-004**：所有角色模型必须支持工具调用；此外 implementer/reviewer 另要求结构化输出与长上下文能力（按 ProviderCapability 校验）。
- **PRD-MODEL-005**：凭据保存在系统密钥库；状态文件只保存引用和非敏感配置。
- **PRD-MODEL-006**：主模型发生可重试错误（限流、超时、暂时不可用、无效响应）时，单次调用内自动切换 fallback；鉴权失败与内容拒绝不切换，直接报错。
- **PRD-USAGE-001**：记录 Provider、模型、角色、输入/输出/缓存 token、耗时和可计算费用。
- **PRD-USAGE-002**：全局和角色级阈值是软告警，不自动暂停、取消或换模。
- **PRD-USAGE-003**：未知价格或用量明确显示“不完整”，不得估造。

### 7.7 全画布与工作台

- **PRD-CANVAS-001**：首页完全由主画布承担；仓库、Git、模型、运行和连接状态分别显示在相关节点内，不设置固定全局状态区域。
- **PRD-CANVAS-002**：中央对话图是首屏最大空间，六个能力节点使用固定环绕布局；概览节点不可自由编排。
- **PRD-CANVAS-003**：指针视差只移动外层相机，不改变对话逻辑坐标、内部 viewport、选择和草稿；reduced-motion 下关闭。
- **PRD-CANVAS-004**：打开能力节点时，工作台节点生成在中心到触发节点的射线外侧，相机聚焦该节点；同一时间只允许一个工作台。
- **PRD-CANVAS-005**：关闭、Escape 或浏览器返回后，精确恢复主画布视口、焦点、视差、对话分支视口和工作台内部状态。
- **PRD-CANVAS-006**：工作台只保留最小标题和关闭控制，不承载全局状态，不切换成传统页面或固定侧区。
- **PRD-CANVAS-007**：关系型能力尽可能节点化；输入框、开关、下拉、文本编辑器和终端控件可以保留在所属节点内部。
- **PRD-CANVAS-008**：危险操作使用连接在来源节点后的 `ActionConfirmationNode`；确认或取消后生成结果节点。
- **PRD-CANVAS-009**：文件工作台使用目录、搜索结果、文件预览和引用节点；Git 使用仓库、分支、变更、Diff、提交和同步节点；终端使用终端会话节点；模型与设置使用 Provider、模型、角色、用量和设置分组节点。
- **PRD-CANVAS-010**：需求工作台占用最大可用工作台尺寸，内部 React Flow 铺满内容区；需求列表是锚点，规格、澄清、确认、Run、工作项、Diff、验证、审核、发布和诊断均在同一子画布展开。
- **PRD-CANVAS-011**：大输出通过详情节点、折叠节点或 artifact 引用展示；语义缩放和 viewport 虚拟化承担大规模内容。
- **PRD-CANVAS-012**：节点内部可使用必要的下拉、提示、编辑器和终端浮层，但这些浮层不得承担全局导航、通知或业务状态覆盖。

### 7.8 GrayDango 通知

- **PRD-NOTIFY-001**：GrayDango 始终存在，是唯一全局通知入口，不允许完全关闭。
- **PRD-NOTIFY-002**：用户可关闭动画和非关键气泡；错误、阻断和需要操作的通知始终可达，reduced-motion 下使用静态表现。
- **PRD-NOTIFY-003**：队列优先级为“错误/需要操作 → 警告 → 完成/信息”；同级按发生时间排序。
- **PRD-NOTIFY-004**：普通通知自动收起；阻断和待操作通知保留到用户确认或问题解除。
- **PRD-NOTIFY-005**：气泡支持前后查看、确认和来源定位；点击后打开对应工作台并聚焦 `source_node_id`（来源为 `conversation` 时聚焦中央对话图对应分支节点，不打开工作台，见 8.3）。
- **PRD-NOTIFY-006**：通知通过 `notification.raised`、`notification.acknowledged`、`notification.resolved` 形成事实；未解决警告、错误和待操作通知重启后恢复。
- **PRD-NOTIFY-007**：通知气泡不复制节点内持续状态；状态解除时由领域事件关闭通知，而不是依赖超时猜测。

### 7.9 JSONL 事实、快照与实时流

- **PRD-EVENT-001**：JSONL 是唯一业务事实源；所有状态变化由单写入器分配全局单调 `sequence`。
- **PRD-EVENT-002**：每次变更先追加并持久化事件，再更新内存 reducer、推送前端和生成 `state.json`。单写入器允许 ≤5ms 窗口微批：同批事件保序追加后一次 fsync，整批落盘后才 reducer 投影与推送；里程碑事件（需求确认、计划、质量、发布、阻断、通知）逐条 fsync，不参与微批。
- **PRD-EVENT-003**：`state.json` 是完整物化快照，包含 `format_version`、`last_sequence`、`written_at`、`state_hash` 和业务状态。
- **PRD-EVENT-004**：启动时加载有效快照并重放更大序号事件；快照缺失或落后不导致已持久化事实丢失。
- **PRD-EVENT-005**：Git、发布和其他外部副作用使用 `intent → external action → observed result` 事件；恢复时先核对外部事实。
- **PRD-EVENT-006**：事件分段保存；语义压缩只处理已完成的高频节点增量和工具状态，并保留可重建最终节点的 checkpoint。
- **PRD-EVENT-007**：需求确认、计划、质量、发布、阻断和通知里程碑永久保留。
- **PRD-EVENT-008**：活动文件尾部半行可恢复截断；中间损坏、未知序号缺口或封存段损坏必须阻止写入并提供只读诊断和备份恢复。
- **PRD-EVENT-009**：REST 承担命令和快照读取；业务实时事件通过 `GET /api/v1/events?after=<sequence>` 以 `application/x-ndjson` 传输。
- **PRD-EVENT-010**：客户端跨任意网络 chunk 边界按换行解析；游标落后于压缩下限时收到 `system.resync_required`，随后重新加载快照。
- **PRD-EVENT-011**：JSONL、日志、API 和诊断不保存凭据、隐藏推理、完整未截断工具输出或终端正文。

## 8. 状态与公共模型

### 8.1 对话与需求

- `ConversationNodeKind`：`user_message | process | tool | assistant_answer | clarification_question | clarification_answer | requirement_spec | requirement_confirmation`。
- `ConversationNodeState`：`streaming | running | completed | failed | aborted`。
- `RequirementState`：`drafting → clarifying → spec_ready → confirmed → queued`；旁路状态为 `cancelled | superseded`。
- Composer 是临时交互节点；`ProcessGroup` 是可逆展示投影。
- 需求列表显示分组由 `RequirementState` 与关联最新 Run 联合投影：`drafting/clarifying`→草拟；`spec_ready`→待确认；`confirmed/queued` 且无活动 Run→排队；关联 Run 非终态→运行；`RunOutcome=delivered`→交付；Run 终态 `blocked/failed`→阻断。

### 8.2 运行、质量和发布

- `RunPhase`：`queued → waiting_workspace → planning → executing → validating → reviewing → publishing → terminal`。
- 任一非终态阶段可进入 `pausing | paused | blocked`，并保存 `resume_phase`。
- `RunOutcome`：`delivered | blocked | cancelled | failed`。
- phase 级 `blocked` 永远可通过 resume/restart 恢复；只有用户显式放弃才转为终态 `RunOutcome=blocked`。
- `VerificationVerdict`：`clean | baseline_issues_only | new_regression | unavailable`。
- `ReviewVerdict`：`approved | approved_with_advisories | blocking_findings | unavailable`。
- `PublicationState`：`not_started | preparing | pushed | review_open | waiting_remote | merged | syncing_local | completed | failed`。

界面必须组合表达，例如“已交付 · 仅存在基线失败 · 3 个 P2/P3 建议”，禁止只显示“完成”。

### 8.3 事件、快照与通知

`EventEnvelope` 至少包含：

```text
schema_version, sequence, event_id, occurred_at,
aggregate_type, aggregate_id, event_type, payload
```

`StateFile` 至少包含：

```text
format_version, last_sequence, written_at, state_hash, state
```

`Notification` 至少包含：

```text
id, severity, message, source_workbench, source_node_id,
lifecycle, raised_at, acknowledged_at, resolved_at
```

`Notification.source_workbench` 取值：`conversation | delivery | files | git | terminal | models | settings | system`。来源为 `conversation` 时，定位是聚焦中央对话图对应分支节点（不打开工作台）；来源节点已被压缩折叠时先展开最近 checkpoint/详情节点；来源不存在时打开所属工作台诊断节点并解释。

## 9. 非功能需求

- **PRD-NFR-001 可恢复性**：事件持久化成功是状态变更的提交点；重启后 reducer 重放得到相同状态哈希。单写入器允许 ≤5ms 窗口微批，崩溃窗口最多丢失最后 5ms 的流式 delta。
- **PRD-NFR-002 安全**：路径解析拒绝逃逸、符号链接逃逸、`.git` 和运行目录；Agent 子进程只获得最小环境。`run_command` 固定 cwd 为分配的 worktree，并维护危险程序 denylist（如 rm/mkfs/dd 写盘设备、shutdown 等）；这是应用层策略，不构成 OS 级文件系统沙箱，进程理论上可写 worktree 外用户路径，依托 denylist、最小环境与工具审计降低风险。
- **PRD-NFR-003 网络**：Agent 命令只允许包管理器、配置的 Git 远端和受控只读抓取。
- **PRD-NFR-004 隐私**：日志、API、事件和诊断不包含凭据、完整 Prompt、隐藏推理或未经截断工具输出。
- **PRD-NFR-005 性能**：一万个对话节点、一百个需求和大量事件下使用语义缩放、viewport 虚拟化、分段读取和按需 artifact。
- **PRD-NFR-006 可访问性**：键盘可进入/退出工作台、遍历节点、确认规格、暂停恢复和处理 GrayDango 通知；满足 WCAG 2.2 AA。
- **PRD-NFR-007 跨平台**：三平台覆盖原子快照替换、JSONL 恢复、路径、Git、PTY、构建和打包。
- **PRD-NFR-008 可观测性**：结构化日志使用关联 ID，指标覆盖事件写入、重放、流连接、阶段、用量、恢复和发布。
- **PRD-NFR-009 格式演进**：v1 不提供自动格式迁移；发现旧布局或未知 `format_version` 时拒绝写入、只读诊断并给出显式归档指引；未来版本的格式升级必须先发布显式迁移器，并在升级前自动备份。
- **PRD-NFR-010 契约**：公开 API 位于 `/api/v1`；Rust OpenAPI 是 REST 契约源，Rust JSON Schema 是 NDJSON 事件联合类型的契约源。
- **PRD-NFR-011 单二进制**：正式发布物是包含前端静态资源的单个 Raccoon Node 可执行文件，不依赖相邻资源目录、Node.js 或 Vite。

## 10. 产品验收场景

### AC-01 从模糊目标到自动交付

- Given 用户已配置五个模型角色且仓库干净
- When 用户提交开发目标、完成澄清并确认最新规格
- Then 系统自动规划、执行、验证、审核和发布，并返回提交或 PR/MR 与完整报告

### AC-02 运行期间继续准备需求

- Given 一个 Run 正在执行
- When 用户继续问答、创建分支并确认另一个需求
- Then 对话与规格正常工作，新需求入队但不获得仓库写锁

### AC-03 脏工作区保护

- Given 主工作区存在未提交修改
- When 用户确认需求
- Then 需求可入队，Run 停在 `waiting_workspace`，系统不 stash、不覆盖也不忽略修改

### AC-04 基线失败不被隐藏

- Given 基线中一个检查已经失败
- When 最终候选没有新增失败且审核无 P0/P1
- Then 可以交付，但必须显示 `baseline_issues_only` 和原失败摘要

### AC-05 新回归阻断

- Given 基线检查通过
- When 最终候选导致同一检查失败且自动修复未收敛
- Then 发布不启动，Run 进入 `blocked` 并提供证据、重试与放弃操作

### AC-06 审核等级

- Given 审核同时返回 P1 和 P2
- When P1 修复后消失、P2 仍存在
- Then 可以交付，P2 作为未解决建议持续可见

### AC-07 外部副作用恢复

- Given integration 已提交但发布结果事件尚未完成时进程退出
- When 用户重新启动
- Then 系统先核对 Git 或远端事实，再继续记录结果，不重复提交、推送或合并

### AC-08 Provider 能力约束

- Given 模型不满足所配置角色的能力要求
- When 用户将其保存为任一角色（例如缺少工具调用能力，或 implementer/reviewer 缺少结构化输出与长上下文能力）
- Then 保存被阻止，并展示缺失能力和兼容模型

### AC-09 软预算

- Given Run 达到用户设置的软阈值
- When 后续工作仍有有效进展
- Then 系统继续执行并通过 GrayDango 告警，不自动换模、暂停或取消

### AC-10 工作台射线展开与恢复

- Given 主场景处于某一视差位置
- When 用户打开 Git 工作台再通过关闭、Escape 或浏览器返回退出
- Then 工作台在 Git 节点射线外侧展开且相机聚焦，退出后精确恢复视口、焦点、滚动和视差

### AC-11 最大化需求子画布

- Given 用户打开包含规格、Run 和 WorkPlan 的需求
- When 用户继续查看 Diff、验证、审核、发布和诊断
- Then 所有内容都以节点在铺满工作台的子画布内可达，无须切换页面或打开固定详情区

### AC-12 流式完全节点化对话

- Given 中央图只有一个 Composer
- When 用户发送会触发工具的问题
- Then 用户、过程、工具、回答和新 Composer 按序成为稳定节点，内容真实流式更新，过程组可逆折叠

### AC-13 对话分支与节点化确认

- Given 历史用户节点已有后续内容
- When 用户从该节点创建新分支并完成澄清与确认
- Then 新分支只继承祖先，原分支不变，规格 revision 和确认均可定位并进入队列

### AC-14 事件先写与快照补齐

- Given 事件已持久化但快照尚未替换时进程退出
- When 程序重启
- Then 从快照重放更高序号事件得到正确状态和相同 `state_hash`

### AC-15 损坏与语义压缩

- Given 活动文件尾部存在半行，或事件段存在中间损坏、序号缺口
- When 程序恢复
- Then 尾部半行按规则截断；其他损坏阻止写入并提供只读诊断，压缩前后重放状态哈希一致且业务里程碑不丢失

### AC-16 NDJSON 重连与重新同步

- Given 浏览器连接发生拆包、粘包、重复事件或游标落后于压缩下限
- When 客户端续传
- Then 解析器按行重组、按 sequence 去重；收到 `system.resync_required` 后重新加载快照

### AC-17 GrayDango 与无覆盖层工作流

- Given 同时存在阻断、警告和普通完成通知
- When 用户浏览队列、确认一项并点击阻断通知
- Then GrayDango 按优先级呈现、普通项自动收起、阻断项持久保留，并打开来源工作台聚焦来源节点；危险操作只通过 `ActionConfirmationNode` 完成

### AC-18 大规模与三平台单二进制

- Given 存在一万个对话节点、一百个需求和大量事件
- When 用户在 macOS、Linux、Windows 的独立单二进制中浏览、重启并恢复
- Then 画布保持可交互、通知可响应、事件可重放，且运行时不依赖外部前端资源

## 11. 成功标准

- AC-01 至 AC-18 都有自动化或明确的三平台手工验收用例。
- 用户从启动到确认第一个需求，只需处理 Git 初始化和模型凭据等不可推断信息。
- 每个 delivered Run 都能回答交付位置、验证结果、审核风险、用量和下一步。
- 四份文档中的需求 ID、状态、事件名、接口和 ADR 一一对应，无互相矛盾的第二套方案。
