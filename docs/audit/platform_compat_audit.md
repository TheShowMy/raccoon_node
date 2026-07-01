# 平台兼容性审核报告

> 审核日期：2026-06-18
> 审核范围：src/main.rs、scripts/build.mjs、frontend/vite.config.ts、package.json、frontend/package.json、Cargo.toml、.pre-commit-config.yaml
> 审核维度：路径处理、外部命令调用、环境变量、行尾符、文件系统差异、构建脚本跨平台性、开发体验、网络绑定

---

## 高风险问题

### 1. pre-commit 本地钩子全部使用 `bash -c`，依赖 bash 环境

- **文件**：`.pre-commit-config.yaml:37-84`
- **相关代码**：
  ```yaml
  - id: prettier
    entry: bash -c 'cd frontend && npm run format:check'
    language: system
  - id: tsc
    entry: bash -c 'cd frontend && npm run check'
    language: system
  - id: frontend-build
    entry: bash -c 'cd frontend && npm run build'
    language: system
  - id: cargo-fmt
    entry: bash -c 'cargo fmt -- --check'
    language: system
  - id: cargo-check
    entry: bash -c 'cargo check --all'
    language: system
  - id: cargo-clippy
    entry: bash -c 'cargo clippy --all-targets --all-features --tests --benches -- -D warnings'
    language: system
  - id: cargo-test
    entry: bash -c 'cargo test'
    language: system
  ```
- **问题描述**：pre-commit 本地钩子使用 `bash -c` 执行命令，依赖系统存在 bash。在已安装 Git Bash / WSL / MSYS2 的 Windows 环境中通常可以运行；但在纯净 Windows 环境或未将 bash 加入 PATH 时可能失败。
- **平台影响**：当前环境验证 `pre-commit run --all-files` 可正常执行 bash 钩子（ prettier 检查因代码格式问题失败，与 bash 无关）。长期看，`bash -c` 仍属于隐式依赖，不如直接调用命令健壮，且 `cd frontend && ...` 这类 shell 语法在 Windows 非 bash 环境下不可靠。
- **修复建议**：将 `entry` 改为直接调用命令，如 `entry: npm --prefix frontend run format:check`，或改用 `language: node` / `language: rust` 等 pre-commit 原生支持的语言环境。若必须用 shell 脚本，提供跨平台的 `.cmd` 或 `.ps1` 替代。

### 2. `normalize_components` 对 Windows 路径前缀处理存在逃逸风险

- **文件**：`src/main.rs:2262-2271`
- **相关代码**：
  ```rust
  fn normalize_components(path: &Path) -> Vec<String> {
      path.components()
          .filter_map(|component| match component {
              Component::Normal(value) => Some(value.to_string_lossy().to_string()),
              Component::RootDir => Some("/".to_owned()),
              Component::Prefix(value) => Some(value.as_os_str().to_string_lossy().to_string()),
              Component::CurDir => None,
              Component::ParentDir => Some("..".to_owned()),
          })
          .collect()
  }
  ```
- **问题描述**：Windows 的 `Component::Prefix` 包含盘符（如 `C:`）或 UNC 路径前缀（如 `\\server\share`）。`ensure_child_path` 的 `starts_with` 比较是在字符串数组上进行的。如果 `data_root` 是相对路径而 `project_dir` 是绝对路径，或两者路径分隔符风格不一致（通过 `env::var` 传入），`normalize_components` 输出混合风格字符串，比较结果不可预期。
- **平台影响**：Windows 下通过环境变量传入与代码构造不同风格的路径时，`ensure_child_path` 可能误报或漏报，存在目录逃逸风险。
- **修复建议**：统一使用 `std::fs::canonicalize` 或 `dunce::simplified` 将路径规范化后再比较，避免字符串级比较。

### 3. `pi` / `pi.cmd` 启动假设过于具体，Windows 上可能找不到

- **文件**：`src/main.rs:1792-1805`
- **相关代码**：
  ```rust
  let program = if cfg!(target_os = "windows") {
      "pi.cmd"
  } else {
      "pi"
  };
  let mut child = Command::new(program)
      .arg("--mode")
      .arg("rpc")
      ...
      .spawn()?;
  ```
