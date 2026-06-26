# raccoon_node API 文档

后端默认监听 `http://127.0.0.1:3001`，API 前缀为 `/api`。

## 通用错误格式

```json
{
  "message": "错误描述"
}
```

HTTP 状态码：
- `400` Bad Request：请求参数非法
- `404` Not Found：资源不存在
- `500` Internal Server Error：服务器内部错误

---

## 1. 获取启动数据

`GET /api/start`

返回所有项目、需求与设置摘要。

**响应：**

```json
{
  "projects": [],
  "requirements": [],
  "settings_summary": { "title": "设置", "description": "..." },
  "model_summary": { "title": "模型设置", "description": "..." },
  "model_settings": { ... }
}
```

---

## 2. 创建项目

`POST /api/projects`

**请求体：**

```json
{
  "name": "项目名称",
  "git_url": "https://github.com/user/repo.git"
}
```

**响应：** `Project` 对象

```json
{
  "id": "project-name-1234567890",
  "name": "项目名称",
  "git_url": "https://github.com/user/repo.git",
  "local_path": ".../projects/project-name-1234567890/repo",
  "created_at": "2026-06-18T10:00:00Z",
  "updated_at": "2026-06-18T10:00:00Z"
}
```

---

## 3. 删除项目

`DELETE /api/projects/{id}`

删除项目记录与本地克隆目录。

**响应：** `204 No Content`

---

## 4. 获取项目画布

`GET /api/projects/{id}/canvas`

返回项目详情与按状态分组的需求列表。

**响应：**

```json
{
  "project": { ... },
  "active_requirement": { ... },
  "queued_requirements": [],
  "completed_requirements": []
}
```

---

## 5. 创建需求

`POST /api/projects/{id}/requirements`

**请求体：**

```json
{
  "message": "用户原始需求描述"
}
```

**响应：** `ProjectCanvasResponse`

---

## 6. 追加需求消息

`POST /api/requirements/{id}/messages`

**请求体：**

```json
{
  "message": "补充说明"
}
```

**响应：** `ProjectCanvasResponse`

---

## 7. 提交澄清答案

`POST /api/requirements/{id}/clarifications`

**请求体：** `ClarificationAnswerRequest[]`

```json
[
  {
    "clarification_id": "q1",
    "selected_options": ["option-a"],
    "custom_text": null
  }
]
```

**响应：** `ProjectCanvasResponse`

---

## 8. 需求事件流（SSE）

`GET /api/requirements/{id}/events`

Server-Sent Events，推送 Coordinator、自动规划和执行进度。事件数据格式：

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

`task_id`、`pi_type` 和 `payload` 仅在对应事件有值时返回。

**事件类型：**

- 需求分析：`coordinator_started`、`coordinator_progress`、
  `coordinator_time_warning`、`pi_event`
- 分析结果：`clarifications_ready`、`draft_ready`、`analysis_failed`、
  `analysis_cancelled`
- 自动规划：`execution_planning_started`、`execution_plan_ready`、
  `execution_plan_failed`
- 自动执行：`execution_started`、`execution_task_started`、
  `execution_task_completed`、`execution_task_retrying`、
  `execution_task_guided`、`execution_completed`、`execution_failed`
- `serialization_failed`（内部序列化失败时的降级事件）

SSE 只负责实时通知，不作为状态存储。客户端收到非瞬时事件或重新连接后，应通过
`GET /api/projects/{id}/canvas` 获取持久化的最新状态。

---

## 9. 确认需求

`POST /api/requirements/{id}/confirm`

将 `DraftReady` 状态的需求确认并自动加入所属项目的执行队列。

- 每个项目独立按入队顺序执行，项目内同一时间只运行一个需求，后入队需求不会抢占。
- 队首需求由后端自动生成执行 DAG，并在规划成功后自动开始执行。
- 单个需求的 DAG 节点仍可按依赖关系并行；项目级串行约束针对需求。
- 规划或执行最终失败时，该项目队列暂停，避免后续需求越过失败项。

**响应：** `ProjectCanvasResponse`

