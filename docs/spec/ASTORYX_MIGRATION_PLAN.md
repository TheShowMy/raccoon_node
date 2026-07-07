# Astryx 前端设计系统迁移计划

> 目标：把 `frontend/` 从纯 Tailwind + 自定义 CSS 迁移到 **Astryx**（`@astryxdesign/core`），**彻底移除 Tailwind CSS v4**，完全使用 Astryx 提供的主题、token 与组件；保留 React Flow 节点画布特色，并让 AI 对话 UI 直接对齐 Astryx 官方 AI Chat 模板。

---

## 1. 目标与原则

1. **完全移除 Tailwind CSS v4**：包括 `tailwindcss`、`@tailwindcss/vite` 依赖、`@theme` 块、`@apply` 工具类、所有 utility class。
2. **完全使用 Astryx 设计语言**：布局、组件、排版、对话、表单、按钮全部使用 Astryx；自定义样式只保留节点/画布覆盖，且只引用 Astryx CSS 变量。
3. **主题由 Astryx 接管**：使用 `@astryxdesign/theme-*` 系列主题包，每个主题都支持 `light` / `dark` 模式；设置面板需同时支持「主题包切换」和「明暗模式切换」。
4. **AI 对话参考官方模板**：以 `npx astryx template ai-chat --skeleton` 为基准，重写 `RequirementChatNode`、`RequirementConversation`、`ChatComposer`、`ChatMessageBubble` 等。
5. **渐进迁移，不立 flag**：按「工具链 → 主题 → 布局/基础组件 → 对话 → 节点 → 清理」六阶段推进，每阶段独立可合并。
6. **前端设计优先，后端配合**：主题模型、设置 API 随前端需求改造，不为了保留后端字段而限制 UI 设计。

---

## 2. 现状速览

| 项目 | 现状 |
|------|------|
| 组件库 | 无第三方 UI 库，43 个自定义 `.tsx` 组件 |
| 样式 | Tailwind CSS v4（CSS-only），`frontend/src/styles/components/all.css` 约 4650 行全局样式，含大量 `@apply` |
| 主题 | 自定义 CSS 变量：`tokens.css` + `spacing.css` + `typography.css`，暗色模式通过 `data-theme="dark"` |
| 主题设置 | `useCurrentProject` 本地状态，`applyTheme` 直接写 `document.documentElement.dataset.theme`；仅支持 light/dark |
| 对话 UI | `ChatMessageBubble`、`ChatComposer`、`ProcessStreamRows`、`AnchoredScroll`、`RequirementConversation` |
| 节点 UI | `StartNode`、`NodeBar`、10 个具体节点组件，React Flow `@xyflow/react` |
| 图标 | `lucide-react`（Astryx 也用它，保留） |
| Markdown | `react-markdown` + `remark-gfm`（需评估 Astryx `Markdown` 是否满足 GFM） |

---

## 3. Astryx 选型依据

- **核心包**：`@astryxdesign/core@0.1.3`。
- **主题包**：Astryx 已发布 7 套独立主题，每套都内置亮/暗色：
  - `@astryxdesign/theme-neutral`（克制暖灰，默认）
  - `@astryxdesign/theme-stone`（温暖石色）
  - `@astryxdesign/theme-matcha`（柔和绿色）
  - `@astryxdesign/theme-y2k`（复古亮粉/青柠）
  - `@astryxdesign/theme-chocolate`（温暖巧克力棕）
  - `@astryxdesign/theme-gothic`（深蓝灰+衬线）
  - `@astryxdesign/theme-butter`（奶油黄+蓝色点缀）
- **构建方式**：Astryx 提供预构建 CSS `astryx.css`，**不强制项目接入 StyleX 编译**；自定义样式用普通 CSS 引用 Astryx CSS 变量即可。
- **关键组件**：
  - 布局：`Stack`、`HStack`、`VStack`、`Layout`、`AppShell`。
  - 基础：`Button`、`ButtonGroup`、`IconButton`、`TextInput`、`TextArea`、`Selector`、`Dialog`、`TabList`、`Badge`、`Token`。
  - 对话（与项目高度匹配）：`ChatLayout`、`ChatComposer`、`ChatMessageList`、`ChatMessage`、`ChatMessageBubble`、`ChatMessageMetadata`、`ChatSystemMessage`、`ChatToolCalls`、`ChatTokenizedText`、`Tokenizer`。
  - 内容：`Markdown`、`CodeBlock`、`Timestamp`。
