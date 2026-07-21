# 项目 Agent 约束

## 项目

Raccoon Node v2：单仓库、本地优先、完全节点化的需求到代码自动交付产品。
当前处于**前端假数据验收阶段**：`frontend/` 用 mock 数据实现完整交互与像素视觉语言；
`backend/` 仅为可编译桩，真实后端在前端验收通过后实施。

## 必读文档

需求与契约的唯一事实源（编码前必须查看相关章节）：

- 产品需求：[docs/rewrite/01-product-requirements.md](docs/rewrite/01-product-requirements.md)
- 前端需求：[docs/rewrite/02-frontend-requirements.md](docs/rewrite/02-frontend-requirements.md)
- 后端需求：[docs/rewrite/03-backend-requirements.md](docs/rewrite/03-backend-requirements.md)
- 技术决策：[docs/rewrite/04-architecture-decisions.md](docs/rewrite/04-architecture-decisions.md)

## 常用命令

- 开发：`npm run dev`
- 检查：`npm run check`（tsc + prettier + vitest）
- 提交检查：`pre-commit run --all-files`
- 后端桩：`cargo check`

## 硬约束

- 设计系统是像素风格：`@pxlkit/core` + `@pxlkit/ui-kit`（仅 MIT 包）为基线，
  缺失组件按同风格自研；pxlkit 图标包（source-available）未署名前不使用。
- 位图字体只用于标题/标签/强调；正文、代码、Diff 必须高可读字体。
  Press Start 2P 无 CJK 字形，`--px-font-pixel` 已带中文回退链；
  应用位图字体的文本字号不得低于 10px。
- 基础组件库不承担顶层导航、全局通知、业务状态覆盖或危险操作确认；
  GrayDango 是唯一全局通知入口。
- 假数据层位于 `frontend/src/api/mock/`；业务组件只依赖 `src/api/`、`src/events/`
  和领域 selector，不直接拼接 URL 或按事件名散落分支。
- 引入、移除或升级第三方依赖时，必须同步更新 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；
  新增依赖先确认许可证与项目 MIT 兼容。
- 每次执行 `git commit` 或 `git push` 前，必须得到用户的明确要求或确认；
  未获明确授权前绝不主动提交。提交代码绝对不能跳过 pre-commit。
