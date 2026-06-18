# raccoon_node 性能与可扩展性审核报告

> 审核日期：2026/06/18
> 审核范围：`src/main.rs`、`frontend/src/main.tsx`、`frontend/vite.config.ts`
> 审核性质：只读审查，未修改任何文件

---

## 一、显著瓶颈

### 1. Pi RPC 全局串行锁（io_lock）

- **文件**：`src/main.rs:288`, `src/main.rs:2026`
- **相关代码**：
  ```rust
  struct PiRpcClient {
      io_lock: Mutex<()>,
      stdin: Mutex<ChildStdin>,
      stdout: Mutex<BufReader<ChildStdout>>,
      child: Mutex<Child>,
  }
  ```
  `send_command` 和 `wait_for_agent_end_with_events` 都先获取 `io_lock`。
- **问题描述**：所有 Pi Agent RPC 请求（包括 `get_available_models`、`analyze_requirement`、`set_model`、`prompt` 等）都通过同一个 `io_lock` 串行执行。即使前端同时发起多个需求分析，后端也只能排队依次处理。
- **影响评估**：**高**。这是整个系统最核心的并发瓶颈。当多个需求同时进入分析状态时，所有 Pi Agent 调用串行排队，120 秒超时叠加等待时间，极易触发超时失败。分析任务本应是 CPU/IO 密集型，却被锁退化为单线程。
- **优化建议**：
  - 方案 A：将 `io_lock` 的粒度缩小到仅保护单次请求-响应对（send + read response），但允许不同请求在 Pi Agent 内部队列中并行处理（前提是 Pi Agent 支持并发请求）。
  - 方案 B：如果 Pi Agent 本身不支持并发，考虑启动多个 Pi Agent RPC 子进程作为连接池，按需求哈希分发。
  - 方案 C：将 `analyze_requirement` 中的多个命令（`new_session`、`set_model`、`prompt`、`wait_for_agent_end`）合并为一个复合命令，减少锁持有时间。

### 2. AppState.store 全局 Mutex 阻塞所有 API

- **文件**：`src/main.rs:40`, `src/main.rs:352-354`
- **相关代码**：
  ```rust
  struct AppState {
      store: Arc<Mutex<JsonStore>>,
      ...
  }
  ```
  几乎每个 API handler（`get_start`、`create_project`、`delete_project`、`get_project_canvas`、`create_requirement`、`append_requirement_message`、`submit_requirement_clarifications`、`confirm_requirement`、`get_model_settings`、`put_model_settings`）都先 `state.store.lock().await`。
- **问题描述**：`JsonStore` 被单个 `tokio::sync::Mutex` 包裹，所有读写操作串行。即使读操作（如 `get_start`、`get_project_canvas`）也阻塞写操作（如 `create_project`）。
- **影响评估**：**高**。随着项目数、需求数增长，读 API 会频繁阻塞写 API。`get_project_canvas` 每次都要遍历全部需求做过滤和排序，持有锁期间其他请求全部排队。
- **优化建议**：
  - 使用 `tokio::sync::RwLock` 替代 `Mutex`，读多写少的场景下允许多个读并发。
  - 将 `AppData` 中的 `projects` 和 `requirements` 改用并发数据结构（如 `DashMap` 或按项目分片的独立锁），进一步减少锁竞争。
  - 读操作（如 `get_start`、`get_project_canvas`）可以只读快照，不阻塞写操作。

### 3. JSON 全量序列化写入（每次操作都写整个文件）

- **文件**：`src/main.rs:2195-2214`, `src/main.rs:723`, `src/main.rs:744`, `src/main.rs:756`, `src/main.rs:867`, `src/main.rs:911`, `src/main.rs:988`, `src/main.rs:1053`, `src/main.rs:1066`
- **相关代码**：
  ```rust
  async fn write_json(path: &Path, data: &AppData) -> Result<(), AppError> {
      let mut content = serde_json::to_string_pretty(data)?;
      content.push('\n');
      // ... 写临时文件 + rename
  }
  ```
  每次 `create_project`、`delete_project`、`save_model_settings`、`create_requirement`、`append_requirement_message`、`submit_requirement_clarifications`、`apply_requirement_analysis`、`confirm_requirement` 都调用 `write_json`。
