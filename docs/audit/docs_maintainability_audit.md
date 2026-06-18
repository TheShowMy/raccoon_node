# 文档与可维护性审核报告

> 审核日期：2026-06-18
> 审核范围：CLAUDE.md、AGENTS.md、docs/spec/TECH_STACK.md、src/main.rs、frontend/src/main.tsx、frontend/src/styles.css
> 审核维度：文档完整性、代码可维护性、类型一致性、注释质量、常量管理、中文文案一致性、API 文档、死代码/TODO

---

## 一、文档缺口

### 1.1 README.md 完全缺失（高优先级）

- **文件路径**：项目根目录
- **问题描述**：项目根目录没有 `README.md`，新开发者无法快速了解项目用途、技术栈、启动方式、目录结构。
- **改进建议**：新建 `README.md`，包含：项目简介、技术栈、快速启动（`npm run dev` / `npm run build`）、目录结构、API 概览、环境变量（`RACCOON_DATA_FILE`、`RACCOON_PUBLIC_DIR`、`RACCOON_HOST`/`RACCOON_PORT`）、贡献指南入口。
- **预期收益**：降低新开发者上手门槛，提升项目可发现性。

### 1.2 API 接口零文档（高优先级）

- **文件路径**：`src/main.rs`
- **问题描述**：所有 11 个 API 端点没有任何请求/响应格式说明：
  - `GET /api/start`
  - `POST /api/projects`
  - `DELETE /api/projects/{id}`
  - `GET /api/projects/{id}/canvas`
  - `POST /api/projects/{id}/requirements`
  - `POST /api/requirements/{id}/messages`
  - `POST /api/requirements/{id}/clarifications`
  - `GET /api/requirements/{id}/events`（SSE）
  - `POST /api/requirements/{id}/confirm`
  - `GET /api/settings/models`
  - `PUT /api/settings/models`
- **改进建议**：新建 `docs/api/README.md` 或 `docs/api/openapi.yaml`，用 OpenAPI 3.0 描述所有端点；或至少为每个 handler 添加 rustdoc 注释说明请求体/响应体/错误码。
- **预期收益**：前后端协作更高效，测试和第三方集成有依据。

### 1.3 CHANGELOG、CONTRIBUTING、部署文档缺失（低优先级）

- **文件路径**：项目根目录
- **问题描述**：没有 `CHANGELOG.md`、`CONTRIBUTING.md`、`docs/deployment.md`。
- **改进建议**：
  - `CHANGELOG.md`：遵循 Keep a Changelog 格式，记录版本变更。
  - `CONTRIBUTING.md`：说明提交规范、pre-commit 要求、分支策略。
  - `docs/deployment.md`：说明构建产物结构（`build/bin`、`build/public`、`build/data`）和环境变量配置。
- **预期收益**：规范发布流程，方便外部贡献。

---

## 二、可维护性问题

### 2.1 前后端类型完全重复定义（高优先级）

- **文件路径**：`frontend/src/main.tsx` + `src/main.rs`
- **问题描述**：以下 15+ 类型在前端和后端各自独立定义，字段名和结构必须手动保持一致，存在类型漂移风险：
  - `Project`（id, name, git_url, local_path, created_at, updated_at）
  - `Requirement`（id, project_id, title, original_message, status, messages, clarification_round, clarifications, draft, pi_session_file, error, created_at, updated_at）
  - `RequirementMessage`（role, content, metadata, created_at）
  - `RequirementDraft`（title, summary, acceptance_criteria）
  - `RequirementClarification`（id, question, question_type, options, answer）
  - `ClarificationOption`（value, label, description, recommended）
  - `ClarificationAnswer`（selected_options, custom_text）
  - `ModelSettings` / `ModelTierSetting`（low/medium/high 三档）
  - `PiModel`（id, name, provider, reasoning）
  - `SummaryNode`（title, description）
- **改进建议**：引入共享类型定义机制：
  - **方案 A**：用 `ts-rs` 或 `specta` 从 Rust 生成 TypeScript 类型，作为构建步骤的一部分。
  - **方案 B**：将类型定义到独立 JSON Schema，前后端均从 Schema 生成。
  - **方案 C**：至少建立一个 `frontend/src/types/api.ts` 由前端引用，后端通过单元测试断言保证序列化一致性。
- **预期收益**：消除类型漂移风险，减少维护成本，重构时更安全。