---

## 10. 重试执行规划

`POST /api/requirements/{id}/plan`

仅用于自动规划失败后的手动重试。普通前端流程不应主动调用该接口触发首次规划；
首次规划由确认入队后的后端调度器自动完成。

**响应：** `ProjectCanvasResponse`

---

## 11. 执行失败恢复

- `POST /api/requirements/{id}/tasks/{task_id}/retry`：重试失败节点。
- `POST /api/requirements/{id}/tasks/{task_id}/retry-from`：从指定节点恢复后续执行。
- `POST /api/requirements/{id}/tasks/{task_id}/rerun-review`：重新运行审核节点。

恢复操作成功后，后端继续调度当前需求；当前需求完成后，所属项目队列才会继续处理
下一项。

**响应：** `ProjectCanvasResponse`

---

## 12. 重启恢复

队列、执行计划和节点状态会持久化。服务重启时：

- 尚未开始的排队需求保留原有 FIFO 顺序。
- 正在执行的需求会记录中断，并按节点恢复策略继续。
- 正在生成执行计划的需求会重新入队，并基于最新代码重新规划。
- 已生成计划但尚未执行的需求会自动开始执行。
- 已进入最终失败状态的需求不会被静默跳过，所属项目队列保持暂停。

---

## 13. 获取模型设置

`GET /api/settings/models`

返回可用模型列表与当前设置。

**响应：**

```json
{
  "models": [
    { "id": "provider/model", "name": "Model Name", "provider": "provider", "reasoning": true }
  ],
  "settings": { ... },
  "rpc_status": "ready",
  "rpc_error": null
}
```

---

## 14. 保存模型设置

`PUT /api/settings/models`

**请求体：** `ModelSettings`

```json
{
  "low": { "model_id": "provider/model-a", "thinking_level": "low" },
  "medium": { "model_id": "provider/model-b", "thinking_level": "medium" },
  "high": { "model_id": "provider/model-c", "thinking_level": "high" }
}
```

**响应：** `ModelSettingsResponse`

---

## 15. 获取项目问答会话

`GET /api/projects/{id}/chat`

返回该项目唯一的问答会话。尚未提问时返回空消息列表，不会额外创建多个会话。

**响应：**

```json
{
  "project_id": "project-id",
  "messages": [
    {
      "role": "user",
      "content": "认证入口在哪里？",
      "created_at": "2026-06-25T10:00:00Z"
    },
    {
      "role": "assistant",
      "content": "认证入口位于……",
      "created_at": "2026-06-25T10:00:05Z"
    }
  ],
  "running": false,
  "error": null,
  "updated_at": "2026-06-25T10:00:05Z"
}
```

---

## 16. 发送项目问答消息

`POST /api/projects/{id}/chat/messages`

向该项目的单一问答会话追加问题，并异步启动回答。

**请求体：**

```json
{
  "message": "这个项目如何启动？"
}
```

**响应：** `ProjectChatResponse`

项目问答以项目仓库为只读工作目录，固定使用中档模型，并通过独立的持久
`pi --mode rpc` 子进程执行。它不会创建或修改需求、触发需求规划、进入执行队列，
也不会修改仓库文件。

---

## 17. 项目问答事件流（SSE）

`GET /api/projects/{id}/chat/events`

独立的 Server-Sent Events 流，仅推送该项目问答的实时进度，不复用
`GET /api/requirements/{id}/events`。

**事件数据格式：**

```json
{
  "project_id": "project-id",
  "event": "project_chat_completed",
  "message": "回答完成",
  "pi_type": null,
  "payload": null
}
```

**事件类型：**

- `project_chat_started`
- `project_chat_completed`
- `project_chat_failed`
- `pi_event`
- `serialization_failed`（内部序列化失败时的降级事件）

SSE 只负责实时通知，不作为状态存储。客户端重新连接后应通过
`GET /api/projects/{id}/chat` 获取完整会话。

---

## 类型参考

主要类型定义在后端 `src/models.rs` 与前端 `frontend/src/types/api.ts` 中，两者需保持同步。