- **问题描述**：无论修改多小（如新增一条消息），都全量序列化整个 `AppData`（包括所有项目、所有需求、所有消息）为 pretty JSON，再写入磁盘。时间复杂度 O(N)，N 为数据总量。
- **影响评估**：**高**。当需求数量增长到数百条、消息历史累积时，每次写入都会序列化数 MB 的 JSON，CPU 和 IO 开销线性增长。同时因为 `Mutex` 的存在，写入期间所有 API 被阻塞。
- **优化建议**：
  - 短期：使用 `serde_json::to_vec` 替代 `to_string_pretty`，减少格式化开销。
  - 中期：引入增量持久化，如 SQLite 或 sled/rocksdb，只写入变更的记录。
  - 长期：按项目分片存储（每个项目独立 JSON 或 SQLite），避免全量写入。
  - 增加写入缓冲/批量写入（如 500ms 内合并多次写入）。

### 4. React useMemo 依赖列表 34 项导致频繁重建

- **文件**：`frontend/src/main.tsx:1881-2114`
- **相关代码**：
  ```typescript
  const nodes = useMemo<Node<StartNodeData>[]>(() => { ... }, [
    backToStartCanvas, cancelDeleteProject, confirmDeleteProject,
    confirmRequirement, createProject, creating, currentCanvas,
    deleteError, deletingId, clarificationAnswers, draftModelSettings,
    error, modelError, modelRpcStatus, modelSettingsOpen, models,
    pendingDeleteProject, projectCanvas, openProjectCanvas,
    requestDeleteProject, requirementBusy, requirementError,
    requirementInput, requirementStreamEvents, saveModelSettings,
    selectedProjectId, sendRequirementMessage, savingModels,
    setModelSettingsOpen, startData, theme, toggleModelSettings,
    submitClarifications, updateClarificationAnswer, updateModelTier,
  ]);
  ```
- **问题描述**：`nodes` 和 `edges` 的 `useMemo` 依赖了几乎所有状态变量。任何微小状态变化（如 `requirementInput` 输入一个字符、`theme` 切换）都会触发 `nodes` 数组完全重建，进而触发 React Flow 的整棵树重新渲染。
- **影响评估**：**高**。输入框每输入一个字符就重建所有节点（包括项目列表、模型配置、删除确认等），React Flow 需要重新计算布局、重新渲染 DOM。这是前端最显著的卡顿来源。
- **优化建议**：
  - 将 `nodes` 拆分为多个独立的 `useMemo`，按画布（start vs project）分别计算，减少不必要的重建。
  - 使用 `useRef` 或事件总线传递回调函数，避免回调函数引用变化触发 `useMemo` 失效。
  - 将 `requirementInput`、`requirementStreamEvents` 等高频变化状态从 `nodes` 依赖中移除，改为通过 ref 或 context 传递给子组件。
  - 考虑使用 `React.memo` 包裹 `StartNode` 和各个子节点组件，配合自定义 `areEqual` 比较。

---

## 二、潜在瓶颈

### 5. broadcast::channel(256) 事件丢失风险

- **文件**：`src/main.rs:352`
- **相关代码**：
  ```rust
  let (event_tx, _) = broadcast::channel(256);
  ```
- **问题描述**：`broadcast::channel` 容量为 256。当 Pi Agent 产生大量事件（如 `message_update`、`tool_execution_start/update/end`）且消费者（SSE 连接）消费速度跟不上时，旧事件会被丢弃。`BroadcastStream` 使用 `lagged` 语义，消费者会收到 `Lagged` 错误并跳过中间事件。
- **影响评估**：**中**。在分析高峰期，一个需求分析可能产生数十到上百个 Pi 事件，256 容量对单个需求足够，但如果多个需求同时分析、多个 SSE 客户端连接，事件可能丢失。用户会看到 trace bubble 不连贯或跳步。
- **优化建议**：
  - 增大容量到 1024 或更高。
  - 在 `BroadcastStream` 处理中检测 `lagged` 情况并记录日志，便于排查。
  - 考虑按需求 ID 分多个 broadcast channel，避免不同需求之间的事件竞争同一缓冲区。

### 6. SSE 连接管理不完善

- **文件**：`src/main.rs:485-505`
- **相关代码**：
  ```rust
  Sse::new(stream).keep_alive(KeepAlive::default())
  ```
- **问题描述**：虽然使用了 `KeepAlive::default()`（默认间隔 5 秒发送 `:keep-alive` 注释），但前端 `EventSource` 在组件卸载时调用 `source.close()`，这是正确的。然而，如果前端页面崩溃或网络异常断开，SSE 连接可能长时间保持。`KeepAlive::default()` 的超时行为是 30 秒无数据则断开，但连接句柄仍可能累积。
- **影响评估**：**中**。大量用户或长时间运行后，半开连接可能累积，消耗内存和文件描述符。
- **优化建议**：
  - 在 `requirement_events` handler 中增加连接超时（如 5 分钟无活跃事件自动断开）。
  - 增加连接数监控指标。
  - 考虑使用 `tokio::time::timeout` 包装整个 SSE stream。