- **AI 模板**：CLI 提供 `ai-chat` 页面模板，可直接作为重构参考骨架。

---

## 4. 迁移阶段

### Phase 0 — 预研与基线（1~2 天）

1. **Tailwind 使用情况审计**：
   - 统计所有 `.tsx`、`.css` 中 Tailwind utility class 和 `@apply` 数量。
   - 列出 `tokens.css` 中自定义变量与 Astryx token 的映射关系。
2. **后端影响评估**：
   - 识别因前端设计系统切换而需要后端配合的变更点（主题包 + 明暗模式模型）。
   - 输出后端变更清单，纳入迁移计划。
3. **最小 PoC**：
   - 安装 `@astryxdesign/core` + 全部 `@astryxdesign/theme-*` 包。
   - 临时保留 Tailwind，验证 Astryx `Theme` + `Button` + `Card` 在现有页面可正常渲染。
   - 验证切换不同主题包与亮/暗模式是否生效。
   - 验证 Astryx `Markdown` 是否支持 GFM tables/tasklists；如不满足，规划保留 `react-markdown`。
4. 输出：
   - `docs/spec/astryx-poc-report.md`（Tailwind 用量、token 映射、后端变更清单、Markdown 兼容结论、bundle 增量）。
5. 不回退条件：PoC 在 `npm run check` 与 `npm run build` 通过。

### Phase 1 — 移除 Tailwind、接入 Astryx 主题（3~4 天）

1. **卸载 Tailwind**：
   - `npm uninstall tailwindcss @tailwindcss/vite`。
   - 删除 `vite.config.ts` 中的 `@tailwindcss/vite` 插件。
2. **替换 `styles/theme/*.css`**：
   - 删除 `tokens.css` 中的 `@theme` 块和自定义颜色/间距变量。
   - 保留 `base.css` 中浏览器级 reset/滚动条/ focus ring，或改用 Astryx `reset.css`。
   - 仅保留项目专属变量（如 `--raccoon-node-radius`、`--raccoon-handle-size`），值引用 Astryx 变量。
3. **更新 `styles/index.css`**：
   ```css
   @import "@astryxdesign/core/astryx.css";
   @import "@astryxdesign/theme-neutral/theme.css";
   @import "./theme/base.css";
   @import "./canvas.css";
   @import "./nodes.css";
   @import "./legacy-components.css"; /* 待清理 */
   ```
4. **接入 `Theme` provider**：
   - `App.tsx` 外层包裹：
     ```tsx
     import { Theme } from "@astryxdesign/core/theme";
     import { neutralTheme } from "@astryxdesign/theme-neutral";

     <Theme theme={neutralTheme} mode={themeMode}>
       <App />
     </Theme>
     ```
   - `useCurrentProject` 中 `applyTheme` 不再直接写 `dataset.theme`，而是把 `themePack` / `themeMode` 传入 `Theme`；Astryx 会自动同步 `data-theme` 到 `html`。
5. **修复构建**：Vite 不再处理 Tailwind，但需确认 CSS import 路径、prettier 无 `@apply` 解析错误。

### Phase 2 — 主题设置与基础组件（3~5 天）

1. **设置面板主题切换**（见第 6 节）：
   - 提供两个独立控件：**主题包选择**（7 套 Astryx 主题）和 **明暗模式切换**（light / dark）。
   - 删除自定义 `.settings-theme-grid` 样式。
2. **后端主题模型同步改造**：
   - 将 `src/config.rs` 的 `Theme` 枚举拆分为 `theme_pack: String` 与 `theme_mode: ThemeMode`（`Light` / `Dark`）。
   - 更新 `AppConfig` 默认值、序列化与反序列化逻辑。
   - 更新 `src/api/handlers.rs` 的 `BasicSettings` / `BasicSettingsUpdate` 类型、校验与响应。
   - 更新 `frontend/src/types/api.ts` 中对应类型。
   - 更新相关 Rust 单元测试，确保配置 round-trip 与验证通过。
   - 本次改造遵循「前端设计优先」：后端类型/字段/校验随前端需求变更，不反过来限制 UI 设计。
