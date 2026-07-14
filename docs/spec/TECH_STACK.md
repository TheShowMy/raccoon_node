# 技术架构

## 运行边界

- Raccoon 只服务启动目录对应的一个 Git 仓库，不维护项目列表，也不克隆或删除用户仓库。
- 运行数据只写入 `<git_root>/.raccoon-node/`；用户源码与 Git 根目录不能成为清理目标。
- 后端是 Rust 2024、Axum、Tokio 与 SQLite，前端是 React、TypeScript、Vite、React Flow 和 Astryx。
- 所有模型、会话和 Agent 能力只通过持久 `pi --mode rpc` 子进程提供。
- 发布构建将前端静态资源嵌入 `build/bin/raccoon` 单二进制。

## 数据与会话

- `.raccoon-node/data.db` 是业务事实源；Pi JSONL 只保存模型上下文，不承担队列或恢复状态。
- 新数据库事务化创建并保存 schema 指纹。指纹缺失或不匹配时拒绝启动，并提示用户手动删除
  `.raccoon-node`；程序不迁移、归档或自动删除旧数据。
- 对话实时流使用 `agent.event`、`snapshot.changed`、`session.error`、`notice.append`；重连后以
  SQLite 快照对账。
- 日志按日滚动并最多保留 7 个文件，禁止写入 Prompt、凭据、完整工具输出或 token 正文。

## 需求与工作流

- 项目聊天保持一个父 Pi session；`/需求生成` 克隆完整父上下文形成独立需求 session。
- ChangeSpec 只保存 intent、Given/When/Then 行为场景、带用户原文证据的显式约束和 non-goals。
- Planner 只生成行为切片、依赖、范围提示、验证目标与可修订 DesignNotes。
- 同层任务仅在 2–3 项属于同一非空 group 且范围两两不重叠时并行；每项使用独立分支、
  worktree 和 Pi session，结果按计划顺序汇入 integration。
- Agent 只能修改分配的 worktree。受管 extension 拦截 Git 写操作和工作区越界；integration
  前后指纹是最终防线，确定性技术故障直接暂停且不调用额外模型。
- 仓库原生验证比较 base 与最终结果；只有新增回归是机械阻断，自创 grep 等只作为 observation。
- 最终审核按风险运行 1–3 个隔离 Agent。正确性可见 ChangeSpec，质量和安全只看 diff 与中性证据；
  仅 P0/P1 阻断。
- 常规实现与集成修复仍不收敛时，WorkflowRun 最多使用一次全新高级 Rescue；技术故障不消耗 Rescue。

## 发布与恢复

- `local` 使用安全 fast-forward；`pull_request` 推送受管分支并通过 GitHub PR 或 GitLab MR 在远端合并。
- 发布状态持久化且可幂等恢复。远端合并是 PR/MR 模式的权威结果，本地主分支无法安全同步只产生告警。
- 成功完成前清理受管 worktree 和分支；暂停、阻塞、取消保留现场。
- Token 阈值只产生观测告警。看门狗只在持续无有效活动时终止；Pi compaction 尊重用户设置。

## 受管协议

- `raccoon:requirements`
- `raccoon:task-runtime`
- `raccoon:workflow-output`
- `raccoon:parallel-review`

内部协议使用稳定名称，不提供旧协议回退。GitLab REST `/api/v4`、Git porcelain v2 和包 semver
属于外部协议版本，不受此约束。

## 目录与验证

- 后端：`src/`
- 前端：`frontend/src/`
- 受管 extensions：`src/pi/assets/`
- 当前 API：`docs/api/README.md`
- 使用与分发：`README.md`

常用验证：

```sh
npm run check
cargo clippy --all-targets --all-features --tests --benches -- -D warnings
git diff --check
pre-commit run --all-files
```

Windows 是一等平台。路径使用 `Path`/`PathBuf`，拒绝 UNC，外部程序前去除 `\\?\` 本地盘前缀；
子进程禁止依赖 Bash 拼接，`.cmd`/`.bat` 必须按 Windows 规则启动。