### 2.2 前端单文件职责过重（中优先级）

- **文件路径**：`frontend/src/main.tsx`
- **问题描述**：单个文件 2503 行，包含：所有类型定义（约 200 行）、所有节点组件（CreateProjectNode、ProjectListNode、ProjectItemNode、DeleteConfirmNode、ModelConfigNode、StyleSettingsNode、ProjectBackNode、RequirementListNode、RequirementChatNode 等）、所有状态管理（useState x 20+）、所有 API 调用逻辑、所有辅助函数（formatDate、readError、parseStreamEvent、shortenGitUrl 等）。
- **改进建议**：按职责拆分为：
  - `frontend/src/types/api.ts` — 所有共享类型
  - `frontend/src/nodes/*.tsx` — 各节点组件
  - `frontend/src/hooks/useProject.ts` — 项目相关状态和 API
  - `frontend/src/hooks/useRequirement.ts` — 需求相关状态和 SSE
  - `frontend/src/hooks/useModelSettings.ts` — 模型设置状态
  - `frontend/src/api/client.ts` — fetch 封装
  - `frontend/src/utils/format.ts` — 日期、URL、错误格式化
- **预期收益**：提升可维护性，支持并行开发，减少合并冲突。

### 2.3 后端模块未拆分（中优先级）

- **文件路径**：`src/main.rs`
- **问题描述**：`main.rs` 3049 行，包含所有类型定义（约 300 行）、JsonStore 存储逻辑（约 400 行）、所有 API handler（约 200 行）、Pi RPC 客户端（约 400 行）、需求分析解析逻辑（约 300 行）、测试（约 800 行）。
- **改进建议**：按域拆分为：
  - `src/models.rs` — 所有数据类型（Project、Requirement、ModelSettings 等）
  - `src/store.rs` — JsonStore 及持久化逻辑
  - `src/api/mod.rs` + `src/api/*.rs` — 各 API handler
  - `src/pi_rpc.rs` — PiRpcClient 及 RPC 协议实现
  - `src/error.rs` — AppError 及响应转换
  - `src/requirement_analysis.rs` — 提示词构建、JSON 解析、澄清规范化
- **预期收益**：提升编译并行度，降低认知负荷，方便单元测试。

### 2.4 魔术数字/常量散落（中优先级）

- **文件路径**：`src/main.rs` + `frontend/src/main.tsx` + `frontend/src/styles.css`
- **问题描述**：业务阈值和尺寸常量未集中管理：
  - `src/main.rs:1884` — `Duration::from_secs(120)` 需求分析超时
  - `src/main.rs:352` — `broadcast::channel(256)` 事件广播容量
  - `src/main.rs:1462` — `.take(6)` 澄清问题上限
  - `src/main.rs:1511` — `.truncate(4)` 选项上限
  - `src/main.rs:2303` — `.take(24)` 需求标题截断长度
  - `frontend/src/main.tsx:47-55` — 节点布局常量（PROJECT_LIST_WIDTH=420、PROJECT_ITEM_HEIGHT=86、PROJECT_ITEM_GAP=12 等）
  - `frontend/src/styles.css` — 大量 CSS 尺寸硬编码（28px、1.5px、32px 等）
- **改进建议**：
  - Rust 侧：建立 `src/constants.rs`，将所有业务阈值提取为 `const`。
  - 前端侧：布局常量可保留在 `constants.ts`，CSS 尺寸若需主题化可提取到 CSS 变量。
- **预期收益**：统一调整行为阈值，减少魔法值导致的维护困惑。

### 2.5 中文文案与代码命名映射分散（中优先级）

- **文件路径**：`frontend/src/main.tsx` + `src/main.rs`
- **问题描述**：状态/角色的显示文本分散在多个辅助函数中：
  - `modelStatusText()` — 将 rpcStatus 映射为中文
  - `requirementStatusText()` — 将 RequirementStatus 映射为中文
  - `requirementMessageRoleText()` — 将 role 映射为中文
  - `traceStatusText()` — 将 trace status 映射为中文
  - `tierLabels` — 将 ModelTierKey 映射为中文
  - `thinkingLevels` — 将 ThinkingLevel 映射为中文
  - 后端 `validate_tier_model()` 中硬编码 `"低"`、`"中"`、`"高"` 档中文名
