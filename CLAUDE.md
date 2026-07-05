# 项目 Agent 约束

> **同步要求**：`AGENTS.md` 与 `CLAUDE.md` 必须同步修改，内容保持一致。

## 项目

raccoon_node：Rust + React Flow 的本地 Git 仓库节点画布。当前运行目录中的 Git
仓库就是唯一项目，固定项目 ID 为 `current`，不提供项目列表、克隆或删除功能。
当前功能包括项目问答、需求澄清、FIFO 任务 DAG 执行、失败/重启恢复、Web 三档模型设置和极简网页启动 TUI。
LLM 与模型能力必须通过 Pi Agent RPC：后端通过 `pi-rpc-rs` 封装持久 `pi --mode rpc` 子进程并使用 stdin/stdout JSONL 通信。

## 必读文档

- 架构与硬约束：[docs/spec/TECH_STACK.md](docs/spec/TECH_STACK.md)
- 使用、CLI/TUI、安装和分发：[README.md](README.md)
- API、项目问答、需求和任务流：[docs/api/README.md](docs/api/README.md)

以下情况编码前必须查看相关文档：

- 新增模块、调整目录或改构建脚本。
- 引入、移除或升级依赖。
- 修改 Rust/Axum/Tokio/API、SQLite、根 crate 内部模块、`.raccoon-node/` 资源或恢复逻辑。
- 修改 React/Vite/React Flow/节点 UI。
- 修改项目问答、需求澄清、FIFO 队列、任务 DAG 或恢复流程。
- 修改 LLM、模型设置、Pi Agent RPC 或 Agent 能力。
- 修改 Git 根解析、`.raccoon-node/` 资源或 worktree 规则。
- 修改 CLI、TUI、单二进制嵌入或 npm/crates.io/GitHub Release 发布流程。
- 修改 pre-commit 或验证流程。

## 常用命令

- 开发：`npm run dev`
- 打包：`npm run build`（生成 `build/bin/raccoon`，Windows 为 `raccoon.exe`）
- 基础检查：`npm run check`
- 版本一致性检查：`npm run check:versions`
- 完整检查：`pre-commit run --all-files`

## Windows 兼容

- Windows 是一等支持平台；修改路径、子进程、Git、构建或开发脚本时，必须同时验证 Windows 与 macOS/Linux 行为。
- 路径必须使用 `Path` / `PathBuf` 和平台 API 处理，禁止手工拼接 `/`、`\` 或假设盘符格式。
- Windows `canonicalize` 可能返回 `\\?\C:\...`；路径传入 `pi.cmd`、Git、GH 或其他外部进程前，必须转换为普通本地磁盘绝对路径。
- 当前仅支持 Windows 本地磁盘路径；UNC 路径（`\\server\share`、`\\?\UNC\...`）必须明确拒绝，禁止静默回退到其他目录。
- Pi Agent 子进程的 `current_dir` 必须是当前 Git 根目录或
  `.raccoon-node/worktrees/` 内的受管 worktree；新会话完成后必须校验
  session JSONL 首行 `cwd` 与预期目录一致。
- Windows `.cmd` / `.bat` 不能按原生可执行文件假设处理；Node 构建脚本优先使用 `process.execPath + npm_execpath`，确需 shell 时必须显式使用 `cmd.exe` 并避免字符串拼接。
- npm、pre-commit 和构建命令禁止依赖 Bash 专用语法；文档中的 Windows 示例必须使用 PowerShell 语法。
- Windows 路径相关测试至少覆盖普通盘符、`\\?\` 扩展路径、UNC 拒绝、保留文件名和超长路径组件。

## 硬约束

- 只允许在有效 Git 仓库中运行；`--project-root` 必须直接指向 Git 根目录。
- 项目 ID 固定为 `current`，项目源码就是 Git 根目录，不复制或移动用户仓库。
- 运行数据只允许位于 `<git_root>/.raccoon-node/`；配置、SQLite 主存储、会话、
  日志、受管插件、worktree 和附件分别位于 `config.toml`、`data.db`、
  `sessions/`、`logs/`、`extensions/`、`worktrees/`、`attachments/`。
- `.raccoon-node/data.db` 是唯一业务主存储；Pi session 保存完整模型上下文，不承担
  FIFO、DAG、worktree 或恢复状态；SQLite 保存业务投影与事务状态。
- `.raccoon-node/extensions/` 只允许存放程序内置的受管 Pi extension；
  项目 Pi RPC 必须隔离用户全局和项目插件。
- `.raccoon-node/logs/` 中的文件日志按日滚动，最多保留 7 个文件；禁止记录
  prompt、澄清答案、token 或完整工具输出。
- 生产构建是嵌入前端静态资源的 `build/bin/raccoon` 单二进制，不依赖外置 `public` 或数据目录。
- Rust 发布对象是根 crate `raccoon-node`；内部实现位于 `src/` 模块中，不再发布或依赖单独的 `raccoon-*` 子 crate。
- 所有 LLM、模型列表、模型选择和 Agent 能力必须基于 Pi Agent RPC，低层 RPC 依赖 `pi-rpc-rs`，禁止绕过 `pi --mode rpc`。
- 禁止执行 `pi --list-models` 等一次性命令作为运行时数据来源。
- 禁止直接读写 Pi Agent 的 auth/settings 文件；本项目只保存自身三档模型设置。
- 删除和清理只能作用于 `.raccoon-node/` 内的受管资源，绝不能删除 Git 根目录或用户源码。
- 前端不处理 Git 密码、token、SSH key。
- 不提交 `build/`、`target/`、`node_modules/`、`frontend/dist/`、
  `.raccoon-node/`、`*.tsbuildinfo`。
- 提交代码绝对不能跳过 pre-commit，禁止 `git commit --no-verify`。
- pre-commit 失败必须修复根因，不允许注释、删除或屏蔽钩子绕过。
- 每次执行 `git commit` 或 `git push` 前，必须得到用户的明确要求或确认；未获明确授权前绝不主动提交。
