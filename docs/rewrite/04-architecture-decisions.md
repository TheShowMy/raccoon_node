# Raccoon Node 技术选型与架构决策

> 状态：Accepted
> 决策基线日期：2026-07-16
> 关联文档：[产品需求](./01-product-requirements.md) · [前端需求](./02-frontend-requirements.md) · [后端需求](./03-backend-requirements.md)

## 1. 决策原则

1. 业务状态和安全策略由 Raccoon Node 掌握，第三方库只能作为可替换基础设施。
2. JSONL 事实事件先于内存、快照、网络和界面投影。
3. 节点是产品交互语言；只有基础输入控件留在所属节点内部。
4. 单仓库、本地优先、三平台一致和单二进制是 v1 硬边界。
5. 前后端独立构建，但公开契约只能有一个 Rust 事实源。
6. 默认自动交付必须由确定性权限、质量门槛和可恢复副作用支撑。

## 2. 决策总览

| 编号    | 决策                                                    | 状态     |
| ------- | ------------------------------------------------------- | -------- |
| ADR-001 | `rig-core = 0.40.0` 位于自有模型与 Agent 适配层后       | Accepted |
| ADR-002 | React 19 + React Flow + 像素风格设计系统（pxlkit + 自研） | Accepted |
| ADR-003 | 单仓前后端独立构建，生产发布为单二进制                  | Accepted |
| ADR-004 | REST 命令与快照 + HTTP NDJSON 业务事件 + WebSocket 终端 | Accepted |
| ADR-005 | JSONL Event Store + 单一 `state.json`                   | Accepted |
| ADR-006 | Git CLI + 受管 integration/work-item worktree           | Accepted |
| ADR-007 | 系统密钥库保存凭据，非本机访问全接口鉴权                | Accepted |
| ADR-008 | 只提供内置工具，结构化命令与策略化网络                  | Accepted |
| ADR-009 | 自有 reducer、快照、重放与外部事实核对                  | Accepted |
| ADR-010 | 三平台单二进制本地包，v1 拒绝 UNC                       | Accepted |
| ADR-011 | 全画布、射线工作台节点与全铺满需求子画布                | Accepted |
| ADR-012 | GrayDango 是唯一全局通知入口                            | Accepted |

## 3. ADR-001：Rig 作为 Agent 基础库

### Context

现有 Pi 运行时同时提供 Provider、模型列表、多轮会话、流式、工具、上下文和 Agent 循环。新版需要纯 Rust 生态能力，但不能把另一框架变成业务事实源。

截至决策日期：