- **问题描述**：Windows 使用 `pi.cmd`，但 `pi.cmd` 必须存在于 PATH 中。如果用户安装的是 `pi.exe`（某些 Python 工具在 Windows 上生成 `.exe` 而不是 `.cmd`），或 `pi` 通过 `pipx` 安装但不在 PATH 中，启动会失败。错误信息通过 `spawn()?` 直接抛出，是英文 I/O 错误。
- **平台影响**：Windows 上 `pi` 安装方式多样（pip、pipx、直接下载），`pi.cmd` 假设过于具体。Pi Agent RPC 是核心 LLM 能力，启动失败等于功能不可用。
- **修复建议**：尝试 `pi`、`pi.cmd`、`pi.exe` 的优先级查找；启动失败时给出明确的安装指引错误信息。

---

## 中风险问题

### 4. `git clone` 直接调用 `git` 命令，无 PATH 兜底或错误处理

- **文件**：`src/main.rs:2216-2235`
- **相关代码**：
  ```rust
  let output = Command::new("git")
      .arg("clone")
      .arg(git_url)
      .arg(repo_dir)
      .output()
      .await?;
  ```
- **问题描述**：直接调用 `git` 依赖系统 PATH。Windows 上 Git 可能未安装、未加入 PATH。错误信息仅捕获 stderr，但 Windows 上命令找不到时的错误信息是英文且来自操作系统。
- **平台影响**：Windows 上 Git 未安装或不在 PATH 中时，报错信息不友好；且 `git clone` 到 Windows 长路径（超过 260 字符）可能失败。
- **修复建议**：在启动时检测 `git` 可用性并给出明确提示；对 Windows 长路径问题，考虑在文档中说明或启用 `LongPathsEnabled` 注册表设置。

### 5. `build.mjs` 中 `run("cargo", ["build", "--release"])` 在 Windows 上可能找不到 `cargo`

- **文件**：`scripts/build.mjs:31`
- **相关代码**：`run("cargo", ["build", "--release"]);`
- **问题描述**：`cargo` 在 Windows 上通常通过 `rustup` 安装，命令就是 `cargo`（无 `.exe` 后缀，因为 Windows 的 `CreateProcess` 会自动补全）。但如果用户通过其他方式安装，或 `cargo` 不在 PATH 中，会失败。
- **平台影响**：Windows 上 Rust 未正确安装时构建失败。
- **修复建议**：在构建脚本开头检测 `cargo` 和 `npm` 的可用性，给出友好提示。

### 6. `server_addr` 默认绑定 `0.0.0.0`，在 Windows 防火墙环境下可能触发安全警告

- **文件**：`src/main.rs:2345-2355`
- **相关代码**：
  ```rust
  let host = env::var("RACCOON_HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
  ```
- **问题描述**：默认绑定 `0.0.0.0` 会监听所有网络接口。Windows 防火墙会在首次运行时弹出拦截对话框，对普通用户造成困惑。且开发模式下前端 Vite 也绑定 `0.0.0.0`（`frontend/vite.config.ts:8` 和 `frontend/package.json:7`）。
- **平台影响**：Windows 首次运行会触发防火墙弹窗；在公共网络环境下有暴露风险。
- **修复建议**：开发模式默认绑定 `127.0.0.1`，生产模式可通过环境变量显式设置为 `0.0.0.0`。或在文档中明确说明防火墙行为。

### 7. `CorsLayer::new().allow_origin(Any)` 允许任意来源

- **文件**：`src/main.rs:387-392`
- **相关代码**：
  ```rust
  CorsLayer::new()
      .allow_origin(Any)
      .allow_methods(Any)
      .allow_headers(Any)
  ```
- **问题描述**：生产环境下允许任意 CORS 来源存在安全风险。虽然这是本地工具，但绑定 `0.0.0.0` 后局域网内任何人都能访问 API。
- **平台影响**：所有平台，但在 Windows 家庭网络中更常见（用户可能不了解网络暴露风险）。
- **修复建议**：限制 CORS 来源为 `127.0.0.1:5173`（开发模式）或根据 `RACCOON_HOST` 动态配置。

### 8. `build_root_from_current_exe` 对 Windows 路径分隔符的假设

- **文件**：`src/main.rs:2357-2369`
- **相关代码**：
  ```rust
  let bin_dir = exe.parent()?;
  if bin_dir.file_name()?.to_string_lossy() != "bin" {
      return None;
  }
  ```
- **问题描述**：`file_name()` 在 Windows 上返回 `"bin"` 是正确的，因为 `Path` 抽象已经处理了分隔符。但如果可执行文件路径包含大小写混合（如 `Bin` 或 `BIN`），Windows 文件系统不区分大小写，但字符串比较区分。
- **平台影响**：Windows 上如果目录名大小写不一致，构建产物检测会失败，回退到开发路径。
- **修复建议**：使用 `eq_ignore_ascii_case` 进行比较。

