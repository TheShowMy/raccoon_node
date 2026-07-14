# db-trace reinvestigation: raccoon_agents_test review-task-3 failure

> Aspect: **db-trace**
> Target project: `/Users/theshow/work/rust/project/raccoon_agents_test`
> Source project: `/Users/theshow/work/rust/project/raccoon_node`
> Requirement: `requirement-1783867380305-1`

## Summary

The raccoon server log is **silent on failures**: it only records 76 `started Pi Agent RPC` INFO lines and contains no lines matching "执行失败", "Pi 子进程退出", "并行审核未返回", "恢复策略", "OOM", "memory" or "143". All failure/recovery evidence comes from the SQLite `requirements.messages` column and the task trace metadata stored there.

For `review-task-3` the database shows:

- **17 successful (but rejected) parallel review executions** interleaved with **10 retryable failure events** and **1 final failure**.
- The task finally exhausted with `execution_failure_count = 5`, `recovery_stage = Exhausted`, `model_tier = high`, `high_tier_execution_used = true`, and final error `等待 Pi Agent 新输出空闲超时`.
- `task-3` itself went through **18 implementation attempts / review rounds**. The implementation session context exploded to **64.20 % (131,475 tokens)** and burned **≈ 9.4 M input tokens** in trace-recorded usage alone.
- The three review subagents run with `--no-session`, so they do **not** inherit the 370 K/131 K-token implementation context. Their own context usage stayed low (≤ 1.47 %). This weakens the claim that the review children failed because they each loaded the swollen task-3 context.

macOS system logs (`log show`) contain **no OOM, `pi`, or crash entries** for the 14:42–18:02 window, and `~/Library/Logs/DiagnosticReports` has no `pi` crash report. Exit code **143** is `SIGTERM`; on macOS the OOM killer normally uses `SIGKILL` (exit 137) for command-line processes. The evidence therefore does **not** support the original "parallel review OOM" conclusion. The more consistent explanation is that the parallel-review orchestrator repeatedly launches three fresh `--no-session` model-loading child processes, hits a SIGTERM from resource contention / an internal Pi Agent timeout / the 90 s raccoon idle timeout, and then retries until exhaustion.

## Method

- Read the original analysis: `docs/analysis/raccoon_agents_test_analysis.md`.
- Read the raccoon server log: `.raccoon-node/logs/raccoon.2026-07-12`.
- Listed and inspected all `.raccoon-node/sessions/*.jsonl` files.
- Queried `.raccoon-node/data.db` with `sqlite3` and Python (`json`, `sqlite3`).
- Parsed every `requirements.messages` JSON entry to extract system failure events, trace usage, and task statuses.
- Read the relevant raccoon_node source:
  - `src/store/mod.rs`, `src/store/helpers.rs` — counters and recovery stages.
  - `src/requirement/execution.rs` — task planning / review angles.
  - `src/pi/mod.rs` — Pi process launch, timeout, session handling.
  - `src/pi/transport.rs` — `--no-session` arguments.
  - `src/pi/assets/raccoon-review-orchestrator.mjs` — parallel review child spawning.
  - `src/pi/assets/raccoon-review-worker.mjs` — review tools.
- Checked macOS logs with `log show` and `~/Library/Logs/DiagnosticReports` for OOM or `pi` crash evidence.

## Findings

### 1. Server log does not contain failure/recovery events

`raccoon.2026-07-12` is 76 lines and only contains:

```text
2026-07-12T14:42:27.822526Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
2026-07-12T14:42:27.824391Z  INFO raccoon: server listening on http://127.0.0.1:3001 ...
...
2026-07-12T17:28:04.145829Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
```

Grep for failure-related Chinese/English keywords in the log directory returned **zero matches**.

There are **76 "started Pi Agent RPC" lines** over ~3.5 hours. The log records starts, not exits, so it cannot by itself prove concurrency or memory pressure.

### 2. Failure/recovery timeline (from `requirements.messages`)

All system failure events for `review-task-3` and the earlier reviews:

| # | Timestamp (UTC) | Task | Recorded reason |
|---|-----------------|------|-----------------|
| 19 | 2026-07-12T14:51:56.081985Z | review-task-1 | `审核子代理「代码质量与测试」执行失败：Pi 子进程退出：143` |
| 20 | 2026-07-12T14:52:00.606762Z | review-task-1 | `并行审核未返回受管工具结果` |
| 41 | 2026-07-12T14:58:58.203386Z | review-task-2 | `审核子代理「正确性」执行失败：Pi 子进程退出：143` |
| 85 | 2026-07-12T15:37:11.724275Z | **review-task-3** | `审核子代理「代码质量与测试」执行失败：Pi 子进程退出：143` |
| 86 | 2026-07-12T15:37:18.205858Z | **review-task-3** | `并行审核未返回受管工具结果` |
| 87 | 2026-07-12T15:37:22.455370Z | **review-task-3** | `并行审核未返回受管工具结果` |
| 88 | 2026-07-12T15:37:31.149744Z | **review-task-3** | `已生成高档模型恢复方案` (GuidedRetry OK) |
| 89 | 2026-07-12T15:37:36.061958Z | **review-task-3** | `并行审核未返回受管工具结果` |
| 103 | 2026-07-12T15:45:15.776829Z | **review-task-3** | `审核子代理「正确性」执行失败：Pi 子进程退出：143` |
| 116 | 2026-07-12T15:55:37.693316Z | **review-task-3** | `审核子代理「正确性」执行失败：Pi 子进程退出：143` |
| 125 | 2026-07-12T16:00:29.655782Z | **review-task-3** | `审核子代理「边界与安全」执行失败：Pi 子进程退出：143` |
| 126 | 2026-07-12T16:33:55.687498Z | **review-task-3** | `等待 Pi Agent 新输出空闲超时` |
| 127 | 2026-07-12T16:50:45.217938Z | **review-task-3** | `审核子代理「正确性」执行失败：Pi 子进程退出：143` |
| 128 | 2026-07-12T16:51:07.059406Z | **review-task-3** | `已生成高档模型恢复方案` (GuidedRetry OK) |
| 129 | 2026-07-12T17:28:03.935314Z | **review-task-3** | `等待 Pi Agent 新输出空闲超时` |
| 130 | 2026-07-12T18:02:06.529113Z | **review-task-3** | `任务执行失败：等待 Pi Agent 新输出空闲超时` (final, no retry) |

Notes:

- `review-task-1` and `review-task-2` also saw exit `143` and recovered, so `143` is not unique to `review-task-3`.
- Every `143` event for `review-task-3` happened **seconds after the corresponding "started Pi Agent RPC" log line**, not after a long run.
- The final failure was an **idle timeout**, not a `143`.

### 3. Final task status (from `execution_plan` in `data.db`)

| Task | Status | `review_rejection_count` | `execution_failure_count` | `attempt` | `recovery_stage` | Notes |
|------|--------|--------------------------|---------------------------|-----------|------------------|-------|
| task-1 | `completed` | 2 | 0 | — | `none` | — |
| review-task-1 | `completed` | 0 | 0 | — | `none` | — |
| task-2 | `completed` | 4 | 0 | — | `none` | — |
| review-task-2 | `completed` | 0 | 0 | — | `none` | — |
| branch-merge-1 | `completed` | 0 | 0 | — | `none` | — |
| **task-3** | `awaiting_review` | **3** | 0 | **18** | `none` | 18 review-history rounds, all `rejected` |
| **review-task-3** | **failed** | 0 | **5** | **17** | **exhausted** | `high_tier_execution_used = true` |
| task-4 / task-5 / merge-review | `pending` | 0 | 0 | — | `none` | Blocked by task-3/review-task-3 |

The discrepancy between the **18 rejected review rounds** stored in `task-3.review_history` and the final `task-3.review_rejection_count = 3` is explained by the recovery code: `reset_recovery_state` (called when a failed task group is recovered) zeros `review_rejection_count`. In other words, the counter was reset multiple times during the long ping-pong loop.