- Rig 提供 Provider、Agent、工具、流式、多轮 chat 和 memory 抽象，也允许自定义 Provider。[Rig Core](https://docs.rs/rig-core/latest/rig_core/)
- Rig 的 streaming API 可以提供文本、工具和用量基础；Provider reasoning 只能作为适配层输入，不能直接成为公开过程节点。[Rig streaming](https://docs.rs/rig-core/latest/rig_core/streaming/)
- Rig 仍可能发生 breaking changes，因此其类型不能进入持久状态或公开契约。[Rig repository](https://github.com/0xPlaygrounds/rig)
- `genai` 更适合作为多 Provider 模型调用层；Agent 循环、memory 和工具生命周期仍需完整自建。[genai](https://docs.rs/crate/genai/latest)
- AutoAgents 提供 Agent/协议分层，但当前稳定性和采用度不足以优先于 Rig。[AutoAgents](https://docs.rs/autoagents/latest/autoagents/)
- langchainrust 功能面广，但决策时最新版文档构建失败，不满足核心依赖要求。[langchainrust](https://docs.rs/crate/langchainrust/latest)

### Decision

- 固定使用 `rig-core = 0.40.0` 并提交锁文件。
- 只有 `models` 和 `agent` 模块可以引用 Rig 类型。
- 自有 `ModelGateway` 负责 Provider、模型发现、能力、流和错误归一。
- 自有 `AgentRuntime` 负责上下文、工具循环、取消、重试、用量和产品事件。
- 业务上下文从 Raccoon Node 状态投影重建；Rig memory 只可作为进程内实现。
- Provider Registry 暴露固定版本编译进来的全部 Provider；无凭据契约测试覆盖全 Registry，有凭据时才运行实时 smoke。

### Consequences

- 获得成熟的多 Provider 与 Agent 基础，同时隔离升级风险。
- Rig 升级必须单独更新本 ADR 并通过 Provider、流式、工具、用量和恢复契约测试。
- “全部 Provider 可配置”不等于公开 CI 持有全部真实凭据。

### Rejected

- **继续 Pi**：违背纯 Rust 和自有状态边界。
- **只用 genai**：需要立即自建完整 Agent loop，v1 成本更高。
- **直接暴露 Rig 类型**：breaking changes 会进入事件、快照和前端。
- **使用 langchainrust 或 AutoAgents 作为主框架**：当前稳定性、文档或采用度不如 Rig。

## 4. ADR-002：像素风格设计系统（pxlkit 基础 + 自研节点视觉）

### Context

产品的设计语言确定为**像素风格（Pixel / Retro）**，与 GrayDango 像素宠物（16×16 spritesheet）同源统一。通用企业级组件库（MUI、Ant Design）的默认视觉与像素语言冲突，深度覆写成本高于直接采用像素系基础库。

现有像素系 React 生态：

- [`@pxlkit/ui-kit`](https://github.com/Joangeldelarosa/pxlkit)：111 个复古组件（表单、Modal、Tooltip、Dropdown、Tabs、Accordion、数据展示等），pixel/linear 双 surface 与暗色模式，WCAG 2.1 AA；`@pxlkit/core` 提供像素图标渲染、16×16 网格工具、PixelToast 与动画原语。两者均 MIT。
- [RetroUI（`pixel-retroui`，BSD-3）](https://github.com/Dksie09/RetroUI)：9 个像素基础组件与位图字体，体量小，适合作为风格与实现参考。
- 许可注意：pxlkit 的图标包（gamification/feedback/social/weather/ui/effects/parallax）为 source-available（免费需署名，付费免署名），只有 core/ui-kit/voxel 是 MIT。

### Decision

- 使用 React 19、TypeScript、Vite、`@xyflow/react`；基础控件以 `@pxlkit/ui-kit` + `@pxlkit/core` 为基线，RetroUI 作为风格参考。
- 像素设计 token（调色板、硬边框、像素阴影、位图字体、间距）以 CSS variables 承载，是唯一 token 来源；不引入 MUI/Emotion 等第二套通用组件体系。
- 库中不存在的组件一律按相同像素风格自研：ConversationGraph、工作台节点、规格、Run、Diff、验证、审核、发布、终端和 GrayDango；自研组件复用 `@pxlkit/core` 的网格/调色板工具与 token。
- 位图字体只用于标题、标签与强调；正文、代码和 Diff 使用高可读字体。
- 图标策略：优先自绘 16×16 像素图标（与 pxlkit 网格格式兼容）；使用 pxlkit 图标包素材时必须在 `THIRD_PARTY_NOTICES` 与关于页署名。
- 基础组件库不承担顶层导航、全局通知、业务状态覆盖或危险操作确认。
- TanStack Query 管理 REST 状态，Zustand 只管理画布导航、本地草稿和外观偏好。

### Consequences

- 像素语言从宠物扩展到全产品，形成统一且高辨识度的视觉；无需与通用组件库的默认视觉对抗。
- `@pxlkit/ui-kit` 的 WCAG 2.1 AA 覆盖保留了 PRD-NFR-006 的可访问性基线；自研组件必须达到同等 ARIA/键盘标准（axe + 手工键盘验收把关）。
- 首个前端里程碑必须先建立像素 token、字体方案、节点语法和状态语义。
- pxlkit 图标包的署名义务进入发布检查；如需免署名商用再单独评估其付费条款。
- 实现事实（P1 发现）：`@pxlkit/ui-kit` 的 `styles.css` 是 Tailwind v4 CSS-first 配置，
  组件样式由 Tailwind 工具类生成，因此 `tailwindcss` + `@tailwindcss/vite` 作为**构建期**
  依赖引入（MIT）。这不改变运行时 token 体系（CSS variables 仍是唯一 token 来源），
  业务代码不直接使用 Tailwind 工具类。

### Rejected

- **Material UI / Ant Design**：默认视觉与像素语言冲突，覆写成本高于收益。
- **Radix + 全自定义像素皮肤**：可行但失去 pxlkit 的现成组件覆盖与 a11y 基线，v1 建设量过大。
- **RetroUI 作为唯一基础库**：组件数量不足（9 个），缺口过大。
- **继续 Astryx**：成熟度和可预测性不足，并会继承当前实现约束。

## 5. ADR-003：单仓前后端独立构建与单二进制

### Decision

新仓库顶层结构：

```text
/
├── backend/
├── frontend/
├── docs/
├── scripts/
├── packaging/
├── package.json
└── Cargo.toml
```

- `backend/` 是独立 Cargo package，`frontend/` 是独立 npm package。
- 开发时 Vite 与 Axum 分别运行，Vite 只代理 `/api/v1`。
- 生产构建先生成 `frontend/dist/`，再把静态资源编译进 Rust 可执行文件。
- 单二进制同时启动 Axum、提供嵌入资源和 SPA fallback，并按配置打开浏览器。
- 运行时不依赖相邻资源目录、Node.js、Vite 或第二个生产服务。
- CI 把二进制复制到空目录，验证首屏、深链、API、事件流和缓存。
- 根 package 只编排构建与检查，不把前端源码变成 Rust 模块依赖。

### Why

这保留前后端独立开发和替换边界，也保持 Raccoon Node 已验证的单文件分发体验。v1 没有两个仓库或两个生产服务带来的独立发布收益。

### Rejected

- **前后端分仓**：增加契约协调和发布成本。
- **可执行文件旁放置前端目录**：移动文件后容易丢失 UI，不符合单二进制。
- **要求用户启动两个生产服务**：破坏本地工具体验。
- **普通 Rust 测试隐式启动 npm**：构建边界不清晰。

## 6. ADR-004：REST、HTTP NDJSON、终端 WebSocket 与生成契约

### Decision

- REST 负责 `GET /api/v1/snapshot`、只读查询和所有命令。
- `GET /api/v1/events?after=<sequence>` 返回 `application/x-ndjson`，每行一个版本化 `EventEnvelope`。
- 事件在 durable append 后才可发送，按项目 sequence 严格有序。
- 浏览器跨任意网络 chunk 边界按换行解析，并用 sequence 去重和检测缺口。
- 游标早于压缩下限时，服务端发送 `system.resync_required` 后关闭；客户端重新加载快照。
- 终端使用独立、鉴权 WebSocket，隔离 PTY 双向字节流。
- utoipa/OpenAPI 是 REST DTO 的唯一来源；Rust JSON Schema 是 NDJSON 事件联合与 payload 的唯一来源。
- 前端自动生成 REST client、事件 TypeScript 类型和运行时校验数据。
- Provider/Rig 原始事件与隐藏推理不进入公开协议。

### Why

业务实时流是服务端到浏览器的顺序事件，HTTP 流即可满足；命令继续使用可缓存、可测试、幂等清晰的 REST。PTY 确实需要双向低延迟字节流，因此单独使用 WebSocket。

### Rejected

- **所有功能共用 WebSocket**：命令幂等、错误、缓存和重连更复杂。
- **轮询全部状态**：对话与运行延迟高，请求浪费大。
- **GraphQL subscription**：为固定单项目领域增加额外运行时和 schema。
- **透传 Provider 流**：把第三方事件稳定性与隐私风险带入前端。

## 7. ADR-005：JSONL Event Store 与单一状态快照

### Context

产品需要本地优先、可检查、可重放的业务事实，并明确要求自定义 JSONL 事件流和 JSON 状态文件。持久化必须处理事件落盘后快照未更新、进程强杀、尾部半行、分段损坏和语义压缩。

### Decision

- `events/active.jsonl` 和封存的 `<sequence-range>.jsonl` 是唯一业务事实源。
- 所有业务命令进入单写入器，由它分配单调 sequence。
- 提交顺序为：追加完整 JSON 行与换行 → flush/fsync → reducer → 在线推送 → 快照。
- 单写入器允许 ≤5ms 窗口微批：同批事件保序追加后一次 fsync，整批落盘后才 reducer 投影与推送；里程碑事件（需求确认、计划、质量、发布、阻断、通知）逐条 fsync，不参与微批；崩溃窗口最多丢失最后 5ms 的流式 delta。
- `state.json` 包含 `format_version`、`last_sequence`、`written_at`、`state_hash` 和完整 `state`。
- 快照使用同目录临时文件、flush/fsync 和原子替换；启动时验证哈希并重放更高 sequence。
- active 尾部不完整记录可以在备份后截断；中间坏行、未知缺口和封存段损坏阻止写入，进入只读诊断。
- 语义压缩只处理已完成节点增量与工具中间状态，输出可重建 checkpoint，并在替换前比较重放状态哈希。
- 需求确认、计划、质量、发布、阻断、通知、用户原文和最终回答作为里程碑保留。
- 格式升级、压缩和人工恢复前生成有限备份；发现旧布局时只给归档指引。

### Consequences

- 事实格式简单、可逐行审查，恢复不依赖外部服务或框架会话。
- 需要自行实现单写入器、规范序列化、分段、哈希、压缩和三平台原子文件语义。
- 复杂任意查询不作为 v1 目标；API 从内存投影和索引提供产品所需查询。

### Rejected

- **关系型嵌入存储作为权威**：不符合已确定的 JSONL 事实与 JSON 快照方案。
- **只保存快照**：无法可靠解释崩溃窗口、外部副作用和增量重连。
- **每个聚合一个状态文件**：跨聚合序号和原子恢复边界不清晰。
- **把 Provider session 当事实**：不能覆盖 Git、质量、发布和通知语义。

## 8. ADR-006：Git CLI 与受管 worktree

### Decision

- Git CLI 是状态、Diff、分支、worktree、提交和远端操作的语义来源。
- status 使用 porcelain v2 `-z`，不按换行猜测路径。
- 每个 Run 使用 integration branch/worktree，并行项使用 item branch/worktree。
- Agent 只能使用 Git 只读工具；提交、合并、push 和清理由 workflow/publication 执行。
- 主工作区不干净时阻止执行，不自动 stash。
- 同层最多三个独立项并行；每个并行批之后自动插入显式合并任务：后端在 integration worktree 中按工作项 position 顺序执行 git merge，无冲突则后端直接创建受管提交，有冲突时由 implementer 在 integration worktree 内编辑文件解决冲突（Agent 不执行任何 Git 写命令），后端验证 diff 后创建受管提交；合并任务最多尝试 2 次，超限 blocked；完成全部层次后只剩 integration 一个分支进入验证、审核与发布。

### Why

Git CLI 与用户 credential helper、SSH、worktree 和托管平台行为一致。worktree 提供可解释隔离，不强制容器化用户工程。

## 9. ADR-007：凭据与访问安全

### Decision

- Provider、GitHub、GitLab 凭据保存在系统密钥库；事件与快照只保存引用和非敏感状态。
- 环境变量是无可用密钥库环境的显式、只读回退，不自动复制。
- loopback 也用启动 nonce 换取 SameSite session，防范任意网页访问 localhost。
- 非 loopback 必须配置访问凭据，REST、NDJSON 和 WebSocket 全部鉴权并限制 CORS origin。
- 终端在非 loopback 下需要额外短期授权。
- Git push 使用用户已有 credential helper/SSH；托管平台 REST 使用应用保存的 token。

### Consequences

Linux 无 secret service 时必须显式使用环境变量或安装受支持密钥服务。v1 不提供自研加密 vault，也不把密钥写入 `state.json`。

## 10. ADR-008：内置工具与策略化网络

### Decision

- v1 不支持 MCP、第三方插件、技能或用户定义 Agent 工具。
- 工具固定为文件列出/读取/搜索、补丁、结构化命令、Git 只读和业务提交。
- 命令使用 program + args，不接受自由 shell 字符串。
- 默认网络 profile 为 offline；包管理器、Git 远端和受控只读抓取走独立策略。
- 子进程环境采用 allowlist，不继承 Provider token、托管平台 token、通用代理或其他凭据。
- 明确标注这是应用策略，不宣称提供 OS 级网络沙箱。

### Why

第三方工具和自由 shell 会把默认自动交付的权限面扩大到难以审计。v1 先固定有限工具、路径和恢复边界。

## 11. ADR-009：自有 reducer、快照、重放与外部事实核对

### Decision

- Requirement、Run、验证、审核和发布使用独立状态或结论，不复用单一 status。
- 对话保存不可变 DAG；用户、公开过程、工具、回答、澄清、规格和确认分别是领域节点。
- Composer 与 `ProcessGroup` 是可重建 UI 投影。
- 每个 EventEnvelope 通过纯 reducer 产生新的 `ApplicationState`；同一初始状态和事件序列必须得到相同 state hash。
- `state.json` 只加速启动；重放器是恢复、压缩校验和确定性测试的共同实现。
- 外部操作使用 `intent → external action → observed result`。重启后先核对 Git 或远端事实，再决定补写结果或安全重试。
- 在线事件流只是 durable 事件的传输，不是第二事实源。
- 不显示或保存隐藏 chain-of-thought；公开过程来自产品阶段、工具事实和可公开摘要。

### Why

这一方案让事件、快照、恢复和前端投影共享同一领域语义，并解决“运行结束但质量未通过”的歧义。外部事实核对避免强杀窗口中重复提交、推送或合并。

### Rejected

- **在各模块维护独立可变状态**：重启和事件推送容易产生不同结论。
- **让 UI 根据原始事件猜状态**：领域门槛会分散到前端。
- **恢复时无条件重试外部动作**：可能重复产生不可逆副作用。

## 12. ADR-010：三平台单二进制本地分发

### Decision

- macOS、Linux、Windows 各发布一个包含前端资源与启动逻辑的可执行文件。
- 分发渠道沿用三种：npm 全局包（按平台分包）、`cargo install --locked`、GitHub Releases 三平台单二进制。
- 路径使用 `Path`/`PathBuf`，外部进程使用 program + args。
- Windows 支持普通本地盘，拒绝 UNC、扩展 UNC 和设备保留名。
- `.cmd`/`.bat` 经显式 Windows 适配，核心流程不依赖 Bash。
- 三平台 CI 覆盖 PTY、进程树、Git、路径、JSONL、原子快照、打包和恢复。
- 打包测试在没有源码、前端目录和 Node.js 的目录中启动 UI。

### Deferred

UNC、容器执行、远程执行器、自动更新和签名安装器可单独立项。

## 13. ADR-011：全画布、射线工作台与节点化关系

### Context

Raccoon Node 只服务当前一个 Git 仓库。现有“环绕节点 → 射线外侧工作台 → 相机聚焦 → 关闭恢复”具有明确的空间辨识度，必须保留。新版还要求对话、澄清、需求、Git、文件、终端、模型和操作确认尽可能统一成节点关系。

### Decision

- 首页只有全屏外层 React Flow 场景和 GrayDango；不设置固定顶层业务区域。
- 中央是面积最大的独立 `ConversationGraph`，六个紧凑能力节点固定环绕。
- 外层相机使用有界视差；能力节点不可拖动，中央对话图维护独立受控 viewport。
- 初始对话图只有 Composer；发送后生成用户、过程、工具、回答和新 Composer，内容流式更新。
- 历史对话是不可变 DAG；澄清、规格 revision 和确认沿分支生成节点；完成过程可逆聚合。
- 点击环绕节点时，以中心到触发节点的射线在触发节点外侧创建大型 `CanvasWorkbenchNode`，相机聚焦该节点。
- 同时只打开一个工作台；工作台只保留最小标题和关闭控制，其他节点作为低对比上下文保留。
- 关闭、Escape 和浏览器返回使用同一导航状态机，精确恢复外层 viewport、焦点、视差、内部 viewport 和滚动。
- 文件使用目录/搜索/预览/引用节点；Git 使用仓库/分支/变更/Diff/提交/同步节点；终端使用会话节点；模型与设置使用 Provider/模型/角色/用量/设置分组节点。
- 危险操作从来源节点连接到 `ActionConfirmationNode`，执行后形成结果节点。
- 需求工作台采用最大可用工作台节点，内部 React Flow 铺满内容区。需求列表为锚点，规格、澄清、确认、Run、工作项、Diff、验证、审核、发布和诊断都在同一子画布。
- 大输出使用详情节点、折叠节点或 artifact 引用；语义缩放和 viewport 虚拟化控制规模。
- 基础输入、选择、提示、编辑器和终端控件可以位于节点内部，但不能承担全局导航或业务状态覆盖。

### Why

外层固定空间确保能力入口稳定，中央图承载无限增长与分支对话，射线工作台延续项目识别度，内部子画布则让复杂关系仍然保持节点语义。

### Rejected

- **等权卡片仪表盘**：对话失去中心地位。
- **线性消息时间线**：无法表达过程、工具、确认和历史分支。
- **把所有节点混进一张自由画布**：对话增长会推走固定能力入口。
- **传统三栏需求管理页**：割裂需求、Run、质量和发布关系。
- **固定详情侧区**：形成第二套页面导航并压缩画布。
- **用全局覆盖确认危险操作**：失去来源关系和可追踪结果。
- **破坏性合并过程/工具节点**：丢失审计与恢复事实。

## 14. ADR-012：GrayDango 唯一通知入口与无全局业务覆盖

### Context

全画布产品如果同时出现多种全局提示、固定状态区域和独立通知中心，会遮挡节点、分散注意力并形成第二套导航。GrayDango 已经是产品品牌角色，适合承担统一、轻量且可定位的通知。

### Decision

- GrayDango 始终存在，是唯一全局通知入口和唯一允许的全局覆盖视觉。
- 用户可关闭动画和非关键气泡，但不能关闭错误、阻断和待操作通知的可达性。
- 队列按“错误/待操作 → 警告 → 完成/信息”排序，同级按发生时间。
- 普通通知自动收起；阻断项保留到 acknowledged 或 resolved。
- 气泡支持前后浏览、确认和来源定位；定位时按 ADR-011 打开工作台，再聚焦 `source_node_id`。
- `notification.raised`、`notification.acknowledged`、`notification.resolved` 是正式领域事件。
- 未解决 ActionRequired、Warning 和 Error 进入状态快照，重启后恢复队列。
- 用户确认只代表已读/知晓，领域问题解除才产生 resolved。
- 节点内部持续状态不重复进入气泡；长错误和日志通过来源节点或 artifact 展示。
- 除 GrayDango 和节点内部锚定的短暂控件浮层外，不创建全局业务覆盖层。

### Consequences

- 通知体验一致，并能从全局提醒回到具体业务关系。
- GrayDango 成为关键可访问组件，必须覆盖键盘、屏幕阅读器、无动画模式、队列溢出和来源缺失。
- 后端通知生命周期是业务事实，前端计时器不能擅自解决关键通知。

### Rejected

- **独立通知中心**：产生第二导航入口并脱离来源节点。
- **每个工作台自行显示全局提示**：用户离开工作台后会丢失阻断。
- **所有通知永久驻留**：高频完成信息会淹没待操作项。
- **允许完全关闭宠物**：关键通知将失去唯一可达入口。

## 15. 新项目纵向实施顺序

### Milestone 1：基础启动、事件存储与模型

- 建立单仓前后端、三平台 CI、生成契约、像素 token 与组件基线、静态资源嵌入和单二进制链路。
- 完成 Git 根、运行目录、单写入器、JSONL 分段、`state.json`、重放、只读诊断、鉴权、Provider Registry、密钥库和角色配置。
- 交付标准：空仓库可启动；事件落盘后强杀可恢复；可配置并探测一个 Provider。

### Milestone 2：全画布问答、GrayDango 与规格

- 完成中央对话 DAG、流式过程/工具/回答、分支、节点化澄清、规格 revision 和确认。
- 完成环绕布局、射线工作台、视口恢复、GrayDango 队列、NDJSON 对账和重新同步。
- 交付标准：AC-10、AC-12～17 中相关场景通过。

### Milestone 3：Agent 执行与需求全画布

- 完成 AgentRuntime、内置工具、写锁、WorkPlan、worktree、并行切片与显式合并任务、暂停编辑和用量。
- 完成需求最大化工作台和规格到诊断的全部节点类型。
- 交付标准：临时仓库自动完成多切片任务，Agent 无法越界或执行 Git 写动作。

### Milestone 4：验证与审核

- 完成验证目录、基线对比、风险自适应多角度审核、修复、rescue（整个 Run 最多一次，见 PRD-RUN-009/BE-RUN-009）和独立质量结论。
- 交付标准：历史失败、新回归、P1、P2/P3 四类场景通过。

### Milestone 5：发布、压缩与恢复

- 完成本地 fast-forward、GitHub PR、GitLab MR、外部事实核对、语义压缩、备份和恢复。
- 交付标准：强杀不重复提交/推送/合并，压缩前后 state hash 一致。

### Milestone 6：其余工作台与跨平台硬化

- 完成文件、Git、终端、模型、用量和设置的节点化工作台，以及大规模、可访问性和三平台打包。
- 交付标准：产品 AC-01 至 AC-18 都有可复现证据。

## 16. ADR 变更规则

- 依赖主版本、公开 API、事件权威、Agent 权限、发布语义、Provider 范围、全画布交互或平台范围变化时必须更新或新增 ADR。
- 实现发现决策不可行时，先记录事实、替代方案和影响，再修改需求，禁止在代码中静默偏离。
- Rig、pxlkit、事件格式和跨平台文件依赖升级必须重新运行契约、浏览器、重放和平台测试，并更新决策基线日期。
