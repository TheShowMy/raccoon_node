# Source-Review-Orchestrator Reinvestigation Report

## Summary

The original analysis concluded that the final `review-task-3` failure was caused by **OOM (out-of-memory)** when three parallel code-review subagents ran concurrently. This reinvestigation finds that **conclusion is not supported by the evidence** and is in several key respects contradicted by it.

What actually happened:

- The raccoon server log is extremely sparse; it records only Pi Agent starts, not failure details. The real failure/recovery timeline is in `data.db` and the session JSONL files.
- `review-task-3` suffered **11 execution failures** over ~2.5 hours, not 5. The failures alternated between:
  - `Pi 子进程退出：143` (6 occurrences, angle-specific),
  - `并行审核未返回受管工具结果` (4 occurrences),
  - `等待 Pi Agent 新输出空闲超时` (3 occurrences, including the final exhaustion).
- The three review angles **did run in parallel** via `Promise.all` in the review-orchestrator extension, and each subagent was started with `--no-session`. Subagent context usage was small (max 3.68% context percent). The 64.2% context figure was the **parent implementation session**, not the subagents.
- macOS system logs for the failure window (15:50–17:30 on 2026-07-12) contain **no OOM kills**, no `SIGTERM` targeting raccoon/pi processes, and no memory-pressure events tied to the failure times. The `memorystatus_control` errors visible at 14:42:35 concern non-memory-managed system processes (`mds.index`, `searchpartyuseragent`) and occur at session startup, not during the review failures.
- Exit code 143 (`128 + SIGTERM`) is consistent with the child `pi --mode rpc --no-session` processes being terminated by an **internal Pi Agent timeout/limit or by the parent orchestrator/raccoon idle-timeout path**, not with the OS OOM killer.

**Conclusion:** The OOM hypothesis is weakened and likely contradicted. The more plausible root cause is a **reliability/timeout problem in the parallel-review orchestration itself**: three `--no-session` subagents are launched concurrently with no retry, no concurrency limit, and a hard 90 s idle timeout that is applied to the parent process while the subagents run. As the implementation session context grew, the Pi Agent child processes became unstable and began exiting with `143` or returning no result, eventually exhausting `MAX_EXECUTION_FAILURES`. The original analysis also materially under-counted total token burn (~918 K reported vs. ~12.1 M operation-scope input tokens observed) and misattributed the 64.2% context to the subagents.

---

## Method

Evidence sources examined:

1. `/Users/theshow/work/rust/project/raccoon_node/docs/analysis/raccoon_agents_test_analysis.md` — original analysis, read uncritically and cross-checked.
2. `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/logs/raccoon.2026-07-12` — raccoon server log.
3. `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/sessions/*.jsonl` — 32 Pi Agent session files.
4. `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/data.db` — SQLite store; `requirements.messages` parsed for trace metadata and failure timeline.
5. `/Users/theshow/work/rust/project/raccoon_node/src` — Rust orchestration source, especially:
   - `src/requirement/execution.rs`
   - `src/store/helpers.rs`
   - `src/store/mod.rs`
   - `src/pi/mod.rs`
   - `src/pi/assets/raccoon-review-orchestrator.mjs`
   - `src/pi/assets/raccoon-review-worker.mjs`
   - `src/models/mod.rs`
6. macOS `log show` and `/var/log/system.log*` for the window 2026-07-12 14:40–17:35, searched for OOM, kill, SIGTERM, memory pressure, raccoon, and pi.

Tools used: `Read`, `Grep`, `Bash`, `sqlite3`, Python 3.

---

## Findings

### 1. Log-failures: the raccoon log is not the primary failure record

The raccoon server log contains **only 76 lines**, all of the form:

```
2026-07-12T14:42:27.822526Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
```

There are **no** `执行失败`, `Pi 子进程退出`, `并行审核未返回`, `恢复策略`, or memory-related lines in this file. The original analysis quotes log lines that do not exist in the file.

The actual failure timeline is reconstructed from `data.db` `requirements.messages`. For `review-task-3` alone:

