# raccoon_node 代码质量审核报告

**审核日期**：2026/06/18
**审核文件**：
- `src/main.rs`（约 3000 行 Rust 后端）
- `frontend/src/main.tsx`（约 2500 行 React/TypeScript 前端）
- `frontend/src/styles.css`

**关注维度**：
1. 单一职责与函数/组件长度
2. 嵌套深度与可读性
3. 重复代码与可复用抽象
4. 命名清晰度
5. TypeScript/Rust 类型安全
6. 错误处理一致性
7. 项目硬约束合规性（Pi Agent RPC、数据目录限制）
8. React 副作用、状态管理、事件监听清理

---

## 严重问题

### 1. 前端 `main.tsx` 约 2500 行，职责严重混杂

- **文件**：`frontend/src/main.tsx`，全文件
- **问题**：一个文件承载了类型定义（~100 行）、所有 React 组件（10+ 个节点子组件）、工具函数、状态管理、事件处理。`App` 组件是典型的"上帝组件"，持有 20+ 个 state 变量和大量业务逻辑。`nodes` 的 `useMemo` 依赖数组长达 35 项，极易因遗漏依赖导致 stale closure 或无限循环。
- **影响**：维护困难、代码冲突频繁、编译/热更新慢、新成员难以快速定位代码。
- **改善建议**：按功能拆分为独立模块：
  - `types.ts` — 所有类型定义
  - `components/nodes/` — 各节点子组件（CreateProjectNode、RequirementChatNode 等）
  - `components/ui/` — 通用组件（ModelSelect、TraceBubble 等）
  - `hooks/` — 自定义 hooks（useModelSettings、useProjectCanvas、useEventSource 等）
  - `utils/` — 工具函数
  - `App.tsx` — 仅保留节点编排和顶层布局

### 2. `StartNode` 组件类型分支过多，违背开闭原则

- **文件**：`frontend/src/main.tsx:325-419`
- **问题**：`StartNode` 通过 `data.kind` 做 10 路条件渲染，且 Handle 的显隐逻辑也散落在条件中。新增节点类型必须修改此组件，容易遗漏 Handle 配置。
- **影响**：扩展困难，新增节点类型时容易引入 bug。
- **改善建议**：将 `StartNode` 改为纯容器（只负责 Handle 和样式壳），通过 `nodeTypes` 映射注册各类型节点组件。每个节点类型独立成文件。

### 3. Rust 后端 `main.rs` 约 3000 行，未按模块拆分

- **文件**：`src/main.rs`，全文件
- **问题**：路由、handler、数据层、Pi RPC 客户端、领域模型、工具函数、测试全部在一个文件。编译单元过大，增量编译优势丧失。
- **影响**：代码导航困难；多人协作时冲突频繁；编译时间长。
- **改善建议**：拆分为：
  - `models/` — 数据结构（Project、Requirement 等）
  - `store.rs` — JsonStore 及持久化逻辑
  - `api/` — 路由和 handler
  - `pi_rpc/` — PiRpcClient 和 ModelProvider trait
  - `utils.rs` — 辅助函数

---

## 中等问题

### 4. `JsonStore` 锁粒度偏粗，存在并发瓶颈

- **文件**：`src/main.rs:665-725`
- **问题**：`JsonStore` 被 `Arc<Mutex<JsonStore>>` 包裹，`create_project` 中执行 `git clone` 会长时间持有锁，阻塞其他请求。
- **影响**：高并发时 API 响应延迟显著增加。
- **改善建议**：`git clone` 等 IO 密集型操作应在锁外执行，仅保留数据修改在锁内。先计算路径、执行 clone，成功后再获取锁写入数据。

### 5. `wait_for_agent_end_with_events` 字符串复用不利于调试

- **文件**：`src/main.rs:1969-2008`
- **问题**：`line.clear()` 后复用同一个 `String` 读取，但 `serde_json::from_str` 借用了 `line` 的切片。如果解析失败抛出错误，`line` 内容已经丢失，不利于调试。
- **影响**：调试困难；代码模式容易误导后续维护者。
- **改善建议**：每次读取使用新的 `String`，或至少在错误日志中保留 `trimmed` 内容。

### 6. 前端 `EventSource` 未处理错误重连

- **文件**：`frontend/src/main.tsx:1573-1613`
- **问题**：`EventSource` 只设置了 `onmessage` 和 `addEventListener`，没有 `onerror` 处理。网络中断后不会自动重连，用户界面会卡住。
- **影响**：网络波动导致功能不可用，用户无感知。
- **改善建议**：添加 `source.onerror` 处理，实现指数退避重连或至少提示用户网络异常。

### 7. `styles.css` 存在大量重复样式和 `!important`

