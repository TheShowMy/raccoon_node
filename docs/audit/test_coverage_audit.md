# raccoon_node 测试覆盖率审核报告

审核日期：2026/06/18
审核范围：src/main.rs（#[cfg(test)] 模块）、Cargo.toml、frontend/package.json、.pre-commit-config.yaml

---

## 一、当前测试覆盖优点

1. **JSON 存储初始化**：`initializes_json_store` 测试验证了空数据文件创建、默认值结构和 `ThinkingLevel` 默认配置。
2. **项目创建与基础校验**：`creates_project_and_rejects_invalid_names` 覆盖了空名称、空 Git URL、大小写重复名称的拒绝逻辑，以及 slug 生成和 `local_path` 正确性。
3. **Git 克隆失败回滚**：`clone_failure_does_not_write_project` 验证了克隆失败时不会写入项目记录、不会残留目录。
4. **项目删除**：`deletes_project_record_and_local_directory` 覆盖了记录删除、目录清理、关联需求删除、缺失项目 404。
5. **API 路由集成**：`serves_start_and_create_project_api` 用 Tower `ServiceExt::oneshot` 测试了 `GET /api/start` 和 `POST /api/projects` 的端到端响应。
6. **模型设置 API**：`model_settings_api_returns_models_and_handles_rpc_error` 和 `model_settings_save_validates_models_and_allows_reuse` 覆盖了 GET/PUT 模型设置、RPC 错误降级、模型 ID 校验、描述更新。
7. **Canvas 分组**：`project_canvas_groups_requirements` 验证了 `active`/`queued`/`completed` 三态分组和缺失项目 404。
8. **需求分析完整流程**：`requirement_api_creates_clarifies_and_confirms_queue` 覆盖了需求创建 -> 异步分析 -> DraftReady -> 确认 -> 入队，以及空消息 400。
9. **澄清答案提交**：`requirement_clarification_answers_resume_analysis` 覆盖了澄清状态写入、答案提交、状态重置为 Analyzing、消息内容生成、Trace 消息记录。
10. **解析逻辑**：`requirement_analysis_parse_failure_returns_failed_output` 覆盖了纯文本失败、HTML 包裹 JSON 提取、正常 `needs_clarification` 解析。

---

## 二、测试缺口（按严重程度）

### 2.1 严重缺口

| 待测试功能 | 文件位置 | 建议测试场景 |
|---|---|---|
| **路径安全（`ensure_child_path` / `project_dir` 目录穿越）** | `src/main.rs:1078-1091`, `2252-2271` | 构造 `../etc/passwd` 等恶意 ID，验证 `project_dir` 拒绝；验证 `normalize_components` 对 Windows 盘符、`..`、符号链接的处理 |
| **Pi RPC 错误处理（`send_command` 超时、子进程崩溃、响应 ID 不匹配）** | `src/main.rs:2019-2064` | 模拟 stdout 提前 EOF、响应 `success: false`、ID 不匹配时是否正确循环等待或报错 |
| **SSE 事件流过滤与序列化** | `src/main.rs:485-505` | 验证广播事件按 `requirement_id` 过滤、非目标事件被丢弃、序列化失败降级、KeepAlive 行为 |
| **删除边界：删除不存在的本地目录** | `src/main.rs:727-746` | `project_dir.exists() == false` 时 `delete_project` 不应报错，仍应删除记录和需求 |
| **并发场景：同一项目同时创建需求** | `src/main.rs:426-444` | 两个并发 `create_requirement` 请求不应导致 JSON 写冲突或数据丢失 |
| **`wait_for_requirement_status` flaky 风险** | `src/main.rs:3027-3047` | 轮询 500ms 超时在慢 CI 上可能失败，需增加超时或改为条件变量通知 |

### 2.2 中等缺口