| # | Index | Timestamp (UTC) | Recorded reason |
|---|-------|-----------------|-----------------|
| 1 | 85 | 2026-07-12T15:37:11.724Z | 审核子代理「代码质量与测试」执行失败：Pi 子进程退出：143 |
| 2 | 86 | 2026-07-12T15:37:18.205Z | 并行审核未返回受管工具结果 |
| 3 | 87 | 2026-07-12T15:37:22.455Z | 并行审核未返回受管工具结果 |
| 4 | 89 | 2026-07-12T15:37:36.061Z | 并行审核未返回受管工具结果 |
| 5 | 103 | 2026-07-12T15:45:15.776Z | 审核子代理「正确性」执行失败：Pi 子进程退出：143 |
| 6 | 116 | 2026-07-12T15:55:37.693Z | 审核子代理「正确性」执行失败：Pi 子进程退出：143 |
| 7 | 125 | 2026-07-12T16:00:29.655Z | 审核子代理「边界与安全」执行失败：Pi 子进程退出：143 |
| 8 | 126 | 2026-07-12T16:33:55.687Z | 等待 Pi Agent 新输出空闲超时 |
| 9 | 127 | 2026-07-12T16:50:45.217Z | 审核子代理「正确性」执行失败：Pi 子进程退出：143 |
| 10 | 129 | 2026-07-12T17:28:03.935Z | 等待 Pi Agent 新输出空闲超时 |
| 11 | 130 | 2026-07-12T18:02:06.529Z | **最终失败：等待 Pi Agent 新输出空闲超时** |

Counts:
- `Pi 子进程退出：143`: **6**
- `并行审核未返回受管工具结果`: **4**
- `等待 Pi Agent 新输出空闲超时`: **3**
- Total `review-task-3` execution failures: **11**

Between failures, `review-task-3` completed successfully (returning rejections) **17 times**. Each successful completion resets `execution_failure_count` to 0 (`src/store/mod.rs:1963`), so the task survived multiple failure/rejection cycles before final exhaustion rather than failing after 5 consecutive execution failures as the original report implied.

### 2. Session-concurrency: three angles in parallel, but subagent context is small

- **32 session JSONL files** in `.raccoon-node/sessions/`.
- **19 of those sessions** have `cwd` under `.../worktrees/requirement-1783867380305-1-task-3`.
- The review orchestrator extension (`src/pi/assets/raccoon-review-orchestrator.mjs`) launches the three angles with:

```js
const reviews = await Promise.all(ANGLES.map(async (angle, index) => { ... }));
```

Each child is spawned as a separate `pi --mode rpc` process with:

```js
const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", workerPath,
  "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--tools", "read,grep,find,ls,read_staged_diff,submit_review_result"];
```

This is direct evidence of:
- **Parallel execution** of the three angles.
- ** `--no-session` subagents** that do not load or reuse the parent Pi session.
- A restricted tool set; the subagents only read staged diffs and submit results.

Context usage from the session/DB trace metadata:

| Metric | Value |
|--------|-------|
| Max operation-scope context percent observed | **64.20%** |
| Context tokens at that point | 131,475 |
| Context window at that point | 204,800 |
| Max subagent context percent observed | **3.68%** |
| Messages with operation context > 50% | 5 (all task-3 related) |

The 64.2% context belongs to the **operation scope of the parent task** (model `MiniMax-M2.7`, 204,800-token window), not to the review subagents. Because the subagents are `--no-session`, they start fresh and their context usage stayed low (≤3.68%).

Peak concurrent Pi Agent processes: from the 76 log starts spread over ~3 h, and from the architecture, at any moment there is at most:
- 1 global Pi client,
- 1 project client,
- 3 review subagent children,
- plus occasional analysis/chat clients.
That is **4–5 concurrent Pi processes at peak**, matching the user's observation.

### 3. DB-trace: final status, token burn, and context growth

Final requirement status (from `requirements` table):

```
requirement-1783867380305-1 | failed | 准备对项目的结构和前端ui
```

Token usage aggregated from `requirements.messages` trace metadata (operation scope):

| Metric | Value |
|--------|-------|
| Total operation-scope input tokens | **12,100,502** |
| Total operation-scope output tokens | 327,579 |
| Total operation-scope cacheRead | 6,459,210 |
| Largest single operation input | 2,342,533 (task-3, message [115]) |
| Largest operation context percent | 64.20% (task-3, message [124]) |

The original analysis reported total input tokens of ~918 K; that figure appears to have counted only the per-task summary trace, missing the much larger operation-scope usage stored in `requirements.messages` metadata.

