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
  "theme_pack": "neutral",
  "theme_mode": "dark",
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

默认响应只携带需求和 WorkflowRun 摘要。打开某个 WorkflowRun 时使用
`GET /api/projects/current/canvas?workflow_requirement_id={requirement_id}`；仅所选需求返回
完整 Workflow 快照，attempt session 仍通过独立接口按需读取。

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

### 懒加载文件树

`GET /api/projects/current/files/tree?path=src`

只返回指定目录的直接子项，目录排在文件之前并按名称排序。根目录使用空 `path`；
内部目录、路径逃逸和符号链接均不会被遍历。

### 预览仓库文件

`GET /api/projects/current/files/content?path=README.md`

只读取仓库内不超过 64KB 的 UTF-8 文本。路径逃逸、符号链接逃逸、二进制文件、
`.git/` 和 `.raccoon-node/` 均会被拒绝。

```json
{
  "path": "README.md",
  "content": "# project"
}
```

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

每次 Prompt 最多携带 8 个仓库引用文件和 3 张图片，图片总计不超过 10MB。引用文件单个不超过 32 KiB 且累计不超过 128 KiB 时内联；超过内联预算的文件只发送安全仓库相对路径和大小，由 Pi Agent 按需分段读取，不静默截断需求事实。

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

成功接受后返回 `202 Accepted`：

```json
{
  "accepted": true,
  "turn_id": "turn-id"
}
```

会话运行、创建需求分支或存在未确认活动需求时再次发送返回 `409 Conflict`。

### 创建需求分支与停止

- `POST /api/projects/current/chat/commands/requirement-branch`
- `POST /api/projects/current/chat/abort`

分支命令请求体与创建需求相同，`message` 必须非空。完整父问答会克隆当前 Pi 活动
分支；无完整问答时创建独立需求。完整问答存在但父 session 丢失、越界或 cwd 不
匹配时明确报错，不会静默丢失上下文。响应包含 `requirement_id` 和
`origin: project_chat_branch | standalone`。

停止接口中断当前普通聊天回答，成功接受后返回
`202 { "accepted": true }`。

### 问答 WebSocket

`GET /api/projects/current/chat/events`

该地址升级为只读 WebSocket，不再提供聊天 SSE。消息格式为：

```json
{
  "type": "agent.event",
  "payload": {}
}
```

事件类型：

- `agent.event`：携带原始 Pi Agent 事件
- `snapshot.changed`
- `session.error`
- `notice.append`

客户端先建立连接并缓冲事件，再调用问答查询接口加载 SQLite 快照，合并后回放
缓冲事件。断线重连时重新执行该流程；`snapshot.changed` 后重新拉取快照，并以
最终持久消息替换临时流。WebSocket 只提供实时增量，不是业务状态存储。

### 问答原始会话

`GET /api/projects/current/chat/session?before=100&limit=100`

返回当前项目问答的 Pi JSONL 时间线。分页规则和响应结构见下方“JSONL 会话分页”。

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

成功接受后返回 `202 Accepted`：

```json
{
  "accepted": true,
  "requirement_id": "requirement-id"
}
```

该接口只创建 `origin: standalone` 的独立需求。聊天树分叉必须调用上方
`chat/commands/requirement-branch`。`Requirement.pi_session_file` 与父聊天 session
均为后端字段，不会出现在 API 响应中。

### 获取对话和追加消息

- `GET /api/requirements/{id}/conversation`
- `POST /api/requirements/{id}/messages`
- `GET /api/requirements/{id}/conversation/events`

追加消息请求与创建需求相同，成功接受后返回：

```json
{
  "accepted": true,
  "requirement_id": "requirement-id",
  "turn_id": "turn-id"
}
```

`conversation/events` 升级为只读 WebSocket，使用与项目问答相同的统一事件协议、
快照合并和重连规则。需求分析运行期间再次创建或追加需求返回 `409 Conflict`。
停止需求分析继续使用 `POST /api/requirements/{id}/cancel`。

### 提交澄清答案

`POST /api/requirements/{id}/clarifications`

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

`prompt_id` 和 `revision` 必须取自当前对话快照中的活动澄清卡；后端拒绝陈旧版本和
不完整答案。旧版答案数组仍可兼容读取，但新客户端必须发送版本化对象。确认草案时
`POST /api/requirements/{id}/confirm` 同样发送当前 `prompt_id` 和 `revision`。

### 确认、取消和删除

- `POST /api/requirements/{id}/confirm`
- `POST /api/requirements/{id}/cancel`
- `DELETE /api/requirements/{id}`

确认后需求进入当前项目 FIFO 队列。调度器自动生成只包含真实工作项的 WorkPlan，创建
一个 WorkflowRun，并在独立 integration worktree 中串行执行。失败 WorkflowRun 会暂停
后续队列，避免后续需求越过失败项。确认或放弃后父聊天恢复可用；child session 中的
消息和确认草案不会写回父 session。

### WorkflowRun

