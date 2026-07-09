# /goal: 完善 Astryx 椭圆画布前端并浏览器验收

## Objective

在当前已经存在的全屏椭圆画布前端基础上，继续完善剩余功能，并在测试仓库中启动项目完成浏览器验收。

测试仓库启动环境：

```powershell
$env:RACCOON_PROJECT_ROOT = "D:\work\rust\raccoon_agents_test"
npm run dev
```

`D:\work\rust\raccoon_agents_test` 是专用测试仓库，可以用于创建需求、终端、Git 操作等验收数据。不要提交或 push 本仓库代码，除非用户明确要求。

## Goal Mode Rules

- 只勾选阶段级 checkbox。每个阶段完成后，把对应 `[ ]` 改成 `[x]`。
- 每个阶段下面的普通 bullet 是实现清单，不需要逐条改 checkbox。
- 不要重做当前已存在的主画布基础结构。
- 主画布继续保持 6 个固定外围节点：设置、终端、Git、Token、需求列表、文件。
- 不要把单个需求、任务或临时状态节点追加到主椭圆上。
- 同一时间只打开一个主面板。
- UI 优先使用 Astryx 现成模板、block 和组件组合；能用模板改出来的，不要硬做自定义 UI。
- 每个阶段开始前都必须重新用 Astryx CLI 查询该阶段会用到的模板、block、组件和文档，避免上下文压缩或时间间隔导致遗漏。
- 查询结果要在阶段实现时转化为具体组件选择；如果没有合适模板，再补自定义布局。
- 第一版实时更新优先轮询，稳定后再逐步接 WebSocket/SSE。
- 完成后必须启动项目，并用浏览器验收。
- 验收结束前确认没有残留锁住 `target\debug\raccoon.exe` 的进程。

## Product Decisions

- 中心节点是普通聊天节点，不做“需求会话 / 项目问答”双 tab。
- 中心聊天通过 `/` 命令进入特定流程。
- `/` 命令第一版只有两个入口：`需求生成`、`新建会话`。
- `/需求生成` 进入需求生成流程：补充信息、澄清、生成需求卡片、用户确认后创建/进入执行。
- `/新建会话` 开启或重置聊天上下文，具体语义以后端现有能力为准。
- 需求生成过程中的澄清卡片和确认卡片浮在输入框上方。
- 需求列表面板是一个比浏览器可视区域小一圈的大节点；内部使用子画布或等价节点式布局。
- 需求列表子画布左侧展示列表节点，点击需求后在右侧展开 DAG 与任务节点。
- 文件节点是类 IDE 文件浏览器，支持文件树、搜索、预览、多文件 tab。
- Git 节点支持 stage、unstage、commit、push 等写操作；危险操作必须确认。
- 终端节点第一版需要完整 xterm，可输入、resize、关闭 session；command profiles 暂缓。
- Pi 登录终端仍放在设置的模型配置面板里。
- 视觉方向：稍微有科幻/节点画布感，但信息仍密集、实用。
- 小屏暂不重点优化。
- 新实现达到基础可用后，一次性删除不再使用的旧前端模块。

## Stage Checklist

### 1. Scope And Astryx References

- [ ] 完成实现前准备和 Astryx 模板调研。

实现清单：

- 阅读 `AGENTS.md`、`docs/spec/TECH_STACK.md`、`README.md`、`docs/api/README.md` 中与前端/API/启动相关的约束。
- 检查 git 状态，记录已有未提交改动，不回滚用户或其他代理的改动。
- 用 Astryx CLI 做一次总览查询，了解 chat、文件/IDE、settings、list/table、panel/layout 等区域可用模板和组件。
- 记录初步可复用模板/组件，但后续每个阶段开始前仍需重新查询该阶段相关 Astryx 能力。

### 2. Chat Node

- [ ] 完成中心普通聊天节点。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询 chat、composer、tool-call、command menu、attachment drawer 相关模板/组件。
- 将中心节点明确收敛为普通聊天，不出现“需求会话 / 项目问答”双 tab。
- 接入普通聊天消息读取、发送、停止运行、新建/重置会话能力。
- 实现消息区：普通消息、系统提示、错误、运行中状态、Pi thinking/tool 过程、streaming 文本。
- 实现输入框附件 drawer。
- 实现文件引用、图片附件、粘贴/拖拽上传。
- 实现 `/` 命令菜单。
- `/` 命令菜单只显示 `需求生成` 和 `新建会话`。
- `/新建会话` 能开启或重置聊天上下文。

### 3. Requirement Generation

- [ ] 完成 `/需求生成` 流程。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询 chat card、form、choice、confirmation、drawer/panel 相关模板/组件。
- `/需求生成` 进入需求生成流程。
- 支持用户继续补充需求描述。
- 支持澄清问题卡片，浮在输入框上方。
- 支持需求确认卡片，浮在输入框上方。
- 用户确认后才创建/进入后续执行流程。
- 用户可以继续补充或修改需求说明，避免过早提交。
- 参考旧前端澄清与确认卡片行为，但不复刻旧布局。

### 4. Requirements Panel

