# raccoon_node

面向本地 Git 仓库的节点画布。后端使用 Rust、Axum 与 Tokio，前端使用 React、
Vite 与 React Flow；所有 LLM 和模型能力均通过持久 Pi Agent RPC 子进程提供。

## 功能

- 当前 Git 仓库即项目，启动后直接进入项目画布
- 项目问答：基于当前仓库内容维护连续的只读问答会话
- 需求澄清：分析需求、提出澄清问题并生成确认草案
- 自动执行：确认后按 FIFO 规划和执行任务 DAG，支持失败恢复与重启恢复
- 会话查看：安全渲染 GFM、预览引用文档，并按需查看需求、问答和任务的原始 JSONL
- Web 设置中心：配置基础运行参数、低/中/高三档模型和思考等级
- 极简 TUI：自动打开网页，按钮下方实时显示后端日志；开发模式还会并列显示 Vite 日志

## 安装

运行时需要系统已安装 Git 和 Pi Agent。首次启动检测不到 Pi Agent 时，交互式向导可
确认执行官方 npm 安装命令。

### npm

需要 Node.js 22 或更高版本。

```sh
npm install --global raccoon-node
```

### GitHub Release

也可从 [GitHub Releases](https://github.com/TheShowMy/raccoon_node/releases) 下载
对应平台压缩包并校验 SHA256。当前提供：

- macOS Apple Silicon（darwin-arm64）
- Linux x64 GNU（linux-x64）
- Windows x64（win32-x64）

### crates.io

也可通过 Cargo 安装根 crate；发布包携带预构建前端资源，安装时不需要 Node/npm：

```sh
cargo install raccoon-node --locked
```

npm、crates.io 与 GitHub Release 三种安装方式提供相同命令：`raccoon`。

## 更新

### npm

```sh
npm install --global raccoon-node@latest
```

### crates.io

```sh
cargo install raccoon-node --locked --force
```

### GitHub Release

从 [GitHub Releases](https://github.com/TheShowMy/raccoon_node/releases) 下载
最新对应平台压缩包，覆盖现有二进制即可。

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
鉴权，交互式设置会要求二次确认，CLI 显式传入时会输出风险警告；此时 TUI 顶部会显示
每次启动随机生成的 Web 终端密钥，前端启用项目终端或 Pi 登录终端前需要输入密钥，
验证通过后 12 小时内有效。

每次启动都会检查发布方式。仓库未配置 `origin` 时直接使用本地合并；配置
`origin` 后，程序会检查 Git 远程访问、GitHub CLI 登录、仓库写入权限、默认分支和
Merge commit 设置。检查失败会在画布左上角的“PR 发布”节点显示处理方式，并阻止
任务执行；处理完成后需重启应用重新检查。仓库规则仍可能在实际推送或合并时执行
额外校验。

TUI 顶部仅显示“打开网页”按钮，支持鼠标直接点击；按钮下方显示日志面板。发布构建
显示单一后端日志面板，`npm run dev` 开发模式则左右平分为“后端日志”和“Vite 日志”。
以下按键作为不展示的兜底：

- `Enter` / `o`：打开浏览器
- `q` / `Ctrl+C`：优雅退出

配置优先级为 CLI 参数 > `.raccoon-node/config.toml` > 默认值。如果本次启动带有
`--host` 或 `--port`，Web 设置中心会同时显示保存值、CLI 覆盖值和实际生效值。

点击项目画布左上角的“设置”节点会向左上展开大尺寸设置工作台。基础页完整展示
双栏设置，无需内部滚动；主题点击后立即切换并持久化，提交模式、监听地址和端口
使用显式保存，监听变更会通过 Web 重启服务。选择 `0.0.0.0` 时必须在节点内确认
无鉴权 API 暴露风险。

模型页在配置区右侧内嵌固定暗色的 Pi 登录终端，不会展开普通项目终端。用户手动
输入 `/login` 后再重载 Pi RPC 模型列表；Raccoon 不读写 Pi 的认证文件或
`models.json`。模型列表为空或任一低/中/高档未保存时，画布会通过两步聚光引导
用户依次点击“设置”和“模型设置”；用户可永久跳过。进入模型页后继续按
“启动终端、登录、重载、配置、保存”显示配置引导。

## 项目数据

Raccoon 不复制或删除用户仓库。运行数据固定保存在 Git 根目录：

```text
<git_root>/
├── .git/ 或 .git
└── .raccoon-node/
    ├── config.toml
    ├── data.db
    ├── sessions/
    ├── logs/
    ├── extensions/
    ├── worktrees/
    └── attachments/
```

`data.db` 是唯一业务主存储；Pi session 保存完整模型上下文，日志按日滚动并保留
最近 7 个文件，`extensions/` 仅存放程序内置的受管 Pi extension。

首次初始化会幂等地将 `.raccoon-node/` 追加到仓库 `.gitignore`。

Pi Agent 的工作目录只能是当前 Git 根目录或 `.raccoon-node/worktrees/` 内的受管
worktree；会话首行记录的 `cwd` 必须与预期目录一致。

## 从源码开发

需要 Node.js 22、Rust 1.96、Git 和 Pi Agent。

`Cargo.toml` 中的 `rust-version` 声明项目承诺支持的最低 Rust 版本；
`rust-toolchain.toml` 固定在本目录实际使用的工具链。两者当前均为 1.96。

```sh
npm ci
npm --prefix frontend ci
```

### 启动开发服务

开发模式下前端启用 Vite HMR 热更新，修改前端代码即时生效，无需重新构建。

**在当前仓库测试（项目源码自身作为测试仓库）：**

```sh
npm run dev
```

**指定外部仓库测试（--project-root 指向要测试的 Git 仓库）：**

macOS / Linux：

```sh
RACCOON_PROJECT_ROOT=/path/to/test-repo npm run dev
```

Windows PowerShell：

```powershell
$env:RACCOON_PROJECT_ROOT = "C:\path\to\test-repo"
npm run dev
```

启动后浏览器自动打开 `http://localhost:5173`，前端 HMR 生效，API 请求自动代理到
后端 `http://127.0.0.1:3001`。如果不设 `RACCOON_PROJECT_ROOT`，默认使用当前项目
根目录。开发模式默认启动极简 TUI，后端管理 Vite dev server。退出 TUI 会同时关闭
Vite；从 Web 修改端口并重启后，后端和 Vite 会一起重启，Vite proxy 会指向新的
后端端口。完整日志继续写入 `.raccoon-node/logs/`。

### 生产构建

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
