# log-failures 复勘报告：review-task-3 失败原因再调查

> 目标项目：`/Users/theshow/work/rust/project/raccoon_agents_test`
> raccoon-node 源码：`/Users/theshow/work/rust/project/raccoon_node/src`
> 复勘时间：2026-07-13
> 复勘人：Kimi Code CLI（log-failures 视角）

## Summary

原分析将 review-task-3 的最终失败归咎于 **“3 个并发审核子代理 OOM”**。本次复勘发现：

1. **raccoon 服务器日志中没有任何失败/退出/内存相关记录**，只有 76 条 `started Pi Agent RPC using pi` 启动记录。完整失败/恢复时间线来自 `data.db` 的 system 消息与 session JSONL。
2. review-task-3 在 2026-07-12 15:37–18:02 之间记录了 **11 条系统级失败消息**（10 次“将按恢复策略重试” + 1 次最终失败）。最终失败原因是 **“等待 Pi Agent 新输出空闲超时”**，不是 OOM。
3. 子代理报出的 **exit 143（SIGTERM）** 是 `raccoon-review-orchestrator.mjs` 在子进程未返回有效结果后调用 `child.kill()` 产生的正常清理信号，不能等同于 OOM。子进程内部事件显示真正的终止原因是 **LLM request timed out**，以及子代理被错误地指示调用一个它并没有的工具 `run_parallel_code_review`。
4. macOS 系统日志中 **没有 memory-pressure、jetsam 或 kernel OOM kill** 记录；`~/Library/Logs/DiagnosticReports` 也没有 pi/raccoon 崩溃报告。
5. 审核子代理的上下文占用非常小（父级 review-task-3 最大 1.35%，子代理最大 1.18%）。任务-3 实现 session 确实膨胀到 64.20% 上下文，但那是**实现会话**，不是审核子代理。

**结论：原 OOM 结论不被证据支持，最可能的根因是并行审核子代理的超时/工具提示冲突 + raccoon_node 90 秒空闲超时导致的级联失败。**

---

## Method

复勘使用了以下数据源：

- `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/logs/raccoon.2026-07-12`
- `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/sessions/*.jsonl`（32 个父级 session 文件）
- `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/data.db` 的 `requirements` 表（`messages`、`execution_plan` 列）
- `raccoon_node` 源码：`src/store/mod.rs`、`src/store/helpers.rs`、`src/pi/mod.rs`、`src/pi/assets/raccoon-review-orchestrator.mjs`
- macOS `log show` 与诊断报告目录

---

## Findings

### 1. raccoon 服务器日志：只有启动，没有失败/内存记录

`.raccoon-node/logs/raccoon.2026-07-12` 共 76 行、6485 字节，内容全部是：

```text
2026-07-12T14:42:27.822526Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
...
2026-07-12T17:28:04.145829Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
```

对该日志检索 `失败|退出|错误|OOM|memory|143|SIGTERM|超时|未返回|恢复策略|exec|fail|exit|timeout` 等关键词，**仅命中 “started Pi Agent RPC using pi” 本身**，没有一行直接记录失败原因。

> 关键事实：服务器日志 **不能独立证明 OOM**；所有失败/恢复事件都写在 SQLite 和 session 文件里。

---

### 2. 失败/恢复时间线（来自 `data.db` system 消息）

#### 2.1 review-task-3 的 11 次系统失败

