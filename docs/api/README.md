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
  "theme": "dark"
}
```

仓库没有 `remote.origin.url` 时，`git_url` 为空字符串。

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
- `GET /api/requirements/{id}/tasks/{task_id}/session`：读取任务对应的 Pi Agent session 内容，按消息角色解析为可读的文本/思考/工具调用列表

执行计划中的实现任务通过 `review_history` 返回结构化审核轮次。旧任务没有历史时返回
空数组；仅保存结果摘要，不包含思考内容或完整工具输出。

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
  "port": 3001,
  "port_overridden": false
}
```

`port_overridden` 表示本次运行端口由 CLI `--port` 覆盖。

### 保存设置

`PUT /api/settings/basic`

```json
{
  "theme": "light",
  "port": 4321
}
```

主题保存后立即生效。端口只保存到 `.raccoon-node/config.toml`，下次不带
`--port` 参数启动时生效。端口范围为 `1..=65535`。

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
settings 文件。

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

主要类型定义在 `src/models.rs` 与 `frontend/src/types/api.ts`，两端必须保持同步。