- [ ] 完成需求列表面板和执行子画布。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询 canvas/layout、list、DAG、task card、details dialog 相关模板/组件。
- 需求列表主面板尺寸略小于浏览器可视区域。
- 在需求列表主面板内部实现独立需求执行子画布或等价节点式布局。
- 子画布左侧/起点展示需求列表节点。
- 需求列表区分待处理与已完成需求。
- 展示需求状态、更新时间、任务进度、失败信息。
- 点击需求后在右侧展开该需求 DAG。
- 失败且未生成执行计划的需求提供重新生成 DAG 入口。
- DAG 展示 implementation、review、review summary、branch merge、merge review 等任务关系。
- 任务节点展示状态、摘要、警告、失败信息和恢复入口。
- 失败任务组或独立任务支持恢复，busy 状态互不影响。
- 任务详情支持任务描述、依赖/review、恢复信息、PR/merge/cleanup、token usage、session transcript。

### 5. Settings Panel

- [ ] 完成设置面板。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询 settings、form、selector、radio、terminal embed、onboarding 相关模板/组件。
- 基于 Astryx settings/form 模板或组件组合完善设置面板。
- 基础设置包含主题包、明暗模式、host、port、commit mode。
- 主题切换即时生效，保存失败时回滚。
- host/port 保存后如需重启，触发重启流程并跳转到新地址。
- 监听 `0.0.0.0` 时显示明确风险确认。
- 模型设置保留 low/medium/high 三档模型和 thinking level。
- 模型页展示 Pi RPC 状态、模型列表、保存、重新加载入口。
- 首次模型未配置完整时提供轻量 onboarding。
- Pi 登录终端放在模型设置面板，用于用户手动 `/login` 后重新加载模型。

### 6. Terminal Panel

- [ ] 完成终端面板。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询 terminal、panel、tabs/list、status 相关模板/组件。
- 实现终端会话列表、创建、选择、关闭。
- 实现完整 xterm 面板。
- 通过 WebSocket 接收输出、发送输入和 resize。
- 展示连接中、断开、服务端错误、进程退出等状态。
- 按后端安全策略处理非本机访问或外部监听授权。

### 7. Git Panel

- [ ] 完成 Git 面板。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询 Git/status、diff、table/list、confirmation dialog 相关模板/组件。
- 基于 Astryx 数据列表/table/panel 组件完善 Git 面板。
- 展示当前分支、upstream、ahead/behind、远端配置、write blocked。
- 展示 staged/unstaged 文件和变更类型。
- 支持选择文件、查看 diff、binary/truncated diff 状态。
- 支持 stage、unstage、fetch、pull、push、switch branch、create branch。
- 支持 commit。
- commit 和 push 必须二次确认。
- write blocked 时禁用写操作并展示原因。

### 8. Token Panel

- [ ] 完成 Token 面板。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询 metric、progress、token/status、dashboard widget 相关模板/组件。
- 展示 input、output、cache read、cache write。
- 展示 context tokens、context window、context percent。
- 数据优先来自 canvas 返回的 `token_usage`。

### 9. Files Panel

- [ ] 完成文件面板。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询 file explorer、IDE、tabs、tree/list、preview/code/markdown 相关模板/组件。
- 基于 Astryx 文件/IDE/资源浏览模板或组件完善文件面板。
- 实现文件树。
- 支持文件搜索。
- 支持内容预览。
- 支持多文件 tab。
- Markdown 用富文本预览，普通文本/代码用代码块预览。
- 文件能力可复用给聊天里的 `@file` 引用。

### 10. Cleanup

- [ ] 完成旧前端清理。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询 cleanup 后仍使用组件的文档，确认没有误删 Astryx 必需样式/入口。
- 确认新实现基础可用。
- 删除不再使用的旧前端模块、旧节点、旧 hook、旧样式。
- 保留仍被新实现使用的类型、API、工具函数或测试。
- 清理未使用依赖、未使用 import、死代码。

### 11. Verification

- [ ] 完成检查、启动和浏览器验收。

实现清单：

- 阶段开始前重新用 Astryx CLI 查询验收涉及组件文档，核对主要 UI 区域使用方式没有偏离模板/组件预期。
- 运行前端类型检查。
- 运行前端格式检查。
- 运行前端构建。
- 运行项目级检查；如 Rust 检查因外部文件锁失败，先清理残留进程再重跑。
- 设置 `$env:RACCOON_PROJECT_ROOT = "D:\work\rust\raccoon_agents_test"`。
- 启动 `npm run dev`。
- 打开浏览器访问本地应用。
- 验收主画布：中心聊天节点 + 6 个外围节点，无 minimap，无旧 controls。
- 验收视差：无面板时平滑，经过节点不卡顿。
- 验收 `/需求生成`：可进入需求生成、澄清、确认卡片流程。
- 验收 `/新建会话`：可开启或重置聊天上下文。
- 验收需求列表面板：内部子画布、点击需求展开 DAG。
- 验收任务详情和失败恢复。
- 验收设置、模型配置、Pi 登录终端入口。
- 验收终端 xterm 可输入、resize、关闭。
- 验收 Git 状态、diff、stage/unstage/commit/push 确认。
- 验收 Token 面板。
- 验收文件面板：文件树、搜索、预览、多 tab。
- 所有阶段完成后，确认没有残留开发服务器或锁住 `target\debug\raccoon.exe` 的进程。

## Completion Criteria

- 本文件所有阶段级 checkbox 都已勾选。
- 项目能在测试仓库 `D:\work\rust\raccoon_agents_test` 启动。
- 浏览器验收全部通过。
- 没有残留锁定构建产物的 `raccoon.exe` 进程。
