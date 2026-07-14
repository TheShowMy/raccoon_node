# OOM 假设复核报告：review-task-3 失败根因再调查

> 分析目标：`/Users/theshow/work/rust/project/raccoon_agents_test`
> 时间窗口：2026-07-12 14:42–18:02
> 原始结论：review-task-3 因并行审核子代理 OOM 失败
> 复核角度：**OOM 假设是否成立**

---

## Summary

原始分析将 review-task-3 的最终失败归因于「3 个 `--no-session` 审核子代理并发导致 OOM」。复核后，**该结论不被证据支持，应被显著削弱**。核心发现：

1. **失败消息不在 raccoon server log 中**，而是保存在 SQLite `requirements.messages` 里；原始分析引用的「log[msg[19]]、log[msg[41]]」等说法与文件内容不符。
2. **143 退出码是 SIGTERM，不是 OOM 杀手的 SIGKILL**。在 macOS 上，OOM 杀手通常发送 SIGKILL（9）；143 = 128 + 15 对应 SIGTERM。
3. **143 失败是单角度、间歇性、可恢复的**：多个 session 文件显示，3 个审核角度中通常只有 1 个以 143 失败，其余 2 个成功返回；类似的 143 失败在 review-task-1、review-task-2 中也出现过，但最终都成功了。
4. **最终失败原因是「等待 Pi Agent 新输出空闲超时」**，不是 143，也不是系统 OOM。
5. **Pi 子进程是 API 客户端**（模型提供商 minimax-cn / deepseek），不本地加载模型权重；上下文窗口使用峰值 64.2%（131K / 204K tokens），不存在足以触发系统 OOM 的内存占用。
6. 系统日志中**没有任何 raccoon/pi 进程被系统杀死或 OOM 的纪录**，也没有相关 crash report。

因此，最可能的根因是：**并行审核 orchestrator 缺少单个子代理超时和整体 wall-clock 超时，导致子代理在启动/内部超时时以 SIGTERM（143）退出，父任务又因 idle 超时机制被无限期重置，最终耗尽 `MAX_EXECUTION_FAILURES`**。

---

## Method

1. 读取原始分析报告 `docs/analysis/raccoon_agents_test_analysis.md`。
2. 读取 raccoon server log `.raccoon-node/logs/raccoon.2026-07-12`。
3. 用 Python + `sqlite3` 解析目标项目 `data.db` 的 `requirements.messages` JSON 与 `execution_plan`。
4. 解析全部 32 个 session JSONL 文件，提取：
   - session header（cwd、id、timestamp）
   - `run_parallel_code_review` 工具返回的 reviews 数组
   - 各审核角度的 ok/error/usage
   - model_change 时间线
5. 阅读 raccoon-node 源码：`src/requirement/execution.rs`、`src/pi/mod.rs`、`src/pi/assets/raccoon-review-orchestrator.mjs`、`src/pi/assets/raccoon-review-worker.mjs`、`src/store/mod.rs`、`src/store/helpers.rs`。
6. 检查 macOS 系统日志 `log show` 与 DiagnosticReports，搜索 OOM、SIGKILL、SIGTERM、raccoon/pi 进程被杀等事件。

---

## Findings

### 1. Log failures：失败/恢复时间线

#### 1.1 raccoon server log 的真实内容

`.raccoon-node/logs/raccoon.2026-07-12` 只有 **76 行 INFO 日志**，且全部是关于启动 Pi Agent RPC 的：

```text
2026-07-12T14:42:27.822526Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
...
2026-07-12T17:28:04.145829Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
```

**该日志中没有任何 `执行失败`、`Pi 子进程退出`、`并行审核未返回`、`恢复策略`、`等待 Pi Agent 新输出空闲超时` 等消息。**

#### 1.2 真实的失败时间线（来自 SQLite `requirements.messages`）

