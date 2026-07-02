# raccoon-node

面向本地 Git 仓库的节点画布。

## 安装

需要 Node.js 22 或更高版本，以及系统已安装的 Git 和 Pi Agent。

```sh
npm install --global raccoon-node
```

首次启动检测不到 Pi Agent 时，交互式向导会确认执行官方 npm 安装命令。

## 更新

```sh
npm install --global raccoon-node@latest
```

## 使用

在 Git 仓库根目录或任意子目录运行：

```sh
raccoon
```

程序会向上定位最近的 Git 根目录；非 Git 目录会直接报错，且不会创建运行数据。

也可显式指定根目录，但该路径必须直接指向 Git 根：

```sh
raccoon --project-root /path/to/repository
```

## 平台支持

npm 包会根据当前平台自动安装对应的二进制可选依赖：

- macOS Apple Silicon (`raccoon-node-darwin-arm64`)
- Linux x64 (`raccoon-node-linux-x64`)
- Windows x64 (`raccoon-node-windows-x64`)

当前不支持 Intel Mac、Linux ARM64、musl 或 Windows ARM64。

## 更多安装方式

也可从 [GitHub Releases](https://github.com/TheShowMy/raccoon_node/releases) 下载对应平台压缩包并校验 SHA256。

## 功能

- 当前 Git 仓库即项目，启动后直接进入项目画布
- 项目问答：基于当前仓库内容维护连续的只读问答会话
- 需求澄清：分析需求、提出澄清问题并生成确认草案
- 自动执行：确认后按 FIFO 规划和执行任务 DAG，支持失败恢复与重启恢复
- 模型设置：配置低、中、高三档模型和思考等级
- 本地 TUI：查看日志、打开浏览器、修改设置、重启或退出服务

## 仓库

<https://github.com/TheShowMy/raccoon_node>
