# Astryx PoC 与兼容报告

更新时间：2026-07-07

## 结论

当前迁移已经完成 Tailwind 工具链移除和 Astryx 基础接入：

- `frontend/package.json` 不再依赖 `tailwindcss` 或 `@tailwindcss/vite`。
- `frontend/src/styles/index.css` 直接导入 Astryx `reset.css`、`astryx.css` 和默认 `theme-neutral/theme.css`。
- `frontend/src/styles/theme/` 与 `frontend/src/styles/components/` 中的退休空壳 CSS 已删除，当前样式入口只保留 `frontend/src/styles/index.css`。
- 前后端主题契约已统一为 `theme_pack` + `theme_mode`，默认值为 `neutral` + `dark`。
- 设置面板可以保存主题包和明暗模式，前端通过 Astryx `Theme` provider 渲染。
- 模型设置中的自定义 `SimpleSelect` 已替换为 Astryx `Selector`。
- 未被调用的旧 `TraceBubble` 自定义组件及其样式已删除。
- `DocumentPreview` 已替换为 Astryx `Collapsible`、`Stack`、`Text`、`IconButton` 与 `CodeBlock`，并删除 `.document-preview*` 旧样式。
- 未被调用的旧 `ClarificationPanel` 自定义组件及其 `.clarification-*` 样式已删除。
- `ProcessStreamRows` 的工具调用详情已从自定义 `<pre>` / `.rq-process-row__content` 切换为 Astryx `CodeBlock`，保留 `ChatToolCalls` 展开行为。
- `NodeBar` 标题/副标题已改用 Astryx `Text`，标题栏 icon-only 操作已改用 Astryx `IconButton`，并删除 `.node-bar__btn` 旧按钮样式。
- `TokenUsageNode` 指标区域已改用 Astryx `Grid`、`Card`、`Stack` 和 `Text`，删除重复的旧 collapsed/header/grid/value/empty 样式。
- `ProjectGithubNode` 展开内容已改用 Astryx `Stack`、`Text`、`StatusDot` 和 `List`，删除旧 issues/notes/restart 文本列表样式。
- `RequirementListNode` 状态与任务进度已改用 Astryx `Token`，重新生成操作改用 Astryx `Button`，删除旧 status pill 和 action button 样式。
- `RequirementDagNode` 关闭操作已改用 Astryx `IconButton`，正文已改用 Astryx `Stack` 和 `Text`，删除不再使用的 DAG action/body 文本样式。
- AI 对话核心组件已开始使用 Astryx Chat 组件：`ChatMessage`、`ChatMessageBubble`、`ChatMessageMetadata`、`ChatSystemMessage`、`ChatMessageList`、`ChatComposer`、`ChatToolCalls`。
- `RichContent` 的 fenced code 渲染已切换到 Astryx `CodeBlock`，继续保留 `react-markdown` + `remark-gfm` 以保持 GFM 行为。
- `SessionTranscript` 的 thinking、tool call、tool result、unknown 和 raw JSON 输出已切换到 Astryx `CodeBlock`；diff 仍保留自定义逐行 `<pre>` 以支持增删行高亮。
- `ProjectGitNode` 的批量暂存/取消、远端 Fetch/Pull/Push、新分支输入、diff 预览、提交输入、提交按钮和确认按钮已迁移到 Astryx `Button`、`CheckboxInput`、`TextInput`、`TextArea` 和 `CodeBlock`，并删除对应旧按钮/输入/diff 样式覆盖。
- `ProjectTerminalNode` 的终端授权、命令标签、命令管理、profile 编辑和 tab 关闭按钮已迁移到 Astryx `Button`、`IconButton` 和 `TextInput`；xterm viewport 和 tab 主选择行为保留。
- `ModelSettingsPanel` 的重载、保存、Pi 登录终端操作和终端授权输入已迁移到 Astryx `Button` 和 `TextInput`；档位卡片 radio 结构暂保留自定义实现。
- `RequirementTaskNode` 的恢复、详情、折叠和详情弹窗关闭操作已迁移到 Astryx `Button` / `IconButton`；原生 `<dialog>` 和任务流布局保持不变。

## Tailwind 残留审计

已验证命令：

```powershell
rg -- '--tw-|@apply|@theme|tailwindcss|@tailwindcss' frontend/src frontend/package.json frontend/vite.config.ts
```

结果：无输出。

说明：

- `frontend/node_modules/` 中仍存在 Astryx 官方文档和包源码对 Tailwind bridge 的说明，这是依赖包内容，不是本项目有效配置。
- `docs/spec/ASTORYX_MIGRATION_PLAN.md` 保留 Tailwind 作为迁移背景说明。
- `docs/audit/` 中的历史审计仍会提到 Tailwind，属于历史记录，不影响运行时迁移状态。

## Token 映射

`frontend/src/styles/index.css` 中保留的项目级 alias 已改为引用 Astryx token：