| # | 时间（UTC） | 消息索引 | 内容 |
|---|------------|---------|------|
| 1 | 15:37:11.724 | 85 | 审核子代理「代码质量与测试」执行失败：Pi 子进程退出：143 |
| 2 | 15:37:18.205 | 86 | 并行审核未返回受管工具结果 |
| 3 | 15:37:22.455 | 87 | 并行审核未返回受管工具结果 |
| 4 | 15:37:31.149 | 88 | 已生成高档模型恢复方案（GuidedRetry） |
| 5 | 15:37:36.061 | 89 | 并行审核未返回受管工具结果 |
| 6 | 15:45:15.776 | 103 | 审核子代理「正确性」执行失败：Pi 子进程退出：143 |
| 7 | 15:55:37.693 | 116 | 审核子代理「正确性」执行失败：Pi 子进程退出：143 |
| 8 | 16:00:29.655 | 125 | 审核子代理「边界与安全」执行失败：Pi 子进程退出：143 |
| 9 | 16:33:55.687 | 126 | 等待 Pi Agent 新输出空闲超时 |
| 10 | 16:50:45.217 | 127 | 审核子代理「正确性」执行失败：Pi 子进程退出：143 |
| 11 | 16:51:07.059 | 128 | 已生成高档模型恢复方案 |
| 12 | 17:28:03.935 | 129 | 等待 Pi Agent 新输出空闲超时 |
| 13 | 18:02:06.529 | 130 | **最终失败：等待 Pi Agent 新输出空闲超时** |

review-task-3 共记录 **5 次 `Pi 子进程退出：143`**、**3 次「并行审核未返回受管工具结果」**、**3 次「等待 Pi Agent 新输出空闲超时」**。注意同一个 attempt 可能同时触发 143 +「未返回受管工具结果」，因此事件数大于 execution failure 计数。

从 DB `execution_plan` 读取的最终任务状态：

- `task-3`：`awaiting_review`，`review_rejection_count=3`，`execution_failure_count=0`
- `review-task-3`：`failed`，`review_rejection_count=0`，`execution_failure_count=5`，`recovery_stage=exhausted`

#### 1.3 原始分析引用的 log 行不存在

原始分析称「review-task-1 和 review-task-2 也出现过同样的 SIGTERM（msg[19], msg[41]）」。这些消息确实存在于 DB 中：

- `[19]` 14:51:56.081985Z：review-task-1「代码质量与测试」Pi 子进程退出：143
- `[41]` 14:58:58.203386Z：review-task-2「正确性」Pi 子进程退出：143

但它们是 `requirements.messages` 的数组索引，**不是 raccoon server log 的行号**。这是原始分析在证据来源上的重大偏差。

---

### 2. Session concurrency：并发子代理数量与运行模式

#### 2.1 审核子代理的启动方式

源码 `src/pi/assets/raccoon-review-orchestrator.mjs` 第 116 行：

```javascript
const reviews = await Promise.all(ANGLES.map(async (angle, index) => {
  const childPrompt = `${policy}\n\n审核角度：${angle}\n\n${packet}\n\n必须先读取 staged diff，完成审核后调用 submit_review_result。`;
  const review = await runChild(angle, childPrompt, ctx, workerPath, signal, emit);
  ...
}));
```

`ANGLES = ["正确性", "边界与安全", "代码质量与测试"]`，因此**3 个审核角度是并发启动**的。每个子进程命令行为：

```javascript
const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", workerPath,
  "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--tools", "read,grep,find,ls,read_staged_diff,submit_review_result"];
if (model) args.push("--model", model);
```

注意：**`--no-session` 的是 ReviewSubAgent 子代理，不是 Review 父任务本身**。Review 父任务使用普通 session 并加载 `raccoon-review-orchestrator.mjs` 扩展（`src/pi/mod.rs` 第 423-442 行）。原始分析把这一层级关系说反了。

#### 2.2 峰值并发进程数

- raccoon 主进程：1
- Review 父任务 Pi 进程（Medium，MiniMax-M3）：1
- 并行审核子代理 Pi 进程（`--no-session`，MiniMax-M3）：3
- 可能同时存在的 task-3 implementation session（MiniMax-M2.7，通常已空闲）：1
- 可能存在的 project client（用于分析/规划，通常已空闲）：≤1（上限 `MAX_PROJECT_CLIENTS = 5`）

因此峰值活跃的 Pi 子进程约为 **4–6 个**，与原始分析和用户观察基本一致。