- `POST /api/requirements/{id}/retry-analysis`：在澄清会话中断后创建新 session，
  并使用已保存业务上下文重试分析
- `GET /api/requirements/{id}/session`：按时间合并该需求历次分析 session
- `POST /api/requirements/{id}/workflow-run`：为已确认需求生成 WorkPlan，并启动或续跑
  该需求唯一的 WorkflowRun
- `GET /api/requirements/{id}/workflow-run`：读取该需求最近的 Workflow 快照
- `GET /api/workflow-runs/{run_id}`：读取 run、行为切片、依赖、attempt、验证、
  checkpoint 和 finding 的一致性快照
- `GET /api/workflow-runs/{run_id}/events?after={sequence}&limit={limit}`：分页增量读取只追加
  事件，响应为 `{ "events": [], "next_after": null }`
- `POST /api/workflow-runs/{run_id}/resume`：只恢复 `paused_technical`，从已保存 operation
  继续；其他状态返回 `409 Conflict`
- `GET /api/workflow-runs/{run_id}/attempts/{attempt_id}/session`：分页读取指定 attempt 的
  Pi JSONL 会话；内部 session 路径不会出现在响应中

需求确认产物是 OpenSpec 风格 `ChangeSpec`：`intent`、Given/When/Then
`acceptance_scenarios`、带原消息 ID 和原文摘录的 `explicit_constraints`、`non_goals`。
行为场景禁止文件名、函数/API/组件精确名称、CSS 选择器或变量和 shell 命令。WorkPlan
只描述行为切片的 `objective`、`scenario_refs`、`depends_on`、非约束 `scope_hints` 与
`verification_goals`；技术选择进入可修订 `DesignNotes`，不成为机械验收条件。不存在 Stage、
Review、Summary、Merge、Fix 或 Recovery 伪任务。Planner 非法结构在同一 Pi session 中只做
一次短纠正，仍失败进入技术暂停。

当前执行器默认串行租约工作项，并在一个受管 integration worktree 上累计改动。每个工作项
依次执行低档首次实现、低档普通修复和高档修复；结构化结果缺失或不合法同样只允许一次
同 session 短纠正。每次 attempt 都是独立持久 session，前后复核 HEAD、分支 ref 与 staged
指纹；任务 Agent 可运行 Git 只读命令，受管 `raccoon:task-runtime:v3` extension 在工具调用
前拒绝 Git 写命令，调度器负责 stage、checkpoint commit 和最终集成。

WorkflowRun 启动时确定性生成 `RepositoryValidationCatalog`：始终包含 `git diff --check`，
并按仓库现有脚本选择 Node check/test/build、Rust test/既有 Clippy、pytest 或 Go test。
调度器在 base HEAD 建立基线，最终 fingerprint 重新执行；只有基线通过而最终失败才是硬阻断，
既有失败未恶化只展示，无法建立基线标记 unverified。Agent 自创 grep、rg 或字符串计数只作为
observation。全部行为切片完成后才执行最终 checkpoint。审核父调用通过
`raccoon:parallel-review:v5` 编排上下文、工具和内存 session 完全隔离的真实 AgentSession，
子 Agent 不写 session 文件：

- 正确性只看 ChangeSpec、base 到当前 worktree 的固定完整 diff 和中性验证结果；
- 代码质量与安全是盲审，完全看不到任务标题、需求描述、验收文本、实现总结、正确性意见
  或其他角度上下文；
- 完整 diff 按风险确定性选择 1–3 个角度；修复后只复审正确性、仍有 P0/P1 的角度和
  本次修复新增触发的安全角度；
- finding 只提交 P0–P3、类别、路径、位置、短摘要、证据和修复建议；P0/P1 阻断，P2/P3
  只展示；传输成功使用 `transport_status=completed`，不等于业务审核通过；
- 非法结构带精确 JSON 路径返回原隔离 session 修正两次，仍失败只重试该角度一次；再次失败
  进入 `paused_technical`，不触发 Fixing 或 Rescue。

常规低档实现、低档修复、高档修复和一次高档集成修复发生语义失败后，WorkflowRun 最多获得
一次外部高级 Rescue。
Rescue 使用全新短 session，从整个 run 的契约、失败分类、未关闭 blocker、验证摘要和当前
diff 总览恢复 integration worktree；不继承失败 Agent 的长上下文。Rescue 修改后先运行原生
gate；首次失败会把精简证据反馈给同一个 Rescue session 一次。再次语义失败才进入
`blocked`。数据库、协议、Pi 进程、审核持久化和子 Agent 传输失败进入
`paused_technical`，不消耗 Rescue；SQLite busy 操作最多重试三次。

token 预算仅用于一次性告警和 operation trace，不会终止 Agent，也不会写回模型上下文。
运行看门狗只按有效活动续期：普通 Pi 操作或验证连续 600 秒无活动才失败，审核子 Agent
连续 300 秒无活动才失败；总时长没有硬上限。Pi 原生 compaction 尊重用户现有设置，压缩
活动刷新空闲计时；估算节省量标记 `usageKnown=false`，不混入供应商计费用量，也不把摘要
正文复制到 SQLite。