- **文件**：`frontend/src/styles.css:92-135` 与 `884-943`
- **问题**：`.react-flow__controls` 和 `.react-flow__controls-button` 的样式在 `@layer components` 和 `@layer utilities` 中几乎完全重复。`!important` 在 `theme-switcher__item--active` 等类中过度使用。
- **影响**：样式优先级难以预测，维护困难。
- **改善建议**：合并重复样式；用 Tailwind 的 `@apply` 或 CSS 变量替代 `!important`。

### 8. `build_requirement_prompt` 硬编码巨型提示词

- **文件**：`src/main.rs:1183-1297`
- **问题**：约 110 行的 raw string 提示词直接嵌入代码，难以维护和版本控制。
- **影响**：修改提示词需要改代码并重新编译；非程序员无法参与提示词优化。
- **改善建议**：将提示词提取为独立文件（如 `prompts/requirement_coordinator.txt`），编译时通过 `include_str!` 嵌入。

### 9. `requirement_events` SSE handler 中序列化失败丢失上下文

- **文件**：`src/main.rs:485-505`
- **问题**：`serde_json::to_string` 的 `unwrap_or_else` 处理了序列化失败，但 fallback 字符串是硬编码的，丢失了原始事件上下文。
- **影响**：调试时无法知道哪个事件导致序列化失败。
- **改善建议**：记录错误日志，保留事件类型信息。

---

## 轻微问题

### 10. `normalize_components` Windows 路径前缀处理可能不正确

- **文件**：`src/main.rs:2262-2272`
- **问题**：Windows 路径前缀（如 `C:`）被保留为独立组件，但 `ensure_child_path` 做字符串前缀匹配时可能因大小写或分隔符不一致导致误判。
- **影响**：数据目录逃逸检查在边缘场景下可能失效。
- **改善建议**：使用 `std::fs::canonicalize` 后比较绝对路径。

### 11. `derive_requirement_title` 对中文截断不友好

- **文件**：`src/main.rs:2297-2310`
- **问题**：`chars().take(24)` 对中文按字符计数，但前端显示可能按字节或像素宽度。24 个字符的中文标题在 UI 上可能超出。
- **影响**：UI 显示可能截断。
- **改善建议**：前端做溢出处理（如 `text-overflow: ellipsis`），或后端限制更保守。

### 12. 前端中文文案散落，不利于国际化

- **文件**：`frontend/src/main.tsx` 多处（如 `requirementStatusText`、`modelStatusText`、`requirementMessageRoleText`）
- **问题**：中文文案散落在各处函数中，未来如需多语言支持，改动面广。
- **影响**：国际化成本高。
- **改善建议**：建立 `locales/zh.ts` 集中管理所有用户可见文案。

### 13. `TraceBubble` 的 `useEffect` 滚动依赖 `bubbles` 数组引用

- **文件**：`frontend/src/main.tsx:1189-1197`
- **问题**：`bubbles` 是数组，每次父组件渲染都会创建新引用，导致 `useEffect` 频繁触发 `requestAnimationFrame`。
- **影响**：性能开销，虽然轻微。
- **改善建议**：只对 `bubbles.length` 或最后一个元素内容做依赖。

### 14. `ModelSelect` 的 `useEffect` 清理函数模式不够稳健

- **文件**：`frontend/src/main.tsx:681-696`
- **问题**：`handleClickOutside` 的 `useEffect` 依赖只写了 `open`，如果 `setOpen` 的引用变化可能导致问题。
- **影响**：轻微，但模式不够稳健。
- **改善建议**：使用 `useRef` 保存最新回调，或改用 `useEventListener` 封装。

---

## 优先级最高的 5 条改进建议

1. **拆分 `frontend/src/main.tsx`** — 按类型/组件/hooks 拆分为 8-10 个模块，优先拆分 `App` 组件和 `StartNode` 子节点组件。这是当前最大的技术债务，直接影响维护效率和开发体验。

2. **拆分 `src/main.rs`** — 至少将 `JsonStore`、`PiRpcClient`、路由 handler 拆到独立文件，降低编译单元粒度，提升增量编译效率。

3. **为 `EventSource` 添加错误处理和重连机制** — 在 `frontend/src/main.tsx:1573-1613` 添加 `onerror` 处理，实现指数退避重连，避免网络波动导致功能不可用。

4. **将 `git clone` 移出 `JsonStore` 锁范围** — 在 `src/main.rs:665-725` 中，先计算路径、执行 clone，成功后再获取锁写入数据，消除并发瓶颈。

5. **提取硬编码提示词为外部文件** — 将 `build_requirement_prompt` 的 110 行提示词移入 `prompts/` 目录，使用 `include_str!` 加载，便于非程序员维护提示词。
