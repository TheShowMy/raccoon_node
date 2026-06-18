# raccoon_node 项目结构与构建流程审核报告

> 审核日期：2026/06/18
> 审核范围：项目根目录、src/main.rs、frontend/src/main.tsx、scripts/build.mjs、package.json、frontend/package.json、Cargo.toml、.pre-commit-config.yaml、docs/spec/TECH_STACK.md
> 审核维度：目录组织、前后端职责边界、单文件大小、构建脚本、pre-commit 流程、npm 脚本、开发体验、数据目录规则

---

## 一、高优先级问题

### 1. 后端单文件过大（src/main.rs 约 3000 行）

- **文件路径**：`src/main.rs`
- **问题描述**：`src/main.rs` 同时承载了：类型定义（约 300 行）、路由和 handler（约 200 行）、JsonStore 数据层（约 400 行）、Pi RPC 客户端（约 400 行）、需求分析解析逻辑（约 300 行）、工具函数（约 200 行）、单元测试（约 800 行）。
- **影响**：代码导航困难、增量编译优势丧失、多人协作冲突概率高、新成员上手慢。
- **改进建议**：按职责拆分为模块：
  - `src/models.rs` — 数据结构和枚举
  - `src/store.rs` — JsonStore 及持久化逻辑
  - `src/api/` — 路由和 handler 分层
  - `src/pi_rpc.rs` — PiRpcClient 和 ModelProvider trait
  - `src/requirement_analysis.rs` — prompt 构建、JSON 解析、澄清规范化
  - `src/error.rs` — AppError 及响应转换
  - `src/utils.rs` — 路径、格式化等工具函数
- **预期收益**：降低单文件复杂度，提升编译并行度，方便单元测试。

### 2. 前端单文件过大（frontend/src/main.tsx 约 2500 行）

- **文件路径**：`frontend/src/main.tsx`
- **问题描述**：单个文件包含类型定义、10+ 个节点组件、状态管理、API 调用、事件监听、工具函数、CSS-in-JSX 类名逻辑。
- **影响**：`App` 组件成为"上帝组件"，维护困难，任何小改动都可能导致整文件重编译，代码冲突频繁。
- **改进建议**：按功能拆分：
  - `frontend/src/types/api.ts` — 共享类型
  - `frontend/src/components/nodes/*.tsx` — 各节点子组件
  - `frontend/src/components/ui/` — 通用组件（ModelSelect、TraceBubble 等）
  - `frontend/src/hooks/` — useProject、useRequirement、useModelSettings、useEventSource
  - `frontend/src/api/client.ts` — fetch 封装
  - `frontend/src/utils/` — formatDate、shortenGitUrl、readError 等
  - `frontend/src/App.tsx` — 仅保留顶层编排
- **预期收益**：提升可维护性，支持并行开发，减少热更新范围。

### 3. pre-commit 本地钩子依赖 bash，Windows 开发者无法运行

- **文件路径**：`.pre-commit-config.yaml:37-84`
- **问题描述**：所有 local 钩子都使用 `entry: bash -c '...'`，Windows 默认没有 bash 环境。这与 CLAUDE.md 中"禁止跳过 pre-commit"的硬约束冲突。
- **影响**：Windows 开发者无法完成合规提交，等于阻塞了 Windows 开发流程。
- **改进建议**：
  - 将 `bash -c 'cd frontend && npm run ...'` 改为 `npm --prefix frontend run ...`
  - cargo 相关钩子改为直接 `cargo fmt -- --check` 等
  - 必要时提供 `scripts/pre-commit.bat` 或 `.ps1` 作为兜底
- **预期收益**：恢复 Windows 开发者的 pre-commit 可用性。

---

## 二、中优先级问题

### 4. 前端缺少测试框架和测试脚本

- **文件路径**：`frontend/package.json`
- **问题描述**：`scripts` 中无 `test` 命令，依赖中无 Vitest/Jest/Playwright。
- **影响**：前端零自动化测试，UI 回归风险高。
- **改进建议**：引入 Vitest + React Testing Library 做单元测试，Playwright 做 E2E 测试。
- **预期收益**：降低前端重构风险，提升交付信心。

### 5. scripts/build.mjs 健壮性不足

