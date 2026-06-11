# 技术栈

NodeOrchestrator：基于节点的 Pi Agent 编排器，每个节点是一个独立 Pi RPC 进程，通过数据流边连接。

## 后端

| 技术 | 用途 |
|------|------|
| Axum | Web 框架（REST / WebSocket） |
| Tokio | 异步运行时，子进程监管，节点间 channel 通信 |
| Serde + serde_json | JSONL / YAML 序列化 |
| SQLx | 数据库访问，编译期检查 SQL |
| SQLite | Graph、Node、Edge、Session 状态持久化 |
| git2 / 命令行 | Git worktree 管理（per Node 代码隔离） |
| tokio::sync::{mpsc, broadcast} | 节点间内存数据流（Edge 传输） |
| tower-http | 静态文件服务、CORS、trace |
| anyhow + thiserror | 错误处理 |
| tracing + tracing-subscriber | 结构化日志 |
| dirs | 跨平台资源路径解析 |

## 前端

| 技术 | 用途 |
|------|------|
| React 19 + TypeScript | UI 框架 |
| Vite | 构建工具 |
| React Flow | 节点图编辑器（核心画布） |
| shadcn/ui + Tailwind CSS | UI 组件 |
| Zustand | 全局状态管理 |
| Monaco Editor | 节点内代码/Diff 展示 |

## 通信

| 协议 | 用途 |
|------|------|
| stdin/stdout JSONL | Pi Agent RPC（per Node） |
| WebSocket | 前端 ↔ 后端实时状态同步 |
| REST | Graph CRUD、Node 配置、手动触发 |
| tokio channel | 节点间内存数据流（Edge 传输） |

## 运行时

| 组件 | 说明 |
|------|------|
| Node Runtime | 每个 Node 对应一个 `pi --mode rpc` 子进程，独立生命周期 |
| Edge Dispatcher | 基于 tokio channel 的数据流调度，支持条件边和广播 |
| Graph Engine | 事件驱动执行引擎，拓扑排序 + 数据到达触发 |
| Upgrade Controller | 节点失败重试 → 指导 → set_model 升级 |
| Worktree Manager | per Node Git worktree 分配与回收 |

## 数据持久化

SQLite 单库，核心表：
- `graphs` — 工作流定义
- `nodes` — 节点配置与状态
- `edges` — 边定义与条件
- `sessions` — Pi RPC 子进程元数据
- `executions` — 运行历史与产物
- `upgrades` — 升级记录
