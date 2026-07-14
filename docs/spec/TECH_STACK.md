# 技术栈

## 栈

- 后端：Rust 2024（MSRV 1.96）、Axum、Tokio、serde/JSON、rusqlite、chrono、tracing。
- Pi RPC：低层 RPC 依赖 `pi-rpc-rs`，应用层仍由本项目封装模型、会话、受管 extension 和任务流程。
- 前端：React、TypeScript、Vite、React Flow（`@xyflow/react`）、Astryx
  (`@astryxdesign/core` + 7 套 `@astryxdesign/theme-*` 主题包)、lucide-react、
  `react-markdown` 与 `remark-gfm`。
- CLI/TUI：clap、ratatui、crossterm。
- 静态资源：Vite 产物通过 rust-embed 嵌入 `raccoon` 单二进制。
- 存储：`<git_root>/.raccoon-node/data.db` 是唯一业务主存储。
- Git：当前 Git 仓库即唯一项目；后端使用系统 Git 管理任务 worktree。
- LLM：只通过 Pi Agent RPC，后端启动持久 `pi --mode rpc` 子进程，stdin/stdout JSONL 通信。

## 目录

- 后端入口：`src/main.rs`
- 后端模块：根 crate `raccoon-node` 的内部模块位于 `src/api/`、`src/store/`、`src/pi/`、`src/requirement/`、`src/workflow/` 等目录，不再依赖单独发布的内部 crates。
- 前端入口：`frontend/src/main.tsx`；`App.tsx` 只编排领域 hooks 与主画布，画布、聊天、
  工作台和共享 UI 分模块实现，六个外围工作台通过动态 import 按需加载。
- 前端样式：`frontend/src/styles/index.css`，使用 Astryx 预构建 CSS 与普通 CSS，
  保留 React Flow 画布/节点覆盖。
- 构建脚本：`scripts/build.mjs`
- 项目仓库：当前 Git 根目录，固定项目 ID `current`
- 项目配置：`<git_root>/.raccoon-node/config.toml`
  （包含 `theme_pack` 与 `theme_mode`）。
- 应用数据：`<git_root>/.raccoon-node/data.db`
- Pi Agent RPC 完整模型上下文：`<git_root>/.raccoon-node/sessions/`
- JSONL 会话查看：后端按需解析 session 文件并分页返回，原始记录不复制进 SQLite。
- 对话传输：HTTP 接受项目问答、需求分析和停止操作；只读 WebSocket 推送统一增量
  事件。前端先订阅并缓冲事件，再拉取 SQLite 快照并回放缓冲事件；重连后重新对账。
- Workflow 传输：需求事件 SSE 只承载实时通知；运行事实通过 Workflow 快照与只追加事件
  API 对账，不与对话 WebSocket 混用。
- 每日滚动日志（最多 7 个文件）：`<git_root>/.raccoon-node/logs/`
- 内置受管 Pi extension：`<git_root>/.raccoon-node/extensions/`
- OpenSpec 规格：确认结果是 `ChangeSpec(intent, acceptance_scenarios,
  explicit_constraints, non_goals)`。行为场景只保存 Given/When/Then 用户可观察结果；具体
  文件、函数、API、组件、CSS 和命令只能在用户明确指定并带原消息 ID、原文摘录时进入
  `explicit_constraints`。Planner 的 `DesignNotes` 是带仓库证据的可修订技术设计，不参与
  机械验收。
- WorkflowRun v5：WorkPlan 只包含行为切片、场景引用、依赖、非约束范围线索和验证目标，
  不存在 Stage、Review、Fix、Merge 或 Recovery 伪任务。执行器在单个 integration worktree
  上默认串行完成低档实现、低档修复和高档修复；全部切片完成后才执行最终验证和审核。
- 仓库原生验证：启动时确定性生成 `RepositoryValidationCatalog` 并在 base HEAD 建立基线；
  最终只把“基线通过、最终失败”视为硬回归。命令缺失或无法建立基线标记为 unverified，
  既有失败未恶化只展示。Agent 自创 grep、字符串计数等只属于 observation，不能成为 gate。
- 代码审核：`raccoon:parallel-review:v5` 对 base commit 到当前受管 worktree 的完整 diff
  自适应选择 1–3 个独立内存 `AgentSession`。正确性只看 ChangeSpec、固定 diff 和中性验证；
  质量/测试与安全完全盲审，不接收任务标题、DesignNotes、实现总结或其他角度结论。子 Agent
  只开放仓库只读工具和 `submit_review_result`，不启动额外 Pi CLI、不写子 session 文件。
  finding 使用 P0–P3；仅 P0/P1 阻断，后端按角度、类别、路径和位置归并，固定生成总体摘要。
  非法结构在同一子会话中按精确 JSON 路径修正两次，再失败只重试该角度一次；技术失败进入
  `paused_technical`，不触发代码修复或 Rescue。
- 增量复审：首次审核按完整 diff 选择角度；集成修复后只复审正确性、仍有 P0/P1 的角度和
  本次修复实际改动新触发的安全角度。审核传输状态使用 `transport_status`，不得与业务通过混淆。
- 外部恢复：语义实现链和唯一一次高档集成修复仍不收敛时，每个 WorkflowRun 仅允许一次
  全新高档 Rescue。Rescue 只接收 ChangeSpec、最终 diff、未关闭 P0/P1、验证差异和精简失败链；
  原生 gate 首次失败时只向同一 Rescue session 反馈一次短证据。数据库、协议、Pi 进程、审核
  持久化等技术失败暂停并可恢复，不消耗 Rescue。