- **改进建议**：将所有状态/角色的显示文本集中到一个映射表或 i18n 字典中；后端验证错误中的中文档名也应从同一来源获取。
- **预期收益**：减少翻译遗漏，支持未来多语言。

### 2.6 代码注释质量两极分化（高优先级）

- **文件路径**：`src/main.rs` + `frontend/src/main.tsx`
- **问题描述**：
  - **有价值的 WHY 注释**（应保留并推广）：
    - `buildBubbleStreamFromTrace:2331-2334` — "trace.output is intentionally not rendered: Pi Agent returns structured JSON..."
    - `buildBubbleStreamFromEvents:2351-2353` — "Only stream thinking deltas; text deltas contain the structured JSON..."
    - `collect_message_update:1641-1643` — "text_delta contains the structured JSON response; it is parsed into the assistant message..."
  - **完全无注释的复杂函数**：
    - `parse_requirement_analysis` — 解析 Pi Agent 返回的 JSON，涉及多种状态分支
    - `extract_json_object` / `find_balanced_braces` / `sanitize_json_fragment` — JSON 提取和修复逻辑
    - `build_pi_trace_metadata` — 将 Pi Agent 事件转换为 trace 元数据
    - `upsert_trace_tool` — 工具调用状态的合并逻辑
- **改进建议**：为所有非平凡的纯函数和解析逻辑添加单行 rustdoc/注释，说明输入/输出/边界行为；提示词模板（`build_requirement_prompt` 的 70 行内嵌字符串）可抽离到独立文件或常量。
- **预期收益**：降低代码理解成本，方便后续修改提示词。

---

## 三、其他发现

### 3.1 CLAUDE.md / AGENTS.md 一致性（无问题）

- 两者内容逐字一致，同步要求已落实。
- **建议**：在 pre-commit 或 CI 中添加自动化 diff 检查，防止未来因疏忽导致不一致。

### 3.2 无 TODO/FIXME 标记（中性）

- 搜索全仓库未找到任何 TODO/FIXME/XXX/HACK。
- 说明代码较干净，但也可能意味着潜在改进点未被记录。
- **建议**：保持现状；未来遇到临时方案时主动添加 TODO 并关联 issue。

### 3.3 CSS 类名前缀（风险低）

- `frontend/src/styles.css` 中所有类名已有语义前缀（`node-`、`project-`、`requirement-`、`model-`、`clarification-`、`trace-` 等），与其他库冲突风险极低。
- **建议**：保持现状即可；如需更强隔离可迁移到 CSS Modules。

### 3.4 Windows 路径处理（低风险）

- `src/main.rs:2262-2272` 的 `normalize_components` 中 `Component::Prefix` 分支在 Windows 上会被用到，但 `Component::RootDir` 的 `"/"` 在 Windows 路径中可能不触发。
- **建议**：为 `normalize_components` 添加一行注释说明跨平台行为。

---

## 四、优先级最高的 5 项改进

| 优先级 | 改进项 | 理由 |
|-------|-------|------|
| 1 | **新建 README.md** | 最基础文档缺失，影响所有新开发者 |
| 2 | **建立前后端共享类型定义机制** | 15+ 类型重复定义是最突出的可维护性债务，类型漂移风险高 |
| 3 | **编写 API 文档** | 11 个端点无任何文档，前后端协作和测试缺乏契约依据 |
| 4 | **拆分前端 `main.tsx`** | 2503 行单文件阻碍并行开发和代码审查 |
| 5 | **为关键函数添加注释** | `parse_requirement_analysis`、`extract_json_object` 等复杂逻辑无注释，理解成本高 |

---

## 五、文档建设推荐顺序

1. **README.md** — 最基础，影响最大，新开发者第一眼看到的内容
2. **API 文档** — 用 rustdoc + 手写 `docs/api.md` 或 OpenAPI YAML，为前后端协作提供契约
3. **前后端类型共享** — 技术方案需先调研（ts-rs / specta / JSON Schema），然后实施
4. **前端文件拆分** — 与类型共享同步进行，拆分后类型共享更容易落地
5. **Rust 模块拆分** — 在 API 文档完成后进行，此时对模块边界已有清晰认识
6. **TECH_STACK.md 补充** — 补充 SSE、广播、RPC 等细节
7. **CHANGELOG + CONTRIBUTING + 部署文档** — 项目进入稳定迭代期后再完善
