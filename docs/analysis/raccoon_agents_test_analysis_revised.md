# raccoon_agents_test 任务执行复勘报告（修正版）

> 复勘日期：2026-07-13
> 目标项目：`/Users/theshow/work/rust/project/raccoon_agents_test`
> 需求：`requirement-1783867380305-1`「前端UI视觉打磨与项目结构重组」
> 最终状态：**failed**（任务「审核：引入 svelte-spa-router 替代手动 hash 路由」执行失败）
> 复勘结论：**原「并发 OOM」结论不被证据支持，真正根因是并行审核 orchestrator 的超时/并发控制缺陷。**

---

## 一、核心结论变更

| 项目 | 原分析 | 复勘后 |
|------|--------|--------|
| 直接失败原因 | 3 个并行审核子代理 OOM | **父任务 idle 超时**（"等待 Pi Agent 新输出空闲超时"） |
| 退出码 143 | OOM 信号 | **SIGTERM**，来自子代理被终止/内部超时 |
| review-task-3 执行失败次数 | 5 次 | **11 次**（含多次成功-拒绝后的重置） |
| 总 input tokens | ~918 K | **~12,100,502** |
| 最大上下文占比 | 64.2%（误归为审核子代理） | **64.2% 出现在 task-3 实现 session**，审核子代理 ≤ 3.68% |
| 子代理是否继承大上下文 | 是 | **否，子代理使用 `--no-session`，上下文很小** |
| 系统日志 OOM 证据 | 未核查/默认成立 | **macOS 日志无 raccoon/pi OOM/jetsam/crash 记录** |

---

## 二、任务状态汇总（复核）

| 任务 | 类型 | 状态 | review_rejection_count | execution_failure_count | 备注 |
|------|------|------|------------------------|------------------------|------|
| task-1 | implementation | ✅ completed | 2 | 0 | — |
| review-task-1 | review | ✅ completed | 0 | 0 | 曾出现 143，后恢复 |
| task-2 | implementation | ✅ completed | 4 | 0 | — |
| review-task-2 | review | ✅ completed | 0 | 0 | 曾出现 143，后恢复 |
| branch-merge-1 | branch_merge | ✅ completed | 0 | 0 | — |
| task-3 | implementation | ⏸️ awaiting_review | 3 | 0 | **实际 18 轮 review round** |
| **review-task-3** | **review** | **❌ failed** | **0** | **5** | **recovery_stage = exhausted** |
| task-4/5 / merge-review | — | ⏸️ pending | — | — | 被阻塞 |

> 注：`execution_failure_count=5` 是最终连续失败 streak；整个 review-task-3 生命周期共记录 **11 次执行失败事件**（6 次 143 + 4 次"未返回受管工具结果" + 3 次 idle 超时）。

---

## 三、Token 消耗统计（修正）

### 3.1 按阶段累计（来自 `requirements.messages` trace usage）

| 阶段 | Input | Output | Cache Read | Cache Write | 最大上下文占比 |
|------|------:|-------:|----------:|-----------:|--------------:|
| Implementation（task-1/2/3） | 11,815,137 | 107,533 | 5,470,649 | 800,443 | **64.20%** |
| Review（全部审核任务） | 248,955 | 212,821 | 547,857 | 0 | 1.47% |
| 需求分析/规划/协调 | 21,914 | 4,438 | 173,568 | 0 | 2.87% |
| Branch merge | 14,496 | 2,787 | 267,136 | 0 | 3.05% |
| **合计** | **12,100,502** | **327,579** | **6,459,210** | **800,443** | — |

### 3.2 task-3 实现阶段上下文爆炸

| Round | 时间 | Input tokens | 上下文占比 |
|------:|------|-------------:|-----------:|
| 1 | 15:02:14 | 23,266 | 6.13% |
| 6 | 15:20:41 | 59,205 | 28.58% |
| 10 | 15:36:41 | 701,711 | 41.63% |
| 16 | 15:54:57 | 2,342,533 | 62.98% |
| **18** | **15:59:52** | **370,353** | **64.20%** |

**关键发现**：
- 最大上下文 64.20%（131,475 / 204,800 tokens）出现在 **task-3 实现 session**（模型 MiniMax-M2.7）。
- review-task-3 父 session 最大上下文仅 **1.35%**（6,919 / 512,000）。
- 并行审核子代理（`--no-session`）最大上下文仅 **3.68%**（~18,841 / 512,000）。

因此，**"审核子代理因继承 370K/131K 上下文而 OOM"的因果链不成立**。

---

## 四、失败原因诊断（修正）

### 4.1 原 OOM 结论为什么不成立

1. **143 是 SIGTERM，不是 OOM 杀手的 SIGKILL**
   - macOS OOM / jetsam 对命令行进程通常发送 **SIGKILL（exit 137）**。
   - `exit 143 = 128 + 15`，即 **SIGTERM**，与 orchestrator 主动 kill、Pi 内部超时、父任务取消一致。