### JSONL 会话分页

项目问答、需求分析和 Workflow attempt 会话接口使用相同响应。默认返回最新 100 条记录，
`limit` 最大为 200；存在更早记录时，用 `next_before` 继续请求。每条有效 JSONL
都会保留原始 `raw`，但 compaction 记录会从 API `raw` 中移除摘要正文；无法解析的行
只计入 `invalid_lines`。持久 compaction 记录展示 Pi 实际保存的压缩前 token、文件上下文
计数和 hook 来源；压缩后估算仅在本次 operation trace 可得时展示，不伪造 session 字段。

```json
{
  "entries": [
    {
      "cursor": 42,
      "source": "代码节点",
      "line": 43,
      "kind": "message",
      "id": "message-id",
      "role": "assistant",
      "timestamp": "2026-07-01T00:03:00Z",
      "blocks": [
        { "type": "text", "text": "完成实现" },
        {
          "type": "tool_call",
          "id": "edit-1",
          "name": "edit",
          "arguments": { "path": "src/main.rs" }
        }
      ],
      "raw": { "type": "message" }
    }
  ],
  "next_before": 42,
  "invalid_lines": 0
}
```

内容块类型为 `text`、`thinking`、`tool_call`、`tool_result` 或 `unknown`。
`tool_result` 可携带 `output`、`diff` 和 `is_error`。接口不会返回 session 文件路径。

WorkflowRun 通过最终 checkpoint 后，由调度器提交 integration 分支，并在主工作区仍处于
原始 HEAD 且保持干净时执行 fast-forward-only 合并。主工作区在运行期间变化会触发唯一
Rescue 或最终 blocked，不会覆盖用户改动，也不会自动 push。

### Workflow 事件

`GET /api/requirements/{id}/events`

需求事件 SSE 仍提供实时 UI 通知；可传 `include_pi_events=false` 只订阅状态事件。Workflow
事实与重连对账以 SQLite 快照和 `/api/workflow-runs/{run_id}/events` 增量事件为准。

```json
{
  "requirement_id": "requirement-id",
  "task_id": "work-item-id",
  "event": "work_item_attempt_started",
  "message": "开始执行工作项：标题",
  "pi_type": null,
  "payload": null
}
```

常见通知为 `workflow_planning_started`、`workflow_plan_ready`、`workflow_plan_failed`、
`workflow_started`、`work_item_attempt_started`、`work_item_attempt_failed`、
`work_item_completed`、`integration_fix_started`、`final_review_started`、
`workflow_rescue_started`、`workflow_rescue_feedback_started`、
`workflow_paused_technical`、`workflow_completed` 和 `workflow_blocked`。需求分析与澄清
对话继续使用上方 `conversation/events` WebSocket。

## 基础设置

### 获取设置

`GET /api/settings/basic`

```json
{
  "theme_pack": "neutral",
  "theme_mode": "dark",
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
  "theme_pack": "matcha",
  "theme_mode": "light",
  "host": "0.0.0.0",
  "port": 4321,
  "commit_mode": "local",
  "confirmed_external": true
}
```

主题可通过仅提交 `{ "theme_mode": "light" }` 或
`{ "theme_pack": "matcha" }` 独立持久化，不触发发布条件检查。提交模式显式保存后生效，只有模式实际变化时才重新检查发布条件。host 仅支持
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

## Web 终端授权

监听地址为 `0.0.0.0` 时，项目终端 API 需要先用本次启动的终端密钥授权。密钥只在
TUI 中显示，每次进程启动随机生成，不写入 SQLite 或配置文件；授权成功后 12 小时内有效。
监听地址不是 `0.0.0.0` 时，接口返回 `required: false`，终端沿用本机访问限制。

### 查询授权状态

`GET /api/projects/current/terminal-access`

```json
{
  "required": true,
  "authorized": false,
  "expires_at": null
}
```

### 提交启动密钥

`POST /api/projects/current/terminal-access`

```json
{
  "key": "ABCD-EFGH-JKLM"
}
```

成功后返回：

```json
{
  "required": true,
  "authorized": true,
  "expires_at": "2026-07-06T12:00:00Z"
}
```

授权过期后，后续终端 HTTP API 会重新要求密钥；已建立的终端 WebSocket 会收到错误消息并断开。

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
后续启动不再读取。SQLite 保存业务消息、澄清轮次、WorkflowRun 规范化状态、只追加事件
与 token usage 摘要，Pi session 保存完整 thinking 和工具输入输出。检测到旧 v3 执行库时，
启动过程先按字节归档 v4 数据库，再创建全新 v5 schema；运行时不保留旧 Workflow 执行器
或协议兼容分支。

Pi 会话记录的 `cwd` 必须等于当前 Git 根目录或受管 worktree。所有清理操作只能
作用于 `.raccoon-node/`，不会删除用户仓库。

主要类型定义在 `src/models/mod.rs` 与 `frontend/src/types/api.ts`，两端必须保持同步。
