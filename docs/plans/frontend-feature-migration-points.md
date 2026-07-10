# /goal: 重写 Astryx 椭圆画布与 Pi 分支需求流

## Objective

保留全屏椭圆主画布和六个固定外围节点，恢复迁移前已经验证的领域层，重新实现模块化 Astryx 前端。`/需求生成` 使用 Pi RPC clone 从普通聊天派生需求分支；分支确认后回到主会话并异步回写最终需求摘要。

测试仓库：

```powershell
$env:RACCOON_PROJECT_ROOT = "D:\work\rust\raccoon_agents_test"
npm run dev
```

不要提交或 push，除非用户明确授权。

## Product Decisions

- 中心节点始终显示“项目对话”，项目消息与需求分支共用一个 Astryx 消息时间线，不提供双 Tab 或独立需求页。
- `/` 菜单只有 `需求生成` 和 `新建会话`，支持 `/需求生成 <描述>`。
- 主聊天非空时 clone 当前 Pi 活动分支作为需求 session；为空时创建独立需求 session。
- 需求分支结合主会话上下文和用户新输入完成补充、澄清与确认。
- 澄清和确认卡片固定在 composer 上方，提交版本化 `prompt_id`、`revision` 和结构化答案。
- 确认或停止后 composer 回到普通聊天，但完整需求分支继续保留在时间线；放弃会删除该分支。只有确认会向主 Pi session 回写最终摘要。
- 回写结果显示为系统摘要卡片，不展示 Pi 内部确认回复；失败可重试且不回滚需求。
- 活动需求分支期间禁用新建普通会话。
- 主画布保持设置、终端、Git、Token、需求列表、文件六个固定外围节点；同一时间只打开一个主面板。
- 主画布使用固定镜头，禁止用户平移缩放；鼠标位置只驱动平滑视差。只有需求工作台内的嵌套 DAG 支持平移缩放。
- 需求和任务只出现在需求面板内部的子画布，不追加到主椭圆。
- 视觉保持轻量科幻节点感，但优先信息密度和长期操作效率；小屏只保证可访问。

## Goal Mode Rules

- 只勾选阶段级 checkbox；阶段全部实现并验证后才从 `[ ]` 改为 `[x]`。
- 每个 UI 阶段开始前，在 `frontend/` 目录重新运行相关 `npx astryx` 查询。
- 优先使用 Astryx 模板、block 和组件；自定义布局必须使用 design token。
- 新实现基础可用前不删除仍被依赖的旧领域逻辑或测试。
- 完成后必须启动指定测试仓库并用浏览器验收。
- 验收结束前停止开发服务器、Vite、Pi 和锁定 `target\debug\raccoon.exe` 的进程。

## Astryx Discovery Record

- 阶段 3（Canvas And Chat）：在 `frontend/` 执行
  `astryx build "full screen React Flow canvas with central project chat and six fixed orbit tools"`。
  采用 `AppShell`、`TopNav`、`ChatLayout`、`ChatComposer`、`ChatToolCalls`、`Banner`、
  `Dialog` 与流式文本能力；主 React Flow 只负责坐标、程序化镜头和节点挂载，
  用户不能平移缩放。
- 阶段 3（Fixed Camera Follow-up）：执行
  `astryx build "fixed full-screen React Flow orbital canvas with pointer parallax and non-interactive camera"`，
  并查询 `astryx docs motion`、`astryx docs layout`。恢复最大 260 画布单位、0.16 插值的
  鼠标视差，遵循 reduced-motion；需求工作台内的嵌套 React Flow 保持可平移缩放。
- 阶段 3（Chat Rewrite Follow-up）：在 `frontend/` 重新执行
  `npx astryx build "project AI chat with streaming reasoning tool calls attachments command menu and floating requirement confirmation"`，
  采用 `ai-chat` 页面模板，并查询 `ChatLayout`、`ChatComposer`、`ChatComposerInput`、
  `ChatComposerDrawer`、`ChatMessage`、`ChatMessageBubble`、`ChatSystemMessage`、
  `ChatToolCalls`、`Collapsible`、`Banner`、`AlertDialog` 和 `useStreamingText`。
  中心聊天从模板重新实现；旧 `RequirementChatNode`、旧 chat transcript、旧 composer/bubble
  及其测试全部删除，只保留 API、业务 hooks 和节点数据契约。