#### 2.3 session 文件数量

`.raccoon-node/sessions/` 下实际有 **32 个 `.jsonl` 文件**（不是 34 个）。由于子代理使用 `--no-session`，它们不产生 session 文件；session 文件主要来自：

- 需求分析/规划（2 个 project 级 session）
- task-1 / task-2 / task-3 的 implementation session（多次复用）
- branch-merge-1 session（1 个）

---

### 3. DB trace：需求状态、token 消耗与上下文

#### 3.1 最终需求状态

- `requirement-1783867380305-1` 状态：**`failed`**
- 已完成任务：task-1、review-task-1、task-2、review-task-2、branch-merge-1
- 失败任务：review-task-3
- 阻塞任务：task-4/5、review-task-4/5、merge-review

#### 3.2 task-3 与 review-task-3 的拒绝/失败计数

| 任务 | 状态 | review_rejection_count | execution_failure_count | recovery_stage |
|------|------|------------------------|------------------------|----------------|
| task-3 | awaiting_review | 3 | 0 | none |
| review-task-3 | failed | 0 | 5 | exhausted |

task-3 因审核不通过被拒绝了 3 次，触发了 2 次 GuidedRetry（高档模型恢复方案）；review-task-3 自身作为审核任务，每次执行失败都会增加 `execution_failure_count`，达到 5 次后进入 exhausted。

#### 3.3 全需求 token 消耗（来自 messages 中 trace 的 usage 对象）

| 指标 | 数值 |
|------|------|
| 累计 input tokens | 12,100,502 |
| 累计 output tokens | 327,579 |
| 累计 cacheRead | 6,459,210 |
| 累计 cacheWrite | 800,443 |
| **最大 context percent** | **64.1968%** |
| 最大 context tokens / window | 131,475 / 204,800 |

最大上下文出现在 **task-3 implementation session**（15:59:52，MiniMax-M2.7，204,800 tokens 窗口）。Review 父任务复用了该 session，因此 Review 父进程启动时已经携带 131K tokens 的历史上下文。

Review 子代理（`--no-session`）每次启动都是 fresh session，窗口 512K，实际使用约 1.3%（~6,560 tokens）。失败子代理的 usage 极低：

| 失败角度 | input | output | 说明 |
|----------|------:|-------:|------|
| 正确性 | 54 | 78 | 几乎未开始 |
| 正确性 | 127 | 746 | 启动后很快退出 |
| 正确性 | 127 | 812 | 启动后很快退出 |
| 边界与安全 | 129 | 1,119 | 启动后很快退出 |
| 代码质量与测试 | 1 | 1,360 | 只收到提示就退出 |
| 代码质量与测试 | 1 | 1,754 | 只收到提示就退出 |

这些失败发生在子代理生命周期的**极早期**，与「模型加载后因上下文过大而 OOM」的假设不符。

---

### 4. Source-review-orchestrator：源码层面的并发与超时设计

#### 4.1 关键常量

- `src/store/mod.rs:41`：`MAX_REVIEW_REJECTIONS = 5`
- `src/store/mod.rs:42`：`MAX_EXECUTION_FAILURES = 4`
- `src/pi/mod.rs:43`：`MAX_JSON_REPAIR_ATTEMPTS = 1`
- `src/pi/mod.rs:42`：`MAX_PROJECT_CLIENTS = 5`
- `src/requirement/execution.rs:119` / 719 / 903：所有任务默认 `timeout_seconds: 90`

#### 4.2 Review 任务超时

`src/pi/mod.rs` 1147-1148：

```rust
self.wait_for_agent_end_with_events(
    Duration::from_secs(input.task.timeout_seconds),  // 90s warning
    Duration::from_secs(input.task.timeout_seconds),  // 90s hard idle timeout
    ...
)
```

#### 4.3 空闲超时机制的问题

`src/pi/mod.rs` 1603-1678 的 `wait_for_agent_end_with_events` 逻辑：

- `last_output_at` 只有在 `event_has_output_activity` 返回 true 时才重置；
- `event_has_output_activity` 把 `tool_execution_update` / `tool_execution_end`、文本 delta、thinking delta 等都算作 activity；
- **hard_timeout 也是基于 idle 时间**，而不是 wall-clock 时间：

