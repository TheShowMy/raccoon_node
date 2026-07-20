# Raccoon Node 前端开发需求

> 状态：实施基线
> 关联文档：[产品需求](./01-product-requirements.md) · [后端需求](./03-backend-requirements.md) · [技术决策](./04-architecture-decisions.md)

## 1. 目标与边界

前端把自动交付系统呈现为可理解、可控制的单项目节点空间。首屏是一个完整 React Flow 场景：中央对话节点图占据主要空间，初始只有一个 Composer；需求、文件、Git、终端、用量统计、设置节点固定环绕。模型配置并入设置；所有工作台仍以画布节点形式在射线外侧展开，不切换成传统业务页面。

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
- `@xyflow/react` 承载外层能力场景、中央对话图和需求交付全铺满子画布。
- 设计系统是**像素风格（Pixel / Retro）**，与 GrayDango 像素宠物统一。基础控件优先使用 [`@pxlkit/ui-kit`](https://github.com/Joangeldelarosa/pxlkit)（111 个复古组件，MIT，WCAG 2.1 AA，pixel/linear 双 surface 与暗色模式）与 `@pxlkit/core`（像素图标渲染、16×16 网格工具、PixelToast、动画原语，MIT）；[RetroUI（`pixel-retroui`，BSD-3）](https://github.com/Dksie09/RetroUI) 作为风格参考与补充来源。
- 库中不存在的组件（React Flow 业务节点、Diff、终端、图表等）一律按相同像素风格自研；自研组件复用 `@pxlkit/core` 的网格/调色板工具与 token，保持视觉一致。
- 像素设计 token（调色板、硬边框、像素阴影、位图字体、间距）以 CSS variables 承载，是唯一 token 来源；不引入 MUI/Emotion 等第二套通用组件体系。
- 许可约束：`@pxlkit/core`、`@pxlkit/ui-kit`、`@pxlkit/voxel` 为 MIT；pxlkit 图标包为 source-available（免费需署名，付费免署名）。v1 优先使用 ui-kit 组件与自绘 16×16 图标；使用任何图标包素材必须在 `THIRD_PARTY_NOTICES` 与关于页署名。
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
- 基础组件库（pxlkit/自研像素组件）不能承担顶层导航、全局通知、业务状态覆盖或危险操作确认。
- **FE-BUILD-001**（PRD-NFR-011）：正式构建生成可嵌入静态产物，JS、CSS、字体和图标不依赖相邻运行目录。
- **FE-BUILD-002**：构建输出包含版本与内容哈希 manifest，支持后端嵌入、SPA fallback 和不可变资源缓存。
- **FE-BUILD-003**：假数据验收使用 `src/api/mock/` 和暂时的手写前端契约；演示控制台默认不挂载，只有显式设置 `VITE_ENABLE_DEMO_CONSOLE=true` 才允许在开发环境显示；定时演示通知同样默认关闭，只能通过 `VITE_ENABLE_DEMO_NOTIFICATIONS=true` 启用测试 fixture。后端接入时再以 Rust 生成契约替换手写类型，本轮不得伪造或修改后端 OpenAPI/JSON Schema 产物。

## 3. 信息架构

### 3.1 顶层结构

应用只有两个顶层视觉区域：

1. **全屏主画布**：承担能力概览、中央对话、工作台展开、状态定位和全部业务导航。
2. **GrayDango**：唯一允许的全局覆盖视觉，承担全局通知气泡和通知队列。

仓库、分支、连接、模型、用量、Run 和安全状态分别显示在对应节点内。产品名可以是画布中的静态品牌元素或节点标签，但不能占用一条固定业务区域。

### 3.2 外层能力节点

外层场景使用固定逻辑布局，不允许用户拖动或保存自定义位置：

| 节点       | 概览摘要                          | 打开后的节点关系                                      |
| ---------- | --------------------------------- | ----------------------------------------------------- |
| 中央对话图 | 活动分支、流式节点、Composer      | 用户、过程、工具、回答、澄清、规格、确认              |
| 需求交付   | 排队、执行、阻断、最近交付        | 确定需求、Run、分层任务、Diff、验证、审核、发布、诊断 |
| 文件       | 仓库摘要、最近引用                | 目录、搜索、预览、引用分区                            |
| Git        | 仓库、分支、变更、写锁            | 仓库、分支、变更、Diff、提交、同步、确认分区          |
| 终端       | 会话数、连接状态                  | 会话标签与单一活动终端                                |
| 用量统计   | 总 Token、对话/任务拆分、最近活跃 | 指标条、365 天每日点阵、模型聚合                      |
| 设置       | 模型配置、运行安全和维护摘要      | 通用、模型、运行与安全、维护四分类                    |

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
- `/canvas/workbenches/usage`
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

- **FE-CANVAS-008**（PRD-CANVAS-004、AC-10）：打开前保存主场景 viewport、视差目标、触发节点、焦点、对话 branch viewport、需求子画布 viewport，以及普通工作台各 pane 的滚动位置。
- **FE-CANVAS-009**：以主场景中心 `C` 和触发节点中心 `N` 计算单位射线 `normalize(N - C)`；工作台中心位于 `N + ray * offset`，`offset` 由触发节点边界、安全间距和工作台尺寸确定。
- **FE-CANVAS-010**：工作台是外层 React Flow 中的真实大型 `CanvasWorkbenchNode`；相机使用安全边距聚焦该节点，不使用固定屏幕坐标或覆盖层伪装。
- **FE-CANVAS-011**：同一时间只创建一个工作台节点；打开另一能力时先完成当前工作台关闭与状态保存，再创建新节点。
- **FE-CANVAS-012**：工作台打开后暂停主场景视差，其他节点保留为低对比上下文且不可交互，不卸载主场景。
- **FE-CANVAS-013**：工作台框架只显示最小标题、必要的局部定位信息和关闭控制；业务状态由需求节点或普通工具页的来源区域表达。
- **FE-CANVAS-014**：关闭、Escape 或浏览器返回都进入同一 closing 状态，精确恢复保存的 viewport、焦点、选择、滚动和视差目标。
- **FE-CANVAS-015**：重复打开、关闭、快速返回和窗口缩放不得产生空节点 ID、重复工作台、跳帧焦点或丢失返回点；已打开工作台在宿主尺寸变化后必须沿同一能力射线重算位置，并用安全边距快速平滑适配到完整可见区域。
- **FE-CANVAS-016**：reduced-motion 下关闭飞行与视差动画，直接设置稳定相机，但保持几何位置、焦点和返回语义。

### 4.3 工作台内部交互

- **FE-CANVAS-017**：工作台内部滚动、表单、编辑器、终端和需求子画布使用 `nodrag`/`nowheel` 边界，不能误驱动外层相机；只有需求工作台存在内部画布拖选与缩放。
- **FE-CANVAS-018**（PRD-CANVAS-007）：层级、依赖、来源和生命周期在对话图与需求交付画布中使用节点与边；普通工作台按领域布局组织 pane，输入、开关、下拉、文本编辑器和终端留在来源区域内。
- **FE-CANVAS-019**（PRD-CANVAS-008）：危险动作确认链（来源 → 确认 → 结果）在画布中以节点呈现；普通工作台使用底部中央绝对定位的 `WorkbenchActionDock`，不改变 pane 几何、滚动高度或分栏。Dock 同时展示一个前台确认，按创建时间排队，结果显示 3 秒后收起；来源按钮或文件行高亮并滚入 Dock 安全区。它属于当前工作台，不是全局覆盖或通知入口。
- **FE-CANVAS-020**：节点或普通 pane 内可使用必要的选择菜单、提示和编辑器浮层；它们必须锚定所属控件、失焦可关闭，不得承担跨工作台业务状态。
- **FE-CANVAS-021**（PRD-CANVAS-011）：需求画布的大输出使用 `DetailNode`、`CollapsedArtifactNode` 或 artifact 引用；普通工作台使用主预览/详情 pane 和 artifact 引用，不为大输出重新引入子画布。
- **FE-CANVAS-022**：滚动位置使用通用稳定键保存：对话与需求按节点和滚动区域保存，普通工作台按工作台与 pane 的 `data-scroll-key` 保存；关闭或路由切换后恢复。
- **FE-CANVAS-023**：只有需求工作台消费一次性 `deliveryFocusRequest` 并聚焦内部 `node_id`；文件、Git、终端、用量统计、设置的 GrayDango 定位和深链只打开工作台，不定位内部面板。

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
  deliveryViewport: Viewport | null;
  scrollPositions: Record<string, number>;
  expandedProcessGroupIds: string[];
  deliveryFocusRequest: {
    node_id: string;
    request_id: string;
  } | null;
};
```

服务端节点、Run、通知和消息正文不得复制进该 store。未发送 Composer 和未提交表单草稿按对象 ID 存为本地 UI 状态。

## 5. 中央对话节点图

中央对话图默认可直接操作，不存在“概览后再进入聊天”的第二步。节点链为：

```text
问答：Composer → 用户消息 → 过程/工具 → 回答 → Composer
开发：Composer → 用户消息 → 过程/工具 → 回答 → 澄清 → 回答 → 规格 → 确认 → Composer
```

- **FE-CHAT-001**（PRD-CHAT-001）：Composer 支持文本、文件引用和图片附件，并显示限制与移除操作。假数据阶段的图片使用真实本地文件选择和预览，只向 mock API 传递名称、MIME、大小等安全元数据，不伪造服务端上传。
- **FE-CHAT-002**（PRD-CHAT-002）：Composer 显示自动判定的问答或开发需求；判定为 `ambiguous` 时按问答处理并提示“意图识别不确定”，用户可随时覆盖为开发需求，覆盖只影响当前提交。
- **FE-CHAT-003**（PRD-CHAT-003）：选定连续节点后可“整理为需求”，来源和附件直接关联。
- **FE-CHAT-004**（PRD-CHAT-004）：活动 Run 期间 Composer 和分支仍可用，开发需求提示将排队。
- **FE-CHAT-005**（PRD-CHAT-005）：活动过程/回答节点提供停止操作，停止后保留已接收内容并显示 `aborted`。
- **FE-CHAT-006**（PRD-CHAT-006）：过程节点只展示公开理解、证据、动作、结论和下一步，不提供隐藏推理入口。
- **FE-CHAT-007**：发送成功后 Composer 原位固化为用户节点。普通问答结束后在末端恢复一个 Composer；`drafting | clarifying | spec_ready` 需求存在时由最新澄清或确认节点接管输入，确认入队、取消或被取代前不得投影 Composer。
- **FE-CHAT-008**（PRD-CHAT-008、AC-12）：过程与回答在首个 delta 前显示稳定外壳，真实内容追加到同一节点，不以逐字动画伪造完整内容。
- **FE-CHAT-009**：工具节点显示目的、工具名、等待/运行/完成/失败、耗时和截断摘要；完整安全输出通过详情节点引用。
- **FE-CHAT-010**（PRD-CHAT-011）：回答完成后默认生成可逆 `ProcessGroup`；展开恢复成员节点、边、顺序和错误。
- **FE-CHAT-011**（PRD-CHAT-009）：历史用户节点提供“从这里分支”；新分支共享祖先并错层展开，原分支不可改写。
- **FE-CHAT-012**：用户真实平移、缩放或定位历史节点后暂停自动跟随，通过“回到最新”恢复；节点内部滚动不得误触暂停。发送、提交澄清、保存规格、确认或取消属于前向操作并恢复跟随；暂停期间流式增量不抢焦点。
- **FE-CHAT-013**：远景只显示节点类型、阶段和分支摘要，近景才渲染正文、工具摘要和操作。
- **FE-CHAT-014**：重连先加载包含活动节点已组装内容的快照，再按全局 sequence 和 node sequence 对账，不产生重复节点或文本。
- **FE-CHAT-015**（PRD-CHAT-014）：任意对话节点提供 redact 入口，经 `ActionConfirmationNode` 确认后节点内容显示为“已删除”标记；节点 ID、结构、分支关系与相邻节点保持不变，附件引用显示已失效。
- **FE-CHAT-016**：主链与分支布局以 React Flow 实测外框为准，相邻前后节点边界统一保留 48 画布逻辑像素；Composer、过程组和展开成员不得使用另一套中心点槽位。
- **FE-CHAT-017**：首次测量前按节点类型估算尺寸并缓存；流式节点增高或过程组展开/折叠后只重排其后继，已完成前驱和既有分支车道保持稳定。
- **FE-CHAT-018**：自动跟随按“最后一个 `streaming | running` 节点 → 当前分支待操作澄清/确认节点 → 本次前向操作中新建的持久节点 → Composer”选择目标；保持当前 zoom，把目标真实中心锚定到画布水平 50%、垂直 65%，并应用安全边距。同一批次产生澄清回答、规格和确认时只定位最后的可操作确认节点。
- **FE-CHAT-019**：新目标进入虚拟化保留集合后最多等待两个动画帧取得 React Flow 实测尺寸；相机保持当前 zoom，以 `220ms`、线性空间插值和 ease-out 曲线平滑移动。实测尺寸晚到或同一流式节点增高时使用 `100ms` 平滑补偿，不允许 `0ms` 二次跳变；请求按帧合并且后请求覆盖前请求，偏移小于 `1px` 不重复移动。reduced-motion 下直接定位。
- **FE-CHAT-020**：用户在对话画布手动平移或缩放后暂停跟随并显示“回到最新”；点击该操作或切换分支恢复跟随。深链或 GrayDango 定位历史节点时保持暂停，不抢回末端。
- **FE-CHAT-021**：对话深链必须切换正确分支、展开包含目标的过程组、选择并聚焦目标节点；刷新和直接访问使用相同恢复语义。
- **FE-CHAT-022**：澄清问题、澄清回答、规格 revision、需求确认、操作确认和操作结果都注册为中央对话节点。澄清显式支持单选、多选和自由文本：单选/多选使用全宽 radio/checkbox 选项行，“推荐”不自动选中，只有选择“自定义”后才展开不可拖动尺寸的文本框。提交后依次产生独立回答、规格和确认节点；确认摘要显示发布路径、模型角色、预算与脏工作区影响。澄清标题使用 `pending | answered | cancelled` 业务状态，不把内容节点的 `completed` 显示成需求已经完成。
- **FE-CHAT-023**：对话图在传给 React Flow 前按 viewport 做窗口化；已测尺寸继续缓存，选中、活跃和深链目标必须固定保留。一万个节点时 DOM 数量保持有界且仍可定位末端。
- **FE-CHAT-024**：`ConversationNode` 的 mock 契约包含 `clarification_round_id` 和 `redacted_at`；redact 使用 `conversation.node.redacted` 事件和 `conversation_redact` 两阶段操作，reducer 清除可见正文与附件引用但保留节点和边。
- **FE-CHAT-025**（PRD-CHAT-015、AC-19）：中央对话图右上角固定显示“＋ 新建会话”，不随内部 viewport 移动，在 Composer 隐藏或用户查看历史时仍可达。空闲时幂等创建；存在活动响应、草稿或输入门控时，在当前输入所有者后投影 `ActionConfirmationNode`。确认后 abort 旧响应并切换空图，取消则恢复原 viewport；命令执行期间按钮禁用。
- **FE-CHAT-026**：会话与分支是两级状态。viewport、Composer 草稿、选择和过程组展开按 `session_id + branch_id` 保存；新会话只含 root branch 与 Composer，并使用默认 viewport/自动跟随。旧会话继续保存在领域投影中，但当前 UI 不渲染会话列表、返回入口或历史搜索。

## 6. 需求交付工作台

### 6.1 最大化全铺满子画布

- **FE-DELIVERY-001**（PRD-CANVAS-010、AC-11）：需求工作台使用最大可用 `CanvasWorkbenchNode`，扣除最小标题后，内部 React Flow 铺满全部内容区。
- **FE-DELIVERY-002**：需求列表节点只接收曾经确认的需求，固定投影为 `queued | active | blocked | history`；历史默认折叠。草拟、澄清、`spec_ready` 和从未确认即取消的需求不可出现。
- **FE-DELIVERY-003**：选择需求后只展开确定需求摘要、Run、WorkPlan、工作项、Integration Diff、验证、审核、发布和按需诊断。摘要显示目标、确认 revision、冻结预算、队列位置和 Run 状态，并提供返回中央对话确认节点的操作。
- **FE-DELIVERY-004**：所有详情在同一子画布通过节点或 artifact 引用访问，不切换路由页面，不创建固定详情区域。
- **FE-DELIVERY-005**：子画布保存 viewport、选中需求、筛选和展开节点；关闭工作台不卸载中央对话图或丢失 Composer 草稿。
- **FE-DELIVERY-006**：一百个需求和大量工作项时，默认只展开当前需求一跳关系；更远关系按需加载，折叠后保留摘要节点。

### 6.2 对话与交付边界

- **FE-SPEC-001**（PRD-SPEC-004）：澄清问题、用户回答、规格 revision 和需求确认只注册在中央对话图；需求工作台不得复制这些节点或提供编辑入口。
- **FE-SPEC-002**（PRD-SPEC-001～003）：中央规格节点包含目标、用户价值、范围、场景、约束、非目标、风险、假设和证据；场景与约束显示稳定 ID 和来源。
- **FE-SPEC-003**（PRD-SPEC-005～008）：中央对话保存 revision 链与确认关系；确认后语义修改必须返回原分支创建新 revision，关联未终态 Run 取消后重新确认并创建新 Run。
- **FE-SPEC-004**：确认节点显示发布路径、模型角色、默认任务预算、当前有效预算和脏工作区影响；确认成功后才允许需求进入交付投影。

### 6.3 Run、质量与发布

- **FE-RUN-001**（PRD-RUN-001）：需求列表节点内提供可访问队列重排；活动项（含 `waiting_workspace` 的 Run）不可移动。
- **FE-RUN-002**（PRD-RUN-002～003）：计划生成后自动展开 Run 和 WorkPlan 节点；Run 节点默认显示阶段、产出、风险和下一步。
- **FE-RUN-003**（PRD-RUN-004～005）：请求暂停后，进行中的工作项继续完成且不可编辑；Run 进入 `paused` 后通过计划编辑节点修改 pending 工作项、依赖和验证目标，并显示 DAG 与场景覆盖校验结果节点。
- **FE-RUN-004**：任务 DAG 使用最长依赖路径从左到右分层。WorkPlan 只连接根任务，每个 `depends_on` 只产生一条带箭头正交边；同层 2–3 项纵向排列，显式 `merge_task` 独占下一层并接收汇合边。普通依赖实线、合并依赖双线、阻断依赖红色虚线。
- **FE-RUN-005**：`waiting_workspace` 节点说明执行尚未开始，问答和需求准备仍可使用。
- **FE-RUN-006**：Run 节点和交付报告显示冻结预算、已知费用和完整性；达到 80% 显示软告警，未知价格不按零估算。
- **FE-RUN-007**：普通任务固定 `360×208`，合并任务固定 `320×160`；同层边缘间距为 `48px`，层间边缘距离至少 `112px`。节点以概要/尝试/产物页签和内部滚动承载内容，状态与 attempt 不改变几何或坐标。
- **FE-RUN-008**：终端工作项连接 Integration Diff，之后只绘制 `Diff → 验证 → 审核 → 发布` 质量主链；未来阶段保留灰态。诊断与危险确认位于辅助区，不接入任务主链。
- **FE-RUN-009**：环、缺失依赖、批次矛盾、缺少合并任务或场景未覆盖时停止正常 DAG 投影，显示 `PlanInvalidNode` 和确定性问题清单，并阻止保存与执行。
- **FE-RUN-010**：选择需求时在节点完成测量后仅对当前执行流水线做一次安全 `fitBounds`；状态更新保持视口，计划 revision 只提示查看新增层。Run 提供定位当前任务，GrayDango 可聚焦 Run 或工作项。
- **FE-QUAL-001**（PRD-QUAL-002～004）：验证节点并列显示基线和最终结果，独立呈现 `VerificationVerdict`。
- **FE-QUAL-002**（PRD-QUAL-005）：审核节点分为 P0/P1 阻断和 P2/P3 建议；交付后建议仍可见。
- **FE-QUAL-003**（PRD-QUAL-008）：`ReviewVerdict=unavailable` 时审核节点显示阻断原因，并提供“未经审核交付”的 `ActionConfirmationNode` 入口；确认结果形成永久事实节点。
- **FE-PUB-001**（PRD-PUB-001～004）：发布节点显示实际路径、回退原因、分支、提交和 PR/MR 链接。
- **FE-PUB-002**（PRD-PUB-006）：远端已合并而本地同步失败时组合展示两个事实。
- **FE-PUB-003**：最终报告节点依次显示结果、位置、验收证据、质量、建议、用量和下一步。
- **FE-PUB-004**（PRD-PUB-007）：远端必要检查失败或远端拒绝合并时，发布节点显示 `blocked`、PR/MR 链接、CI 修复尝试结果与恢复操作入口；恢复操作使用 prepare/confirm 两阶段确认节点。

## 7. 其他工作台

文件、Git、终端、用量统计、设置是位于外层工作台节点内的领域化连续工具页面。每个主要 `WorkbenchPane` 保留 `px-cut`、像素边框、标题条和状态色；pane 之间正常密度为 `2px`，紧凑密度和窄工作台为 `1px`。pane 无浮动阴影和大外边距，内部列表行、字段组、标签和操作只使用分隔线与选中态，不递归套用切角卡片。普通工作台内容铺满宿主，每个主要 pane 独立滚动；容器变窄时使用工作台内部标签切换 pane，不把全部区域纵向堆叠。

### 7.1 文件

- **FE-FILE-001**（PRD-CANVAS-009）：桌面布局为左侧 `280px` 资源管理器 pane 和右侧文件预览 pane；资源管理器以“目录 / 搜索”标签切换并保留各自状态，不同时拼成卡片。
- **FE-FILE-002**：预览主区支持行号、高亮、复制路径和引用；二进制、过大、非 UTF-8 和受限路径在预览来源区显示结果。容器小于 `700px` 时使用“浏览 / 预览”标签切换，选择文件后进入预览。
- **FE-FILE-003**：引用操作把路径加入目标 Composer，不自动发送。

### 7.2 Git

- **FE-GIT-001**：局部工具栏显示仓库、当前分支、ahead/behind、写锁，以及 Fetch、Pull、Push 和创建分支入口。桌面固定为左侧 `220px` 仓库/分支、中间 `minmax(300px, 34%)` 变更/提交、右侧 `minmax(0, 1fr)` Diff 三个相邻 pane。
- **FE-GIT-002**：中栏按 staged、unstaged、untracked、conflicted 分组，Diff 选择与批量勾选相互独立；每行提供不撑高行的选择热区，分组标题提供三态全选，顶部提供“暂存所选 / 取消暂存所选 / 清除选择”和数量。未暂存与未跟踪可共同批量暂存，已暂存可批量取消；冲突文件不可选择，写锁占用时全部选择型写操作禁用并解释原因。批量命令成功后只清除实际处理路径，刷新时自动剔除已不存在路径。文件行固定单行，正常密度约 `26px`、紧凑约 `22px`；状态和省略路径始终可见，单文件操作绝对定位在右侧，仅 hover、focus 或选中时出现且不撑高行，当前高度稳定显示至少 12–15 项。
- **FE-GIT-003**（PRD-CANVAS-008）：commit、push/pull/fetch、切换/创建分支和丢弃必须经底部 `WorkbenchActionDock` 执行；来源工具按钮、分支、变更行或提交区高亮，完成事实与 GrayDango 通知保留。
- **FE-GIT-004**：容器小于 `840px` 时使用“仓库 / 变更 / Diff”标签切换，选择变更后进入 Diff。v1 不增加 Stash、提交历史、多仓库、交互式 rebase 或凭据管理。

### 7.3 终端

- **FE-TERM-001**：顶部显示节点式会话标签与新建按钮，主体只挂载当前活动 xterm；可切换、重命名和关闭会话，不提供终端平铺。
- **FE-TERM-002**：连接断开和进程退出是不同状态；重连不把旧输出写入业务事件。
- **FE-TERM-003**：终端标签工具区与主体以 `1px` 分隔；关闭仍运行的终端时由当前工作台底部 `WorkbenchActionDock` 确认，关闭按钮保持来源高亮。

### 7.4 模型、用量与设置

- **FE-MODEL-001**：模型配置只存在于设置的“模型”分类。桌面内容为左侧 `220px` Provider、中间 `300px` 凭据/模型、右侧能力与五角色配置连续三栏；密钥只允许新建或替换，不回显。
- **FE-MODEL-002**：模型分配到 qa/clarifier/planner/implementer/reviewer 五种角色；不满足能力要求时在设置来源区显示阻止结果并由 GrayDango 以 `settings` 来源通知。容器小于 `840px` 时使用 Provider/模型/能力与角色标签切换。
- **FE-USAGE-001**：独立用量统计页顶部显示总 Token、对话 Token、任务 Token，三项都分别显示未缓存与缓存值；未知记录只补充“N 条 Token 或缓存数据不完整”，不使用“已知至少”。总 Token 为 input + output，cache 单独展示且不重复计入；过长数值按万、千万、亿中文档位缩写。
- **FE-USAGE-002**：中部使用 CSS Grid 展示最近 365 天每日 Token 点阵，7 行、月份标记和 5 档色阶；点阵采用 roving tabindex，任一时刻只有一个日期进入 Tab 顺序，方向键按日或按周移动，hover 与键盘焦点均显示可读日期与 Token。
- **FE-USAGE-003**：下部按 Provider/模型聚合总量、对话、任务、缓存和占比；费用只在模型行显示已知小计及“不完整”，顶部不显示费用、预算、Provider 或角色配置。
- **FE-SET-001**：设置采用左侧 `220px` 分类导航和右侧当前分类表单；基础控件留在当前表单区，不同时渲染所有设置卡片。
- **FE-SET-002**：保存结果、错误和 `restart_required` 显示在右侧来源区，保存和重启是两个动作；容器小于 `700px` 时分类导航变为横向标签。
- **FE-SET-003**：GrayDango 动画、非关键气泡、明暗模式和密度是本地外观偏好；不能关闭关键通知可达性。
- **FE-SET-004**：设置只包含 `general | models | runtime_security | maintenance` 四类；模型选择、角色草稿、当前分类和滚动状态关闭重开后恢复。
- **FE-SET-005**：运行与安全保存 `default_task_budget_usd`，只作为新需求确认默认值；用量总览不得读取它做累计比较。

## 8. GrayDango 通知

### 8.1 展示和队列

- **FE-PET-001**（PRD-NOTIFY-001）：GrayDango 始终挂载，位置避开主要节点操作区；不得提供“完全关闭”选项。
- **FE-PET-002**（PRD-NOTIFY-002）：关闭动画时使用静态宠物；关闭非关键气泡后，错误、阻断和待操作通知仍自动可见。
- **FE-PET-003**（PRD-NOTIFY-003）：队列 selector 按 severity/lifecycle 排序：错误与待操作、警告、完成与信息；同级按 `raised_at`。
- **FE-PET-004**（PRD-NOTIFY-004）：普通通知按可访问的阅读时长自动收起；阻断项直到 acknowledged 或 resolved 前保持可再次访问。
- **FE-PET-005**：气泡提供前一条、后一条、当前位置、确认和定位操作；气泡与收起指示器必须位于宠物定位容器内并随拖动同步移动，根据宠物所在边缘自动翻转锚点以避免越界；空队列不显示占位业务气泡。
- **FE-PET-006**：通知内容简短且可行动，不复制长日志；错误详情通过对话/需求节点或普通工作台内的诊断功能区访问。

### 8.2 来源定位与恢复

- **FE-PET-007**（PRD-NOTIFY-005）：`conversation` 通知聚焦中央对话图对应分支节点；`delivery` 通知按射线流程打开需求工作台并聚焦 `source_node_id`；其余普通工作台通知只打开对应工作台，即使携带 `source_node_id` 也不定位内部 pane。
- **FE-PET-008**：对话或需求来源节点已折叠时先展开对应投影；目标不存在时仍打开所属画布并展示诊断结果。普通工作台没有内部来源定位失败状态。
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

- 视觉语言为像素复古风：画布节点使用硬边框、无圆角和像素位移阴影；普通工具页主要 pane 使用无浮动阴影的切角硬边框并保留 `2px`（紧凑/窄屏 `1px`）间距。GrayDango 是唯一轻量品牌角色。
- 位图字体只用于标题、标签和强调；正文、规格长文、代码与 Diff 使用高可读等宽/正文字体，禁止以像素字体牺牲正文可读性。
- 明暗主题沿用像素 token 双套色板（参考 `@pxlkit/ui-kit` 的 surface/dark mode 机制）；状态颜色只是辅助，必须同时有文本和像素图标。
- RunPhase、RunOutcome、验证、审核和发布分别展示，禁止统一翻译为“成功/失败”。
- 工作台内容增长优先增加内部空间关系，不持续推移已完成节点。
- 一万个对话节点、一百个需求和大量事件时，远景只渲染简化节点，近景按 viewport 加载正文。
- v1 支持 1024 CSS px 及以上桌面视口；更窄视口提供只读说明，不承诺移动端编辑。
- 所有画布节点支持键盘遍历；普通工作台按工具栏、标签、pane 和控件顺序遍历。屏幕阅读器通过语义树访问节点关系或 pane 标题，不要求理解二维坐标。
- 内部选择菜单、提示、表单和标签页使用 pxlkit 基础组件或同等 ARIA/键盘标准的自研像素组件；焦点不得逃出当前工作台或丢失返回节点。
- 意图切换、需求筛选、窄屏工作台标签、设置分类和批量操作等关键控件必须提供稳定点击热区；Git 高密度文件行和 Token 点阵只扩大交互热区或使用方向键导航，不放大其视觉密度。
- 对话 Composer 使用固定宽度和由内容/行数控制的高度，禁用浏览器原生 textarea 拖拽缩放；全局可滚动区域使用基于主题 token 的硬边、零圆角像素滚动条，hover 与键盘滚动状态保持可辨识。

## 11. 错误与极端状态

- 首屏快照失败生成可重试系统节点，并让 GrayDango 提供错误定位，不进入无限加载。
- 事件断线、版本不兼容、revision 冲突、Provider 不可用、技术暂停和发布失败使用不同节点语义。
- 对话或需求来源节点尚未加载时，GrayDango 定位先加载最小关系子图；普通来源只等待对应工作台完成射线打开。
- 过期 revision 通过差异节点展示，不覆盖本地草稿。
- 只读诊断模式禁用所有 mutation，但允许浏览快照、损坏范围、备份和归档指引。

## 12. 前端测试与验收

### 12.1 单元与组件

- 外层相机射线位置、边界钳制、视差插值、工作台聚焦、返回恢复和 reduced-motion。
- 1440×900 中央对话面积、初始单 Composer、环绕安全区和缩放降级。
- 工作台单实例、快速开关、Escape、浏览器返回和跨工作台切换。
- 对话 DAG、分支、Composer 固化、分支输入门控、单选/多选/自由文本澄清、node delta、过程组和 viewport 虚拟化。
- 不同高度节点、流式增高、过程组展开/折叠、分支与 Composer 的外框间距恒为 48px。
- 活跃节点选择、50%/65% 锚点、zoom 保持、手动暂停、恢复跟随和 reduced-motion。
- 需求子画布只显示确定需求及执行节点；未确认需求不进入分组，中央对话保留完整澄清、revision 和确认链。
- 纯串行、2/3 项并行、显式合并、多批次和跳层依赖布局稳定；节点无重叠、48px 同层间距、112px 层间距，根边、依赖边与质量主链数量严格匹配。
- 环、缺失依赖、非法批次、缺少合并任务和场景未覆盖只显示 `PlanInvalidNode`，不绘制误导连线。
- 五个普通工作台内部不存在 React Flow、Handle、边、坐标、缩放、`auto-fit` 卡片网格或递归小卡片；主要 pane 正常间距为 `2px`，紧凑/窄屏为 `1px`。
- 危险操作在画布中只能由来源节点连接到 `ActionConfirmationNode`，在普通工作台中只能经底部悬浮 `WorkbenchActionDock` 执行；Dock 前后 pane 几何和滚动位置必须完全不变。
- 覆盖 Git 三栏与 26/22px 文件行、文件双栏、终端单活动会话、设置四分类及模型三栏、独立用量统计页，以及窄屏标签、UI 状态和 pane 滚动恢复。
- GrayDango 队列优先级、自动收起、确认/解除差异、来源定位、重启恢复和无动画模式。
- NDJSON 拆包、粘包、UTF-8 边界、断线续传、重复、缺口和 `system.resync_required`。
- 状态与质量组合文案、用量口径、费用未知、任务预算冻结/80% 告警和模型能力过滤。

### 12.2 浏览器验收

- **FE-E2E-001**（AC-01～03）：从对话到交付，并验证运行期间问答和脏工作区保护。
- **FE-E2E-002**（AC-04～06）：历史失败、新回归、P1 和 P2/P3 使用独立节点语义。
- **FE-E2E-003**（AC-08～09）：不兼容模型无法保存；默认预算、确认覆盖、Run 冻结和 80% 软告警符合契约。
- **FE-E2E-004**（AC-10）：每个环绕节点按射线打开，三种关闭方式都精确恢复。
- **FE-E2E-005**（AC-11）：需求工作台不显示未确认需求或规格节点；确定需求的分层任务、显式汇合、Integration Diff 与质量主链清晰可达，控制台无 React Flow 测量错误。
- **FE-E2E-006**（AC-12～13）：验证流式节点、过程组、历史分支、三种澄清类型、澄清/确认期间无 Composer、取消后恢复输入，以及节点化规格确认。
- **FE-E2E-007**（AC-16）：在真实浏览器网络流中验证续传、重复事件和重新同步。
- **FE-E2E-008**（AC-17）：验证 GrayDango 队列、普通来源只打开工作台、对话/需求节点定位，以及确认节点/工作台悬浮 Dock 两种形态。
- **FE-E2E-009**：DOM 与可见组件审计确认不存在固定顶层栏、全局状态条、模态确认层、抽屉式业务区域、条形轻提示或固定详情侧区。
- **FE-E2E-010**（AC-18）：一万个对话节点、一百个需求和大量事件下保持交互、键盘导航和通知响应。
- **FE-E2E-011**：macOS、Linux、Windows 浏览器 CI 覆盖首屏、终端、键盘和嵌入产物。
- **FE-E2E-012**：连续多轮消息保持 48px 边界间距，活动生成节点和待操作业务节点均位于 50%/65% 锚点且不会完全居中；节点内部滚动不暂停，真实画布浏览后自动跟随暂停，前向操作可恢复。
- **FE-E2E-013**：覆盖澄清到 Run 的中央节点链、redact 确认链、本地图片选择、五种普通工具页、pane 滚动恢复和 GrayDango 跨工作台定位。
- **FE-E2E-014**：一万个对话节点时 DOM 数量保持有界，仍可深链并跟随末端；全画布 axe 验收只在真实 Playwright 浏览器执行，JSDOM 组件 axe 只覆盖独立节点。

## 13. 完成定义

- 所有 `FE-*` 需求有组件、集成或 E2E 追踪。
- REST 客户端与事件联合类型均由 Rust 契约生成，CI 检查产物未漂移。
- 单二进制复制到无源码、无 Node.js 的临时目录后可完成首屏、深链、事件连接和刷新。
- Playwright 覆盖空间比例、视差、工作台射线、视口恢复、流式对话、需求全画布、GrayDango 和危险确认。
- axe 无严重问题，关键路径完成键盘和屏幕阅读器手工验收。

## 14. 需求追踪矩阵

| 前端需求        | 产品需求 / 验收                                                                   |
| --------------- | --------------------------------------------------------------------------------- |
| `FE-BUILD-*`    | PRD-NFR-011、AC-18                                                                |
| `FE-CANVAS-*`   | PRD-CANVAS-001～014、PRD-NFR-005～006、AC-10～11、AC-17～18                       |
| `FE-CHAT-*`     | PRD-CHAT-001～015、AC-02、AC-12～13、AC-19                                        |
| `FE-DELIVERY-*` | PRD-CANVAS-010～014、PRD-RUN-001～013、AC-11                                      |
| `FE-SPEC-*`     | PRD-SPEC-001～008、AC-01、AC-13                                                   |
| `FE-RUN-*`      | PRD-RUN-001～013、AC-02～07、AC-11                                                |
| `FE-QUAL-*`     | PRD-QUAL-001～008、AC-04～06                                                      |
| `FE-PUB-*`      | PRD-PUB-001～007、AC-01、AC-07                                                    |
| `FE-FILE-*`     | PRD-CANVAS-009、PRD-CHAT-001                                                      |
| `FE-GIT-*`      | PRD-CANVAS-008～009、PRD-RUN-001                                                  |
| `FE-TERM-*`     | PRD-CANVAS-008～009、PRD-NFR-002                                                  |
| `FE-MODEL-*`    | PRD-MODEL-001～006、AC-08                                                         |
| `FE-USAGE-*`    | PRD-USAGE-001～003、AC-09                                                         |
| `FE-SET-*`      | PRD-CANVAS-009、PRD-NOTIFY-001～002                                               |
| `FE-PET-*`      | PRD-NOTIFY-001～007、AC-09、AC-17                                                 |
| `FE-EVENT-*`    | PRD-EVENT-001～011、AC-14～16                                                     |
| `FE-E2E-*`      | AC-01～06、AC-08～13、AC-16～18（AC-07/14/15 为后端场景，由 BE-E2E/BE-TEST 覆盖） |