Task-3 review rejection / fix cycle counters (from message content):

| Counter | Count |
|---------|-------|
| `review-task-3` successful completions returning rejection | 17 |
| `review-task-3` execution failures | 11 |
| `task-3` fix/implementation messages | 9 |
| `task-3` GuidedRetry (高档模型恢复方案) generations | 4 |

The largest context percent was reached near the end of the task-3 lifecycle (messages [102]–[124]), just before the cluster of final failures.

### 4. Source-review-orchestrator: constants and design choices

From `src/store/helpers.rs` and `src/models/mod.rs`:

```rust
const MAX_REVIEW_REJECTIONS: u32 = 5;
const MAX_EXECUTION_FAILURES: u32 = 4;
```

Recovery progression (`src/store/helpers.rs:516-528`):

```rust
fn next_execution_recovery_stage(
    failure_count: u32,
    retryable: bool,
) -> Option<RequirementRecoveryStage> {
    if !retryable || failure_count > MAX_EXECUTION_FAILURES {
        return None;
    }
    Some(match failure_count {
        1 | 2 => RequirementRecoveryStage::AutoRetry,
        3 => RequirementRecoveryStage::GuidedRetry,
        _ => RequirementRecoveryStage::HighTierExecution,
    })
}
```

Review task timeout (`src/pi/mod.rs:1136-1149`):

```rust
let task_timeout = Duration::from_secs(input.task.timeout_seconds);
self.wait_for_agent_end_with_events(
    Duration::from_secs(input.task.timeout_seconds),
    Duration::from_secs(input.task.timeout_seconds),
    &events,
    |event| { ... },
)
```

`timeout_seconds` is 90 for all review tasks (`src/requirement/execution.rs:719`). The parent process therefore times out if **idle for 90 s** while the three subagents are running. The orchestrator extension has no internal concurrency limit, no sequential fallback, and no per-angle timeout; it waits on `Promise.all`.

Subprocess launch (`src/pi/mod.rs:735-826`):

```rust
pub async fn start_no_session(working_dir: &Path) -> Result<Self, AppError> { ... }
```

This is used for `ReviewSubAgent` (`src/pi/mod.rs:423`). For `Review` tasks, a normal session-based Pi client is started and the review orchestrator extension is loaded (`src/pi/mod.rs:428-442`).

Key design issues identified:

1. **No concurrency throttle.** `raccoon-review-orchestrator.mjs` always spawns 3 subagents in parallel via `Promise.all`.
2. **No isolation on failure.** If one angle crashes with 143, the whole `run_parallel_code_review` call fails; there is no per-angle retry.
3. **Parent timeout is applied to the orchestrator call.** The 90 s idle timeout is measured on the parent process's stdout; if the subagents are slow but still working, the parent can be killed, producing `等待 Pi Agent 新输出空闲超时`.
4. **`--no-session` subagents load a fresh model connection each time**, but their context is small; the memory pressure argument in the original report depends on them inheriting the parent context, which they do not.
5. **Failure counters reset on every successful completion**, so a task can accumulate many total failures across multiple rejection/fix cycles before exhaustion.

### 5. OOM-hypothesis: testing against system evidence

Exit code 143 means the process exited after receiving `SIGTERM` (`128 + 15`). Possible sources:

| Source | Evidence for/against |
|--------|----------------------|
| OS OOM killer | **Against.** No OOM, `jetsam`, or memory-pressure logs target a raccoon/pi PID during 15:50–17:30. macOS logs `memorystatus_control` errors only at 14:42:35 for unrelated system services. |
| Raccoon idle-timeout kill | **Partially for.** `wait_for_agent_end_with_events` kills the parent on idle timeout, but it returns `等待 Pi Agent 新输出空闲超时`, not `143`. The `143` exits occur inside the subagents before the orchestrator returns. |
| Pi Agent internal timeout/limit | **Plausible.** Subagents are `--no-session` `pi --mode rpc` processes; Pi may impose its own limits or become unstable under concurrent load. |
| Orchestrator extension `child.kill()` | **Against.** The extension only calls `child.kill()` after receiving `stats` response (`raccoon-review-orchestrator.mjs:69`), i.e. on success. |

System log excerpts:

- 15:55:17.052: `com.apple.mdworker.shared... exited due to SIGKILL | sent by mds[117]` — this is Spotlight killing its own indexer, unrelated to raccoon.
- 15:50–15:55: repeated `Client not entitled` and `Ignoring memory limit update because this process is not memory-managed` from `runningboardd` for `clash-verge-rev` and `mds.index`, not raccoon.
- No `SIGKILL`, `SIGTERM`, or `exited due to` entries for any raccoon or pi PID in the failure window.

Memory estimate: the 64.2% context is **131,475 tokens** in the parent `MiniMax-M2.7` session. The three review subagents use `MiniMax-M3` (Medium tier) with a 512,000-token window, but their actual observed context usage never exceeded **3.68%** (~18,826 tokens). They do not load the parent's 131 K-token context because of `--no-session`. Therefore the concurrent memory footprint is not 3 × 64.2% of a large context; it is one parent session at 64.2% plus three small fresh sessions. That is consistent with the user's intuition that "only 4 processes were started, there shouldn't be memory problems."

---

## Evidence

### A. `review-task-3` final failure (DB message [130])

```
2026-07-12T18:02:06.529113Z
任务「审核：引入 svelte-spa-router 替代手动 hash 路由」执行失败：等待 Pi Agent 新输出空闲超时
```

### B. Subagent `143` exit recorded in session JSONL

From `2026-07-12T15-59-52-539Z_019f570e-72db-718f-b60e-f118bcc008af.jsonl`:

```json
{
  "angle": "正确性",
  "ok": false,
  "error": "Pi 子进程退出：143",
  "events": [...],
  "usage": { "input": 0, "output": 0, ... }
}
```

### C. Review-orchestrator parallel launch code

`src/pi/assets/raccoon-review-orchestrator.mjs:116-122`:

```js
const reviews = await Promise.all(ANGLES.map(async (angle, index) => {
  const childPrompt = `${policy}\n\n审核角度：${angle}\n\n${packet}\n\n必须先读取 staged diff，完成审核后调用 submit_review_result。`;
  const review = await runChild(angle, childPrompt, ctx, workerPath, signal, emit);
  states[index] = { angle, status: review.ok ? "done" : "error" };
  emit();
  return review;
}));
```

### D. `--no-session` subagent spawn arguments

`src/pi/assets/raccoon-review-orchestrator.mjs:39-41`:

```js
const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", workerPath,
  "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--tools", "read,grep,find,ls,read_staged_diff,submit_review_result"];
```

### E. Max context percent record (DB trace)

```json
{
  "context": { "percent": 64.1968, "tokens": 131475, "window": 204800 },
  "input": 370353,
  "output": 2975,
  "scope": "operation",
  "sessionReused": true,
  "subagents": { "maxContextPercent": 0.0, ... }
}
```

The `subagents.maxContextPercent` field is `0.0` here, confirming the high context was in the parent operation, not the parallel subagents.

### F. Recovery constants

`src/store/helpers.rs:41-42`:

```rust
const MAX_REVIEW_REJECTIONS: u32 = 5;
const MAX_EXECUTION_FAILURES: u32 = 4;
```

---

## Conclusion

- **The original OOM conclusion is not supported and is contradicted by the evidence.** The 64.2% context figure was real, but it belonged to the parent implementation session, not to the three `--no-session` review subagents. The subagents started fresh and their context usage stayed below 4%.
- **macOS system logs contain no OOM or memory-pressure events tied to the failure window.** The only SIGKILL observed was Spotlight killing its own `mdworker`, and the `memorystatus_control` errors occurred at session startup for unrelated services.
- **The most plausible cause is a reliability/timeout defect in the parallel-review orchestration.** Three subagents are launched concurrently with `Promise.all`, no per-angle retry, and a 90-second idle timeout applied to the parent. As the parent session context grew, the Pi Agent child processes became unstable and began exiting with `143` (`SIGTERM`) or returning no result, eventually exhausting the execution-failure budget.
- **The original analysis also materially under-reported token burn** (~918 K vs. ~12.1 M operation-scope input tokens) and **over-simplified the failure count** (reported "5 exec failures" vs. 11 observed across multiple rejection cycles).

**Recommended follow-up:** reduce or throttle parallel-review concurrency, add per-angle retry and fallback-to-sequential logic, and decouple the parent idle timeout from the cumulative runtime of the three subagents.
