# CLAUDE.md

> **同步提示**：修改本文件时，请同步修改 [AGENTS.md](AGENTS.md)。

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

NodeOrchestrator：基于节点的 Pi Agent 编排器。每个节点是一个独立 Pi RPC 子进程，节点通过数据流边连接形成可执行图。图结构在执行过程中由 LLM 动态生成。

## 启动项目

npm run dev

## 文档

- 架构核心：[docs/ARCHITECTURE_CORE.md](docs/ARCHITECTURE_CORE.md)
- 技术栈：[docs/spec/TECH_STACK.md](docs/spec/TECH_STACK.md)

> **何时读取技术栈文档**：初始化项目、引入新依赖、技术选型变更前，先读 `docs/spec/TECH_STACK.md` 确认选型。

## 做什么

- 用 Rust 写编排器后端，不碰 Pi Agent 本身
- **所有与 Pi Agent 的交互必须通过持久 RPC 子进程进行**：`pi --mode rpc`，stdin/stdout JSONL 通信
- **每个任务组内的执行节点共享同一个 Git worktree**，组间代码隔离；worktree 基于 confirmation 后同步的最新主分支创建
- 默认用低价模型，质量循环耗尽时触发指导/升级（循环 → coordinator 指导 → 提升强度档位 → 用户决策）
- 确定性验收：测试、lint、build、schema 验证通过才算完成
- Agent 身份用 YAML Profile 定义（模型、工具白名单、扩展、预算）
- 节点状态机驱动执行：Idle → Ready → Running → [Completed / Failed / WaitingForUser]
- 任务组（Group）是独立执行边界，组内循环不扩散到外层图
- 需求工程阶段（requirement → clarification → confirmation）用户深度参与
- 执行工程阶段全自动，质量循环耗尽才触发指导/升级
- PR 阶段（create_pr → pr_review → merge_pr）任务组完成后自动创建 PR，LLM 自动审核并合并
- 前端三栏布局：左（任务图列表）、中（节点画布，单节点不可拖动）、右（执行详情）

## 不做什么

- 不要把 Pi Agent 移植成 Rust
- 不要用 gRPC，只走 stdin/stdout JSONL
- 不要用 Docker 隔离代码，只用 Git worktree
- 不要让 LLM 自我评估任务完成
- 不要把浏览器能力默认注入所有 coding worker
- 不要把高价模型设为默认 worker
- 不要把项目私有数据硬编码进共享 skill
- **禁止直接执行 `pi --list-models` 等一次性命令获取数据** — 必须通过 RPC 子进程调用对应命令（如 `get_available_models`）
- 不要把任务组内部的固定循环模式做成可配置（coder→reviewer→build 回环是固定模式）

## 路径注意事项

打包后可执行文件位置变化，所有资源路径（扩展、前端、数据库等）需同时兼容 `cargo run`（项目根目录）和独立运行（可执行文件同级目录）两种情况。

## 绝对规则

- **所有新增代码必须通过 pre-commit 规则检查。** 提交代码时禁止绕过或忽略 pre-commit 钩子（如 `git commit --no-verify`）。如果 pre-commit 失败，必须先修复问题再提交。
- **测试截图必须保存到 `/tmp` 目录，不得提交到仓库。** 每次开始新的 UI 测试任务前，先清空 `/tmp` 中的旧截图（`rm -f /tmp/nodeorch-test-*.png`），避免文件无限膨胀。
- **web 测试使用 chrome-devtools mcp。**
- **测试启动的后台服务（`cargo run`、`npm run dev`）必须在测试结束后关闭。** 禁止留下无头进程占用端口 确认无残留，如有清理。
- **用户未明确说"提交推送代码"时，禁止自动执行 `git commit` 或 `git push`。** 只有在用户明确使用"提交推送"等指令时，才执行提交和推送操作。
