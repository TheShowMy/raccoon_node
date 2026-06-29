# raccoon_node

面向本地 Git 仓库的节点画布。后端使用 Rust、Axum 与 Tokio，前端使用 React、
Vite 与 React Flow；所有 LLM 和模型能力均通过持久 Pi Agent RPC 子进程提供。

## 功能

- 当前 Git 仓库即项目，启动后直接进入项目画布
- 项目问答：基于当前仓库内容维护连续的只读问答会话
- 需求澄清：分析需求、提出澄清问题并生成确认草案
- 自动执行：确认后按 FIFO 规划和执行任务 DAG，支持失败恢复与重启恢复
- 模型设置：配置低、中、高三档模型和思考等级
- 本地 TUI：查看日志、打开浏览器、修改设置、重启或退出服务

## 安装

运行时需要系统已安装 Git 和 Pi Agent。首次启动检测不到 Pi Agent 时，交互式向导可
确认执行官方 npm 安装命令。

### npm

需要 Node.js 20 或更高版本。

```sh
npm install --global raccoon-node
```

### crates.io

需要 Rust 1.86 或更高版本；crate 已包含前端产物，安装时不需要 Node.js。

```sh
cargo install raccoon-node
```

### GitHub Release

也可从 [GitHub Releases](https://github.com/TheShowMy/raccoon_node/releases) 下载
对应平台压缩包并校验 SHA256。当前提供：

- macOS Apple Silicon（darwin-arm64）
- Linux x64 GNU（linux-x64）
- Windows x64（win32-x64）

三种安装方式提供相同命令：`raccoon`。

## 使用

在 Git 仓库根目录或任意子目录运行：

```sh
raccoon
```

程序向上定位最近的 Git 根目录；非 Git 目录会直接报错，且不会创建运行数据。
也可显式指定根目录，但该路径必须直接指向 Git 根：

```sh
raccoon --project-root /path/to/repository
```

常用选项：

```text
--port <PORT>           本次运行监听端口
--host <HOST>           127.0.0.1 或 0.0.0.0
--no-open               不自动打开浏览器
--no-tui                使用纯文本日志
--project-root <PATH>   直接指定 Git 根目录
```

默认监听 `127.0.0.1:3001`。TTY 环境默认启动 TUI 并打开浏览器；非 TTY 或
`--no-tui` 不输出终端控制码，也不会自动打开浏览器。监听 `0.0.0.0` 没有 API
鉴权，交互式设置会要求二次确认，CLI 显式传入时会输出风险警告。

TUI 快捷键：

- `o`：打开浏览器
- `s`：设置主题、监听地址、端口和三档模型
- `r`：重启服务
- `q`：优雅退出

配置优先级为 CLI 参数 > `.raccoon-node/config.toml` > 默认值。

## 项目数据

Raccoon 不复制或删除用户仓库。运行数据固定保存在 Git 根目录：

```text
<git_root>/
├── .git/ 或 .git
└── .raccoon-node/
    ├── config.toml
    ├── app.json
    ├── data.db
    ├── sessions/
    ├── worktrees/
    └── attachments/
```

首次初始化会幂等地将 `.raccoon-node/` 追加到仓库 `.gitignore`。旧版 `data/`、
`build/data/` 和 `pi-sessions/` 不迁移、不读取，也不会删除。

Pi Agent 的工作目录只能是当前 Git 根目录或 `.raccoon-node/worktrees/` 内的受管
worktree；会话首行记录的 `cwd` 必须与预期目录一致。

## 从源码开发

需要 Node.js 20、Rust 1.86、Git 和 Pi Agent。

```sh
npm ci
npm --prefix frontend ci
npm run dev
```

生产构建：

```sh
npm run build
./build/bin/raccoon
```

Windows PowerShell：

```powershell
npm run build
.\build\bin\raccoon.exe
```

构建结果是嵌入前端静态资源的单二进制，不需要外置 `public` 或数据目录。

## 验证

- 基础检查：`npm run check`
- 完整检查：`pre-commit run --all-files`

## API

后端 API 前缀为 `/api`，固定项目 ID 为 `current`。详见
[docs/api/README.md](docs/api/README.md)。

## 许可证

[MIT](LICENSE)