| # | 时间（UTC） | 记录内容 |
|---|-------------|----------|
| 1 | 15:37:11 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**审核子代理「代码质量与测试」执行失败：Pi 子进程退出：143** |
| 2 | 15:37:18 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**并行审核未返回受管工具结果** |
| 3 | 15:37:22 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**并行审核未返回受管工具结果** |
| 4 | 15:37:36 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**并行审核未返回受管工具结果** |
| 5 | 15:45:15 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**审核子代理「正确性」执行失败：Pi 子进程退出：143** |
| 6 | 15:55:37 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**审核子代理「正确性」执行失败：Pi 子进程退出：143** |
| 7 | 16:00:29 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**审核子代理「边界与安全」执行失败：Pi 子进程退出：143** |
| 8 | 16:33:55 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**等待 Pi Agent 新输出空闲超时** |
| 9 | 16:50:45 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**审核子代理「正确性」执行失败：Pi 子进程退出：143** |
| 10 | 17:28:03 | 任务「审核：引入 svelte-spa-router…」执行失败，将按恢复策略重试：**等待 Pi Agent 新输出空闲超时** |
| 11 | 18:02:06 | 任务「审核：引入 svelte-spa-router…」执行失败：**等待 Pi Agent 新输出空闲超时** |

> 最终失败代码/原因：**“等待 Pi Agent 新输出空闲超时”**（raccoon_node 父进程空闲超时）。

#### 2.2 早期 review-task-1 / review-task-2 也曾出现同样信号

- 14:51:56 — 审核子代理「代码质量与测试」执行失败：Pi 子进程退出：143
- 14:52:00 — 并行审核未返回受管工具结果
- 14:58:58 — 审核子代理「正确性」执行失败：Pi 子进程退出：143

这说明 143 / “未返回受管工具结果” 是一种**系统性模式**，不是 review-task-3 独有。

---

### 3. 失败计数器与 plan 状态：存在不一致

从 `execution_plan` 读取到的任务级状态：

```json
{
  "id": "task-3",
  "status": "awaiting_review",
  "review_rejection_count": 3,
  "execution_failure_count": 0
}
{
  "id": "review-task-3",
  "status": "failed",
  "execution_failure_count": 5,
  "recovery_stage": "exhausted",
  "model_tier": "high"
}
```

但 `task-3.review_history` 实际保存了 **18 个 review round**（round 1–17 rejected，round 18 reviewing）。assistant 消息中也能看到 17 条“审核不通过：…”的输出。

**解释**：
- `execution_failure_count` 在每次成功的任务执行后会被源码 `store/mod.rs:1963` 重置为 0：
  ```rust
  task.execution_failure_count = 0;
  task.failure_summary = None;
  task.recovery_stage = RequirementRecoveryStage::None;
  ```
  因此它只记录“最近一次连续失败”的次数，而不是整个生命周期的总失败次数。review-task-3 的 5 是最终连续失败 streak。
- `review_rejection_count=3` 与 18 个 review round 的明显差异说明 plan 级计数器没有如实累计所有审核拒绝；具体原因超出本次复勘范围，但它直接反驳了“只有 3 轮审核就失败”的简化叙事。

---

### 4. 并发情况：最终时刻确实是 1 父 + 3 子 = 4 个 Pi 进程

#### 4.1 Session 文件（父级 Pi Agent）

`.raccoon-node/sessions/` 下共有 **32 个 `.jsonl` 文件**。每个文件第一行是 `{"type":"session",...}`，包含 `cwd` 与 session id。与 review-task-3 直接相关的父级 session 是：

```text
2026-07-12T15-59-52-539Z_019f570e-72db-718f-b60e-f118bcc008af.jsonl
  cwd = .../.raccoon-node/worktrees/requirement-1783867380305-1-task-3
  model = MiniMax-M3（审核档位）
```

该 session 内共发起了 **4 次 `run_parallel_code_review` 工具调用**（时间戳 15:59:55、16:00:33、16:34:00、16:51:13），其中第 4 次挂起直到 17:28:04 才因父进程空闲超时而返回。

#### 4.2 并发证据

- `raccoon-review-orchestrator.mjs:116` 使用 `Promise.all(ANGLES.map(...))` 同时启动 3 个子代理：
  ```js
  const reviews = await Promise.all(ANGLES.map(async (angle, index) => {
    const childPrompt = `${policy}\n\n审核角度：${angle}\n\n${packet}\n\n必须先读取 staged diff，完成审核后调用 submit_review_result。`;
    const review = await runChild(angle, childPrompt, ctx, workerPath, signal, emit);
    ...
  }));
  ```
