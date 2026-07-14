# raccoon_node

面向单个本地 Git 仓库的自动化 Agent 工作台。Rust/Axum 后端管理 SQLite、Git worktree、Pi Agent RPC
与发布流程；React Flow + Astryx 前端提供项目聊天、需求、文件、Git、终端、设置和 Token 六个工作台。

## 核心流程

1. 项目聊天维护一个连续只读 Pi session。
2. `/需求生成` 克隆聊天上下文并形成行为型 ChangeSpec。
3. Planner 生成可执行 WorkPlan；合法同层切片使用最多三个隔离 worktree 并行实现。
4. 调度器运行仓库原生验证，并对完整 diff 运行风险自适应隔离审核。
5. 语义修复仍失败时最多使用一次高级 Rescue；技术故障暂停并保留恢复点。
6. 审核通过后本地 fast-forward，或创建并自动合并 GitHub PR/GitLab MR；成功后清理受管资源。

Agent 的 Git 写操作与工作区越界由受管 Pi extension 拦截，不依赖 Prompt。Token 阈值只告警；持续有
有效活动的任务不会因总时长或轮次被中断，Pi 原生 compaction 保持用户配置。

## 安装

运行时需要 Git、Pi Agent，以及以下任一分发方式：

```sh
npm install --global raccoon-node
# 或
cargo install raccoon-node --locked
```

GitHub Releases 提供 macOS Apple Silicon、Linux x64 GNU 与 Windows x64 包。

## 使用

在 Git 仓库内运行：

```sh
raccoon
```

也可明确指定 Git 根：

```sh
raccoon --project-root /path/to/repository
```

常用选项：

```text
--port <PORT>
--host <127.0.0.1|0.0.0.0>
--no-open
--no-tui
--project-root <PATH>
```

配置优先级为 CLI > `.raccoon-node/config.toml` > 默认值。监听 `0.0.0.0` 时普通 API 没有鉴权，
终端功能额外要求本次启动密钥。

## 项目数据

Raccoon 不复制或删除用户仓库。所有运行数据位于：

```text
<git_root>/.raccoon-node/
├── config.toml
├── data.db
├── sessions/
├── logs/
├── extensions/
├── worktrees/
└── attachments/
```

`data.db` 使用当前构建的 schema 指纹，不执行历史迁移。结构不匹配时应用拒绝启动并要求用户手动删除
`.raccoon-node`；不会自动归档、删除或改写旧数据。

## 开发

需要 Node.js 22、Rust 1.96、Git 和 Pi Agent：

```sh
npm ci
npm --prefix frontend ci
npm run dev
```

指定外部测试仓库：

```sh
RACCOON_PROJECT_ROOT=/path/to/test-repo npm run dev
```

Windows PowerShell：

```powershell
$env:RACCOON_PROJECT_ROOT = "C:\path\to\test-repo"
npm run dev
```

生产构建：

```sh
npm run build
./build/bin/raccoon
```

验证：

```sh
npm run check
pre-commit run --all-files
```

架构约束见 [docs/spec/TECH_STACK.md](docs/spec/TECH_STACK.md)，API 见
[docs/api/README.md](docs/api/README.md)。

## License

[MIT](LICENSE)
