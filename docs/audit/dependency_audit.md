# raccoon_node 依赖管理审核报告

审核日期：2026-06-18
审核范围：Cargo.toml、frontend/package.json、package.json、.pre-commit-config.yaml、Cargo.lock、frontend/package-lock.json

---

## 高风险

| 依赖 | 文件 | 当前版本 | 问题描述 | 建议 |
|---|---|---|---|---|
| @types/react | frontend/package.json | ^19.2.7 | 类型定义包被错误地放在 `dependencies` 中，会导致生产构建包含不必要的类型依赖，增加包体积 | 移至 `frontend/package.json` 的 `devDependencies` |
| @types/react-dom | frontend/package.json | ^19.2.3 | 同上，类型定义包不应进入生产依赖 | 移至 `devDependencies` |
| typescript | frontend/package.json | ^5.9.3 | 编译工具放在 `dependencies` 中，生产环境不需要 | 移至 `devDependencies` |
| @vitejs/plugin-react | frontend/package.json | ^5.1.1 | Vite 插件属于构建时依赖，不应进入生产依赖 | 移至 `devDependencies` |
| @tailwindcss/vite | frontend/package.json | ^4.3.1 | Tailwind Vite 插件属于构建时依赖 | 移至 `devDependencies` |
| vite | frontend/package.json | ^7.2.7 | 构建工具放在 `dependencies` 中 | 移至 `devDependencies` |
| tailwindcss | frontend/package.json | ^4.3.1 | 构建时 CSS 处理工具，生产不需要 | 移至 `devDependencies` |
| prettier | frontend/package.json | ^3.7.4 | 格式化工具在 `devDependencies` 是正确的，但版本 3.7.4 不存在（Prettier 最新为 3.3.x 或 3.4.x） | 核实版本号，修正为 `^3.3.3` 或 `^3.4.0` |
| black | .pre-commit-config.yaml | rev: 26.5.1 | 版本号格式异常，Black 最新稳定版为 24.x 或 25.x（截至 2025 年中），26.5.1 可能指向未来版本或笔误 | 核实并修正为 `25.1.0` 或 `24.10.0` |
| @types/node | frontend/package.json | ^25.9.3 | Node 25 尚未发布 LTS，版本号异常 | 降级至 `@types/node@^20` 或 `@types/node@^22`，与当前 Node LTS 对齐 |
| Cargo.lock / package-lock.json | .gitignore | — | `.gitignore` 未明确排除 lock 文件，但 lock 文件也未出现在仓库中。Rust 应用项目应提交 `Cargo.lock`，Node 项目应提交 `package-lock.json` 以保证可复现构建 | 将 `Cargo.lock` 和 `frontend/package-lock.json` 加入版本控制；根目录 `package-lock.json` 视情况提交 |
| Node.js / Rust 版本未声明 | package.json / 根目录 | — | 没有 `engines` 字段或 `rust-toolchain.toml`，无法约束开发和生产环境版本 | 在 `package.json` 添加 `engines`，在根目录添加 `rust-toolchain.toml` |

---

## 中风险

| 依赖 | 文件 | 当前版本 | 问题描述 | 建议 |
|---|---|---|---|---|
| React 19 | frontend/package.json | ^19.2.3 | React 19 于 2024 年底发布，生态兼容性仍在追赶中，部分第三方库可能未完全适配 | 评估当前使用的库（如 `@xyflow/react`）对 React 19 的兼容性，必要时降级至 React 18.3 |
| Tailwind CSS 4 | frontend/package.json | ^4.3.1 | Tailwind 4 是重大版本升级，配置方式与 v3 差异较大，且部分插件生态未跟进 | 确认团队熟悉 v4 配置模式，否则考虑降级至 v3.4 以降低维护成本 |
| Vite 7 | frontend/package.json | ^7.2.7 | Vite 7 是较新版本，插件兼容性可能存在边缘问题 | 监控构建稳定性，保留降级至 Vite 6 的选项 |
| fs-extra | package.json | ^11.3.2 | `scripts/build.mjs` 中使用了 `fs-extra`，但 Node.js 内置 `fs/promises` 已覆盖大部分功能（`remove`、`ensureDir`、`copy`、`pathExists`、`writeJson` 均可替代） | 移除 `fs-extra` 依赖，改用 `node:fs/promises` 减少外部依赖 |

