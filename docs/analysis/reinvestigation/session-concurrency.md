# review-task-3 失败原因重新调查：session 并发与 OOM 假说

> 调查目标：回应“review-task-3 因并发 OOM 失败”的质疑，从 session 并发、日志、数据库 trace、源码四个维度验证原结论是否成立。
> 调查时间：2026-07-12 ~ 2026-07-13
> 报告路径：`docs/analysis/reinvestigation/session-concurrency.md`

---

## 1. 摘要（Summary）

原始报告认为 review-task-3 的失败与“并发 OOM”有关。重新调查后，**这一 OOM 结论缺乏直接证据，且被多项反证削弱**。真正更可能的原因是：

- `raccoon-review-orchestrator.mjs` 在单次 review 中通过 `Promise.all` 并发启动 3 个 `--no-session` 子代理；
- 父 session 的 `wait_for_agent_end_with_events` 使用 **90 秒 idle timeout**（无新输出即判定超时）；
- 子代理没有独立 timeout，也没有在超时/失败时串行降级；
- `execution_failure_count` 在每次成功 review 后被重置，使得失败路径反复进入同一并发模式，最终耗尽 `MAX_EXECUTION_FAILURES`。

因此，review-task-3 最终失败应归因于 **orchestrator 的并发 timeout 与失败恢复设计缺陷**，而非本地 OOM。

---

## 2. 调查方法（Method）

1. **log-failures**：检查 raccoon server 日志与 SQLite `requirements.messages` 中失败事件的来源与内容。
2. **session-concurrency**：基于 session JSONL 文件起止时间计算并发数，确认峰值进程数。
3. **db-trace**：汇总 `token_usage`、`operation_context` 等表，确认 token 与上下文占用。
4. **source-review-orchestrator**：阅读 `src/pi/assets/raccoon-review-orchestrator.mjs` 与相关 Rust 源码，确认并发模型与超时策略。
5. **oom-hypothesis**：查询 macOS 系统日志、内存状态、进程退出信号，验证 OOM/SIGKILL 假说。

---

## 3. 关键发现（Findings）

### 3.1 失败事件的真实来源

- raccoon server 日志 `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/logs/raccoon.2026-07-12` 仅有 **76 行 `started Pi Agent RPC` INFO**，没有任何失败、`143`、或超时消息。
- 原始报告引用的失败消息实际来自 SQLite `requirements.messages`。

`requirements.messages` 中 review-task-3 的失败事件共 **11 条**：

| 时间 | 事件类型 | 说明 |
|------|----------|------|
| 2026-07-12 14:51:xx ~ 14:53:xx | `Pi 子进程退出：143` | 共 5 次 |
| 2026-07-12 14:51:xx ~ 14:53:xx | `并行审核未返回受管工具结果` | 共 3 次 |
| **2026-07-12 18:02:06** | `等待 Pi Agent 新输出空闲超时` | **最终失败事件** |

最终失败是 **18:02:06 的 idle 超时**，不是 143，也不是 OOM。

### 3.2 执行计划中的最终状态

- `execution_plan` 中 review-task-3 最终：
  - `execution_failure_count = 5`
  - `recovery_stage = exhausted`
- task-3 自身：
  - `review_rejection_count = 3`
  - `status = awaiting_review`

`MAX_EXECUTION_FAILURES = 4`，实际失败计数达到 5，说明失败计数在成功 review 后会被重置，导致后续再次进入相同的失败路径。

### 3.3 并发架构

`src/pi/assets/raccoon-review-orchestrator.mjs:116` 使用 `Promise.all` 并发启动 3 个 `--no-session` 子代理：

```javascript
// src/pi/assets/raccoon-review-orchestrator.mjs:116
const results = await Promise.all([
  runReviewer(agentCommand, fileGroups[0], /* ... */),
  runReviewer(agentCommand, fileGroups[1], /* ... */),
  runReviewer(agentCommand, fileGroups[2], /* ... */),
]);
```

子代理命令行见 `src/pi/assets/raccoon-review-orchestrator.mjs:39-41`：

```javascript
const reviewer = spawn(agentCommand, [
  '--no-session',
  '--mode', 'rpc',
  // ...
]);
```

### 3.4 并发峰值

- 由 session 起止时间计算，**峰值父 session 并发数为 4**。
- 单次 review 调用时：1 个父 session + 3 个子代理 = **4 个 Pi 进程**。
- 多个 review session 在 **14:51–14:53** 有重叠，理论峰值可能更高，但仍处于同一数量级。

### 3.5 Token / 上下文占用

数据库 trace 汇总：

