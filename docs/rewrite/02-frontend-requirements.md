# Raccoon Node 前端开发需求

> 状态：实施基线
> 关联文档：[产品需求](./01-product-requirements.md) · [后端需求](./03-backend-requirements.md) · [技术决策](./04-architecture-decisions.md)

## 1. 目标与边界

前端把自动交付系统呈现为可理解、可控制的单项目节点空间。首屏是一个完整 React Flow 场景：中央对话节点图占据主要空间，初始只有一个 Composer；需求、文件、Git、终端、模型与用量、设置节点固定环绕。所有工作台仍以画布节点形式在射线外侧展开，不切换成传统业务页面。

前端不承担：

- 不解析 Provider 原始事件或推断后端领域结论。
- 不保存模型、Git 或终端凭据。
- 不自行判断验证、审核和发布是否通过。
- 不执行 Git、终端或文件系统命令。
- 不维护与 Rust 契约重复的手写 DTO。
- 不把本地 UI store 当作可恢复业务事实。

## 2. 技术基线

### 2.1 依赖

- React 19、TypeScript strict、Vite。
- `@xyflow/react` 承载外层能力场景、中央对话图和工作台内部子画布。
- Material UI（`@mui/material`）+ Emotion 样式引擎提供节点内部的表单、选择器、提示、菜单和可访问基础控件。React 19 支持以 [MUI 安装说明](https://mui.com/material-ui/getting-started/installation/) 为准，主题能力以 [MUI 主题系统](https://mui.com/material-ui/customization/theming/) 为准。
- MUI Theme + CSS variables 是唯一设计 token 来源；业务节点使用自有视觉。
- TanStack Query 管理 REST 快照、命令和缓存失效。
- Zustand 只管理画布视口、工作台导航、焦点来源、本地草稿和非业务外观偏好。
- React Router 只把画布导航状态映射到可恢复 URL，不触发页面替换。
- xterm.js 渲染终端节点内部的 PTY 会话。
- Rust OpenAPI 生成 REST 类型和客户端；Rust JSON Schema 生成 NDJSON 事件联合类型、TypeScript 类型和运行时校验数据。
- Vitest、Testing Library、Playwright 和 axe 负责验证。

### 2.2 工程约束

- 前端位于新仓库 `frontend/`，可独立安装、开发、测试和构建。
- 生成产物位于 `src/api/generated/` 和 `src/events/generated/`，禁止手工编辑。
- 业务组件只能依赖 `src/api/`、`src/events/` 和领域 selector，不直接拼接 URL 或按事件名散落分支。
- React Flow 节点、Diff、规格、Run、验证、审核和 artifact 详情是自有业务组件，不强行套用通用卡片页面。
- MUI 不能承担顶层导航、全局通知、业务状态覆盖或危险操作确认。
- **FE-BUILD-001**（PRD-NFR-011）：正式构建生成可嵌入静态产物，JS、CSS、字体和图标不依赖相邻运行目录。
- **FE-BUILD-002**：构建输出包含版本与内容哈希 manifest，支持后端嵌入、SPA fallback 和不可变资源缓存。

## 3. 信息架构

### 3.1 顶层结构

应用只有两个顶层视觉区域：

1. **全屏主画布**：承担能力概览、中央对话、工作台展开、状态定位和全部业务导航。
2. **GrayDango**：唯一允许的全局覆盖视觉，承担全局通知气泡和通知队列。

仓库、分支、连接、模型、用量、Run 和安全状态分别显示在对应节点内。产品名可以是画布中的静态品牌元素或节点标签，但不能占用一条固定业务区域。

### 3.2 外层能力节点

外层场景使用固定逻辑布局，不允许用户拖动或保存自定义位置：

| 节点       | 概览摘要                        | 打开后的节点关系                                          |
| ---------- | ------------------------------- | --------------------------------------------------------- |
| 中央对话图 | 活动分支、流式节点、Composer    | 用户、过程、工具、回答、澄清、规格、确认                  |
| 需求交付   | 队列、活动 Run、质量结论        | 需求列表、规格、Run、工作项、Diff、验证、审核、发布、诊断 |
| 文件       | 仓库摘要、最近引用              | 目录、搜索结果、预览、引用                                |
| Git        | 仓库、分支、变更、写锁          | 分支、变更、Diff、提交、同步、确认                        |
| 终端       | 会话数、连接状态                | 独立终端会话                                              |
| 模型与用量 | Provider 健康、角色缺口、软告警 | Provider、模型、角色、用量                                |
| 设置       | 重启、安全和数据诊断摘要        | 设置分组、选项、结果和确认                                |

概览节点只显示最多三个高价值摘要和一个主入口。它们不是缩小的传统页面，也不展开长列表。

### 3.3 URL 是画布状态，不是页面

- `/`：主画布概览。
- `/canvas/chat/branches/:branchId/nodes/:nodeId`：聚焦对话分支节点。
- `/canvas/workbenches/delivery`
- `/canvas/workbenches/delivery/requirements/:requirementId`
- `/canvas/workbenches/delivery/runs/:runId`
- `/canvas/workbenches/files`
- `/canvas/workbenches/git`
- `/canvas/workbenches/terminal`
- `/canvas/workbenches/models`
- `/canvas/workbenches/settings`

直接访问 URL 时先加载 `GET /api/v1/snapshot`，再在同一个主画布中生成工作台节点并聚焦目标。关闭工作台返回 `/`；浏览器前进/后退与节点内打开/关闭使用同一状态机。

## 4. 主画布、视差与工作台

### 4.1 首屏与外层相机

- **FE-CANVAS-001**（PRD-CANVAS-001～003）：首屏只挂载中央对话图当前 viewport 邻近节点和六个环绕能力节点。
- **FE-CANVAS-002**：外层节点具有可访问名称、摘要，可用 Enter 打开；固定能力节点不能拖动。
- **FE-CANVAS-003**：外层首页禁止自由平移和缩放；中央对话图拥有独立受控 viewport。
- **FE-CANVAS-004**：在 1440×900 参考视口中，中央对话图可见投影宽度不小于主画布 62%，高度不小于 72%；初始仅显示 Composer。
- **FE-CANVAS-005**：窗口变窄时先压缩环绕距离和摘要，不先挤压中央对话可操作区。
- **FE-CANVAS-006**：指针位置映射为有界相机偏移并平滑插值；不得改变内部节点坐标、选择、焦点、草稿和查询缓存。
- **FE-CANVAS-007**：后台快照刷新不得重置外层或内部相机；提供“回到活动分支末端”的节点内操作。

### 4.2 射线外侧工作台

- **FE-CANVAS-008**（PRD-CANVAS-004、AC-10）：打开前保存主场景 viewport、视差目标、触发节点、焦点、对话 branch viewport、工作台内部 viewport 和节点内部滚动位置。
- **FE-CANVAS-009**：以主场景中心 `C` 和触发节点中心 `N` 计算单位射线 `normalize(N - C)`；工作台中心位于 `N + ray * offset`，`offset` 由触发节点边界、安全间距和工作台尺寸确定。
- **FE-CANVAS-010**：工作台是外层 React Flow 中的真实大型 `CanvasWorkbenchNode`；相机使用安全边距聚焦该节点，不使用固定屏幕坐标或覆盖层伪装。
- **FE-CANVAS-011**：同一时间只创建一个工作台节点；打开另一能力时先完成当前工作台关闭与状态保存，再创建新节点。
- **FE-CANVAS-012**：工作台打开后暂停主场景视差，其他节点保留为低对比上下文且不可交互，不卸载主场景。
- **FE-CANVAS-013**：工作台框架只显示最小标题、必要的局部定位信息和关闭控制；业务状态由内部节点表达。
- **FE-CANVAS-014**：关闭、Escape 或浏览器返回都进入同一 closing 状态，精确恢复保存的 viewport、焦点、选择、滚动和视差目标。
- **FE-CANVAS-015**：重复打开、关闭、快速返回和窗口缩放不得产生空节点 ID、重复工作台、跳帧焦点或丢失返回点。
- **FE-CANVAS-016**：reduced-motion 下关闭飞行与视差动画，直接设置稳定相机，但保持几何位置、焦点和返回语义。

### 4.3 工作台内部交互

- **FE-CANVAS-017**：工作台内部滚动、拖选、表单、编辑器、终端和子画布使用 `nodrag`/`nowheel` 边界，不能误驱动外层相机。
- **FE-CANVAS-018**（PRD-CANVAS-007）：层级、依赖、来源、生命周期和操作结果使用节点与边；输入、开关、下拉、文本编辑器和终端留在所属节点内。
- **FE-CANVAS-019**（PRD-CANVAS-008）：危险动作从来源节点连接到 `ActionConfirmationNode`。节点显示动作、影响、目标、不可逆性和确认/取消；服务端结果形成 `ActionResultNode`。
- **FE-CANVAS-020**：节点内部可使用必要的选择菜单、提示和编辑器浮层；它们必须锚定所属控件、失焦可关闭，不得承担跨工作台业务状态。
- **FE-CANVAS-021**（PRD-CANVAS-011）：大输出使用 `DetailNode`、`CollapsedArtifactNode` 或 artifact 引用；只有 viewport 邻近和语义缩放级别允许时渲染正文。

### 4.4 画布导航状态

`CanvasNavigationState` 只保存 UI 投影：

```ts
type CanvasNavigationState = {
  mode: "overview" | "opening" | "workbench" | "closing";
  workbench: WorkbenchKind | null;
  workbenchNodeId: string | null;
  triggerNodeId: string | null;
  restoreFocusId: string | null;
  savedMainViewport: Viewport | null;
  parallaxTarget: Point | null;
  activeConversationBranchId: string | null;
  selectedConversationNodeId: string | null;
  conversationViewports: Record<string, Viewport>;
  workbenchViewports: Partial<Record<WorkbenchKind, Viewport>>;
  nodeScrollPositions: Record<string, number>;
  expandedProcessGroupIds: string[];
};
```

服务端节点、Run、通知和消息正文不得复制进该 store。未发送 Composer 和未提交表单草稿按对象 ID 存为本地 UI 状态。

## 5. 中央对话节点图

中央对话图默认可直接操作，不存在“概览后再进入聊天”的第二步。节点链为：

```text
Composer → 用户消息 → 过程 → 工具（可选）→ 过程（可选）→ 回答 → Composer
```

- **FE-CHAT-001**（PRD-CHAT-001）：Composer 支持文本、文件引用和图片附件，并显示限制与移除操作。
- **FE-CHAT-002**（PRD-CHAT-002）：Composer 显示自动判定的问答或开发需求；判定为 `ambiguous` 时按问答处理并提示“意图识别不确定”，用户可随时覆盖为开发需求，覆盖只影响当前提交。
- **FE-CHAT-003**（PRD-CHAT-003）：选定连续节点后可“整理为需求”，来源和附件直接关联。
- **FE-CHAT-004**（PRD-CHAT-004）：活动 Run 期间 Composer 和分支仍可用，开发需求提示将排队。
- **FE-CHAT-005**（PRD-CHAT-005）：活动过程/回答节点提供停止操作，停止后保留已接收内容并显示 `aborted`。
- **FE-CHAT-006**（PRD-CHAT-006）：过程节点只展示公开理解、证据、动作、结论和下一步，不提供隐藏推理入口。
- **FE-CHAT-007**：发送成功后 Composer 原位固化为用户节点；响应结束后只在活动分支末端生成一个新 Composer。
- **FE-CHAT-008**（PRD-CHAT-008、AC-12）：过程与回答在首个 delta 前显示稳定外壳，真实内容追加到同一节点，不以逐字动画伪造完整内容。
- **FE-CHAT-009**：工具节点显示目的、工具名、等待/运行/完成/失败、耗时和截断摘要；完整安全输出通过详情节点引用。
- **FE-CHAT-010**（PRD-CHAT-011）：回答完成后默认生成可逆 `ProcessGroup`；展开恢复成员节点、边、顺序和错误。
- **FE-CHAT-011**（PRD-CHAT-009）：历史用户节点提供“从这里分支”；新分支共享祖先并错层展开，原分支不可改写。
- **FE-CHAT-012**：用户手动查看历史后暂停自动跟随，通过轻量定位节点返回最新内容；流式增量不抢焦点。
- **FE-CHAT-013**：远景只显示节点类型、阶段和分支摘要，近景才渲染正文、工具摘要和操作。
- **FE-CHAT-014**：重连先加载包含活动节点已组装内容的快照，再按全局 sequence 和 node sequence 对账，不产生重复节点或文本。
- **FE-CHAT-015**（PRD-CHAT-014）：任意对话节点提供 redact 入口，经 `ActionConfirmationNode` 确认后节点内容显示为“已删除”标记；节点 ID、结构、分支关系与相邻节点保持不变，附件引用显示已失效。

## 6. 需求交付工作台

### 6.1 最大化全铺满子画布

- **FE-DELIVERY-001**（PRD-CANVAS-010、AC-11）：需求工作台使用最大可用 `CanvasWorkbenchNode`，扣除最小标题后，内部 React Flow 铺满全部内容区。
- **FE-DELIVERY-002**：需求列表节点是空间锚点，按草拟、待确认、排队、运行、交付、阻断分组，分组由 `RequirementState` 与关联最新 Run 联合投影；筛选、搜索和重排控件位于该节点内部。
- **FE-DELIVERY-003**：选择需求后按关系展开来源对话、澄清、规格 revision、确认、Run、WorkPlan、工作项、Diff、验证、审核、发布和诊断节点。
- **FE-DELIVERY-004**：所有详情在同一子画布通过节点或 artifact 引用访问，不切换路由页面，不创建固定详情区域。
- **FE-DELIVERY-005**：子画布保存 viewport、选中需求、筛选和展开节点；关闭工作台不卸载中央对话图或丢失 Composer 草稿。
- **FE-DELIVERY-006**：一百个需求和大量工作项时，默认只展开当前需求一跳关系；更远关系按需加载，折叠后保留摘要节点。

### 6.2 澄清、规格与确认

- **FE-SPEC-001**（PRD-SPEC-004）：默认一次一个澄清问题节点，推荐选项和自定义输入位于节点内；提交形成回答节点。
- **FE-SPEC-002**（PRD-SPEC-001）：规格节点包含目标、用户价值、范围、验收场景、约束、非目标、风险、假设和证据分区。
- **FE-SPEC-003**（PRD-SPEC-002～003）：场景和约束显示稳定 ID 与来源，点击来源可跨画布定位原节点。
- **FE-SPEC-004**（PRD-SPEC-005～008）：保存编辑后生成新 revision 节点；确认节点指向特定 revision；冲突结果通过相邻节点展示服务器版本与本地草稿差异。
- **FE-SPEC-005**：确认摘要显示预计发布路径、模型角色、软阈值和脏工作区阻断，不增加计划确认。

### 6.3 Run、质量与发布

- **FE-RUN-001**（PRD-RUN-001）：需求列表节点内提供可访问队列重排；活动项（含 `waiting_workspace` 的 Run）不可移动。
- **FE-RUN-002**（PRD-RUN-002～003）：计划生成后自动展开 Run 和 WorkPlan 节点；Run 节点默认显示阶段、产出、风险和下一步。
- **FE-RUN-003**（PRD-RUN-004～005）：请求暂停后，进行中的工作项继续完成且不可编辑；Run 进入 `paused` 后通过计划编辑节点修改 pending 工作项、依赖和验证目标，并显示 DAG 与场景覆盖校验结果节点。
- **FE-RUN-004**：计划依赖边区分串行、并行、合并任务与阻断，不只依赖颜色。
- **FE-RUN-005**：`waiting_workspace` 节点说明执行尚未开始，问答和需求准备仍可使用。
- **FE-QUAL-001**（PRD-QUAL-002～004）：验证节点并列显示基线和最终结果，独立呈现 `VerificationVerdict`。
- **FE-QUAL-002**（PRD-QUAL-005）：审核节点分为 P0/P1 阻断和 P2/P3 建议；交付后建议仍可见。
- **FE-QUAL-003**（PRD-QUAL-008）：`ReviewVerdict=unavailable` 时审核节点显示阻断原因，并提供“未经审核交付”的 `ActionConfirmationNode` 入口；确认结果形成永久事实节点。
- **FE-PUB-001**（PRD-PUB-001～004）：发布节点显示实际路径、回退原因、分支、提交和 PR/MR 链接。
- **FE-PUB-002**（PRD-PUB-006）：远端已合并而本地同步失败时组合展示两个事实。
- **FE-PUB-003**：最终报告节点依次显示结果、位置、验收证据、质量、建议、用量和下一步。
- **FE-PUB-004**（PRD-PUB-007）：远端必要检查失败或远端拒绝合并时，发布节点显示 `blocked`、PR/MR 链接、CI 修复尝试结果与恢复操作入口；恢复操作使用 prepare/confirm 两阶段确认节点。

## 7. 其他节点化工作台

### 7.1 文件

- **FE-FILE-001**（PRD-CANVAS-009）：目录节点按需展开子目录；搜索产生查询节点和结果节点，不清空目录状态。
- **FE-FILE-002**：文件预览节点支持行号、高亮、复制路径和引用；二进制、过大、非 UTF-8 和受限路径显示明确结果节点。
- **FE-FILE-003**：引用节点把路径加入目标 Composer，不自动发送。

### 7.2 Git

- **FE-GIT-001**：仓库节点连接分支、变更和同步节点；分支节点显示 ahead/behind 和写锁。
- **FE-GIT-002**：变更节点按 staged、unstaged、untracked、conflicted 分组，选择后展开 Diff 节点。
- **FE-GIT-003**（PRD-CANVAS-008）：commit、push、切换分支和丢弃修改必须连接到 `ActionConfirmationNode`，执行后生成结果节点。
- **FE-GIT-004**：v1 不提供交互式 rebase、完整历史图谱或凭据管理。

### 7.3 终端

- **FE-TERM-001**：每个 PTY 是独立终端会话节点，可创建、重命名和关闭。
- **FE-TERM-002**：连接断开和进程退出是不同状态；重连不把旧输出写入业务事件。
- **FE-TERM-003**：关闭仍运行的终端使用相连确认节点；非本机终端授权也通过来源节点和结果节点表达。

### 7.4 模型、用量与设置

- **FE-MODEL-001**：Provider 节点由 Registry 描述生成鉴权字段；密钥只允许新建或替换，不回显。
- **FE-MODEL-002**：Provider 连接模型节点，模型连接 qa/clarifier/planner/implementer/reviewer 五种角色节点；不满足角色能力要求（所有角色要求工具调用，implementer/reviewer 另要求结构化输出与长上下文）时通过结果节点阻止保存。
- **FE-USAGE-001**：用量节点按 Run、角色、Provider 和模型展示 token、费用、完整性和软阈值。
- **FE-SET-001**：设置工作台使用设置分组节点；基础控件位于各分组节点内部。
- **FE-SET-002**：需要重启的修改生成 `restart_required` 结果节点，保存和重启是两个动作。
- **FE-SET-003**：GrayDango 动画、非关键气泡、明暗模式和密度是本地外观偏好；不能关闭关键通知可达性。

## 8. GrayDango 通知

### 8.1 展示和队列

- **FE-PET-001**（PRD-NOTIFY-001）：GrayDango 始终挂载，位置避开主要节点操作区；不得提供“完全关闭”选项。
- **FE-PET-002**（PRD-NOTIFY-002）：关闭动画时使用静态宠物；关闭非关键气泡后，错误、阻断和待操作通知仍自动可见。
- **FE-PET-003**（PRD-NOTIFY-003）：队列 selector 按 severity/lifecycle 排序：错误与待操作、警告、完成与信息；同级按 `raised_at`。
- **FE-PET-004**（PRD-NOTIFY-004）：普通通知按可访问的阅读时长自动收起；阻断项直到 acknowledged 或 resolved 前保持可再次访问。
- **FE-PET-005**：气泡提供前一条、后一条、当前位置、确认和定位操作；空队列不显示占位业务气泡。
- **FE-PET-006**：通知内容简短且可行动，不复制长日志；错误详情通过来源节点或诊断节点访问。

### 8.2 来源定位与恢复

- **FE-PET-007**（PRD-NOTIFY-005）：点击定位时，来源为 `conversation` 的通知聚焦中央对话图对应分支节点而不打开工作台；其他来源若工作台未打开，则按正常射线流程打开，完成相机聚焦后再聚焦 `source_node_id`。
- **FE-PET-008**：来源节点已被压缩折叠时先展开最近 checkpoint/详情节点；来源不存在时打开所属工作台的诊断节点并解释原因。
- **FE-PET-009**（PRD-NOTIFY-006）：启动快照中的未解决通知先恢复队列，再消费后续通知事件；同一通知 ID 不重复显示。
- **FE-PET-010**：acknowledged 与 resolved 分开呈现；用户确认不等于问题解除，未解决阻断仍可从宠物重新访问。
- **FE-PET-011**：简短通知用 `aria-live` 合并播报；流式 token 不逐个播报，阻断通知提供键盘直达。

## 9. 状态管理与数据流

### 9.1 快照与 reducer

- 首屏调用 `GET /api/v1/snapshot`，验证 `StateFile` 的格式版本、last sequence 和业务 state。
- 客户端领域缓存只存 reducer 投影；所有事件处理函数由 `event_type` 到类型化 reducer 集中注册。
- mutation 返回 accepted sequence、revision 或命令结果；不可逆操作等待服务器事实，不进行盲目乐观更新。
- 队列移动和表单草稿可在节点内部预览，服务器拒绝后生成明确结果节点。

### 9.2 HTTP NDJSON 事件流

- **FE-EVENT-001**（PRD-EVENT-009）：使用带鉴权的 fetch 连接 `GET /api/v1/events?after=<sequence>`，要求响应类型为 `application/x-ndjson`。
- **FE-EVENT-002**：使用流式 `TextDecoder` 保留未完成尾串，按换行切分；必须覆盖一个事件跨多个 chunk、多个事件同一 chunk、CRLF 和 UTF-8 多字节边界。
- **FE-EVENT-003**：`EventEnvelope.sequence` 小于等于已应用序号时去重；大于期望序号时停止应用并重新对账，不猜测缺失状态。
- **FE-EVENT-004**：`conversation.node.delta` 继续按 `node_id + node_sequence` 验证节点内部顺序，只追加到指定过程或回答节点。
- **FE-EVENT-005**：断线从最后已应用 sequence 建立新请求；先保持当前只读投影并显示来源节点连接状态，不清空画布。
- **FE-EVENT-006**：收到 `system.resync_required` 后关闭当前 reader，重新加载快照，再以新 `last_sequence` 连接。
- **FE-EVENT-007**：未知事件版本进入版本不兼容诊断并阻止危险 mutation；已知可忽略扩展字段不导致崩溃。
- **FE-EVENT-008**：事件流不进入 localStorage；刷新依赖服务端快照和重放恢复。

### 9.3 本地状态

- Composer 草稿按 branch ID 保存；规格和计划编辑草稿按对象 ID 保存，提交成功后删除。
- GrayDango 动效、非关键气泡、主题和密度是本地偏好。
- Provider 密钥、终端授权、工具输出、通知事实和完整事件不得写入浏览器持久存储。

## 10. 视觉、规模与可访问性

- 视觉语气为专业、克制、有温度；GrayDango 是唯一轻量品牌角色。
- 状态颜色只是辅助，必须同时有文本和图标。
- RunPhase、RunOutcome、验证、审核和发布分别展示，禁止统一翻译为“成功/失败”。
- 工作台内容增长优先增加内部空间关系，不持续推移已完成节点。
- 一万个对话节点、一百个需求和大量事件时，远景只渲染简化节点，近景按 viewport 加载正文。
- v1 支持 1024 CSS px 及以上桌面视口；更窄视口提供只读说明，不承诺移动端编辑。
- 所有画布节点支持键盘遍历；屏幕阅读器通过不可视语义树访问节点类型、父子/依赖关系和操作，不要求理解二维坐标。
- 内部选择菜单、提示、表单和标签页使用 MUI 可访问原语；焦点不得逃出当前工作台或丢失返回节点。

## 11. 错误与极端状态

- 首屏快照失败生成可重试系统节点，并让 GrayDango 提供错误定位，不进入无限加载。
- 事件断线、版本不兼容、revision 冲突、Provider 不可用、技术暂停和发布失败使用不同节点语义。
- 来源节点尚未加载时，GrayDango 定位先打开工作台并加载最小关系子图。
- 过期 revision 通过差异节点展示，不覆盖本地草稿。
- 只读诊断模式禁用所有 mutation，但允许浏览快照、损坏范围、备份和归档指引。

## 12. 前端测试与验收

### 12.1 单元与组件

- 外层相机射线位置、边界钳制、视差插值、工作台聚焦、返回恢复和 reduced-motion。
- 1440×900 中央对话面积、初始单 Composer、环绕安全区和缩放降级。
- 工作台单实例、快速开关、Escape、浏览器返回和跨工作台切换。
- 对话 DAG、分支、Composer 固化、node delta、过程组和 viewport 虚拟化。
- 需求子画布的全铺满尺寸、所有业务节点类型、按需关系展开和 artifact 引用。
- 危险操作只能由来源节点连接到 `ActionConfirmationNode`。
- GrayDango 队列优先级、自动收起、确认/解除差异、来源定位、重启恢复和无动画模式。
- NDJSON 拆包、粘包、UTF-8 边界、断线续传、重复、缺口和 `system.resync_required`。
- 状态与质量组合文案、费用未知、软阈值和模型能力过滤。

### 12.2 浏览器验收

- **FE-E2E-001**（AC-01～03）：从对话到交付，并验证运行期间问答和脏工作区保护。
- **FE-E2E-002**（AC-04～06）：历史失败、新回归、P1 和 P2/P3 使用独立节点语义。
- **FE-E2E-003**（AC-08～09）：不兼容模型无法保存，软阈值只产生通知。
- **FE-E2E-004**（AC-10）：每个环绕节点按射线打开，三种关闭方式都精确恢复。
- **FE-E2E-005**（AC-11）：需求工作台铺满，规格、Run、Diff、验证、审核、发布和诊断无需离开子画布。
- **FE-E2E-006**（AC-12～13）：验证流式节点、过程组、历史分支和节点化规格确认。
- **FE-E2E-007**（AC-16）：在真实浏览器网络流中验证续传、重复事件和重新同步。
- **FE-E2E-008**（AC-17）：验证 GrayDango 队列、来源跨工作台定位和确认节点。
- **FE-E2E-009**：DOM 与可见组件审计确认不存在固定顶层栏、全局状态条、模态确认层、抽屉式业务区域、条形轻提示或固定详情侧区。
- **FE-E2E-010**（AC-18）：一万个对话节点、一百个需求和大量事件下保持交互、键盘导航和通知响应。
- **FE-E2E-011**：macOS、Linux、Windows 浏览器 CI 覆盖首屏、终端、键盘和嵌入产物。

## 13. 完成定义

- 所有 `FE-*` 需求有组件、集成或 E2E 追踪。
- REST 客户端与事件联合类型均由 Rust 契约生成，CI 检查产物未漂移。
- 单二进制复制到无源码、无 Node.js 的临时目录后可完成首屏、深链、事件连接和刷新。
- Playwright 覆盖空间比例、视差、工作台射线、视口恢复、流式对话、需求全画布、GrayDango 和危险确认。
- axe 无严重问题，关键路径完成键盘和屏幕阅读器手工验收。

## 14. 需求追踪矩阵

| 前端需求        | 产品需求 / 验收                                             |
| --------------- | ----------------------------------------------------------- |
| `FE-BUILD-*`    | PRD-NFR-011、AC-18                                          |
| `FE-CANVAS-*`   | PRD-CANVAS-001～012、PRD-NFR-005～006、AC-10～11、AC-17～18 |
| `FE-CHAT-*`     | PRD-CHAT-001～014、AC-02、AC-12～13                         |
| `FE-DELIVERY-*` | PRD-CANVAS-010～011、PRD-RUN-001～009、AC-11                |
| `FE-SPEC-*`     | PRD-SPEC-001～008、AC-01、AC-13                             |
| `FE-RUN-*`      | PRD-RUN-001～009、AC-02～07                                 |
| `FE-QUAL-*`     | PRD-QUAL-001～008、AC-04～06                                |
| `FE-PUB-*`      | PRD-PUB-001～007、AC-01、AC-07                              |
| `FE-FILE-*`     | PRD-CANVAS-009、PRD-CHAT-001                                |
| `FE-GIT-*`      | PRD-CANVAS-008～009、PRD-RUN-001                            |
| `FE-TERM-*`     | PRD-CANVAS-008～009、PRD-NFR-002                            |
| `FE-MODEL-*`    | PRD-MODEL-001～006、AC-08                                   |
| `FE-USAGE-*`    | PRD-USAGE-001～003、AC-09                                   |
| `FE-SET-*`      | PRD-CANVAS-009、PRD-NOTIFY-001～002                         |
| `FE-PET-*`      | PRD-NOTIFY-001～007、AC-09、AC-17                           |
| `FE-EVENT-*`    | PRD-EVENT-001～011、AC-14～16                               |
| `FE-E2E-*`      | AC-01～06、AC-08～13、AC-16～18（AC-07/14/15 为后端场景，由 BE-E2E/BE-TEST 覆盖） |