`review-task-3` final persisted fields:

```json
{
  "execution_failure_count": 5,
  "recovery_stage": "exhausted",
  "model_tier": "high",
  "high_tier_execution_used": true,
  "failure_summary": "等待 Pi Agent 新输出空闲超时",
  "error": "等待 Pi Agent 新输出空闲超时",
  "status": "failed"
}
```

### 4. Session files and concurrency

There are **32 JSONL session files** in `.raccoon-node/sessions/` (not 34; `.DS_Store` and directory listings can inflate counts).

The `review-task-3` parent session is:

```text
2026-07-12T15-59-52-539Z_019f570e-72db-718f-b60e-f118bcc008af.jsonl
  size: 436,708 bytes
  cwd:  /Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/worktrees/requirement-1783867380305-1-task-3
```

This is a normal persistent Pi session (not `--no-session`). The parallel-review extension running inside it spawns three child `pi` processes **with `--no-session`**:

```javascript
// src/pi/assets/raccoon-review-orchestrator.mjs:36-44
function runChild(angle, prompt, ctx, workerPath, signal, onUpdate) {
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
  const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", workerPath,
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--tools", "read,grep,find,ls,read_staged_diff,submit_review_result"];
  ...
  const child = spawn(call.command, call.args, { cwd: ctx.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
```

And they are launched in parallel:

```javascript
// src/pi/assets/raccoon-review-orchestrator.mjs:116-121
const reviews = await Promise.all(ANGLES.map(async (angle, index) => {
  const childPrompt = `${policy}\n\n审核角度：${angle}\n\n${packet}\n\n必须先读取 staged diff，完成审核后调用 submit_review_result。`;
  const review = await runChild(angle, childPrompt, ctx, workerPath, signal, emit);
  ...
}));
```

So the intended per-review concurrency is **1 parent + 3 children = 4 `pi` processes**. The raccoon log records 76 starts in total, but because it does not log exits we cannot reconstruct exact simultaneous peaks; the DAG is mostly serial by the time `review-task-3` runs.

The `--no-session` flag means the children start from a fresh Pi context and **do not** reuse the swollen `task-3` session. This is confirmed by the trace usage for every successful `review-task-3` run:

| Review run | Parent input | Subagent max ctx % | Subagent max ctx tokens |
|------------|-------------:|-------------------:|------------------------:|
| 15:02:57 | 13,688 | 1.00 % | 6,316 |
| 15:05:28 | 3,188 | 1.17 % | 6,984 |
| 15:09:55 | 5,357 | 1.25 % | 7,184 |
| 15:14:45 | 5,239 | 1.32 % | 7,278 |
| 15:16:58 | 5,019 | 1.08 % | 6,564 |
| 15:21:59 | 5,307 | 1.21 % | 7,011 |
| 15:25:51 | 5,375 | 1.21 % | 7,002 |
| 15:32:33 | 7,071 | 1.29 % | 7,500 |
| 15:35:29 | 5,791 | 1.12 % | 6,903 |
| 15:38:07 | 11,388 | 0.58 % | 5,788 |
| 15:39:17 | 5,256 | 1.22 % | 6,594 |
| 15:42:44 | 5,659 | 1.44 % | 7,392 |
| 15:45:55 | 6,113 | 1.47 % | 7,408 |
| 15:47:36 | 5,784 | 1.40 % | 7,058 |
| 15:51:21 | 5,259 | 1.17 % | 6,593 |
| 15:56:22 | 7,592 | 1.39 % | 6,919 |
| 15:58:45 | 5,257 | 1.19 % | 6,568 |

The review children's context stayed **≤ 1.47 %**. The real context explosion is in the **implementation** session, not the review children.

### 5. Token usage and context explosion (from trace metadata)

Aggregated trace usage by major phase:

