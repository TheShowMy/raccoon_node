# raccoon_node

本地节点画布应用，使用 Rust + Axum + Tokio 构建后端，React + Vite + React Flow 构建前端。

## 功能

- 启动画布展示项目列表与操作入口
- 添加、克隆与删除 Git 项目
- 需求澄清 Coordinator：通过 Pi Agent RPC 分析需求、提出澄清问题、生成确认草案
- 模型设置：配置低/中/高三档模型的 model_id 与思考层级

## 技术栈

- 后端：Rust、Axum、Tokio、serde_json
- 前端：React 19、Vite 7、React Flow 12、Tailwind CSS 4
- LLM/模型能力：通过持久 `pi --mode rpc` 子进程使用 stdin/stdout JSONL 通信

## 快速开始

需要 Node.js >= 20 与 Rust 1.86（参见 `rust-toolchain.toml`）。

```sh
npm install
npm run dev
```

后端默认监听 `http://127.0.0.1:3001`，前端开发服务器默认使用 `http://127.0.0.1:5173`。

## 构建

```sh
npm run build
```

输出目录为 `build/`，包含二进制、前端静态资源与默认数据文件。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `RACCOON_HOST` | 后端绑定地址 | `127.0.0.1` |
| `RACCOON_PORT` | 后端端口 | `3001` |
| `RACCOON_DATA_FILE` | 数据文件路径 | `./data/app.json` |
| `RACCOON_PUBLIC_DIR` | 前端静态资源目录 | `./frontend/dist` |

## 目录结构

```
raccoon_node/
├── src/                  # Rust 后端
│   ├── main.rs           # 入口
│   ├── api/              # HTTP 路由与处理器
│   ├── models.rs         # 数据模型
│   ├── store.rs          # JSON 存储
│   ├── pi_rpc.rs         # Pi Agent RPC 客户端
│   ├── requirement_analysis.rs  # 需求分析逻辑
│   ├── error.rs          # 错误类型
│   └── utils.rs          # 工具函数
├── frontend/src/         # React 前端
├── docs/api/             # API 文档
├── prompts/              # LLM prompt 模板
└── scripts/build.mjs     # 构建脚本
```

## API 文档

参见 [docs/api/README.md](docs/api/README.md)。

## 开发约束

- 项目资源只允许位于当前数据目录：`<data_root>/projects/<project_id>/repo`。
- 所有 LLM 相关功能必须基于 Pi Agent RPC，禁止绕过 `pi --mode rpc`。
- 禁止直接读写 Pi Agent 的 auth/settings 文件。
- 删除项目只能删除当前数据目录内的项目资源。
- 提交代码前必须运行 `pre-commit run --all-files`。

## 常用命令

- 开发：`npm run dev`
- 打包：`npm run build`
- 基础检查：`npm run check`
- 完整检查：`pre-commit run --all-files`