- 阶段 3（Live Chat Follow-up）：重新查询 `ChatLayout`、`ChatToolCalls`、`Collapsible`
  和 `ai-chat` skeleton。`ChatLayout` 独占节点滚动并将 composer 固定到底部；工具生命周期
  合并后以单个 `ChatToolCalls` 分组展示。Astryx 0.1.3 没有独立 reasoning 组件，思考过程
  使用官方 `ChatMessageBubble`、`Collapsible`、`StatusDot`、`Text`、`Markdown` 和
  `useStreamingText` 组合，运行时展开、完成后折叠。
- 阶段 3（Requirement Command Follow-up）：在 `frontend/` 执行
  `npx astryx build "在现有项目聊天历史下，用同一个 ChatComposer 选择 /需求生成 后插入可继续编辑的命令 token，提交成功前不切换消息流"`，
  并查询 `ai-chat`、`ChatComposerInputSlashCommands`、`ChatComposerInputMultipleTriggers`、
  `ChatComposer`、`ChatComposerInput` 和 `Token`。`/需求生成` 仅作为黄色内联 token
  留在项目 composer 中；真实 requirement conversation 就绪前保持项目历史可见，不创建空白临时消息流。
- 阶段 3（Unified Requirement Timeline Follow-up）：在 `frontend/` 执行
  `npx astryx build "single continuous AI chat timeline with project messages, requirement branch divider, streaming reasoning tools, and visible confirmation actions above composer"`，
  并查询 `ChatMessageListFullFeatured`、`ChatComposerDrawerFeedback`、`ChatSystemMessage`、
  `ChatMessageList` 和 `ChatComposerDrawer`。采用单个 `ChatMessageList`，每个未删除需求通过
  `ChatSystemMessage variant="divider"` 插入“需求分支”连续区段；prompt 使用不传 `count` 的
  `ChatComposerDrawer` 固定展开，附件 drawer 继续独立支持折叠。
- 阶段 3（Requirement Prompt Visibility Follow-up）：执行
  `npx astryx build "opaque requirement confirmation panel above chat composer with scrollable long content and always-visible footer actions"`，
  并查询 `LayoutBasicCardLayout`、`LayoutFooterActions`、`CardWithInnerLayout`、`Card`、
  `LayoutContent` 与 `LayoutFooter`。长确认/澄清内容改为默认不透明 `Card + Layout`：正文仅在
  `LayoutContent` 内滚动，操作按钮固定在 `LayoutFooter`，不再使用带 muted 叠层的 prompt drawer。
- 阶段 3（Requirement Prompt Overflow Follow-up）：执行
  `npx astryx build "requirement confirmation list with wrapped multi-line criteria and isolated inner wheel scrolling"`，
  并查询 `ListItem`、`List`、`Text` 与 `LayoutContent`。`ListItem.label` 使用 Astryx `Text`
  ReactNode 解除字符串单行省略，长摘要、验收项、问题和选项按词换行；内部滚动区使用
  `overscroll-behavior: contain`，并在 prompt card 阻止 wheel 冒泡到外层聊天时间线。
- 阶段 3（Requirement Prompt Interaction Follow-up）：执行
  `npx astryx build "interactive confirmation card inside chat composer while message input alone is disabled"`，
  并查询 `ChatComposer`、`ChatComposerInput` 与 `ChatSendButton`。prompt 显示时不再设置
  `ChatComposer.isDisabled`（该 prop 会禁用整个根容器的 pointer events），仅禁用输入、附件和发送按钮；
  prompt 内容、滚动条、确认操作及运行态停止按钮保持可交互。
- 阶段 3（Chat Performance Follow-up）：执行
  `npx astryx build "high performance AI chat with long history lazy older messages and fixed composer"`，
  并查询 `ChatMessageList` 与 `ChatComposerInput`。输入、附件和澄清 draft 下沉到聊天节点，历史使用
  `ChatMessageList.scrollToTopAction` 按 80 条分批渲染；实时滚动按 animation frame 合并。主 React Flow
  保持节点引用稳定，工作台先聚焦轻量壳层，再按 Astryx fast motion 的 175ms 时长挂载内容。