| Phase | Input tokens | Output tokens | Cache read | Cache write | Max context % |
|-------|-------------:|--------------:|-----------:|------------:|--------------:|
| Implementation (task-1/2/3) | 11,815,137 | 107,533 | 5,470,649 | 800,443 | **64.20 %** |
| Review (all review tasks) | 248,955 | 212,821 | 547,857 | 0 | 1.47 % |
| Analysis / planning / coordination | 21,914 | 4,438 | 173,568 | 0 | 2.87 % |
| Branch merge | 14,496 | 2,787 | 267,136 | 0 | 3.05 % |

`task-3` alone consumed **9,399,475 input tokens** across 18 implementation attempts. Its per-round trace usage:

| Round | Impl. timestamp | Impl. input | Impl. ctx % | Review timestamp | Review input |
|------:|-----------------|------------:|------------:|------------------|-------------:|
| 1 | 15:02:14 | 23,266 | 6.13 % | 15:02:57 | 13,688 |
| 2 | 15:04:14 | 28,211 | 9.66 % | 15:05:28 | 3,188 |
| 3 | 15:09:13 | 16,351 | 11.97 % | 15:09:55 | 5,357 |
| 4 | 15:14:04 | 19,353 | 14.64 % | 15:14:45 | 5,239 |
| 5 | 15:16:24 | 24,744 | 17.58 % | 15:16:58 | 5,019 |
| 6 | 15:20:41 | 59,205 | 28.58 % | 15:21:59 | 5,307 |
| 7 | 15:23:28 | 13,751 | 9.22 % | 15:25:51 | 5,375 |
| 8 | 15:31:43 | 199,258 | 35.91 % | 15:32:33 | 7,071 |
| 9 | 15:34:59 | 963,055 | 41.09 % | 15:35:29 | 5,791 |
| 10 | 15:36:41 | 701,711 | 41.63 % | 15:38:07 | 11,388 |
| 11 | 15:38:39 | 82,753 | 41.77 % | 15:39:17 | 5,256 |
| 12 | 15:41:52 | 1,606,038 | 46.99 % | 15:42:44 | 5,659 |
| 13 | 15:44:47 | 593,620 | 51.84 % | 15:45:55 | 6,113 |
| 14 | 15:46:59 | 7,774 | 15.26 % | 15:47:36 | 5,784 |
| 15 | 15:50:45 | 771,112 | 57.19 % | 15:51:21 | 5,259 |
| 16 | 15:54:57 | 2,342,533 | 62.98 % | 15:56:22 | 7,592 |
| 17 | 15:58:10 | 1,576,387 | 63.74 % | 15:58:45 | 5,257 |
| 18 | 15:59:52 | 370,353 | **64.20 %** | — | — |

The largest context percent observed anywhere is **64.20 % (131,475 tokens / 204,800 window)** in the final `task-3` implementation trace at `2026-07-12T15:59:52.066557Z`.

### 6. Orchestrator source review

Constants (`src/store/mod.rs:41-42`):

```rust
const MAX_REVIEW_REJECTIONS: u32 = 5;
const MAX_EXECUTION_FAILURES: u32 = 4;
```

Failure recovery mapping (`src/store/helpers.rs:516-527`):

