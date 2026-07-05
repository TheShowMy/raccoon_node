# raccoon_node API

后端默认监听 `http://127.0.0.1:3001`，API 前缀为 `/api`。应用只有当前 Git
仓库一个项目，项目 ID 固定为 `current`。

0.2.0 已删除 `/api/start`、`POST /api/projects` 和
`DELETE /api/projects/{id}`。除当前项目入口外，其余项目 API 暂时保留 `{id}`
路径；调用方必须传 `current`。

## 通用错误

```json
{
  "message": "错误描述"
}
```

- `400 Bad Request`：请求参数或路径非法
- `404 Not Found`：资源不存在
- `500 Internal Server Error`：内部错误

## 当前项目

### 获取当前项目

`GET /api/project/current`

```json
{
  "project": {
    "id": "current",
    "name": "repository",
    "git_url": "https://github.com/user/repository.git",
    "local_path": "/absolute/path/to/repository",
    "created_at": "2026-06-29T10:00:00Z",
    "updated_at": "2026-06-29T10:00:00Z"
  },
  "theme": "dark",
  "publication_readiness": {
    "mode": "pull_request",
    "ready": true,
    "summary": "PR 发布前置检查通过。",
    "issues": [],
    "notes": [
      "origin：https://github.com/user/repository.git",
      "实际账号仍需满足仓库分支规则，并具有推送、创建 PR 和合并权限。"
    ]
  }
}
```

仓库没有 `remote.origin.url` 时，`git_url` 为空字符串。
`publication_readiness.mode` 为 `local`，且不要求安装或登录 GitHub CLI。有远程且
`ready` 为 `false` 时，确认需求、重试执行规划、恢复任务组和启动恢复调度均会被
阻止；修复 `issues` 后保存运行设置会刷新检查结果。

### 获取项目画布

`GET /api/projects/current/canvas`

默认响应不携带任何需求的 `execution_plan`。打开某个 DAG 时使用
`GET /api/projects/current/canvas?dag_requirement_id={requirement_id}`，仅所选需求返回
轻量执行计划；任务 trace、审核历史、session/worktree、恢复和发布详情按空值返回。

返回 `ProjectCanvasResponse`：

```json
{
  "project": { "id": "current" },
  "active_requirement": null,
  "queued_requirements": [],
  "completed_requirements": []
}
```

### 搜索仓库文件

`GET /api/projects/current/files?search=keyword`

返回可引用的 UTF-8 文本文件列表。`.git/`、`.raccoon-node/`、`node_modules/`、
`target/` 和 `dist/` 不会被枚举或读取。

### Git 状态与基础操作

- `GET /api/projects/current/git/status`
- `GET /api/projects/current/git/diff?path={relative_path}&area=staged|unstaged`
- `POST /api/projects/current/git/actions`

状态接口返回当前分支、HEAD、upstream、ahead/behind、本地分支、origin 可用性、
写操作阻止原因，以及文件级 staged/unstaged 状态。diff 只接受当前 Git 变更中的
仓库相对路径；二进制文件不返回内容，文本输出最多 1 MiB。

动作接口只接受以下固定请求，不支持透传任意 Git 命令：

```json
{ "type": "stage", "paths": ["src/main.rs"] }
{ "type": "unstage", "paths": ["src/main.rs"] }
{ "type": "commit", "message": "feat: add node", "confirmed": true }
{ "type": "fetch" }
{ "type": "pull" }
{ "type": "push", "confirmed": true }
{ "type": "switch_branch", "branch": "main" }
{ "type": "create_branch", "branch": "feature/example" }
```

Commit 和 Push 必须显式传入 `confirmed: true`。Pull 固定使用 fast-forward-only；
首次 Push 会推送到 origin 并建立 upstream。切换或创建分支、Pull 要求工作区干净。
只要项目存在待执行、规划中、执行中或失败待恢复的需求，所有 Git 写操作返回
`409 Conflict`，状态与 diff 仍可读取。

### 上传和读取附件

- `POST /api/projects/current/attachments`
- `GET /api/projects/current/attachments/{file}`

上传请求：

```json
{
  "name": "example.png",
  "mime_type": "image/png",
  "data_base64": "..."
}
```

仅支持 png、jpeg、gif 和 webp，单个附件最大 5MB。附件固定写入
`.raccoon-node/attachments/`，路径逃逸和符号链接逃逸会被拒绝。

## 项目问答

### 获取或重置会话

- `GET /api/projects/current/chat`
- `DELETE /api/projects/current/chat`

每个项目只有一个连续会话。重置会清空问答上下文；正在回答时不能重置。