- 受管任务运行时：含 `bash` 的角色加载 `raccoon:task-runtime:v3` extension。模型仍可
  直接执行 `git status`、`git diff`、`git log` 等只读命令；extension 在 `tool_call`
  阶段拦截 Git 写操作并返回明确错误。实现类任务在模型运行前后额外核对当前 worktree
  的 HEAD、分支 ref 和 staged diff 指纹，异常变化按技术失败处理。规划、任务与恢复结果
  通过 `raccoon:workflow-output:v3` 结构化工具提交，不再依赖文本 JSON repair。
- Pi 原生 compaction：不修改 `autoCompactionEnabled`。项目聊天、需求分析、任务和 Review
  父会话记录压缩原因、结果与估算节省量；压缩事件刷新空闲计时。估算值标记
  `usageKnown=false`，不计入供应商计费 token，也不把摘要正文复制到 SQLite。
- 运行看门狗：token 预算仅告警并写入 trace，不终止任务。普通 Agent 连续 600 秒、
  审核内存子 Agent 连续 300 秒没有有效活动才判定空闲超时；总运行时长和轮次不设硬上限。
- 任务 worktree：`<git_root>/.raccoon-node/worktrees/`
- 附件：`<git_root>/.raccoon-node/attachments/`
- 本地打包输出：`build/bin/raccoon`（Windows 为 `raccoon.exe`）

## 命令

- `npm run dev`：启动极简网页启动 TUI，并由后端管理 Vite dev server；完整日志写入 `.raccoon-node/logs/`。
- `npm run build`：构建前端并生成嵌入静态资源的 release 单二进制。
- `npm run check`：前端类型检查、测试、构建和 Rust 检查。
- `cargo package --locked` / `cargo publish --dry-run --locked`：crate 发布前检查。
- `pre-commit run --all-files`：完整提交前检查。

## 检查

- 前端：Prettier、TypeScript、生产构建。
- Rust：`cargo fmt -- --check`、`cargo check --all`、`cargo clippy --all-targets --all-features --tests --benches -- -D warnings`、`cargo test`。
- 提交时绝对不能跳过 pre-commit，禁止 `git commit --no-verify`。

## 约束

- 只允许在有效 Git 仓库中运行；显式 `--project-root` 必须就是 Git 根目录。
- 根页面直接加载固定 `current` 项目画布，不提供 start 画布或项目增删。
- `.raccoon-node/` 必须加入仓库 `.gitignore`，且运行数据不得逃逸该目录。
- 所有 LLM、模型列表、模型选择和后续 Agent 能力必须基于 Pi Agent RPC。
- 需求澄清和确认草案必须通过内置受管 Pi extension 的结构化工具提交；不得恢复
  文本 JSON 提取。
- 执行规划、任务结果与恢复指导必须通过受管工作流工具提交；协议缺失、重复提交或类型
  不匹配均作为技术失败，不回退文本 JSON。Git 写限制由受管 extension 和状态复核实现，
  不写入任务 Prompt。Planner 和工作项结果结构不合法时，只在原 session 中发送一次短
  schema 纠正；仍不合法才形成技术失败。
- 业务状态只以 SQLite v5 为准；`workflow_runs`、`workflow_work_items`、attempt、validation、
  checkpoint、finding 和只追加 event 是执行事实，不再存在 `workflow_stages`。Pi session 只
  保存完整模型历史，不承担 FIFO、租约、worktree 或恢复状态。检测到 v4 数据库时先按字节
  归档再创建全新 v5；运行时不保留旧 Workflow 执行器或协议兼容分支。
- 项目聊天始终持有父 Pi session。`/需求生成` 只在用户提交非空补充说明后执行：
  完整父问答通过 Pi RPC `clone` 派生 child session；无完整上下文时创建独立需求。
  `ProjectChat.pi_session_file` 与 `Requirement.pi_session_file` 分别保存主/分支引用，
  均不序列化到前端。
- 父、子 session 独立演进。需求确认或放弃后恢复父聊天，child 中的需求消息和草案
  永不写回父 session。活动需求期间普通聊天发送和重置返回 `409`。
- 同一项目的需求分析保持单飞，繁忙时拒绝新操作，不增加消息队列、steer 或
  follow-up。session 清理只删除 `.raccoon-node/sessions/` 中未被主聊天、需求或任务
  业务状态引用的 JSONL 文件。
- 对话事件协议固定为 `agent.event`、`snapshot.changed`、`session.error` 和
  `notice.append`。`agent.event` 携带原始 Pi Agent 事件，前端统一归一展示。
- 禁止执行 `pi --list-models` 等一次性命令作为运行时数据来源。
- 禁止直接读写 Pi Agent 的 auth/settings 文件；本项目只保存自身三档模型设置。
- Pi 登录由用户在设置工作台内嵌的固定暗色 Web 终端中手动执行 `/login`；该会话
  复用项目终端协议但不展开普通终端节点，应用不得自动输入登录命令或编辑
  `models.json`。
- Pi 工作目录只能是 Git 根目录或 `.raccoon-node/worktrees/` 中的受管 worktree。
- 清理操作只能删除 `.raccoon-node/` 内受管资源，禁止删除用户仓库。
- 前端不处理 Git 密码、token、SSH key。
- 不提交 `build/`、`target/`、`node_modules/`、`frontend/dist/`、
  `.raccoon-node/`、`*.tsbuildinfo`。

## 分发

- crates.io：发布根 crate `raccoon-node`；内部实现是同一 crate 的模块，不再发布 `raccoon-*` 子 crate。
- npm：主包 `raccoon-node`，按平台可选依赖分发二进制。
- GitHub Release：提供 darwin-arm64、linux-x64、win32-x64 压缩包与 SHA256。
- 当前不支持 Intel Mac、Linux ARM64、musl 或 Windows ARM64。
