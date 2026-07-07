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
- 后端模块：根 crate `raccoon-node` 的内部模块位于 `src/api/`、`src/store/`、`src/pi/`、`src/requirement/` 等目录，不再依赖单独发布的内部 crates。
- 前端入口：`frontend/src/main.tsx`
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
- 任务传输：需求进入执行阶段后继续使用现有 SSE，不与对话 WebSocket 混用。
- 每日滚动日志（最多 7 个文件）：`<git_root>/.raccoon-node/logs/`
- 内置受管 Pi extension：`<git_root>/.raccoon-node/extensions/`
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
- 需求澄清、确认草案和项目问答生成的需求说明必须通过内置受管 Pi extension 的
  结构化工具提交；不得恢复文本 JSON 提取。
- 业务状态只以 SQLite 为准；Pi session 只保存完整模型历史，不承担 FIFO、DAG、
  worktree 或恢复状态。
- 项目问答与需求澄清使用独立 Pi session；同一项目的需求分析保持单飞，繁忙时
  拒绝新操作，不增加消息队列、steer 或 follow-up。
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
