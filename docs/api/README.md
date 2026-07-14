# Raccoon API

默认地址为 `http://127.0.0.1:3001/api`。应用只有当前 Git 仓库一个项目，因此项目级接口均为单例路由。

错误响应：

```json
{ "message": "错误描述" }
```

## 项目与画布

- `GET /project`：项目信息、主题和发布 readiness。
- `GET /canvas?workflow_requirement_id=`：需求队列、Token 汇总和按需展开的 WorkflowRun。
- `GET /files?search=`：搜索可引用文本文件。
- `GET /files/tree?path=`：读取目录的直接子项。
- `GET /files/content?path=`：预览不超过 64 KiB 的 UTF-8 文本。
- `POST /attachments`、`GET /attachments/{file}`：上传与读取图片附件。

文件、附件和树接口拒绝 `.git`、`.raccoon-node`、依赖/构建目录、路径逃逸和符号链接逃逸。
一次 Prompt 最多 8 个文件、3 张图片；大文本转为 path-only，图片保持 5 MiB 单项、10 MiB 总量上限。

## 项目聊天

- `GET /chat`、`DELETE /chat`
- `POST /chat/messages`
- `GET /chat/events`（WebSocket）
- `POST /chat/requirements`
- `POST /chat/abort`

发送消息：

```json
{
  "message": "这个项目如何启动？",
  "references": [{ "path": "README.md" }],
  "images": []
}
```

`POST /chat/requirements` 使用相同请求体，并返回 `requirement_id` 与来源。活动需求期间普通聊天发送和
重置返回 `409`。WebSocket 只推送增量事件，SQLite 快照仍是重连后的事实源。

## 需求

- `GET /requirements/{id}/conversation`
- `GET /requirements/{id}/conversation/events`（WebSocket）
- `POST /requirements/{id}/messages`
- `POST /requirements/{id}/clarifications`
- `POST /requirements/{id}/retry-analysis`
- `POST /requirements/{id}/confirm`
- `POST /requirements/{id}/workflow-run`
- `POST /requirements/{id}/cancel`
- `DELETE /requirements/{id}`

澄清提交只接受：

```json
{
  "prompt_id": "prompt-id",
  "revision": 2,
  "answers": [
    {
      "clarification_id": "q1",
      "selected_options": ["option-a"],
      "custom_text": null
    }
  ]
}
```

确认只接受 `{ "prompt_id": "...", "revision": 2 }`。非法 ChangeSpec 在需求 session 内最多修正一次，
不得启动 Planner。

## WorkflowRun

- `GET /workflow-runs/{run_id}`
- `GET /workflow-runs/{run_id}/events?after=&limit=`
- `POST /workflow-runs/{run_id}/resume`
- `POST /workflow-runs/{run_id}/restart-clean`

状态为 `planning / running / validating / reviewing / fixing / rescuing / publishing /
paused_technical / completed / blocked / cancelled`。`resume` 只接受技术暂停；workspace violation 使用
`restart-clean` 从干净 HEAD 建立唯一 replacement，不移动旧现场。

事件接口返回：

```json
{
  "events": [],
  "next_after": null
}
```

Workflow 快照包含 work items、attempts、validations、checkpoints、findings、publication、受管 workspace
状态和实际调用数。绝对 worktree 路径、Prompt 正文与凭据不会序列化。

## Git 与终端

- `GET /git/status`
- `GET /git/diff?path=&area=staged|unstaged`
- `POST /git/actions`
- `GET|POST /terminals`
- `DELETE /terminals/{terminal_id}`
- `GET /terminals/{terminal_id}/ws`
- `GET|PUT /terminal-commands`
- `GET|POST /terminal-access`

Git actions 只接受 stage、unstage、commit、fetch、pull、push、switch_branch、create_branch；commit/push
必须传 `confirmed: true`，调度占用仓库时写操作返回 `409`。监听 `0.0.0.0` 时终端需要启动密钥。

## 设置与生命周期

- `GET|PUT /settings/basic`
- `GET|PUT /settings/models`
- `POST /settings/models/reload`
- `POST /system/restart`

`commit_mode` 为 `local` 或 `pull_request`。保存主题不触发发布检查；监听地址或端口变化通过
`restart_required` 提示。前端不读取或保存 Pi/Git 凭据。