```rust
let remaining = hard_timeout.saturating_sub(idle_for);
...
_ = tokio::time::sleep(remaining) => {
    let _ = io.child.start_kill();
    return Err(AppError::internal("等待 Pi Agent 新输出空闲超时"));
}
```

这意味着只要 orchestrator 还在 emit `tool_execution_update`（例如「1/3 完成」「2/3 完成」），90 秒计时就会不断重置。一个子代理 hang 住，但其他子代理还在陆续完成并 emit 更新，整个工具调用可以运行几十分钟不被 raccoon 杀死。

#### 4.4 并行审核 orchestrator 本身没有超时

`raccoon-review-orchestrator.mjs`：

- `runChild` 没有设置任何子代理级别的 timeout；
- 它等待 `agent_end` 后请求 `get_session_stats`，收到 stats 后才 `child.kill()`；
- 如果子代理在 `agent_end` 之前 hang 住，`child.kill()` 永远不会被调用，该子进程一直存在；
- `Promise.all` 等待全部 3 个子代理，只要有一个 hang 住，工具调用就不会返回；
- 唯一的中断路径是外部 `signal` abort（例如 raccoon 杀死父任务时），此时所有子代理被 `child.kill()` 发送 SIGTERM，退出码 143。

#### 4.5 143 退出码的来源

在 orchestrator 的 `runChild` 中：

```javascript
child.on("close", (code) => finish({ angle, ok: result?.protocol === PROTOCOL && statsReceived, error: result && statsReceived ? null : (stderr || `Pi 子进程退出：${code}`), ... }));
```

- 正常完成路径：收到 stats 后 `child.kill()` 发送 SIGTERM → code = 143，但 `statsReceived=true` 且 `result` 有效，所以 `ok=true`、无 error。
- 错误路径：子代理在收到 stats 前就以 143 退出 → `error = "Pi 子进程退出：143"`。

因此 143 报告的是**子代理被 SIGTERM 终止且未完成任务**。SIGTERM 的来源可能是：

1. 外部 abort signal（raccoon 超时/取消父任务时杀死所有子代理）；
2. 子代理进程自身的内部超时/看门狗发送 SIGTERM 自杀；
3. 其他外部信号。

**不可能是 macOS OOM 杀手**：macOS OOM 杀手对无响应/高内存进程通常发送 SIGKILL（9），而不是 SIGTERM（15），并且会在系统日志中留下记录。

---

### 5. OOM hypothesis：专门验证 OOM 假设

#### 5.1 系统日志中没有 OOM 证据

在 2026-07-12 15:30–17:00 窗口搜索：

- `runningboardd` 的 jetsam / memory limit 事件：只涉及系统服务（mds、photoanalysisd、Codex 等），**没有任何 raccoon 或 pi 进程**；
- `launchd` 的 SIGKILL 退出：全部是 `com.apple.mdworker.shared.*`，属于 Spotlight 索引，**与 raccoon/pi 无关**；
- 没有 `raccoon` 或 `pi` 被系统杀死、OOM、crash 的日志。

`~/Library/Logs/DiagnosticReports/` 中也没有 raccoon/pi 的 crash report。

#### 5.2 143 不是 OOM 杀手的信号

| 信号 | 数值 | 典型来源 |
|------|------|----------|
| SIGKILL | 9 | 内核 OOM 杀手、`kill -9`、macOS jetsam |
| SIGTERM | 15 | 正常终止请求、看门狗、父进程 polite kill |
| 143 = 128+15 | — | 进程被 SIGTERM 终止后的 shell/Node 退出码 |

macOS 的 OOM/memorypressure 机制通常使用 SIGKILL 或 jetsam，不会留下 143。raccoon 的 orchestrator 在父任务被取消/超时时也会用 SIGTERM 杀子代理，但那种情况下 3 个子代理会同时 143，而证据显示是单角度失败。

#### 5.3 单角度失败模式与 OOM 不符

从 session JSONL 中提取的 `run_parallel_code_review` 结果：