### 9. `write_json` 原子写入使用 `tokio::fs::rename`，在 Windows 上可能因文件句柄未释放而失败

- **文件**：`src/main.rs:2195-2214`
- **相关代码**：
  ```rust
  tokio::fs::write(&temp_path, content).await?;
  if let Err(error) = tokio::fs::rename(&temp_path, path).await {
  ```
- **问题描述**：Windows 不允许重命名或删除被打开的文件。如果另一个进程（如文件监控、防病毒软件、或前端开发服务器）正在读取 `app.json`，`rename` 可能失败。Unix 允许原子重命名覆盖已打开文件。
- **平台影响**：Windows 上高并发或文件被监控时，JSON 写入可能失败。
- **修复建议**：在 Windows 上先尝试写入临时文件，成功后删除原文件再重命名；或捕获 `rename` 失败并回退到非原子写入。

---

## 低风险问题

### 10. （已移除）旧版 `data/app.json` 路径

- **说明**：原审计报告中记录的 `data/app.json` 路径属于已移除的旧版存储方案。当前版本唯一业务主存储为 `.raccoon-node/data.db`，不再使用 `data/` 目录。
- **修复建议**：无需修复，相关代码已移除。

### 11. `display_path` 在 Windows 上返回 `\` 分隔路径，前端展示可能不一致

- **文件**：`src/main.rs:2274-2276`
- **相关代码**：`path.to_string_lossy().to_string()`
- **问题描述**：Windows 上返回 `C:\data\projects\foo\repo`，前端展示时用户可能期望 `/` 分隔的路径。
- **平台影响**：仅展示层面，不影响功能。
- **修复建议**：若前端需要统一展示，可统一替换为 `/` 或保留原样。

### 12. `check-case-conflict` 和 `check-symlinks` 在 Windows 上行为有限

- **文件**：`.pre-commit-config.yaml:8, 13`
- **问题描述**：`check-case-conflict` 在 Windows 不区分大小写的文件系统上无法检测冲突；`check-symlinks` 在 Windows 上需要管理员权限或开发者模式才能创建符号链接。
- **平台影响**：Windows 上这两个钩子几乎无法发现实际问题。
- **修复建议**：保留即可，不会导致失败，只是效果有限。

### 13. `concurrently` 在 Windows 上进程管理可能不彻底

- **文件**：`package.json:6`
- **相关代码**：`"concurrently -k -n backend,frontend -c cyan,green \"cargo run\" \"npm --prefix frontend run dev\""`
- **问题描述**：`concurrently` 在 Windows 上通常能正常工作，但 `cargo run` 编译时间较长时，Ctrl+C 的进程终止可能不如 Unix 干净，留下 `raccoon_node.exe` 僵尸进程。
- **平台影响**：Windows 上开发时可能遇到端口占用（3001 或 5173）需要手动结束进程。
- **修复建议**：在文档中说明，或考虑使用 `concurrently` 的 `--kill-others-on-fail` 等选项增强进程管理。

---

## 优先修复 Top 5

| 优先级 | 问题 | 原因 |
|--------|------|------|
| 1 | pre-commit 本地钩子 bash 依赖 | 依赖 bash 环境，在纯净 Windows 环境可能失败；当前已验证可运行，但直接命令调用更健壮 |
| 2 | normalize_components 路径逃逸 | 安全相关，`ensure_child_path` 是项目资源隔离的核心防线 |
| 3 | pi/pi.cmd 查找逻辑 | 功能阻塞，Pi Agent 是核心 LLM 能力，Windows 上启动失败等于功能不可用 |
| 4 | 默认绑定 0.0.0.0 + 任意 CORS | 安全与体验，Windows 防火墙弹窗影响首次使用，且暴露 API 给局域网 |
| 5 | write_json 原子写入 Windows 兼容性 | 数据可靠性，Windows 文件锁可能导致配置保存失败 |

---

## 总体评价

项目整体跨平台意识较好（如 `build.mjs` 正确处理 `npm.cmd` 和 `.exe`、Rust 代码使用 `PathBuf` 而非字符串拼接）。**pre-commit 配置依赖 bash 环境**，在当前已安装 bash 的环境中可运行，但纯净 Windows 环境存在隐式依赖风险，建议改为直接命令调用以提升健壮性。路径安全校验和 Pi Agent 启动逻辑是第二梯队，需要针对 Windows 路径前缀和命令查找做加固。网络绑定和 CORS 配置建议收紧以提升安全性和开发体验。