3. **基础组件替换**（先 settings/terminal/ui 中非对话部分）：

   | 当前 | Astryx 替代 |
   |------|-------------|
   | 手写 `button` + `.btn*` | `Button`、`IconButton`、`ButtonGroup` |
   | 手写 `input` / `select` / `textarea` | `TextInput`、`TextArea`、`Selector` |
   | `.card*` / `.node-card` 内部 | `Card`、`ClickableCard`、`SelectableCard` |
   | `.badge*` | `Badge`、`StatusDot` |
   | `.settings-choice-list` | `RadioList` / `SegmentedControl` |
   | `.settings-form__column` 等布局 | `Layout`、`Stack`、`HStack`、`VStack` |
   | 排版 `h1/h2/p` 样式 | `Heading`、`Text` |
   | 空状态/加载 | `EmptyState`、`Spinner`、`Skeleton` |

4. 每替换一个组件，删除 `legacy-components.css` 中对应样式。

### Phase 3 — AI 对话重构（核心，5~7 天）

以 Astryx `ai-chat` 模板为参考，重写对话相关组件。

1. **对话布局**：
   - `RequirementChatNode` 内部使用 `ChatLayout`（消息列表 + 底部 Composer）。
   - `AnchoredScroll` 可替换为 `ChatLayout` / `useChatStreamScroll`；若行为不符，保留自定义但使用 Astryx tokens。
2. **消息气泡**：
   - `ChatMessageBubble` → `ChatMessage` + `ChatMessageBubble` + `ChatMessageMetadata`。
   - `ChatMessageList` → `ChatMessageList`（支持 `isStreaming` aria 控制）。
   - 系统/通知消息 → `ChatSystemMessage`。
3. **Composer**：
   - `ChatComposer` → `ChatComposer` + `ChatComposerInput` + `ChatComposerDrawer`。
   - 文件引用/图片 chip 使用 `ChatTokenizedText` 或 `Token`。
   - @ 文件选择器评估 `Tokenizer` + `Typeahead`；若 API 不匹配，保留自定义但样式 Astryx 化。
4. **工具/Trace 展示**：
   - `ProcessStreamRows` 评估替换为 `ChatToolCalls`。
   - 映射 agent trace 事件到 `ChatToolCallItem[]`（`name`、`status`、`target`、`duration`、`node`）。
   - 若 trace 事件包含非工具日志，保留 `ProcessStreamRows`，但使用 Astryx `Collapsible`、`Token`、`StatusDot`。
5. **Markdown 渲染**：
   - 评估 Astryx `Markdown` 是否支持 GFM tables/tasklists。
   - 若暂不支持，保留 `react-markdown` + `remark-gfm`，但把 code copy 按钮改用 Astryx `CodeBlock`。
6. **澄清/确认卡片**：
   - Astryx 无现成 wizard 卡片，使用 `Card` + `Stack` + `ButtonGroup` + `Selector`/`RadioList` 实现。
   - 沉淀为项目模板：`frontend/src/templates/astryx/ClarificationCard.tsx`、`ConfirmationCard.tsx`。

### Phase 4 — 节点画布与 NodeBar（3~4 天）

1. **节点外壳**：
   - `StartNode` 的 `node-card` 保留，但尺寸、阴影、圆角、边框色引用 Astryx tokens。
   - `NodeBar` 使用 `Toolbar`、`ButtonGroup`、`IconButton` 重写。
2. **React Flow 覆盖**：
   - 把 `.react-flow__controls`、`.react-flow__minimap`、`.react-flow__handle`、edge markers 的覆盖迁移到 `canvas.css`。
   - 颜色全部使用 Astryx CSS 变量，确保暗色模式同步。