2. **raccoon server log 没有失败记录**
   - `/Users/theshow/work/rust/project/raccoon_agents_test/.raccoon-node/logs/raccoon.2026-07-12` 只有 76 行 `started Pi Agent RPC` INFO。
   - 所有失败/恢复消息实际来自 SQLite `requirements.messages`，原分析误把 DB 数组索引当作 log 行号。

3. **系统日志无 OOM 证据**
   - `log show` 在 14:40–18:05 窗口内没有 raccoon/pi 被系统杀死、OOM、jetsam 或 crash 的记录。
   - `~/Library/Logs/DiagnosticReports` 没有 2026-07-12 当天 raccoon/pi 的崩溃报告。

4. **失败模式不是 OOM**
   - 每次 143 失败通常只影响 **1 个审核角度**，其余 2 个角度成功返回。
   - 类似的 143 在 review-task-1、review-task-2 中也出现过，但最终都恢复成功。
   - OOM 应导致更一致、更严重的多进程同时失败。

5. **模型是远程 API，不本地加载权重**
   - 使用模型：`minimax-cn/MiniMax-M2.7`、`minimax-cn/MiniMax-M3`、`deepseek/deepseek-v4-flash`。
   - Pi Agent 是远程 API 的本地 RPC 封装，主要内存占用是上下文文本和 JSONL 缓冲。
   - 峰值上下文 131K tokens 不可能触发系统 OOM。

### 4.2 真正根因：并行审核 orchestrator 超时/并发缺陷

review-task-3 的 11 次失败事件：

| 时间 | 事件 |
|------|------|
| 15:37:11 | 审核子代理「代码质量与测试」执行失败：Pi 子进程退出：143 |
| 15:37:18 | 并行审核未返回受管工具结果 |
| 15:37:22 | 并行审核未返回受管工具结果 |
| 15:37:36 | 并行审核未返回受管工具结果 |
| 15:45:15 | 审核子代理「正确性」执行失败：Pi 子进程退出：143 |
| 15:55:37 | 审核子代理「正确性」执行失败：Pi 子进程退出：143 |
| 16:00:29 | 审核子代理「边界与安全」执行失败：Pi 子进程退出：143 |
| 16:33:55 | 等待 Pi Agent 新输出空闲超时 |
| 16:50:45 | 审核子代理「正确性」执行失败：Pi 子进程退出：143 |
| 17:28:03 | 等待 Pi Agent 新输出空闲超时 |
| **18:02:06** | **最终失败：等待 Pi Agent 新输出空闲超时** |

根因链条：

1. **并发启动 3 个 `--no-session` 子代理**
   - `raccoon-review-orchestrator.mjs:116` 使用 `Promise.all(ANGLES.map(...))` 同时启动 3 个审核角度。
   - 每个子代理都是全新的 Pi RPC 进程，冷启动 Medium 模型。

2. **子代理无独立 timeout，父任务 timeout 基于 idle 时间**
   - `src/pi/mod.rs:1147-1148`：Review 任务 `timeout_seconds = 90` 秒，作为 idle timeout。
   - `wait_for_agent_end_with_events` 只要收到任何输出活动（tool update、thinking delta 等）就会重置 90 秒计时。
   - orchestrator 没有 wall-clock 上限，一个子代理 hang 住但其他子代理还在 emit 进度时，调用可以持续数十分钟。

3. **子代理内部超时/资源竞争导致 143**
   - session JSONL 显示子代理事件中出现 `"errorMessage": "Request timed out."`。
   - 失败子代理的 usage 极低（input 1~129），说明失败发生在生命周期极早期（启动/初始化阶段）。

4. **失败计数器在成功 review 后重置**
   - `src/store/mod.rs:1963`：每次成功执行后 `execution_failure_count = 0`。
   - 这使得 task-3 能在 18 轮实现/审核 ping-pong 中不断累积失败，最终耗尽 `MAX_EXECUTION_FAILURES=4`。

5. **task-3 实现 session 上下文膨胀加剧不稳定性**
   - 虽然不足以 OOM，但 131K tokens / 64.2% 的上下文增加了模型处理时间、API 响应时间和超时风险。
   - 每次 fix 都复用同一个 session，input 从 23K 增长到 2.34M tokens。

---

## 五、优化建议（按优先级）

### 🔴 高优先级（直接解决失败根因）

#### 1. 给并行审核增加 wall-clock 超时和单个子代理 timeout

**问题**：orchestrator 无子代理级 timeout，父任务 idle timeout 会被进度更新无限重置。
**方案**：
- 在 `raccoon-review-orchestrator.mjs` 的 `runChild` 中为每个子代理设置独立 timeout（如 60 秒）。
- 给整个 `run_parallel_code_review` 工具调用设置 wall-clock 上限（如 120 秒），超过则取消未完成的子代理并返回已完成角度的结果。
- 区分「子代理自身超时」和「父任务 idle 超时」，不要把正常的 SIGTERM 清理统一报为 execution failure。

**预期效果**：消除长时间 hang 导致的 idle 超时，减少伪失败。