- `runChild` 给子进程的参数包含 `--no-session`：
  ```js
  const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", workerPath,
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--tools", "read,grep,find,ls,read_staged_diff,submit_review_result"];
  ```
  子代理**不会创建 session 文件**，因此 session 文件数（32）不等于子代理进程数。
- 在最终失败时刻，活跃的 Pi 进程 = 1 个 review-task-3 父 session + 3 个 `--no-session` 子代理 = **4 个**。这与“只有 4 个进程”的观察一致。

#### 4.3 全运行期父级并发峰值

服务器日志显示 76 次 `started Pi Agent RPC`，但只有 32 个 session 文件，说明很多父进程是重启/复用已有 session。

能直接确认父级并发的唯一证据是 **14:49:09** 同时启动了两个 session：

```text
2026-07-12T14-49-09-410Z_...task-2.jsonl
2026-07-12T14-49-09-411Z_...task-1.jsonl
```

对应 task-1 与 task-2 并行执行。除此之外，后续任务（包括 review-task-3）的父 session 都是顺序替换的。

---

### 5. 上下文与 Token 占用：审核子代理并不大

#### 5.1 从 `requirements.messages.trace[].metadata.trace.usage` 提取的按任务累计

| 任务/阶段 | Input | Output | CacheRead | CacheWrite | Calls | 最大上下文占比 | 最大上下文 tokens |
|-----------|------:|-------:|----------:|-----------:|------:|---------------:|------------------:|
| 引入 svelte-spa-router（task-3 实现，含全部修复轮次） | 9,399,475 | 81,240 | 5,074,032 | 632,435 | 191 | **64.20%** | 152,644 |
| CSS 变量体系完善（task-2） | 2,356,498 | 21,780 | 295,790 | 153,582 | 42 | 39.02% | 79,918 |
| 审核：引入 svelte-spa-router（review-task-3 父级） | 108,343 | 132,284 | 294,675 | 0 | 17 | 1.35% | 9,619 |
| 审核：CSS 变量体系 | 98,318 | 64,215 | 215,785 | 0 | 5 | 1.42% | 7,278 |
| 基础设施与配置（task-1） | 59,164 | 4,513 | 100,827 | 14,426 | 17 | 7.61% | 15,583 |
| 审核：基础设施 | 42,294 | 16,322 | 37,397 | 0 | 3 | 1.47% | 7,545 |
| 分支合并 1 | 14,496 | 2,787 | 267,136 | 0 | 24 | 3.05% | 15,592 |
| Pi Agent 分析过程 | 21,914 | 4,438 | 173,568 | 0 | 10 | 2.87% | 28,718 |

#### 5.2 关键观察

- **整个运行中最大的上下文占比 64.20% 出现在 task-3 实现阶段**（`requirements.messages` 中 trace[124]，上下文 131,475 / 204,800 tokens），而不是审核子代理。
- review-task-3 父级最大上下文只有 **1.35%**（6,919 / 512,000）。
- 子代理（`runChild` 返回的 `usage.context`）最大上下文占比仅 **1.18%**（6,061 / 512,000）。
- 因此，**将失败归因于“审核子代理上下文爆炸导致 OOM”与数据不符**：子代理上下文非常小。

---

### 6. 源码审查：并行审核编排与失败计数机制

#### 6.1 关键常量

`src/store/mod.rs:41-42`：

```rust
const MAX_REVIEW_REJECTIONS: u32 = 5;
const MAX_EXECUTION_FAILURES: u32 = 4;
```

> 注：源码当前值为 5/4，但 `task-3.review_rejection_count=3` 且第 3 轮后就触发了 GuidedRetry/HighTierExecution，说明**实际运行时使用的阈值可能与当前源码不同**，或计数器在运行中被重置/截断。

#### 6.2 审核任务执行路径

`src/pi/mod.rs:1143-1158`：