3. **画布布局不变**：
   - `buildProjectNodes.ts`、`edges.ts`、`layout.ts` 中的尺寸/位置/数据逻辑不动。
   - 仅当 Astryx 组件内边距改变导致节点溢出时，调整 `node.width/node.height`。
4. **各节点内容组件**：
   - `ProjectTerminalNode`、`ProjectGitNode`、`ProjectGithubNode`、`ProjectSettingsNode`、`TokenUsageNode` 等用 Astryx `Card`、`Stack`、`Text`、`Badge`、`Button` 替换内部结构。
   - 终端 viewport（xterm.js）保留，但标题栏和工具按钮用 Astryx。

### Phase 5 — 清理与文档（2~3 天）

1. 删除 `legacy-components.css` 中已迁移的样式；最终删除该文件。
2. 删除 `styles/theme/tokens.css` 中不再使用的旧变量（保留项目级 raccoon 变量）。
3. 删除不再使用的自定义组件。
4. 更新 `docs/spec/TECH_STACK.md`：
   - 移除 Tailwind CSS，添加 Astryx、theme-neutral 等主题包、CLI。
   - 说明自定义样式仅用于 React Flow 画布/节点覆盖。
5. 更新 `CLAUDE.md`/`AGENTS.md` 的前端组件约定（如有）。
6. 运行 `npm run check`、`pre-commit run --all-files`。

---

## 5. Tailwind → Astryx 映射策略

### 布局（最优先替换）

| Tailwind 用法 | Astryx 替代 |
|---------------|-------------|
| `className="flex flex-col gap-2"` | `<VStack gap={2}>` 或 `<Stack direction="vertical" gap="md">` |
| `className="flex items-center gap-2"` | `<HStack gap={2} align="center">` |
| `className="p-4"` / `m-4` | 组件 `padding`/`margin` props 或 `Layout padding="lg"` |
| `className="w-full h-full"` | `Layout width="100%" height="100%"` / `height="fill"` |
| `className="grid grid-cols-2"` | `Grid`（若 Astryx Grid 满足）或保留少量 CSS grid |

### 视觉

| Tailwind 用法 | Astryx 替代 |
|---------------|-------------|
| `rounded-lg bg-surface shadow-md` | `Card padding="lg"` 或引用 `var(--radius-container)`、`var(--color-surface-primary)` |
| `text-sm text-muted` | `Text` 组件 size/type 或 `color: var(--color-text-secondary)` |
| `border border-default` | `style={{ border: "1px solid var(--color-border-default)" }}` |

### 不再保留的 Tailwind 特性

- `@apply`：全部删除；样式要么用 Astryx 组件 prop，要么写普通 CSS 引用 token。
- `hover:`、`focus:`、`disabled:` variant：用 Astryx 组件自带状态，或 CSS `:hover`。
- `dark:` variant：完全由 Astryx `Theme` 的 CSS 变量层控制。

---

## 6. 主题设置改造细节

### 当前逻辑

- `useCurrentProject` 维护 `theme: ThemeMode` 状态（`"light" | "dark"`）。
- `applyTheme` 直接写 `document.documentElement.dataset.theme = theme`。
- `BasicSettingsPanel` 用原生 `button` + `.settings-theme-grid` 渲染两个主题选项。

### 改造后

1. `useCurrentProject` 改为维护两个状态：
   - `themePack: ThemePack`（默认 `"neutral"`）。
   - `themeMode: ThemeMode`（`"light" | "dark"`，默认 `"dark"`）。
2. 主题包加载器：
   - 每个主题包独立 `import()`，按名称懒加载，避免一次性打包全部主题 CSS。
   - 提供映射表与 fallback：
     ```ts
     const themeLoaders: Record<ThemePack, () => Promise<{ theme: Theme }>> = {
       neutral: () => import("@astryxdesign/theme-neutral"),
       stone: () => import("@astryxdesign/theme-stone"),
       matcha: () => import("@astryxdesign/theme-matcha"),
       y2k: () => import("@astryxdesign/theme-y2k"),
       chocolate: () => import("@astryxdesign/theme-chocolate"),
       gothic: () => import("@astryxdesign/theme-gothic"),
       butter: () => import("@astryxdesign/theme-butter"),
     };
     ```