```rust
fn next_execution_recovery_stage(failure_count: u32, retryable: bool) -> Option<RequirementRecoveryStage> {
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

Review rejection mapping (`src/store/helpers.rs:374-391`):

```rust
match reviewed.review_rejection_count {
    count if count < MAX_REVIEW_REJECTIONS => {
        reviewed.status = RequirementTaskStatus::Fixing;
        reviewed.recovery_stage = RequirementRecoveryStage::None;
    }
    MAX_REVIEW_REJECTIONS => {
        reviewed.status = RequirementTaskStatus::Fixing;
        reviewed.recovery_stage = RequirementRecoveryStage::GuidedRetry;
    }
    count if count == MAX_REVIEW_REJECTIONS + 1 => {
        reviewed.status = RequirementTaskStatus::Fixing;
        reviewed.recovery_stage = RequirementRecoveryStage::HighTierExecution;
    }
    _ => {
        reviewed.status = RequirementTaskStatus::Failed;
        reviewed.recovery_stage = RequirementRecoveryStage::Exhausted;
    }
}
```

Process launch (`src/pi/mod.rs:421-442`):

```rust
let no_session = input.task.kind == RequirementTaskKind::ReviewSubAgent;
let client = if no_session {
    PiRpcClient::start_no_session(&working_dir).await?
} else {
    let mut extension_paths = Vec::new();
    if let Some(path) = &self.clarification_extension_path { extension_paths.push(path.clone()); }
    if let Some(path) = &self.review_extension_path { extension_paths.push(path.clone()); }
    PiRpcClient::start_with_extensions(&self.session_dir, &working_dir, &extension_paths).await?
};
```

Note that `ReviewSubAgent` is `--no-session`; the `Review` task (which runs `run_parallel_code_review`) is a normal persistent session. The `--no-session` children are spawned **inside** the extension (`raccoon-review-orchestrator.mjs`).

Timeouts (`src/pi/mod.rs:1136, 1147-1157, 1691-1705`):

- Review task uses `input.task.timeout_seconds` (90 s) for both warning and hard idle timeout.
- Every Pi RPC command has a 30 s per-request timeout; if it fires, raccoon kills the child.

Design choices that amplify fragility:

1. **Three fresh model loads per review.** Each review launches three `--no-session` children that each cold-start a Medium model (MiniMax-M3). There is no process pool, no model-cache sharing, and no concurrency budget.
2. **No context inheritance for children (by design), but no resource budget either.** The children start fresh, yet three simultaneous loads contend for CPU/disk/memory.
3. **Session reuse for implementation causes unbounded growth.** Each `task-3` fix re-reads the project and appends to the same session, driving input from 23 K to 2.34 M tokens per round and context to 64.2 %.
4. **Tight 90 s review timeout.** A fresh child that needs to load a model and read a diff can easily exceed this, especially when three children race.
5. **`MAX_JSON_REPAIR_ATTEMPTS = 1` (`src/pi/mod.rs:43`).** A single JSON parse failure immediately becomes an execution failure.
6. **Failure counters reset on success.** Every successful-but-rejected review resets `execution_failure_count`, allowing the ping-pong loop to continue almost indefinitely (18 rounds).

### 7. OOM hypothesis test

What the evidence shows:

- **No OOM entries in macOS logs.** `log show --predicate 'process == "pi"'` returned nothing. A broader predicate (`eventMessage contains "killed" OR ...`) returned only unrelated `mdworker` SIGKILLs and normal process exits.
- **No `pi` crash reports** in `~/Library/Logs/DiagnosticReports` for 2026-07-12.
- **Exit code 143 = SIGTERM**, not SIGKILL. On macOS the system OOM path for command-line processes is normally SIGKILL (137), not SIGTERM (143). 143 is consistent with a controlled kill: parent timeout, internal Pi timeout, or an explicit `kill()` call.
- **The failures happen seconds after start**, not after a long run that would consume memory gradually.
- **Review children do not load the 131 K-token implementation context.** Their context usage stayed ≤ 1.47 %. The memory argument in the original analysis relied on each child loading the swollen context, which the data contradict.
- **The same 143 pattern occurred for review-task-1 and review-task-2 and those recovered.** If OOM were the cause, it would be surprising for the same workload to succeed later without a memory reduction.

What we cannot rule out:

- We do not have `pi` internal logs or stderr (raccoon discards child stderr after 16 KB; `pi` does not appear in unified logs). So we cannot prove the exact agent that sent SIGTERM.
- We do not have model weight sizes, so a precise "3 × MiniMax-M3 > available RAM" calculation is impossible from the data alone.

The recovery guidance produced by the High model (`review-task-3.recovery_guidance`) **does** say "并发启动三个审核子代理...导致资源竞争或累计超时...达到了子进程生命周期上限或内存限制". This is a **model-generated hypothesis**, not system evidence, and the db-trace evidence does not corroborate the memory half of it.

## Evidence

### Key quotes

Server log is only starts:

```text
2026-07-12T14:42:27.822526Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
...
2026-07-12T17:28:04.145829Z  INFO raccoon_node::pi: started Pi Agent RPC using pi
```

First `review-task-3` failure recorded in DB:

```text
2026-07-12T15:37:11.724275Z 任务「审核：引入 svelte-spa-router 替代手动 hash 路由」执行失败，将按恢复策略重试：审核子代理「代码质量与测试」执行失败：Pi 子进程退出：143
```

Final `review-task-3` failure:

```text
2026-07-12T18:02:06.529113Z 任务「审核：引入 svelte-spa-router 替代手动 hash 路由」执行失败：等待 Pi Agent 新输出空闲超时
```

Final `review-task-3` state (from `data.db`):

```json
{
  "execution_failure_count": 5,
  "recovery_stage": "exhausted",
  "model_tier": "high",
  "high_tier_execution_used": true,
  "failure_summary": "等待 Pi Agent 新输出空闲超时",
  "error": "等待 Pi Agent 新输出空闲超时"
}
```

`task-3` review history confirms 18 rejected rounds:

```text
round 1 rejected impl_attempt 1 reviews 3
...
round 18 reviewing impl_attempt 18 reviews 0
```

Largest context percent observed:

```json
{"percent": 64.19677734375, "tokens": 131475, "window": 204800}
```

Parallel review child args (source):

```javascript
const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", workerPath,
  "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--tools", "read,grep,find,ls,read_staged_diff,submit_review_result"];
