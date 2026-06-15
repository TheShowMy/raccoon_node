# 技术栈

## 栈

- 后端：Rust 2021、Axum、Tokio、tower-http、serde/JSON、chrono、tracing。
- 前端：React、TypeScript、Vite、React Flow（`@xyflow/react`）、lucide-react、普通 CSS。
- 存储：本地 JSON，开发期 `data/app.json`，生产期 `build/data/app.json`。
- Git：后端调用系统 `git clone`；认证依赖本机 Git 环境。

## 目录

- 后端入口：`src/main.rs`
- 前端入口：`frontend/src/main.tsx`
- 前端样式：`frontend/src/styles.css`
- 构建脚本：`scripts/build.mjs`
- 项目仓库：`<data_root>/projects/<project_id>/repo`
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

- start 画布当前不连线。
- 删除项目只能删除当前数据目录内资源。
- 前端不处理 Git 密码、token、SSH key。
- 不提交 `build/`、`target/`、`node_modules/`、`frontend/dist/`、`data/`、`*.tsbuildinfo`。