### 7. 120 秒超时与长时间分析任务

- **文件**：`src/main.rs:1884`
- **相关代码**：
  ```rust
  self.wait_for_agent_end_with_events(Duration::from_secs(120), ...).await?;
  ```
- **问题描述**：所有需求分析统一使用 120 秒超时。复杂需求（涉及多次工具调用、长思考链）可能超过 120 秒，导致分析被强制中断并标记为失败。
- **影响评估**：**中**。对于简单需求 120 秒足够，但对于复杂需求或 Pi Agent 响应慢时，频繁超时会影响用户体验。且超时后分析结果全部丢失，用户需要重新提交。
- **优化建议**：
  - 按需求复杂度动态调整超时（如根据消息长度、历史轮数估算）。
  - 提供可配置的超时设置（环境变量或 API 参数）。
  - 考虑将分析任务拆分为多个阶段（澄清 -> 草案 -> 确认），每阶段独立超时。

### 8. 需求消息列表无分页/虚拟化

- **文件**：`frontend/src/main.tsx:1060-1068`
- **相关代码**：
  ```tsx
  <div className="requirement-messages">
    {requirement.messages.map((message) => (
      <RequirementMessageBubble key={`${message.role}-${message.created_at}-${message.content}`} message={message} />
    ))}
  </div>
  ```
- **问题描述**：需求消息列表直接全量渲染，没有虚拟化或分页。当消息历史很长（多轮澄清 + 分析）时，DOM 节点数量线性增长。
- **影响评估**：**中**。长对话场景下，DOM 节点可能达到数百个，影响渲染性能和内存占用。
- **优化建议**：
  - 引入虚拟滚动（如 `react-window` 或 `react-virtuoso`），只渲染可见区域的消息。
  - 或限制消息历史显示条数（如最近 50 条），提供"展开全部"按钮。

### 9. TraceBubble 内容无限制增长

- **文件**：`frontend/src/main.tsx:1177-1234`, `frontend/src/main.tsx:2337-2421`
- **相关代码**：`buildBubbleStreamFromEvents` 累积所有 `pi_event` 到 `bubbles` 数组，`TraceBubble` 的 `useEffect` 每次 `bubbles` 变化都触发滚动。
- **问题描述**：`streamEvents` 数组只增不减（直到切换需求），`bubbles` 从所有事件中重建。长时间分析会产生大量气泡，每个气泡都带 DOM 节点和滚动监听。
- **影响评估**：**中**。分析过程中 trace bubble 列表持续增长，内存和渲染开销累积。
- **优化建议**：
  - 限制 trace bubble 最大数量（如 100 个），超出时合并或丢弃旧气泡。
  - 分析完成后将 `streamEvents` 清空或归档，避免长期占用内存。

---

## 三、轻微优化

### 10. FitViewOnGraphChange 频繁触发

- **文件**：`frontend/src/main.tsx:550-568`
- **相关代码**：
  ```typescript
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.16, duration: 260 });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [edgeCount, fitView, nodeCount]);
  ```
- **问题描述**：每次 `nodeCount` 或 `edgeCount` 变化（如输入一个字符导致 `nodes` 重建）都会触发 `fitView`，产生动画和重新布局计算。
- **影响评估**：**低**。80ms debounce 有一定缓解，但高频输入时仍可能频繁触发。
- **优化建议**：
  - 增加更长的 debounce（如 300ms），或仅在画布结构真正变化（如切换 canvas、新增/删除项目）时触发，排除输入字符等无关变化。

### 11. ModelSelect 每次打开都重建 options

- **文件**：`frontend/src/main.tsx:649-783`
- **相关代码**：`options` 数组在 JSX 中内联创建：`options={[ { value: "", label: "选择模型" }, ...data.models.map(...) ]}`。
- **问题描述**：每次 `ModelConfigNode` 渲染时，`ModelSelect` 的 `options` prop 都是新数组引用，触发内部重新渲染。
- **影响评估**：**低**。模型数量通常很少（< 20），影响有限。
- **优化建议**：在 `ModelConfigNode` 中使用 `useMemo` 缓存 `options` 数组。

### 12. project_canvas 每次遍历全量需求