3. `App.tsx` 在根节点包裹 `Theme`：
   ```tsx
   <Theme theme={loadedTheme} mode={themeMode}>
     <main className="app-shell">…</main>
   </Theme>
   ```
   Astryx 会自动把 `data-theme` / `data-astryx-theme` 同步到 `html`。
4. `BasicSettingsPanel`「外观」区域：
   - **主题包选择**：使用 `Selector` 或 `RadioList`，列出 7 套 Astryx 主题，当前选中项为 `themePack`。
   - **明暗模式切换**：使用 `SegmentedControl` 或 `ButtonGroup`（`light` / `dark`）。
   - 两项变更都通过 `updateBasicSettings` 保存到后端，持久化到 `.raccoon-node/config.toml`。
5. `ModelSettingsPanel` 中的终端 `fixedDark` 保持不变；Astryx `Theme` 不影响 xterm 主题，但终端外壳颜色随全局主题。
6. 画布覆盖样式通过 Astryx 变量响应主题，不再依赖 `data-theme="dark"` 手动写两套值。

---

## 7. 节点特色保留清单

以下部分**不替换为 Astryx 现成组件**，只进行 token 化改造：

- `StartNode` 的 React Flow `Handle` 渲染与定位。
- `NodeBar` 的拖拽、折叠、聚焦行为（UI 控件可用 Astryx）。
- 画布缩放、Controls、Minimap、Edge markers 样式。
- 节点尺寸计算与自动布局（`buildProjectNodes.ts`、`layout.ts`）。
- xterm.js 终端渲染区域。

---

## 8. 测试与验收

1. **单元测试**：
   - 现有 30 个测试文件以行为测试为主；class 断言需随组件替换同步更新。
   - 对替换后的 `ChatComposer`、`ChatMessageBubble` 等补充 a11y/交互测试。
   - 对主题包懒加载与 `Theme` provider 切换补充测试。
2. **类型检查**：每阶段跑 `npm run check`。
3. **构建检查**：每阶段跑 `npm run build`，确认静态资源嵌入无误。
4. **视觉回归**：
   - 暗色/亮色切换后节点可见、边框不丢失。
   - 7 套主题包切换后布局、对比度、可读性正常。
   - 对话消息、工具调用、澄清卡片、设置面板在不同主题下正常。
   - 确认无 Tailwind 残留 class 导致的未定义样式。
5. **pre-commit**：最终阶段跑 `pre-commit run --all-files`。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|------|------|
| Astryx 0.1.x 为 beta，API 可能变化 | 锁定版本到 `0.1.3`，迁移期间不自动升级；每周检查 changelog |
| `all.css` 含大量 `@apply` 和 utility class，一次性替换工作量大 | Phase 1 后才移除 Tailwind；按组件逐步替换，保留 `legacy-components.css` 兜底 |
| Astryx `Markdown` 不支持 GFM | 保留 `react-markdown` + `remark-gfm`，仅替换 code block 渲染 |
| 自定义节点布局依赖旧变量名 | 建立旧变量 → Astryx 变量映射表，逐个替换；跑画布回归 |
| 主题包懒加载切换有闪烁 | 预加载当前主题包；切换时先加载再更新状态 |
| Bundle 体积显著增加 | 主题包按需 `import()`；Astryx 组件按需导入，避免整包引入 |

**回滚策略**：每阶段结束提交一次独立 commit；若某阶段阻塞，可 `git revert` 该阶段而不影响已完成阶段。

---

## 10. 后续目标命令说明

以下文本可直接作为“目标”命令的目标说明使用。执行时以当前工作区实际状态为准，先审计已完成内容，再只推进剩余工作。

