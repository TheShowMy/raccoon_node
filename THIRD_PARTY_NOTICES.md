# 第三方开源声明

Raccoon Node v2 使用以下开源项目，谨致谢意。本文件随依赖变更同步更新；
许可审查属于发布检查的一部分（见 `docs/rewrite/04-architecture-decisions.md` ADR-002）。

## 运行时依赖（frontend/）

| 包 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [react](https://github.com/facebook/react) / [react-dom](https://github.com/facebook/react) | 19.x | MIT | UI 框架 |
| [@xyflow/react](https://github.com/xyflow/xyflow) | 12.x | MIT | React Flow：外层场景、中央对话图、工作台子画布 |
| [@pxlkit/core](https://github.com/Joangeldelarosa/pxlkit) | 1.3.x | MIT | 像素图标渲染、16×16 网格工具、PixelToast |
| [@pxlkit/ui-kit](https://github.com/Joangeldelarosa/pxlkit) | 2.1.x | MIT | 像素复古基础组件库（WCAG 2.1 AA） |
| [@tanstack/react-query](https://github.com/TanStack/query) | 5.x | MIT | REST 快照、命令与缓存 |
| [zustand](https://github.com/pmndrs/zustand) | 5.x | MIT | 画布导航、本地草稿与外观偏好状态 |
| [react-router-dom](https://github.com/remix-run/react-router) | 7.x | MIT | 画布导航状态到 URL 的映射 |
| [@xterm/xterm](https://github.com/xtermjs/xterm.js) | 6.x | MIT | 终端会话节点渲染 |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js) | 0.11.x | MIT | 终端尺寸自适应 |

### 字体（自托管，随构建嵌入）

| 字体 | 分发包 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P)（CodeMan38） | @fontsource/press-start-2p | SIL OFL 1.1 | 标题、标签与强调（位图字体） |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/)（JetBrains） | @fontsource/jetbrains-mono | SIL OFL 1.1 | 代码、Diff 与终端 |

## 风格参考（非依赖）

- [RetroUI（pixel-retroui）](https://github.com/Dksie09/RetroUI) — BSD 3-Clause。
  仅作像素风格与实现参考，不作为运行时依赖引入。

## pxlkit 许可说明

`@pxlkit/core`、`@pxlkit/ui-kit`、`@pxlkit/voxel` 为 MIT。
pxlkit 图标包（gamification / feedback / social / weather / ui / effects / parallax）
为 source-available（LICENSE-ASSETS）：**免费使用需署名，付费可免署名**。
v1 不使用图标包素材，图标优先按 16×16 网格格式自绘；若未来引入，
必须在本文件与关于页署名，或评估其付费条款后更新 ADR-002。

## 构建与测试工具（devDependencies）

| 包 | 许可证 |
| --- | --- |
| [Vite](https://github.com/vitejs/vite) / [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | MIT |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) v4 / @tailwindcss/vite | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 |
| [Vitest](https://github.com/vitest-dev/vitest) | MIT |
| [Testing Library](https://github.com/testing-library)（react / jest-dom） | MIT |
| [jsdom](https://github.com/jsdom/jsdom) | MIT |
| [Prettier](https://github.com/prettier/prettier) | MIT |

## 后端（backend/）

当前为零依赖占位桩；引入 Rust 依赖（axum、rig-core 等）时在本节补充。

## 其他

- 提交检查由 [pre-commit](https://github.com/pre-commit/pre-commit)（MIT）与
  [typos](https://github.com/crate-ci/typos)（MIT）驱动（开发工具，不进入产物）。
- GrayDango 宠物素材（`frontend/public/pets/graydango/`）为项目自有资产，自 v1 保留。