```rust
if input.task.kind == RequirementTaskKind::Review {
    self.ensure_parallel_review_extension().await?;
    self.prompt(&rendered_prompt.markdown).await?;
    let mut pi_events = Vec::new();
    self.wait_for_agent_end_with_events(
        Duration::from_secs(input.task.timeout_seconds),
        Duration::from_secs(input.task.timeout_seconds),
        &events,
        |event| { ... },
    ).await?;
    let mut output = parse_parallel_review_output(&pi_events)?;
    ...
}
```

- `timeout_seconds` 默认 90 秒（`src/models/mod.rs:420-422`）。
- `wait_for_agent_end_with_events` 在 90 秒无新输出时调用 `start_kill()` 并返回 `“等待 Pi Agent 新输出空闲超时”`（`src/pi/mod.rs:1667`）。
- 这就是 16:33:55、17:28:03、18:02:06 三次“空闲超时”的来源。

#### 6.3 子代理退出 143 的产生机制

`src/pi/assets/raccoon-review-orchestrator.mjs:83-84`：

```js
child.on("close", (code) => finish({ angle, ok: result?.protocol === PROTOCOL && statsReceived,
  error: result && statsReceived ? null : (stderr || `Pi 子进程退出：${code}`), ... }));
...
signal?.addEventListener("abort", () => child.kill(), { once: true });
```

`child.kill()` 在 Unix 上发送 SIGTERM，子进程退出码 = `128 + 15 = 143`。因此：

- **143 是扩展主动清理子进程的信号**，不是操作系统 OOM killer 的信号。
- 当子进程 LLM 请求超时、或被父进程 abort 信号终止时，都会看到 143。

#### 6.4 子代理失败如何升级为 execution failure

`src/pi/mod.rs:1994-2001`：

```rust
if review.get("ok").and_then(Value::as_bool) != Some(true) {
    return Err(AppError::internal(format!(
        "审核子代理「{angle}」执行失败：{}",
        review.get("error").and_then(Value::as_str).unwrap_or("未知错误")
    )));
}
```

任何一个 angle 的 `ok=false` 都会让 `parse_parallel_review_output` 返回 Err，进而被 `store/mod.rs:2184` 的 `register_execution_failure` 计数。因此“3 个子代理同时 143”会被记录为 1 次 execution failure。

---

### 7. OOM 假设专项检验

#### 7.1 macOS 系统日志

在 2026-07-12 14:40–18:05 窗口内执行：

```bash
log show --start '2026-07-12 14:40:00' --end '2026-07-12 18:05:00' \
  --predicate '(process == "pi") OR (process == "raccoon") OR (eventMessage CONTAINS "Memory pressure") OR (eventMessage CONTAINS "killed") OR (sender == "kernel" AND eventMessage CONTAINS "memorystatus")'
```

结果：
- 没有 `pi` 或 `raccoon` 进程被系统终止的记录。
- 没有 `Memory pressure` 或 `system is under memory pressure` 事件。
- 没有 kernel OOM / `memorystatus` kill 记录。
- `~/Library/Logs/DiagnosticReports` 中没有 2026-07-12 当天与 `pi`/`raccoon` 相关的崩溃报告。

#### 7.2 143 退出码的其他可能原因

- **SIGTERM from raccoon_node**：`wait_for_agent_end_with_events` / `send_command` 超时后会调用 `io.child.start_kill()`（`src/pi/mod.rs:1621,1666,1702,1796,1807`）。
- **SIGTERM from review orchestrator extension**：子代理完成/失败后调用 `child.kill()`。
- **Pi Agent 内部 request timeout**：子进程事件里明确出现 `"errorMessage": "Request timed out."` 与 `"auto_retry_start"`。

#### 7.3 子代理内部事件揭示的真实原因

从 review-task-3 父 session 的 `run_parallel_code_review` 工具结果中，子代理 `边界与安全` 的事件流显示：

```json
{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta",...,
  "delta":"There is NO `run_parallel_code_review` tool available to me. ..."}}
```

