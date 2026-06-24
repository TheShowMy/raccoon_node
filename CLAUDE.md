# 项目 Agent 约束

> **同步要求**：`AGENTS.md` 与 `CLAUDE.md` 必须同步修改，内容保持一致。

## 项目

raccoon_node：Rust + React Flow 的本地节点画布项目。当前包含 start 画布、Git 项目添加、克隆和删除。
LLM 与模型能力必须通过 Pi Agent RPC：后端启动持久 `pi --mode rpc` 子进程并使用 stdin/stdout JSONL 通信。

## 必读文档

- 技术栈：[docs/spec/TECH_STACK.md](docs/spec/TECH_STACK.md)

以下情况编码前必须查看技术栈文档：

- 新增模块、调整目录或改构建脚本。
- 引入、移除或升级依赖。
- 修改 Rust/Axum/Tokio/API/JSON 存储。
- 修改 React/Vite/React Flow/节点 UI。
- 修改 LLM、模型设置、Pi Agent RPC 或 Agent 能力。
- 修改 Git clone、项目删除、`data/` 资源规则。
- 修改 pre-commit 或验证流程。

## 常用命令

- 开发：`npm run dev`
- 打包：`npm run build`
- 基础检查：`npm run check`
- 完整检查：`pre-commit run --all-files`

## Windows 兼容

- Windows 是一等支持平台；修改路径、子进程、Git、构建或开发脚本时，必须同时验证 Windows 与 macOS/Linux 行为。
- 路径必须使用 `Path` / `PathBuf` 和平台 API 处理，禁止手工拼接 `/`、`\` 或假设盘符格式。
- Windows `canonicalize` 可能返回 `\\?\C:\...`；路径传入 `pi.cmd`、Git、GH 或其他外部进程前，必须转换为普通本地磁盘绝对路径。
- 当前仅支持 Windows 本地磁盘路径；UNC 路径（`\\server\share`、`\\?\UNC\...`）必须明确拒绝，禁止静默回退到其他目录。
- Pi Agent 子进程的 `current_dir` 必须是对应项目 repo 或任务 worktree；新会话完成后必须校验 session JSONL 首行 `cwd` 与预期目录一致。
- Windows `.cmd` / `.bat` 不能按原生可执行文件假设处理；Node 构建脚本优先使用 `process.execPath + npm_execpath`，确需 shell 时必须显式使用 `cmd.exe` 并避免字符串拼接。
- npm、pre-commit 和构建命令禁止依赖 Bash 专用语法；文档中的 Windows 示例必须使用 PowerShell 语法。
- Windows 路径相关测试至少覆盖普通盘符、`\\?\` 扩展路径、UNC 拒绝、保留文件名和超长路径组件。

## 硬约束

- 项目资源只允许位于当前数据目录：`<data_root>/projects/<project_id>/repo`。
- 所有 LLM 相关功能必须基于 Pi Agent RPC，禁止绕过 `pi --mode rpc`。
- 禁止执行 `pi --list-models` 等一次性命令作为运行时数据来源。
- 禁止直接读写 Pi Agent 的 auth/settings 文件。
- 删除项目只能删除当前数据目录内的项目资源。
- 前端不处理 Git 密码、token、SSH key。
- 不提交 `build/`、`target/`、`node_modules/`、`frontend/dist/`、`data/`、`*.tsbuildinfo`。
- 提交代码绝对不能跳过 pre-commit，禁止 `git commit --no-verify`。
- pre-commit 失败必须修复根因，不允许注释、删除或屏蔽钩子绕过。
- 未经用户明确要求，不自动执行 `git commit` 或 `git push`。