| 时间 | session | 失败角度 | 其余角度状态 |
|------|---------|----------|--------------|
| 14:50:52 | task-1 review | 代码质量与测试 143 | 正确性 ✅、边界与安全 ✅ |
| 14:58:12 | task-2 review | 正确性 143 | 边界与安全 ✅、代码质量与测试 ✅ |
| 15:36:42 | task-3 review | 代码质量与测试 143 | 正确性 ✅、边界与安全 ✅ |
| 15:44:47 | task-3 review | 正确性 143 | 边界与安全 ✅、代码质量与测试 ✅ |
| 15:54:58 | task-3 review | 正确性 143 | 边界与安全 ✅、代码质量与测试 ✅ |
| 15:59:52 | task-3 review | 边界与安全 143 | 正确性 ✅、代码质量与测试 ✅ |

如果系统真的发生 OOM，3 个同类型的子代理同时运行的概率应导致**多个或全部一起失败**，而不是每次都只有随机 1 个失败。

#### 5.4 模型为远程 API，Pi 进程内存占用低

`requirements.messages` 中的 model_change 记录显示模型来自远程 API 提供商：

- `minimax-cn/MiniMax-M2.7`
- `minimax-cn/MiniMax-M3`
- `deepseek/deepseek-v4-flash`

Pi Agent 在 `--mode rpc` 下是这些远程 API 的本地封装进程，**不加载完整模型权重**。每个进程的主要内存占用是上下文文本和 JSONL 通信缓冲。Review 子代理上下文仅约 6.5K tokens；即使父任务复用 implementation session，峰值上下文也只有 131K tokens。这些数量级（MB 级）不可能导致拥有 GB 级空闲内存的 macOS 系统 OOM。

#### 5.5 最终失败是 idle 超时，不是 OOM

review-task-3 的最后一次系统消息：

```text
2026-07-12T18:02:06.529113Z 任务「审核：引入 svelte-spa-router 替代手动 hash 路由」执行失败：等待 Pi Agent 新输出空闲超时
```

如果根因是 OOM，最后应继续出现 143 或进程崩溃；但实际是 raccoon 的 idle 超时机制触发了最终失败。

#### 5.6 类似 143 在早期 review 中可恢复

review-task-1（14:51:56）和 review-task-2（14:58:58）也出现过 143 失败，但后续重试成功。这说明 143 是一种**间歇性、可恢复的错误**，不是系统内存不足的致命信号。

---

## Evidence

### 引用原文

**Raccoon server log 只含启动信息：**

```text
2026-07-12T14:42:27.822526Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
...
2026-07-12T17:28:04.145829Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
```

**DB 中 review-task-3 的失败序列（节选）：**

```text
2026-07-12T15:37:11.724275Z 任务「审核：引入 svelte-spa-router 替代手动 hash 路由」执行失败，将按恢复策略重试：审核子代理「代码质量与测试」执行失败：Pi 子进程退出：143
2026-07-12T15:37:18.205858Z 任务「审核：引入 svelte-spa-router 替代手动 hash 路由」执行失败，将按恢复策略重试：并行审核未返回受管工具结果
...
2026-07-12T18:02:06.529113Z 任务「审核：引入 svelte-spa-router 替代手动 hash 路由」执行失败：等待 Pi Agent 新输出空闲超时
```

**并行审核结果中典型的单角度 143 失败（`2026-07-12T15-59-52-539Z_...jsonl`）：**

```json
{
  "text": "并行审核技术失败：边界与安全",
  "details": {
    "reviews": [
      { "angle": "正确性", "ok": true, "usage": { "input": 1833, "output": 2671 } },
      { "angle": "边界与安全", "ok": false, "error": "Pi 子进程退出：143", "usage": { "input": 129, "output": 1119 } },
      { "angle": "代码质量与测试", "ok": true, "usage": { "input": 1642, "output": 2230 } }
    ]
  }
}
```

**源码：Review 任务 90 秒 idle 超时，无 wall-clock 硬上限：**

`src/pi/mod.rs:1147-1148`：