- 文字：`--font-sans`、`--font-mono`、`--text-*` 映射到 Astryx 字体与字号 token。
- 半径：`--radius-md/lg/xl/node` 映射到 `--radius-element` 和 `--radius-container`。
- 颜色：画布、面板、边框、文本和状态色优先映射到 `--color-*` Astryx semantic token。
- 阴影：`--shadow-card`、`--shadow-hover`、`--shadow-popover` 映射到 `--shadow-low/med/high`。
- React Flow 和节点仍保留项目 alias，例如 `--canvas-bg`、`--card-border`、`--accent-model`，但这些 alias 的来源是 Astryx token。

本轮同时移除了旧 Tailwind 转译产物中的 `--tw-*` 自定义属性和生成的 Tailwind preflight/property 块。

## 后端影响

主题契约已落地：

- `src/config.rs`：`theme_pack: String` + `ThemeMode`。
- `src/api/handlers.rs` 与 `src/models/mod.rs`：基础设置和当前项目响应返回 `theme_pack` / `theme_mode`。
- `docs/api/README.md`：已记录 `GET/PUT /api/settings/basic` 和 `GET /api/project/current` 的主题字段。
- 前端类型位于 `frontend/src/types/api.ts`，与后端字段一致。

未引入 `system` 模式；当前仅支持 `light` / `dark`。

## Markdown 兼容

当前继续保留：

- `react-markdown`
- `remark-gfm`

原因：现有 `RichContent` 需要稳定支持 GFM 表格、任务列表、自定义代码复制按钮和项目内消息渲染行为。Astryx `Markdown` 可以作为后续替换候选，但本轮不牺牲现有 GFM 行为。

## Bundle 影响

本轮 CSS 清理前后，Vite 生产构建中的主 CSS 变化如下：

| 项目 | 清理前 | 清理后 |
| --- | ---: | ---: |
| 主 CSS | 368.18 kB | 277.93 kB |
| 主 CSS gzip | 50.95 kB | 43.48 kB |

主题包仍按需拆分为独立 CSS chunk。Vite 仍提示主 JS chunk 超过 500 kB，以及 `theme-neutral` 同时静态和动态导入导致无法拆出模块；这是既有状态，后续可单独优化。

## 验证

已通过：

```powershell
npm --prefix frontend run check
npm --prefix frontend run test -- --run src/components/ui/DocumentPreview.test.tsx
npm --prefix frontend run test -- --run src/components/ui/ProcessStreamRows.test.tsx src/components/requirements/RequirementConversation.test.tsx src/components/nodes/RequirementChatNode.test.tsx
npm --prefix frontend run test -- --run src/components/nodes/ProjectGitNode.test.tsx src/components/nodes/ProjectTerminalNode.test.tsx src/components/nodes/ProjectSettingsNode.test.tsx src/components/nodes/ProjectGithubNode.test.tsx src/components/nodes/TokenUsageNode.test.tsx
npm --prefix frontend run test -- --run src/components/nodes/RequirementListNode.test.tsx src/components/nodes/RequirementDagNode.test.tsx
npm --prefix frontend run test -- --run src/components/ui/SessionTranscript.test.tsx
npm --prefix frontend run test -- --run src/components/nodes/RequirementTaskNode.test.tsx
npm --prefix frontend run test -- --run
npm --prefix frontend run build
npm run check
git diff --check
```

前序已通过：

```powershell
npm --prefix frontend run check
npm --prefix frontend run test -- --run
npm --prefix frontend run build
npm --prefix frontend run test -- --run src/hooks/useModelSettings.test.ts src/components/nodes/ProjectSettingsNode.test.tsx src/components/terminal/TerminalSessionView.test.tsx
```

本轮 `npm run check` 已完整通过：前端类型检查、30 个前端测试文件 / 179 个测试、前端生产构建、平台脚本测试、150 个 Rust 单元测试、28 个集成测试、doc-test 以及 `cargo publish --dry-run --locked --allow-dirty` 均通过。构建仍保留既有 Vite 警告：`theme-neutral` 同时静态和动态导入导致无法拆分，以及主 JS chunk 超过 500 kB。

`pre-commit run --all-files` 在当前 Windows 环境未能执行：`pre-commit`、`python`、`py` 均不在 PATH 中；Codex 内置 Python 可用，但未安装 `pre_commit` 模块。未安装额外工具或修改用户环境。

## Additional migration note

- `SessionTranscript` filters, system toggle, load/retry actions, and diff utility actions now use Astryx `Button` / `CheckboxInput`; the remaining transcript `<pre>` is limited to custom diff line highlighting.
- `AnchoredScroll` now uses Astryx `Button` for the new-message jump action, with custom CSS reduced to overlay positioning.
- Latest focused validation: `npm --prefix frontend run test -- --run src/components/ui/SessionTranscript.test.tsx` and `npm --prefix frontend run check`.
