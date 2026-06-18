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

Server-Sent Events，推送 Coordinator 进度、Pi Agent 事件、澄清就绪、草案就绪或分析失败。

**事件类型：**

- `coordinator_started`
- `coordinator_progress`
- `pi_event`
- `clarifications_ready`
- `draft_ready`
- `analysis_failed`
- `serialization_failed`（内部序列化失败时的降级事件）

---

## 9. 确认需求

`POST /api/requirements/{id}/confirm`

将 `DraftReady` 状态的需求确认并入执行队列。

**响应：** `ProjectCanvasResponse`

---

## 10. 获取模型设置

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

## 11. 保存模型设置

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

## 类型参考

主要类型定义在后端 `src/models.rs` 与前端 `frontend/src/types/api.ts` 中，两者需保持同步。