| 待测试功能 | 文件位置 | 建议测试场景 |
|---|---|---|
| **`append_requirement_message` 状态校验** | `src/main.rs:871-923` | 验证非 `Clarifying/Analyzing/Failed/DraftReady` 状态返回 400；验证消息追加后状态重置为 Analyzing |
| **`submit_requirement_clarifications` 边界校验** | `src/main.rs:925-1000` | 空答案数组 400、非澄清状态 400、澄清 ID 不存在 400、答案为空 400、未全部回答 400 |
| **`confirm_requirement` 状态校验** | `src/main.rs:1002-1068` | 非 `DraftReady` 状态返回 400 |
| **`apply_requirement_analysis` 错误分支** | `src/main.rs:1002-1055` | 验证 `Err` 分支正确设置 `Failed` 状态、写入 System 消息、更新 `updated_at` |
| **`write_json` 原子写入失败回滚** | `src/main.rs:2195-2214` | 模拟 `rename` 失败（如目标目录只读），验证临时文件被清理 |
| **`JsonStore::open` 已有文件加载** | `src/main.rs:639-663` | 验证已存在 `app.json` 时正确反序列化，而非覆盖 |
| **`derive_requirement_title` 边界** | `src/main.rs:2297-2310` | 空字符串、超长字符串、全空白字符、Unicode 字符截断 |
| **`slugify` 边界** | `src/main.rs:2278-2295` | 全非法字符、纯空格、Unicode、连续分隔符去重 |
| **`build_requirement_prompt` 输出结构** | `src/requirement/analysis.rs:16-129` | 验证生成的 prompt 包含项目上下文、历史消息、澄清项、已有草案 |
| **`build_pi_trace_metadata` / `collect_message_update` / `upsert_trace_tool`** | `src/main.rs:1577-1697` | 验证空事件返回 `None`、thinking_delta 累加、tool 事件 upsert 逻辑、重复 toolCallId 更新而非追加 |
| **`validate_model_settings` 空模型列表** | `src/main.rs:2096-2119` | 模型列表为空时，任何非空 `model_id` 都应报错 |
| **`get_model_settings` 降级响应结构** | `src/main.rs:516-540` | RPC 错误时 `models` 为空数组、`rpc_error` 有内容、`rpc_status` 为 `error` |

### 2.3 轻微缺口

| 待测试功能 | 文件位置 | 建议测试场景 |
|---|---|---|
| **`sort_requirements_desc` 排序稳定性** | `src/main.rs:2312-2319` | `updated_at` 相同则按 `created_at` 降序 |
| **`display_path` / `data_root_from_file` / `data_file_path` / `public_dir_path`** | `src/main.rs:2245-2343` | 环境变量覆盖、当前 exe 路径推断边界 |
| **`server_addr` 环境变量解析** | `src/main.rs:2345-2355` | 非法 `RACCOON_PORT` 是否 panic、IPv6 地址解析 |
| **`model_summary_description` 部分配置** | `src/main.rs:2121-2130` | 仅配置 low/medium 时返回 "默认模型待配置" |
| **`AppError` Display 和 IntoResponse** | `src/main.rs:2132-2193` | 各变体返回正确 HTTP 状态码和消息体 |
| **`RequirementEventEmitter::emit_pi_event`** | `src/main.rs:621-636` | 验证 payload 中 `type` 缺失时降级为 `unknown` |
| **`PiRpcClient::Drop` 子进程清理** | `src/main.rs:2088-2094` | 验证 `Drop` 时调用 `start_kill`（可用 mock 或进程存在性断言） |
| **CORS 配置** | `src/main.rs:387-392` | 验证预检请求响应头 |

---

## 三、测试质量评估

### 3.1 潜在 flaky 测试

1. **`wait_for_requirement_status`（`src/main.rs:3027-3047`）**
   - 轮询 20 次 x 25ms = 500ms 超时。若异步分析任务在 CI 慢机器上执行超过 500ms，测试会 panic。
   - **建议**：增加超时时间至 5s，或改为条件变量/channel 通知而非轮询文件。

2. **`temp_git_repo` 使用 `timestamp_nanos_opt()`**
   - 纳秒级时间戳在极快速连续调用时理论上可能冲突（虽然概率极低）。
   - **建议**：使用 `tempfile` 的随机命名或 UUID。

3. **`requirement_api_creates_clarifies_and_confirms_queue`**
   - 依赖 `spawn_requirement_analysis` 的异步任务在 500ms 内完成，且 `wait_for_requirement_status` 能捕获状态变化。
   - **建议**：使用 `tokio::time::pause` 控制时间，或注入 `FakeModelProvider` 时阻塞直到分析完成。

### 3.2 断言充分性

- 现有测试对**成功路径**断言较充分，但**错误路径**断言较弱：多数仅检查 `matches!(AppError::BadRequest(_))` 而未验证具体消息内容。
- 建议对关键错误场景增加消息内容断言，防止错误类型正确但错误消息误导用户。

---

## 四、前端测试现状

**frontend/package.json 中无任何测试框架或测试脚本。**

- 无 Jest、Vitest、Playwright、Cypress。
- `scripts` 中仅有 `dev`、`build`、`check`、`format:check`、`format`。
- **结论**：前端零测试覆盖。

---

## 五、pre-commit 中 cargo-test 评估

`.pre-commit-config.yaml` 第 79-84 行：