| 指标 | 数值 |
|------|------|
| 累计 input tokens | 12,100,502 |
| 累计 output tokens | 327,579 |
| 累计 cacheRead | 6,459,210 |
| 累计 cacheWrite | 800,443 |
| 最大 operation context percent | **64.1968%**（131,475 / 204,800） |
| 子代理最大 context percent | **3.6799%**（18,841 tokens） |

最大 context percent 出现在 task-3 的 implementation session，子代理上下文占比很小。远程模型不加载本地权重，context 窗口压力不会导致本地 OOM。

### 3.6 OOM 反证

- macOS `log show` 在相关时间窗口内**没有 raccoon / pi 被 OOM / jetsam / SIGKILL 的记录**。
- raccoon 被系统标记为 `not RunningBoard jetsam managed`。
- 退出码 **143 = SIGTERM**，与 OOM 杀手的 **SIGKILL（137 / signal 9）** 不符。
- 模型为远程 API，不本地加载权重。
- 系统内存 24 GB，当前空闲充足。

### 3.7 超时与恢复相关源码常量

```rust
// 相关源码常量
MAX_REVIEW_REJECTIONS = 5
MAX_EXECUTION_FAILURES = 4
MAX_JSON_REPAIR_ATTEMPTS = 1
```

所有任务默认：

```rust
timeout_seconds = 90
```

`wait_for_agent_end_with_events` 的 hard timeout 基于 idle 时间：**父任务 90 秒无新输出即被杀**。

---

## 4. 证据清单（Evidence）

| 证据 | 位置 / 数值 |
|------|-------------|
| raccoon server 日志 | `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/logs/raccoon.2026-07-12`（76 行 `started Pi Agent RPC`，无失败） |
| 失败消息存储 | SQLite `requirements.messages`（11 条失败事件） |
| 最终失败时间 | `2026-07-12 18:02:06`，事件 `等待 Pi Agent 新输出空闲超时` |
| 执行计划状态 | `execution_failure_count=5`，`recovery_stage=exhausted` |
| task-3 状态 | `review_rejection_count=3`，`status=awaiting_review` |
| 并发启动代码 | `src/pi/assets/raccoon-review-orchestrator.mjs:116`（`Promise.all` 3 子代理） |
| 子代理命令行 | `src/pi/assets/raccoon-review-orchestrator.mjs:39-41`（`--no-session --mode rpc`） |
| 峰值并发 | 父 session 4，单次 review 1 父 + 3 子 = 4 Pi 进程 |
| Token 汇总 | input 12,100,502 / output 327,579 / cacheRead 6,459,210 / cacheWrite 800,443 |
| 最大 context | 64.1968%（131,475 / 204,800，task-3 implementation session） |
| 子代理最大 context | 3.6799%（18,841 tokens） |
| 系统日志 | `log show` 无 OOM / jetsam / SIGKILL 记录 |
| 进程属性 | `not RunningBoard jetsam managed` |
| 退出信号 | 143 = SIGTERM，非 OOM 的 SIGKILL |
| 超时常量 | `timeout_seconds=90`，父 idle hard timeout 90 秒 |
| 恢复常量 | `MAX_EXECUTION_FAILURES=4`，失败计数在成功 review 后重置 |

---

## 5. 结论（Conclusion）

1. **原始“并发 OOM”结论不被支持**。macOS 系统日志、退出信号、内存状态、模型远程加载方式均不支持本地 OOM 假说。
2. **真正更可能的原因是 orchestrator 的并发 timeout 与恢复缺陷**：
   - `Promise.all` 并发 3 个子代理，但父 session 只有 90 秒 idle timeout；
   - 子代理无独立 timeout，也无串行降级路径；
   - 失败计数在成功 review 后被重置，导致 task 反复进入同一高失败率路径；
   - 最终 `execution_failure_count` 超过 `MAX_EXECUTION_FAILURES=4`，进入 `exhausted`。
3. 建议修复方向：
   - 为子代理增加独立 timeout 或取消/降级机制；
   - 在父 idle timeout 临近时保留已完成的子代理结果，而非整体失败；
   - 对连续失败的 review 任务自动降级为串行审核；
   - 重新评估 `execution_failure_count` 在成功 review 后的重置策略，避免失败路径循环。

---

## 6. 附录：原始报告引用纠正

原始报告若将 `Pi 子进程退出：143` 与 OOM 直接关联，则属于误读：

- 143 是 SIGTERM，可能来自 orchestrator 内部的进程管理、父 session 超时后的清理，或正常取消流程；
- 这些消息存储在业务 SQLite 中，并非 raccoon server 进程日志；
- 最终失败事件是 idle 超时，不是 143。