- **文件**：`src/main.rs:760-820`
- **相关代码**：`project_canvas` 方法每次遍历 `self.data.requirements` 全量数组，做三次 `filter` + `collect` + `sort`。
- **问题描述**：时间复杂度 O(N log N)，N 为需求总数。虽然当前数据量小，但需求数增长后会累积。
- **影响评估**：**低**。在 `Mutex` 保护下执行，会延长锁持有时间。
- **优化建议**：
  - 在 `JsonStore` 中维护按 `project_id` 索引的 `HashMap<String, Vec<Requirement>>`，将查询降为 O(1)。
  - 或维护按状态分组的索引（`active`、`queued`、`completed`）。

### 13. requirement_events 中 requirement_id 每次 clone

- **文件**：`src/main.rs:485-505`
- **相关代码**：
  ```rust
  let stream = BroadcastStream::new(...).filter_map(move |event| {
      let requirement_id = requirement_id.clone();
      ...
  });
  ```
- **问题描述**：每个 SSE 事件处理都 `clone` 一次 `requirement_id` 字符串。
- **影响评估**：**极低**。字符串 clone 开销很小，但高频事件下可优化。
- **优化建议**：使用 `Arc<str>` 或 `&'static str` 避免每次 clone。

### 14. derive_requirement_title 每次创建需求都分配多次

- **文件**：`src/main.rs:2297-2309`
- **相关代码**：
  ```rust
  let compact = message.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(24).collect::<String>();
  ```
- **问题描述**：多次分配（`split_whitespace` -> `Vec` -> `join` -> `chars` -> `take` -> `collect`）。
- **影响评估**：**极低**。仅在创建需求时执行一次。
- **优化建议**：使用 `message.split_whitespace().fold` 或手动遍历字符，减少中间分配。

---

## 四、性能优化优先级

| 优先级 | 问题 | 文件 | 预期收益 |
|--------|------|------|----------|
| **P0** | Pi RPC 全局串行锁 | `src/main.rs:288` | 解锁多需求并发分析，消除排队超时 |
| **P0** | AppState.store 全局 Mutex | `src/main.rs:40` | 提升 API 并发吞吐量，减少读操作阻塞 |
| **P0** | JSON 全量序列化写入 | `src/main.rs:2195` | 消除 O(N) 写入瓶颈，支持大数据量 |
| **P0** | React useMemo 依赖爆炸 | `frontend/src/main.tsx:1881` | 消除输入卡顿，提升前端交互流畅度 |
| **P1** | broadcast channel 容量 | `src/main.rs:352` | 避免事件丢失，提升分析过程完整性 |
| **P1** | SSE 连接管理 | `src/main.rs:485` | 防止连接泄漏，提升长时稳定性 |
| **P1** | 120 秒超时 | `src/main.rs:1884` | 减少复杂需求超时失败 |
| **P1** | 消息列表虚拟化 | `frontend/src/main.tsx:1060` | 支持长对话不卡顿 |
| **P2** | TraceBubble 增长限制 | `frontend/src/main.tsx:1177` | 防止内存泄漏 |
| **P2** | FitView 防抖优化 | `frontend/src/main.tsx:550` | 减少无效布局动画 |
| **P2** | project_canvas 索引 | `src/main.rs:760` | 减少锁持有时间 |
| **P3** | 其他微优化 | 多处 | 边际收益 |

---

## 五、是否需要后台任务队列/Worker

**结论：当前阶段建议优先解决上述 P0 问题，后台任务队列是中期必要演进。**

理由：

1. **Pi RPC 串行锁是当前最大瓶颈**，即使引入任务队列，如果队列消费者仍然串行访问 Pi Agent，问题并未解决。应先解锁 Pi Agent 并发（多进程池或 Pi Agent 原生并发支持）。
2. **需求分析任务已经是异步的**（`tokio::spawn`），但缺乏：
   - 任务优先级（新需求 vs 重试）
   - 任务取消（用户中途取消分析）
   - 任务持久化（服务重启后恢复）
   - 并发控制（同时分析 N 个需求）
3. **建议演进路径**：
   - 短期：将 `Mutex<JsonStore>` 改为 `RwLock`，Pi Agent 改为连接池（2-4 个进程）。
   - 中期：引入 SQLite 替代 JSON 全量写入；引入任务队列（如 `tokio::mpsc` + 有限并发 worker）管理需求分析任务。
   - 长期：考虑将需求分析拆分为独立微服务，与主服务解耦。

---

*审核完成。未修改任何文件。*