```rust
self.wait_for_agent_end_with_events(
    Duration::from_secs(input.task.timeout_seconds),
    Duration::from_secs(input.task.timeout_seconds),
    ...
)
```

`src/pi/mod.rs:1665-1667`：

```rust
_ = tokio::time::sleep(remaining) => {
    let _ = io.child.start_kill();
    return Err(AppError::internal("等待 Pi Agent 新输出空闲超时"));
}
```

**源码：orchestrator 并发启动 3 个子代理且无子代理超时：**

`src/pi/assets/raccoon-review-orchestrator.mjs:116`：

```javascript
const reviews = await Promise.all(ANGLES.map(async (angle, index) => {
  ...
  const review = await runChild(angle, childPrompt, ctx, workerPath, signal, emit);
  ...
}));
```

**源码：子代理使用 `--no-session`：**

`src/pi/assets/raccoon-review-orchestrator.mjs:39`：

```javascript
const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", workerPath,
  "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--tools", "read,grep,find,ls,read_staged_diff,submit_review_result"];
```

---

## Conclusion

### 对原始 OOM 结论的判定

**原始「OOM 导致 review-task-3 失败」的结论不被证据支持，应判定为「显著削弱 / 基本不成立」**。

削弱依据：

1. **证据来源错误**：原始分析把 DB `requirements.messages` 的数组索引当成 raccoon log 行号，并把本应放在 DB 中的失败消息说成是 log 输出。
2. **退出码解读错误**：143 是 SIGTERM，不是 OOM 杀手的 SIGKILL。
3. **失败模式不符**：143 是单角度、间歇性、可恢复的；OOM 应造成更一致、更严重的多进程同时失败。
4. **系统日志无 OOM 记录**：没有任何 raccoon/pi 进程被系统杀死或 OOM 的日志/crash report。
5. **进程内存占用不支持 OOM**：Pi 是远程 API 客户端，上下文峰值 131K tokens，远不足以触发系统 OOM。
6. **最终失败是超时**：如果 OOM 是根因，最终事件应是 143 或崩溃，但实际是 raccoon 的 idle 超时。

### 最可能的真正根因

review-task-3 多次失败并最终 exhausted 的最可能原因是 **orchestrator 超时与并发控制缺陷**，而非 OOM：

1. **子代理级 143 失败**：3 个 `--no-session` 子代理并发启动时，个别子代理在初始化阶段因内部超时/资源竞争/模型 API 响应问题以 SIGTERM（143）退出。失败角度随机轮换（正确性、边界与安全、代码质量与测试），说明是并发启动的 race condition，不是确定性内存不足。
2. **父任务 idle 超时无限重置**：`wait_for_agent_end_with_events` 的 hard timeout 基于 idle 时间，只要 orchestrator  emit 进度更新就会重置。没有子代理级 timeout 和整体 wall-clock timeout，导致 hung 的调用可以持续数十分钟。
3. **MAX_EXECUTION_FAILURES 耗尽**：每次子代理 143 或父任务 idle 超时都被记为一次 execution failure，经过 5 次后进入 exhausted，需求失败。
4. **上下文膨胀加剧不稳定性**：task-3 implementation session 被复用到 review 阶段，上下文达到 131K tokens（64.2% 窗口）。虽然不足以 OOM，但增加了模型处理时间和超时风险。

### 建议后续修复方向

1. **给并行审核工具增加 wall-clock 超时和单个子代理超时**，避免一个 hang 的子代理拖垮整个调用。
2. **将 Review 父任务的空闲超时改为真正的 wall-clock 上限**，或至少限制最大累计时间。
3. **对 143 失败增加重试/降级**：例如单角度失败时单独重试该角度，而不是让整个并行审核失败。
4. **避免把庞大 implementation session 直接复用于 review**：review 任务只需要 staged diff，可创建轻量 session 或只传递 diff，减少上下文和相关超时风险。
5. **在 orchestrator 中捕获并区分 SIGTERM 来源**：区分「自己 kill 的完成子代理」和「异常退出的子代理」，避免把正常的 143 误报为失败。

---

*报告生成时间：2026-07-13*
*复核人：Kimi Code CLI（oom-hypothesis 子代理）*
