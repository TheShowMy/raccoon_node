# 技术栈

## 栈

- 后端：Rust 2021、Axum、Tokio、tower-http、serde/JSON、chrono、tracing。
- 前端：React、TypeScript、Vite、React Flow（`@xyflow/react`）、lucide-react、Tailwind CSS。
- 存储：本地 JSON，开发期 `data/app.json`，生产期 `build/data/app.json`。
- Git：后端调用系统 `git clone`；认证依赖本机 Git 环境。
- LLM：只通过 Pi Agent RPC，后端启动持久 `pi --mode rpc` 子进程，stdin/stdout JSONL 通信。

## 目录

- 后端入口：`src/main.rs`
- 前端入口：`frontend/src/main.tsx`
- 前端样式：`frontend/src/styles.css`，使用 Tailwind CSS，保留少量 React Flow 全局覆盖。
- 构建脚本：`scripts/build.mjs`
- 项目仓库：`<data_root>/projects/<project_id>/repo`
- Pi Agent RPC 会话目录：`<data_root>/pi-sessions`
- 打包输出：`build/`

## 命令

- `npm run dev`：启动后端和 Vite。
- `npm run build`：生成 `build/bin`、`build/public`、`build/data`。
- `npm run check`：前端类型检查 + Rust 测试。
- `pre-commit run --all-files`：完整提交前检查。

## 检查

- 前端：Prettier、TypeScript、生产构建。
- Rust：`cargo fmt -- --check`、`cargo check --all`、`cargo clippy --all-targets --all-features --tests --benches -- -D warnings`、`cargo test`。
- 提交时绝对不能跳过 pre-commit，禁止 `git commit --no-verify`。

## 约束

- start 画布使用 React Flow 节点和按需连线；项目 item 使用 `project-list` 子流程节点。
- 所有 LLM、模型列表、模型选择和后续 Agent 能力必须基于 Pi Agent RPC。
- 禁止执行 `pi --list-models` 等一次性命令作为运行时数据来源。
- 禁止直接读写 Pi Agent 的 auth/settings 文件；本项目只保存自身三档模型设置。
- 删除项目只能删除当前数据目录内资源。
- 前端不处理 Git 密码、token、SSH key。
- 不提交 `build/`、`target/`、`node_modules/`、`frontend/dist/`、`data/`、`*.tsbuildinfo`。