```yaml
- id: cargo-test
  name: 运行 Rust 单元测试
  entry: bash -c 'cargo test'
  language: system
  files: \.rs$
  pass_filenames: false
```

**评价**：
- 基本足够：每次 Rust 文件变更时运行全部单元测试。
- **不足**：`pass_filenames: false` 意味着即使只改了一个 `.rs` 文件也会运行全部测试，对于大型测试套件会变慢。当前测试量小，可接受。
- **缺失**：无 `--release` 模式测试、无并发控制（`cargo test --jobs`）、无测试覆盖率检查（`cargo tarpaulin` 或 `cargo llvm-cov`）。

---

## 六、补测优先级排序

| 优先级 | 测试目标 | 推荐框架 |
|---|---|---|
| **P0** | 路径安全（目录穿越） | Rust 内置 `#[cfg(test)]` + `tempfile` |
| **P0** | Pi RPC 错误处理（超时、崩溃、ID不匹配） | Rust 内置 + `tokio::test` + mock stdin/stdout |
| **P0** | SSE 事件流过滤 | Rust 内置 + `tokio::test` + `tokio_stream` |
| **P0** | 并发 JSON 写冲突 | Rust 内置 + `tokio::test` + 多任务并发 |
| **P1** | 需求分析/澄清/确认的状态机边界 | Rust 内置 + `tokio::test` |
| **P1** | `write_json` 原子写入失败 | Rust 内置 + `tempfile` + 权限操控 |
| **P1** | `build_pi_trace_metadata` 完整链路 | Rust 内置 |
| **P2** | 前端组件测试（React Flow 节点、表单校验） | **Vitest** + **React Testing Library** |
| **P2** | 前端 E2E（项目创建、需求分析流程） | **Playwright** |
| **P3** | 集成测试（真实 HTTP API + 内存存储） | `axum` + `tower::ServiceExt`（已在用，扩展场景） |
| **P3** | 测试覆盖率门控 | `cargo-tarpaulin` 或 `cargo-llvm-cov` |

---

## 七、推荐测试框架

| 层级 | 框架 | 理由 |
|---|---|---|
| Rust 单元/集成 | **内置 `#[cfg(test)]` + `tokio::test`** | 已在用，无需引入新依赖；`tempfile` 和 `tower` 已存在于 `dev-dependencies` |
| Rust 覆盖率 | **`cargo-llvm-cov`** | 比 `tarpaulin` 更快更稳定，支持 CI 报告 |
| 前端单元 | **Vitest** | 与 Vite 生态天然集成，ESM 支持好，配置轻 |
| 前端组件 | **React Testing Library** | 社区标准，与 Vitest 配合良好 |
| 前端 E2E | **Playwright** | 支持多浏览器、Trace Viewer、CI 友好，比 Cypress 更适合现代 React 应用 |

---

## 八、总结

当前 Rust 后端对**核心业务流程**（项目 CRUD、需求分析状态机、模型设置）有基本的单元测试覆盖，但**安全关键路径**（目录穿越、并发写、RPC 错误）和**基础设施代码**（SSE、JSON 原子写入、路径工具函数）存在严重缺口。前端完全无测试。建议优先补齐 P0 安全与并发测试，再逐步扩展前端测试矩阵。

---

## 九、优先级最高的 5 项补测建议

1. **路径安全（目录穿越）** - P0
   - 测试 `project_dir` 对 `../etc/passwd` 等恶意 ID 的拒绝
   - 测试 `normalize_components` 对 Windows 盘符和 `..` 的处理
   - 文件：`src/main.rs:1078-1091`, `2252-2271`

2. **Pi RPC 错误处理** - P0
   - 测试 `send_command` 在 stdout EOF、响应 `success: false`、ID 不匹配时的行为
   - 测试 `wait_for_agent_end_with_events` 超时处理
   - 文件：`src/main.rs:1969-2086`

3. **SSE 事件流过滤** - P0
   - 测试广播事件按 `requirement_id` 正确过滤
   - 测试序列化失败时的降级行为
   - 文件：`src/main.rs:485-505`

4. **并发 JSON 写冲突** - P0
   - 测试两个并发 `create_requirement` 请求不会导致数据丢失或文件损坏
   - 文件：`src/main.rs:426-444`

5. **需求分析状态机边界** - P1
   - 测试 `append_requirement_message` 在非法状态下的 400 响应
   - 测试 `submit_requirement_clarifications` 的各种边界校验
   - 测试 `confirm_requirement` 非 DraftReady 状态的拒绝
   - 文件：`src/main.rs:871-1068`