```text
目标：继续完成 Astryx 设计系统全量迁移。

请先读取并遵守：
- AGENTS.md
- CLAUDE.md
- docs/spec/TECH_STACK.md
- docs/api/README.md
- docs/spec/ASTORYX_MIGRATION_PLAN.md

背景：
- 项目正在从 Tailwind CSS v4 + 自定义 CSS 迁移到 Astryx。
- 最终目标是彻底移除 Tailwind 工具链、@apply、@theme 和 Tailwind utility class。
- 前端最终应以 @astryxdesign/core、7 套 @astryxdesign/theme-* 主题包、Astryx token 与 Astryx 组件为主。
- React Flow 画布、节点尺寸/布局、xterm.js 终端渲染、Pi Agent RPC、任务 DAG 和后端业务流程不重写。

执行策略：
1. 先审计当前代码状态，不重复已完成迁移。
2. 只做与 Astryx 全量迁移直接相关的改动，避免顺手重构。
3. 每个阶段都保持可运行、可检查、可回滚。
4. 修改 AGENTS.md 时必须同步 CLAUDE.md，内容保持一致。
5. 不主动提交或推送代码，除非用户明确要求。

后续推进范围：
1. 补齐 Astryx PoC/兼容报告：
   - 输出 docs/spec/astryx-poc-report.md。
   - 记录 Tailwind 残留、Astryx token 映射、Markdown/GFM 兼容结论、后端主题契约状态和 bundle 影响。
2. 完成主题契约收尾：
   - 确认后端、前端类型、API 文档、设置面板和测试都使用 theme_pack + theme_mode。
   - 保持默认 theme_pack=neutral、theme_mode=dark。
   - 不引入 system 模式，除非用户另行要求。
3. 完成 AI 对话 Astryx 化：
   - 重点处理 RequirementChatNode、RequirementConversation、ChatComposer、ChatMessageBubble、ProcessStreamRows、RichContent。
   - 优先使用 Astryx ChatLayout、ChatComposer、ChatMessage、ChatMessageBubble、ChatToolCalls、Markdown/CodeBlock。
   - 若 Astryx API 无法满足现有交互，保留现有行为逻辑，但样式必须引用 Astryx token。
4. 完成节点画布和 NodeBar token 化：
   - 重点处理 NodeBar、StartNode、ProjectSettingsNode、ProjectTerminalNode、ProjectGitNode、ProjectGithubNode、TokenUsageNode、RequirementListNode、RequirementDagNode、RequirementTaskNode。
   - React Flow Handle、edge、minimap、controls、节点布局算法和 xterm 渲染区只做样式/token 迁移，不改业务行为。
5. 清理遗留 CSS 和旧组件：
   - 移除所有 @apply、@theme 和 Tailwind utility class。
   - 删除不再使用的 legacy CSS 与自定义 UI 组件。
   - 自定义 CSS 只保留画布、节点、xterm 等必要覆盖，并全部引用 Astryx CSS 变量。
6. 更新文档：
   - docs/spec/TECH_STACK.md 写清 Astryx、主题包、CLI、StyleX peer 依赖、Tailwind 已移除。
   - docs/api/README.md 写清 theme_pack/theme_mode API 契约。
   - AGENTS.md 与 CLAUDE.md 如涉及前端约定，必须同步更新。

完成定义：
- rg '@apply|@theme' frontend/src 无输出。
- rg 'tailwindcss|@tailwindcss' frontend 无有效依赖或配置残留。
- 前端仍能切换 7 套主题包和 light/dark 模式。
- 设置面板、AI 对话、节点画布在 Astryx 主题下可用且不丢失现有行为。
- 后端 API 保持 /api/project/current 和 /api/settings/basic 可用，并返回/保存 theme_pack + theme_mode。
- npm run check 通过。
- npm run build 通过。
- cargo test 通过。
- pre-commit run --all-files 通过。
```

---

## 11. 参考资源

- GitHub：`https://github.com/facebook/astryx`
- 文档：`https://astryx.atmeta.com/docs/core`
- CLI 模板：`npx astryx template ai-chat --skeleton`
- 包：
  - `@astryxdesign/core`
  - `@astryxdesign/theme-neutral`
  - `@astryxdesign/theme-stone`
  - `@astryxdesign/theme-matcha`
  - `@astryxdesign/theme-y2k`
  - `@astryxdesign/theme-chocolate`
  - `@astryxdesign/theme-gothic`
  - `@astryxdesign/theme-butter`
  - `@astryxdesign/cli`

---

## 12. 后端同步改造原则（前端优先，不迁就）