```json
{
  "project_id": "current",
  "messages": [],
  "running": false,
  "error": null,
  "updated_at": "2026-06-29T10:00:00Z"
}
```

### 发送消息

`POST /api/projects/current/chat/messages`

```json
{
  "message": "这个项目如何启动？",
  "references": [{ "path": "README.md" }],
  "images": []
}
```

项目问答以当前 Git 根目录为只读上下文，使用中档模型。它不会创建需求、修改需求
状态或进入执行队列。

### 问答事件流

`GET /api/projects/current/chat/events`

事件类型：

- `project_chat_started`
- `project_chat_completed`
- `project_chat_failed`
- `pi_event`
- `serialization_failed`

SSE 只提供实时通知；重连后通过问答查询接口获取持久化状态。

## 需求

### 创建需求

`POST /api/projects/current/requirements`

```json
{
  "message": "用户原始需求描述",
  "references": [],
  "images": []
}
```

返回 `ProjectCanvasResponse`。

### 获取对话和追加消息

- `GET /api/requirements/{id}/conversation`
- `POST /api/requirements/{id}/messages`

追加消息请求与创建需求相同，返回 `ProjectCanvasResponse`。

### 提交澄清答案

`POST /api/requirements/{id}/clarifications`

```json
[
  {
    "clarification_id": "q1",
    "selected_options": ["option-a"],
    "custom_text": null
  }
]
```

### 确认、取消和删除

- `POST /api/requirements/{id}/confirm`
- `POST /api/requirements/{id}/cancel`
- `DELETE /api/requirements/{id}`

确认后需求进入当前项目 FIFO 队列，后端自动生成执行 DAG 并开始执行。失败需求会
暂停后续队列，避免后续需求越过失败项。

### 重试规划和任务组恢复

- `POST /api/requirements/{id}/retry-analysis`：在澄清会话中断后创建新 session，
  并使用已保存业务上下文重试分析
- `POST /api/requirements/{id}/plan`：重试失败的执行规划
- `POST /api/requirements/{id}/tasks/{task_id}/recover`：恢复顶层任务组内的技术失败节点
- `GET /api/requirements/{id}/tasks/{task_id}`：按需读取完整任务详情、关联审核和依赖
- `GET /api/requirements/{id}/tasks/{task_id}/session`：读取任务对应的 Pi Agent
  session 内容，按消息角色解析文本、思考和结构化工具调用；工具结果通过
  `toolCallId` 与调用关联，编辑工具可返回 `diff`

执行计划中的实现任务通过 `review_history` 返回结构化审核轮次。旧任务没有历史时返回
空数组；仅保存结果摘要，不包含思考内容或完整工具输出。

任务详情前端会分别读取实现任务和关联 `review_summary` 任务的会话，按时间合并并
标注“代码节点”或“审核汇总”。审核 Sub Agent 会话不进入该时间线。

最终合并审核根据仓库是否配置 `origin` 选择发布方式：有 `origin` 时通过 PR 合并，
没有 `origin` 时直接合并到项目根工作区当前分支。纯本地合并成功后
`pull_request_url` 为 `null`，`merged_into` 返回实际合入分支。

```json
{
  "review_history": [
    {
      "round": 1,
      "implementation_attempt": 1,
      "implementation_summary": "完成实现",
      "status": "approved",
      "started_at": "2026-06-30T10:00:00Z",
      "completed_at": "2026-06-30T10:02:00Z",
      "reviews": [
        {
          "task_id": "review-sub-task-1-1",
          "angle": "正确性与边界",
          "status": "approved",
          "summary": "检查通过",
          "failure_reason": null,
          "completed_at": "2026-06-30T10:01:00Z"
        }
      ],
      "summary_conclusion": "approved",
      "summary": "审核通过",
      "failure_reason": null
    }
  ]
}
```

### 需求事件流

`GET /api/requirements/{id}/events`

运行中 DAG 可传 `include_pi_events=false` 仅订阅状态事件；未传参数时保持完整事件流。

```json
{
  "requirement_id": "requirement-id",
  "task_id": "task-id",
  "event": "execution_task_started",
  "message": "开始执行任务：任务标题",
  "pi_type": null,
  "payload": null
}
```

常见事件：

- 分析：`coordinator_started`、`coordinator_progress`、
  `coordinator_time_warning`、`pi_event`
- 结果：`clarifications_ready`、`draft_ready`、`analysis_failed`、
  `analysis_cancelled`
- 规划：`execution_planning_started`、`execution_plan_ready`、
  `execution_plan_failed`