- **文件路径**：`scripts/build.mjs`
- **问题描述**：构建脚本假设 `cargo` 和 `npm` 在 PATH 中，失败时直接抛出，缺少前置检测和友好错误提示。Windows 下 `spawnSync` 启用 `shell: true` 存在命令注入风险。
- **影响**：新手在环境未配置好时难以定位问题；Windows 构建存在潜在安全问题。
- **改进建议**：
  - 在脚本开头检测 `cargo`、`npm`、`node` 可用性
  - 禁用 `shell: true`，改用 `npm.cmd`/`npm.exe` 直接执行
  - 增加清晰的错误提示和环境要求文档
- **预期收益**：提升构建脚本跨平台性和健壮性。

### 6. 数据目录规则未在代码中强制约束

- **文件路径**：`src/main.rs:2321-2343`
- **问题描述**：`RACCOON_DATA_FILE` 和 `RACCOON_PUBLIC_DIR` 环境变量可直接指向任意路径，缺少 `ensure_child_path` 校验。
- **影响**：用户可能误将数据文件配置到系统目录，造成数据泄露或损坏。
- **改进建议**：对环境变量传入的路径执行目录约束校验，限制在指定数据根目录内。
- **预期收益**：强化数据目录隔离，符合项目硬约束。

### 7. 缺少 README.md 和 API 文档

- **文件路径**：项目根目录、`src/main.rs`
- **问题描述**：没有 README.md，11 个 API 端点没有文档说明。
- **影响**：新开发者无法快速上手，前后端协作缺少契约。
- **改进建议**：
  - 新建 `README.md`，包含启动方式、目录结构、环境变量
  - 新建 `docs/api/README.md` 或 `docs/api/openapi.yaml` 描述所有端点
- **预期收益**：降低上手门槛，提升协作效率。

---

## 三、低优先级问题

### 8. concurrently 在 Windows 上进程终止不彻底

- **文件路径**：`package.json:6`
- **问题描述**：`npm run dev` 使用 concurrently 同时启动 cargo 和 vite，Windows 上 Ctrl+C 可能留下僵尸进程，导致端口占用。
- **影响**：开发体验偶尔需要手动结束进程。
- **改进建议**：在文档中说明，或尝试 `--kill-others-on-fail` 等选项。
- **预期收益**：减少开发环境端口占用问题。

### 9. 根目录 package.json 依赖较少但缺少 engines 声明

- **文件路径**：`package.json`
- **问题描述**：未声明 Node.js 版本要求，开发和 CI 可能出现版本不一致。
- **影响**：版本漂移可能导致构建失败。
- **改进建议**：添加 `engines` 字段，明确 Node.js 版本（如 `>=20`）。
- **预期收益**：统一开发环境。

### 10. Rust 未声明工具链版本

- **文件路径**：项目根目录
- **问题描述**：没有 `rust-toolchain.toml`，Rust 版本依赖开发者本地环境。
- **影响**：不同 Rust 版本可能导致编译行为差异。
- **改进建议**：添加 `rust-toolchain.toml`，锁定 Rust 版本（如 `channel = "1.86"`）。
- **预期收益**：统一 Rust 编译环境。

---

## 四、推荐重构路线图

### 短期（1-2 周）

1. 修复 pre-commit bash 依赖，恢复 Windows 可用性
2. 新建 README.md 和 API 文档
3. 声明 Node.js 和 Rust 版本要求
4. 修复 build.mjs 的 Windows shell 问题

### 中期（1-2 月）

1. 拆分 `src/main.rs` 为多个模块
2. 拆分 `frontend/src/main.tsx` 为组件/hooks/utils
3. 引入前端测试框架
4. 建立前后端共享类型定义机制（ts-rs / specta / JSON Schema）

### 长期（3-6 月）

1. 引入 SQLite 替代 JSON 全量存储
2. 引入任务队列管理需求分析
3. 完善 CHANGELOG、CONTRIBUTING、部署文档

---

## 五、优先级最高的 5 项改进

| 优先级 | 改进项 | 理由 |
|--------|--------|------|
| 1 | 修复 pre-commit bash 依赖 | Windows 开发者无法合规提交，阻塞开发流程 |
| 2 | 拆分 `src/main.rs` | 单文件 3000 行是最大的技术债务 |
| 3 | 拆分 `frontend/src/main.tsx` | 单文件 2500 行，维护困难 |
| 4 | 新建 README.md 和 API 文档 | 基础文档缺失，影响协作 |
| 5 | 修复 build.mjs Windows shell 和安全问题 | 构建流程跨平台性和安全性 |