本次重构以**前端设计系统迁移**为驱动，后端仅做必要配合，禁止为了保留后端现有接口/模型而限制前端设计。

### 12.1 已知需要后端配合的点

| 前端需求 | 后端变更 | 文件 |
|----------|----------|------|
| 主题拆分为「主题包」+「明暗模式」 | `Theme` 枚举改为 `theme_pack: String` + `theme_mode: ThemeMode` | `src/config.rs` |
| 主题字段随基础设置保存 | `BasicSettings` / `BasicSettingsUpdate` 新增 `theme_pack` / `theme_mode` | `src/api/handlers.rs` |
| 前端类型同步 | `types/api.ts` 新增 `ThemePack`、`ThemeMode` 类型 | `frontend/src/types/api.ts` |
| 配置 round-trip 测试 | 更新 config 单元测试，覆盖新字段与默认值 | `src/config.rs` |

### 12.2 改造原则

1. **前端定模型**：Astryx 的 `ThemePack`、`ThemeMode`、`theme` 对象结构、默认值由前端需求决定，后端只负责持久化与透传。
2. **不保留废弃字段**：旧 `Theme` 枚举若与 Astryx 模型冲突，直接替换，不做兼容层。
3. **先改契约再改实现**：先确定 `BasicSettings` 的 JSON 形状，再同步改 Rust struct、handler、测试、前端 `types/api.ts`。
4. **验证顺序**：后端 `cargo test` → 前后端联调 `npm run dev` → 前端 `npm run check`。

### 12.3 本次默认方案（可调整）

- 默认主题包为 `neutral`。
- 明暗模式默认 `dark`（与当前终端/默认暗色体验一致）。
- 两套设置都保存在基础设置里，与 host/port/commit_mode 一起持久化到 `.raccoon-node/config.toml`。
- 如需「跟随系统」模式，后续作为独立增强项扩展 `ThemeMode` 为 `Light / Dark / System`。

---

## 13. 自定义组件 → Astryx 现成组件对照表

> 来源：`https://astryx.atmeta.com/components` 全量组件清单 + 当前 `frontend/src/components` 源码。
> **原则**：React Flow 节点骨架、拖拽/折叠行为、xterm 渲染区等节点特色保留；UI 控件尽量替换为 Astryx。

### 13.1 通用 UI 组件

| 当前组件 | Astryx 替代 | 保留的自定义逻辑 |
|----------|-------------|------------------|
| `ui/AnchoredScroll.tsx` | `useChatStreamScroll` / `ChatLayout`（若 API 匹配）；否则保留滚动锚定逻辑，仅样式用 Astryx token | 底部固定、未读提示、平滑滚动 |
| `ui/ChatComposer.tsx` | `ChatComposer` + `ChatComposerInput` + `ChatComposerDrawer` + `ChatTokenizedText` / `Token` | @-mention 数据源与文件/图片 token 化逻辑 |
| `ui/ChatMessageBubble.tsx` | `ChatMessage` + `ChatMessageBubble` + `ChatMessageMetadata` + `ChatSystemMessage` | 附件、引用、图片渲染与 projectId 文件链接 |
| `ui/ClarificationPanel.tsx` | `Card` + `Stack` + `ButtonGroup` + `Selector` / `RadioList` + `TextArea` | 澄清/确认的状态机、draft answer 计算 |
| `ui/DocumentPreview.tsx` | `Collapsible` + `CodeBlock` + `Markdown` + `IconButton` | 文件头解析、折叠状态 |
| `ui/NodeBar.tsx` | `Toolbar` + `ButtonGroup` + `IconButton` | 折叠/展开/聚焦的节点行为回调 |
| `ui/ProcessStreamRows.tsx` | `ChatToolCalls` + `Spinner` | ProcessRow → ChatToolCallItem 的映射、思考过程折叠 |
| `ui/RichContent.tsx` | `Markdown`（若支持 GFM）或保留 `react-markdown` + Astryx `CodeBlock` | 自定义 code copy 按钮行为 |
| `ui/SessionTranscript.tsx` | `Collapsible` + `Badge` + `Button` + `Spinner` + `Skeleton` + `Tabs` / `TabList` | 分页加载、JSON/工具卡片/Diff 视图渲染 |
| `ui/SimpleSelect.tsx` | `Selector` | — |
| `ui/TraceBubble.tsx` | `Collapsible` + `StatusDot` + `Token` | trace 内容格式化 |

