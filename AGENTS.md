# AGENTS.md

> **同步要求**：修改 `AGENTS.md` 必须同步修改 `CLAUDE.md`；修改 `CLAUDE.md` 必须同步修改 `AGENTS.md`。两者内容必须保持一致。

## 项目

raccoon_node：Rust + React Flow 的本地节点画布项目。当前包含 start 画布、Git 项目添加、克隆和删除。

## 必读文档

- 技术栈：[docs/spec/TECH_STACK.md](docs/spec/TECH_STACK.md)

以下情况编码前必须查看技术栈文档：

- 新增模块、调整目录或改构建脚本。
- 引入、移除或升级依赖。
- 修改 Rust/Axum/Tokio/API/JSON 存储。
- 修改 React/Vite/React Flow/节点 UI。
- 修改 Git clone、项目删除、`data/` 资源规则。
- 修改 pre-commit 或验证流程。

## 常用命令

- 开发：`npm run dev`
- 打包：`npm run build`
- 基础检查：`npm run check`
- 完整检查：`pre-commit run --all-files`

## 硬约束

- 项目资源只允许位于当前数据目录：`<data_root>/projects/<project_id>/repo`。
- 删除项目只能删除当前数据目录内的项目资源。
- 前端不处理 Git 密码、token、SSH key。
- 不提交 `build/`、`target/`、`node_modules/`、`frontend/dist/`、`data/`、`*.tsbuildinfo`。
- 提交代码绝对不能跳过 pre-commit，禁止 `git commit --no-verify`。
- pre-commit 失败必须修复根因，不允许注释、删除或屏蔽钩子绕过。
- 未经用户明确要求，不自动执行 `git commit` 或 `git push`。