也就是说，**子代理收到的 prompt 让它调用 `run_parallel_code_review`，但它的 `--tools` 列表里只有 `read,grep,find,ls,read_staged_diff,submit_review_result`**。这个矛盾导致部分子代理陷入思考/等待，最终触发 LLM request timeout 或被扩展 kill，返回 143。

Run 2（16:34）的子代理事件更直接：

```json
{"type":"message_start","message":{"role":"assistant","content":[],"api":"anthropic-messages","provider":"minimax-cn","model":"MiniMax-M3","usage":{...},"stopReason":"error","errorMessage":"Request timed out."}}
{"type":"agent_end",...}
{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"Request timed out."}
```

这是**明确的请求超时**，与内存无关。

#### 7.4 内存估算

无法从现有数据估算并发 4 个 Pi 进程的实际内存占用，因为：
- 不知道 `MiniMax-M3` / `MiniMax-M2.7` / `deepseek-v4-flash` 的权重加载方式（按需、常驻、MPS/ANE 等）。
- 没有 `pi` 进程的采样内存日志。
- 子代理上下文仅 ~6K tokens，父级 task-3 最大上下文 ~131K tokens，主要内存压力应来自模型权重，而不是上下文。

因此 **“4 个进程导致 OOM”只能是一种假设，现有日志完全没有 corroborating evidence**。

---

## Conclusion

1. **原 OOM 结论不被支持**：服务器日志、系统日志、诊断报告、session 上下文数据均未出现 OOM 或内存压力证据。
2. **143 退出码不是 OOM 信号**：它是扩展/父进程对子代理的 SIGTERM 清理；子代理内部事件显示终止根因是 **LLM request timed out** 以及 **prompt 中要求调用子代理没有的工具 `run_parallel_code_review`**。
3. **最终失败是 raccoon_node 90 秒空闲超时**：review-task-3 父进程在 16:51:13 发起第 4 次并行审核后，直到 17:28:04 才返回，错误为“等待 Pi Agent 新输出空闲超时”；最终一次失败后进入 `exhausted`。
4. **“只有 4 个进程”的说法仅描述最终时刻**：全运行期有 76 次父进程启动、32 个 session 文件；最终 review-task-3 时刻确实是 1 父 + 3 子 = 4 个 Pi 进程，但进程数量本身不是失败原因。
5. **最可能的根因**：并行审核扩展的 **工具提示冲突 + 子代理请求超时 + raccoon_node 父进程空闲超时** 形成的级联失败，而不是内存不足。

---

## 附：关键证据索引

- 服务器日志：`.raccoon-node/logs/raccoon.2026-07-12`（76 行，无失败记录）。
- review-task-3 父 session：`.raccoon-node/sessions/2026-07-12T15-59-52-539Z_019f570e-72db-718f-b60e-f118bcc008af.jsonl`。
- 最大上下文 trace：`requirements.messages[124].metadata.trace.usage.context.percent = 64.19677734375%`（task-3 实现阶段）。
- 失败计数：`requirements.execution_plan.tasks` 中 `review-task-3.execution_failure_count = 5`、`recovery_stage = "exhausted"`。
- 源码：
  - `raccoon_node/src/store/mod.rs:41-42`（MAX_REVIEW_REJECTIONS / MAX_EXECUTION_FAILURES）
  - `raccoon_node/src/store/mod.rs:1963`（成功执行后重置 execution_failure_count）
  - `raccoon_node/src/pi/mod.rs:1143-1158`（Review 任务执行路径与 90s 超时）
  - `raccoon_node/src/pi/mod.rs:1667`（“等待 Pi Agent 新输出空闲超时”）
  - `raccoon_node/src/pi/mod.rs:1994-2001`（子代理失败升级为 execution failure）
  - `raccoon_node/src/pi/assets/raccoon-review-orchestrator.mjs:36-84`（`--no-session`、并发 Promise.all、`child.kill()` 产生 143）