### 13.2 设置与终端

| 当前组件 | Astryx 替代 | 保留的自定义逻辑 |
|----------|-------------|------------------|
| `settings/BasicSettingsPanel.tsx` | `Selector`（主题包） + `SegmentedControl`（light/dark） | host/port/commit_mode 等自定义表单校验与保存 |
| `settings/ModelSettingsPanel.tsx` | `SelectableCard` / `SegmentedControl`（档位） + `Selector` + `Button`/`IconButton` + `ProgressBar`（新手引导步骤） | 三档模型配置、Pi 登录终端集成 |
| `terminal/TerminalSessionView.tsx` | `Banner`（状态/错误提示） | xterm.js 渲染区本身不变 |

### 13.3 需求/对话工作台

| 当前组件 | Astryx 替代 | 保留的自定义逻辑 |
|----------|-------------|------------------|
| `requirements/RequirementConversation.tsx` | `ChatLayout` + `ChatComposer` + `ChatMessageList` + `Card` + `Button` + `Dialog` | 澄清/确认卡片状态机、process 行映射、取消/放弃逻辑 |
| `nodes/RequirementChatNode.tsx` | `TabList` + `Dialog` | 需求/项目标签切换、自定义确认弹窗内容 |

### 13.4 节点内容组件

| 当前组件 | Astryx 替代 | 保留的自定义逻辑 |
|----------|-------------|------------------|
| `nodes/StartNode.tsx` | 保留节点外壳；颜色/圆角/阴影改用 Astryx CSS 变量 | React Flow `Handle` 定位与 `renderNodeContent` |
| `nodes/ProjectSettingsNode.tsx` | `TabList` + `Toolbar` + `Dialog` | 节点展开/折叠、viewport 控制 |
| `nodes/ProjectTerminalNode.tsx` | `TextInput` + `Token` + `TabList` + `Button`/`IconButton` + `EmptyState` | 终端 session 管理、命令 profile 编辑 |
| `nodes/ProjectGitNode.tsx` | `List` + `CheckboxInput` + `TextArea` + `Dialog` + `Collapsible` + `Badge` | Git status 分组、diff 选择、commit action |
| `nodes/ProjectGithubNode.tsx` | `Card` + `Badge` + `StatusDot` + `Text` + `Heading` | 发布就绪判断逻辑 |
| `nodes/TokenUsageNode.tsx` | `Card` + `Grid` + `Text` + `EmptyState` | token 统计计算 |
| `nodes/RequirementListNode.tsx` | `List` + `Badge` + `Button`/`IconButton` + `EmptyState` | 需求选择、plan 动作、busy 状态 |
| `nodes/RequirementDagNode.tsx` | `StatusDot` / `Spinner` + `IconButton`（关闭按钮） | DAG 入口 Handle、thinking 跑马灯 |
| `nodes/RequirementTaskNode.tsx` | `Card` + `Dialog` + `Badge` + `Button` + `IconButton` + `Collapsible` | 任务组折叠、恢复、审核流水线渲染 |

### 13.5 画布顶层

| 当前组件 | Astryx 替代 | 保留的自定义逻辑 |
|----------|-------------|------------------|
| `App.tsx` | 根节点包裹 `Theme`，顶部工具栏可用 `Toolbar`，状态胶囊用 `Badge` | React Flow 初始化、viewport 控制器、节点合并逻辑 |

### 13.6 不替换的节点特色

- `StartNode` 的 React Flow `Handle` 渲染与定位。
- `NodeBar` / 节点标题栏的拖拽、折叠、聚焦行为（UI 控件可替换）。
- 画布缩放、Controls、Minimap、Edge markers 样式。
- 节点尺寸计算与自动布局（`buildProjectNodes.ts`、`layout.ts`）。
- xterm.js 终端渲染区域。