```

### File paths

- `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/logs/raccoon.2026-07-12`
- `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/data.db`
- `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/sessions/2026-07-12T15-59-52-539Z_019f570e-72db-718f-b60e-f118bcc008af.jsonl`
- `/Users/theshow/work/rust/project/raccoon_node/src/store/mod.rs`
- `/Users/theshow/work/rust/project/raccoon_node/src/store/helpers.rs`
- `/Users/theshow/work/rust/project/raccoon_node/src/pi/mod.rs`
- `/Users/theshow/work/rust/project/raccoon_node/src/pi/transport.rs`
- `/Users/theshow/work/rust/project/raccoon_node/src/pi/assets/raccoon-review-orchestrator.mjs`
- `/Users/theshow/work/rust/project/raccoon_node/src/pi/assets/raccoon-review-worker.mjs`

## Conclusion

The original analysis concluded that **OOM killed the three parallel review subagents**, leading to `review-task-3` exhaustion. The db-trace evidence **weakens and largely contradicts** that conclusion:

1. **No OOM evidence** exists in the server log, macOS unified logs, or crash reports for the `pi` process.
2. **Exit code 143 is SIGTERM**, not the SIGKILL normally associated with macOS OOM termination.
3. The review children run **`--no-session`** and their recorded context usage is tiny (≤ 1.47 %). They do not load the 131 K-token `task-3` context, undermining the memory-pressure mechanism described in the original report.
4. The same `143` failure pattern occurred in `review-task-1` and `review-task-2` and those tasks later succeeded, suggesting the cause is transient/resource-contention rather than deterministic memory exhaustion.
5. The final failure mode was an **idle timeout** (`等待 Pi Agent 新输出空闲超时`), not a child crash.

The most plausible cause, based on the db-trace evidence, is **orchestration fragility in the parallel review path**:

- Three fresh `--no-session` child processes are launched in parallel for every review, each cold-loading a Medium model, with no concurrency limit, no resource budget, and no shared model cache.
- The 90 s task timeout and 30 s RPC command timeout give little headroom when children contend.
- The child processes are killed with SIGTERM (143) — most likely by an internal Pi Agent limit, by raccoon's own timeout, or by OS resource contention — before the tool result is returned.
- Meanwhile, the implementation side of `task-3` kept growing its session context (64.2 %, 9.4 M input tokens), but this is a separate, non-lethal problem that made the overall loop expensive, not the direct cause of the review child crashes.

In short: **the failures are better explained by unbudgeted concurrent child-process spawning and tight timeouts than by OOM.** The OOM hypothesis is not supported by the available data and should not be treated as the established root cause.