---

## 低风险

| 依赖 | 文件 | 当前版本 | 问题描述 | 建议 |
|---|---|---|---|---|
| axum 0.8 | Cargo.toml | "0.8" | 版本约束为 `0.8`（等价于 `^0.8.0`），axum 0.8 是较新的主版本，API 可能有变动 | 当前版本合理，但建议明确为 `"0.8.9"` 或 `"~0.8.9"` 以锁定补丁版本 |
| tokio 1 | Cargo.toml | "1" | 版本约束过于宽泛（`^1.0.0`），tokio 1.x 跨度极大，可能引入不兼容更新 | 建议明确为 `"1.52"` 或 `"~1.52.3"`，与当前 `Cargo.lock` 对齐 |
| serde 1 | Cargo.toml | "1" | 同上，约束过于宽泛 | 建议明确为 `"1.0"` 或 `"~1.0.228"` |
| tower 0.5 | Cargo.toml | "0.5" | dev-dependency 版本合理，但建议与生产依赖 tower-http 的版本兼容性保持一致 | 确认 tower 0.5 与 tower-http 0.6 的兼容性 |
| lucide-react | frontend/package.json | ^0.562.0 | 在 `main.tsx` 中使用，确认实际使用范围 | 如仅少量图标使用，考虑按需导入或替换为更轻量的方案 |
| concurrently | package.json | ^9.2.1 | 开发工具，版本合理 | 无需调整 |
| typos | .pre-commit-config.yaml | rev: v1.47.0 | 拼写检查工具，版本较新 | 无需调整 |
| pre-commit-hooks | .pre-commit-config.yaml | rev: v6.0.0 | 基础钩子，版本合理 | 无需调整 |

---

## 优先级最高的 5 项优化

1. **立即将 frontend/package.json 中 7 个构建时/类型依赖移至 devDependencies**
   - 涉及：@types/react、@types/react-dom、typescript、@vitejs/plugin-react、@tailwindcss/vite、vite、tailwindcss
   - 影响：减少生产包体积，避免类型定义进入生产环境

2. **修正 prettier 和 black 版本号**
   - prettier `^3.7.4` → `^3.3.3` 或 `^3.4.0`
   - black `rev: 26.5.1` → `25.1.0` 或 `24.10.0`
   - 影响：确保依赖可正确安装，避免构建失败

3. **提交 lock 文件到版本控制**
   - 提交 `Cargo.lock` 和 `frontend/package-lock.json`
   - 影响：保证可复现构建，避免依赖漂移

4. **声明 Node.js 和 Rust 版本要求**
   - 在 `package.json` 添加 `engines` 字段
   - 在根目录添加 `rust-toolchain.toml`
   - 影响：统一开发和生产环境，减少版本不一致导致的构建问题

5. **评估前端技术栈稳定性（React 19 / Tailwind 4 / Vite 7）**
   - 确认 `@xyflow/react` 对 React 19 的兼容性
   - 监控构建和运行时稳定性
   - 影响：避免因生态不成熟导致的功能缺陷或维护困难

---

## 补充建议

- 建立定期漏洞扫描机制：运行 `cargo audit` 和 `npm audit`
- 收紧 Cargo.toml 版本约束：避免 `"1"` 这种宽泛写法，使用 `"~1.52.3"` 或 `"1.52"`
- 考虑移除 `fs-extra`：改用 `node:fs/promises` 减少外部依赖
- 降级 `@types/node` 至 `^20` 或 `^22`，与当前 Node LTS 版本对齐