#### 2. 单角度失败重试 + 串行降级

**问题**：3 个角度中只要 1 个失败，整个 review 就失败。
**方案**：
- 当某个角度 143 / 未返回结果时，单独重试该角度 1 次。
- 若多次失败，自动降级为**串行审核**（先跑 1 个角度，成功再跑下一个），降低并发启动压力。
- 记录并区分「资源竞争导致的偶发失败」和「持续失败」。

**预期效果**：把 review-task-3 的 11 次失败中的大部分转为成功，避免 exhausted。

#### 3. 将 Review 父任务的空闲超时改为真正的 wall-clock 上限

**问题**：`wait_for_agent_end_with_events` 的 hard timeout 基于 idle 时间，没有绝对上限。
**方案**：
- 在父任务级别同时设置 idle timeout（90s）和 wall-clock timeout（如 5 分钟）。
- 或者根据历史数据动态调整：上下文 > 50% 时增加 timeout 余量。

**预期效果**：防止 orchestrator 在子代理 hang 住时无限期运行。

### 🟡 中优先级（降低 token 消耗和稳定性风险）

#### 4. Review 任务不直接复用庞大的 implementation session

**问题**：review-task-3 复用了 task-3 的 session，启动时已携带 131K tokens 上下文。
**方案**：
- 为 review 创建轻量 session，只传递：需求摘要、staged diff、相关文件路径。
- 或者 clone session 后压缩/删除早期的 implementation 轮次历史。

**预期效果**：review 父任务上下文从 ~131K 降至 ~10-30K，减少处理时间和超时风险。

#### 5. 实现任务 session 上下文压缩 / 短 session fix

**问题**：task-3 的 input 从 23K 增长到 2.34M tokens，18 轮全部堆积在同一个 session。
**方案**：
- 每 N 轮 fix 后创建新 session，只保留：需求、最新代码状态、最近 K 轮审核反馈。
- 对超过阈值（如 100K tokens）的历史进行摘要压缩。

**预期效果**：实现任务 input tokens 可减少 50-70%，降低 API 成本和超时概率。

#### 6. 优化失败计数器策略

**问题**：`execution_failure_count` 在每次成功 review 后重置，导致 ping-pong 循环无限继续。
**方案**：
- 增加"总失败预算"或"单位时间失败预算"，不单纯依赖连续失败计数。
- 当同一任务在 1 小时内累计失败超过阈值时，自动暂停并提示用户介入。

**预期效果**：避免无意义的自动重试，节省 token。

### 🟢 低优先级（长期改进）

#### 7. 进程池 / 模型连接复用

**问题**：每次 review 都冷启动 3 个 `--no-session` Pi 子进程。
**方案**：
- 维护一个小的 review worker 进程池（如 2-3 个常驻进程），按需分配。
- 需要解决 session 隔离和状态清理。

**预期效果**：减少冷启动延迟和偶发初始化失败。

#### 8. 改进日志记录

**问题**：raccoon server log 只记录 Pi 启动，失败原因只在 DB 中。
**方案**：
- 在 raccoon server log 中记录 task 失败/恢复事件、退出码、超时类型。
- 保留子代理 stderr 摘要，便于诊断 143 的真实来源。

**预期效果**：未来分析不再依赖反向推导。

---

## 六、数据一览（修正）

| 指标 | 数值 |
|------|------|
| 需求状态 | ❌ failed |
| 已完成任务 | 5/10 |
| 失败任务 | 1/10（review-task-3） |
| 阻塞任务 | 3/10 |
| 总 input tokens | **12,100,502** |
| 总 output tokens | **327,579** |
| 最大上下文占比 | **64.20%**（task-3 实现 session） |
| Pi Agent 启动次数 | 76 次（log 记录） |
| Session 文件数 | 32 个 |
| review-task-3 执行失败事件 | **11 次** |
| task-3 实现/审核轮次 | **18 轮** |
| 运行时长 | ~3.5 小时（14:42–18:02） |

---

## 七、总结

原分析将失败归因于「并发 OOM」是不成立的。证据显示：

1. **143 是 SIGTERM，不是 OOM 信号**。
2. **系统日志无 OOM/jetsam/crash 记录**。
3. **审核子代理上下文很小（≤ 3.68%），不继承膨胀的 task-3 上下文**。
4. **最终失败是 raccoon 父任务 idle 超时**。
5. **真正根因是并行审核 orchestrator 缺少子代理 timeout、wall-clock 上限和失败降级机制**。

应优先修复并行审核的超时/并发控制，同时降低 review 和 implementation session 的上下文膨胀。这两项修复可以显著提高复杂任务的成功率并减少 token 浪费。

---

*复勘子报告：*
- `docs/analysis/reinvestigation/log-failures.md`
- `docs/analysis/reinvestigation/session-concurrency.md`
- `docs/analysis/reinvestigation/db-trace.md`
- `docs/analysis/reinvestigation/source-review-orchestrator.md`
- `docs/analysis/reinvestigation/oom-hypothesis.md`
