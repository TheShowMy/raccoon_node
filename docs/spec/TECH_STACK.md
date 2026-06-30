# 技术栈

## 栈

- 后端：Rust 2024（MSRV 1.96）、Axum、Tokio、serde/JSON、rusqlite、chrono、tracing。
- 前端：React、TypeScript、Vite、React Flow（`@xyflow/react`）、lucide-react、Tailwind CSS。
- CLI/TUI：clap、ratatui、crossterm。
- 静态资源：Vite 产物通过 rust-embed 嵌入 `raccoon` 单二进制。
- 存储：`<git_root>/.raccoon-node/data.db` 是唯一业务主存储；旧 `app.json`
  首次成功导入后原子改名为 `app.json.migrated`。
- Git：当前 Git 仓库即唯一项目；后端使用系统 Git 管理任务 worktree。
- LLM：只通过 Pi Agent RPC，后端启动持久 `pi --mode rpc` 子进程，stdin/stdout JSONL 通信。

## 目录

- 后端入口：`src/main.rs`
- 前端入口：`frontend/src/main.tsx`
- 前端样式：`frontend/src/styles.css`，使用 Tailwind CSS，保留少量 React Flow 全局覆盖。
- 构建脚本：`scripts/build.mjs`
- 项目仓库：当前 Git 根目录，固定项目 ID `current`
- 项目配置：`<git_root>/.raccoon-node/config.toml`
- 应用数据：`<git_root>/.raccoon-node/data.db`
- 旧数据迁移备份：`<git_root>/.raccoon-node/app.json.migrated`
- Pi Agent RPC 完整模型上下文：`<git_root>/.raccoon-node/sessions/`
- 每日滚动日志（最多 7 个文件）：`<git_root>/.raccoon-node/logs/`
- 内置受管 Pi extension：`<git_root>/.raccoon-node/extensions/`
- 任务 worktree：`<git_root>/.raccoon-node/worktrees/`
- 附件：`<git_root>/.raccoon-node/attachments/`
- 本地打包输出：`build/bin/raccoon`（Windows 为 `raccoon.exe`）

## 命令

- `npm run dev`：启动后端 TUI，并由后端管理 Vite dev server；TUI 分别显示后端日志和 Vite 日志。
- `npm run build`：构建前端并生成嵌入静态资源的 release 单二进制。
- `npm run check`：前端类型检查、测试、构建和 Rust 检查。
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
- 业务状态只以 SQLite 为准；Pi session 只保存完整模型历史，不承担 FIFO、DAG、
  worktree 或恢复状态。
- 禁止执行 `pi --list-models` 等一次性命令作为运行时数据来源。
- 禁止直接读写 Pi Agent 的 auth/settings 文件；本项目只保存自身三档模型设置。
- Pi 工作目录只能是 Git 根目录或 `.raccoon-node/worktrees/` 中的受管 worktree。
- 清理操作只能删除 `.raccoon-node/` 内受管资源，禁止删除用户仓库。
- 前端不处理 Git 密码、token、SSH key。
- 不提交 `build/`、`target/`、`node_modules/`、`frontend/dist/`、
  `.raccoon-node/`、`data/`、`*.tsbuildinfo`。

## 分发

- npm：主包 `raccoon-node`，按平台可选依赖分发二进制。
- crates.io：crate `raccoon-node`，安装后的命令为 `raccoon`。
- GitHub Release：提供 darwin-arm64、linux-x64、win32-x64 压缩包与 SHA256。
- 当前不支持 Intel Mac、Linux ARM64、musl 或 Windows ARM64。