- 阶段 4（Requirement Workbench）：执行
  `astryx build "nested requirement DAG workbench with list, dependency graph and task detail dialog"`。
  参考 `detail-page`、`table-grouped`、`DialogConfirmationDialog`，采用 `List`、`Token`、
  `Dialog`、`AlertDialog`；真实依赖图保留在嵌套 React Flow。
- 阶段 5（Settings And Terminal）：执行
  `astryx build "settings form and IDE terminal workbench"`。参考 `settings` 与 `ide` 页面，
  采用 `FormLayout`、`Field`、`TextInput`、`Layout`、`TabList`、`Banner`；xterm 挂载和
  resize 保留必要底层 DOM。
- 阶段 6（Git Token And Files）：执行
  `astryx build "Git grouped list with diff confirmation plus token metrics and file IDE tabs"`。
  参考 `ide`、`file-explorer`、Grouped Table/List，采用 `AlertDialog`、`CodeBlock`、
  `TabList`、`Token`、`Grid`、`EmptyState`。另逐项查询了 `TextInput`、`EmptyState`、
  `TabList` 和 `CodeBlock` 的实际 props，未按猜测使用组件 API。

## Stage Checklist

### 1. Baseline And Contracts

- [x] 恢复领域层与测试基线，完成 Astryx 总览调研。

- 恢复 `d65b234` 中的 API client、业务 hooks、事件缓冲、格式化工具及测试。
- 保留当前后端类型兼容性，不恢复旧页面或旧 CSS。
- 阅读并同步架构、API、README 与计划文档。

### 2. Pi Requirement Branch

- [x] 完成 Pi clone 需求分支和主会话摘要回写。

- 非空主 session clone 后保存需求分支文件并立即切回主 session。
- 空主 session 直接创建需求 session。
- 确认后异步写回主 session，持久化系统摘要卡片状态。
- 新增摘要写回重试 API，覆盖并发、恢复、失败和 session 清理测试。

### 3. Canvas And Chat

- [x] 完成椭圆画布和单节点分支聊天体验。

- 使用 AppShell + React Flow 实现中心节点、六个外围节点、单主面板、固定镜头、鼠标视差和程序化视口聚焦。
- 普通聊天完整支持快照对账、streaming、thinking/tool、停止、重置、附件和文件引用。
- `/需求生成` 在同一个消息时间线中插入“需求分支”区段；header 和项目历史不切换，无双 Tab 或第二滚动容器。
- 中心聊天 UI 基于 Astryx `ai-chat` 模板完整重写，不复用迁移前聊天组件。

### 4. Requirement Workbench

- [x] 完成需求列表、DAG 子画布和任务详情。

- 左侧区分待处理/已完成需求，右侧按真实依赖展开任务 DAG。
- 支持规划重试、任务组恢复、审核历史、PR/merge/cleanup、token 和 session transcript。

### 5. Settings And Terminal

- [x] 完成设置与终端工作台。

- 设置包含主题、明暗模式、host、port、commit mode、三档模型、RPC 状态与 onboarding。
- 保留 Pi 登录终端；普通终端支持会话、xterm WebSocket、输入、resize、关闭和访问授权。

### 6. Git Token And Files

- [x] 完成 Git、Token 与文件工作台。

- Git 支持状态、diff、stage/unstage、fetch/pull、分支、commit/push 和危险操作确认。
- Token 展示完整 usage/context；文件工作台支持搜索、树、多 Tab、Markdown 和代码预览。

### 7. Cleanup And Verification

- [ ] 完成旧实现清理、完整检查和浏览器验收。

- 删除巨型 App、未使用模块、依赖和死样式，保留模块化领域层与行为测试。
- 运行前端类型、测试、格式、构建，随后运行项目检查与 pre-commit。
- 在 1280x720、1440x900、1920x1080 验收聊天、分支需求、DAG、设置、终端、Git、Token 和文件工作流。

阶段 7 仍未勾选：当前完全访问环境已可运行 `uv`、pre-commit 和本地服务，待本轮
Astryx 聊天重写完成全部检查与三档桌面浏览器验收后再更新阶段状态。

## Completion Criteria

- 所有阶段 checkbox 已勾选且测试覆盖关键行为。
- 指定测试仓库可启动，浏览器验收全部通过且无重叠布局。
- 没有残留开发服务器、Vite、Pi 或锁定构建产物的 `raccoon.exe` 进程。