- 执行：`execution_started`、`execution_task_started`、
  `execution_task_completed`、`execution_task_failed`、`execution_task_retrying`、
  `execution_task_guided`、`execution_completed`、`execution_failed`
- 降级：`serialization_failed`

SSE 不作为状态存储；重连后应重新获取项目画布。

## 基础设置

### 获取设置

`GET /api/settings/basic`

```json
{
  "theme": "dark",
  "host": "127.0.0.1",
  "port": 3001,
  "host_overridden": false,
  "port_overridden": false,
  "effective_host": "127.0.0.1",
  "effective_port": 3001,
  "restart_required": false,
  "commit_mode": "pull_request"
}
```

`host_overridden` / `port_overridden` 表示本次运行值被 CLI 覆盖。此时保存配置不会
改变实际监听值；`effective_host` / `effective_port` 始终表示当前实际值。

### 保存设置

`PUT /api/settings/basic`

```json
{
  "theme": "light",
  "host": "0.0.0.0",
  "port": 4321,
  "commit_mode": "local",
  "confirmed_external": true
}
```

主题可通过仅提交 `{ "theme": "light" }` 独立持久化，不触发发布条件检查。提交
模式显式保存后生效，只有模式实际变化时才重新检查发布条件。host 仅支持
`127.0.0.1` / `0.0.0.0`；保存 `0.0.0.0` 必须传
`confirmed_external: true`，否则返回 `400`。端口范围为 `1..=65535`。若实际
监听值需要变化，响应中的 `restart_required` 为 `true`。

### 重启服务

`POST /api/system/restart`

空闲时返回 `202`：

```json
{
  "accepted": true,
  "next_url": "http://127.0.0.1:4321"
}
```

存在运行中的项目问答、需求分析、排队或执行任务时返回 `409`。TUI 与
`--no-tui` 模式均会响应此生命周期命令。

## 模型设置

### 获取设置

`GET /api/settings/models`

```json
{
  "models": [
    {
      "id": "provider/model",
      "name": "Model Name",
      "provider": "provider",
      "reasoning": true
    }
  ],
  "settings": {},
  "rpc_status": "ready",
  "rpc_error": null
}
```

### 保存设置

`PUT /api/settings/models`

```json
{
  "low": { "model_id": "provider/model-a", "thinking_level": "low" },
  "medium": { "model_id": "provider/model-b", "thinking_level": "medium" },
  "high": { "model_id": "provider/model-c", "thinking_level": "high" }
}
```

模型列表和设置校验均通过持久 Pi Agent RPC 完成，不读取 Pi Agent 的 auth 或
settings 文件，也不读写 `models.json`。

### 重载 Pi 模型

`POST /api/settings/models/reload`

空闲时关闭并重建全局及项目 Pi RPC 客户端，成功后返回与
`GET /api/settings/models` 相同的响应。存在运行任务时返回 `409`，RPC
重建失败时返回经过清理的错误。

登录由设置工作台内嵌终端通过现有终端 API 启动
`pi --no-session --no-extensions --no-context-files`，用户必须手动输入
`/login`；该会话不会展开普通项目终端节点，设置节点收起或项目切换时会清理。
服务端不代填命令、不管理凭据。模型列表为空或任一三档设置缺失时，前端在每次
应用启动时保持正常画布，通过聚光引导用户依次点击设置节点和模型页签。完成或
跳过后在浏览器本地永久隐藏，不新增服务端持久化字段。

## 持久化与路径边界

- 唯一业务主存储：`.raccoon-node/data.db`
- 旧 JSON 迁移备份：`.raccoon-node/app.json.migrated`
- Pi 完整模型会话：`.raccoon-node/sessions/`
- 每日滚动日志（最多 7 个文件）：`.raccoon-node/logs/`
- 内置受管 Pi extension：`.raccoon-node/extensions/`
- 任务 worktree：`.raccoon-node/worktrees/`
- 附件：`.raccoon-node/attachments/`

旧 `.raccoon-node/app.json` 仅在首次迁移时读取；成功导入 SQLite 后原子改名，
后续启动不再读取。SQLite 保存业务消息、澄清轮次、DAG、恢复状态与 token usage
摘要，Pi session 保存完整 thinking 和工具输入输出。

Pi 会话记录的 `cwd` 必须等于当前 Git 根目录或受管 worktree。所有清理操作只能
作用于 `.raccoon-node/`，不会删除用户仓库。

主要类型定义在 `src/models/mod.rs` 与 `frontend/src/types/api.ts`，两端必须保持同步。
