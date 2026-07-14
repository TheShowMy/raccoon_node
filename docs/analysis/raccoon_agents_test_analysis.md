# raccoon_agents_test 任务执行分析报告

> 分析日期：2026-07-12
> 项目：`/Users/theshow/work/rust/project/raccoon_agents_test`
> 需求：`requirement-1783867380305-1`「前端UI视觉打磨与项目结构重组」
> 最终状态：**failed**（任务「审核：引入 svelte-spa-router 替代手动 hash 路由」执行失败）

---

## 一、任务概览

### 1.1 执行计划 DAG

```
task-1 (基础设施) ──→ review-task-1 ──┐
                                       ├──→ branch-merge-1 ──→ task-3 (路由) ──→ review-task-3 ❌
task-2 (CSS变量)  ──→ review-task-2 ──┘                                        (5 exec failures → exhausted)
                                                                                        │
                                                                                   task-4 ──→ ... ──→ merge-review
                                                                                   (pending, blocked)
```

### 1.2 任务状态汇总

| 任务 | 类型 | 档次 | 状态 | 审核拒绝 | 执行失败 | 恢复阶段 |
|------|------|------|------|---------|---------|---------|
| task-1 | implementation | Low | ✅ completed | 2 | 0 | none |
| review-task-1 | review | Medium | ✅ completed | 0 | 0 | none |
| task-2 | implementation | Low | ✅ completed | 4 | 0 | none |
| review-task-2 | review | Medium | ✅ completed | 0 | 0 | none |
| branch-merge-1 | branch_merge | Medium | ✅ completed | 0 | 0 | none |
| task-3 | implementation | Low | ⏸️ awaiting_review | 3 | 0 | none |
| **review-task-3** | **review** | **High** | **❌ failed** | **0** | **5** | **exhausted** |
| task-4 | implementation | Low | ⏸️ pending | — | — | — |
| task-5 | implementation | Low | ⏸️ pending | — | — | — |
| merge-review | merge_review | High | ⏸️ pending | — | — | — |

---

## 二、Token 消耗统计

### 2.1 按任务统计

| 任务 | 模型 | Input | Output | Cache Read | 估算费用 |
|------|------|------:|------:|------:|------:|
| task-2 | MiniMax-M2.7 | 435,343 | 2,104 | 37,062 | $0.134 |
| task-3 | MiniMax-M2.7 | 370,353 | 2,975 | 18,531 | $0.115 |
| review-task-2 | MiniMax-M3 | 36,839 | 24,164 | 110,838 | $0.072 |
| review-task-1 | MiniMax-M3 | 26,721 | 12,162 | 43,098 | $0.040 |
| branch-merge-1 | MiniMax-M3 | 14,496 | 2,787 | 267,136 | $0.026 |
| review-task-3 | deepseek-v4-flash | 4,407 | 1,988 | 23,296 | $0.016 |
| task-1 | MiniMax-M2.7 | 29,972 | 2,520 | 33,564 | $0.013 |
| **合计** | | **918,131** | **48,700** | **533,525** | **$0.417** |

> 注：需求分析、执行计划生成等阶段未在 task trace 中记录完整 usage，估算额外 $0.05–$0.15。**总费用约 $0.52**。

### 2.2 按模型档次统计

| 档次 | 模型 | Input Tokens | 占比 | 费用 |
|------|------|------:|------:|------:|
| Low | MiniMax-M2.7 | 835,668 | 91.0% | $0.262 |
| Medium | MiniMax-M3 | 78,056 | 8.5% | $0.138 |
| High | deepseek-v4-flash | 4,407 | 0.5% | $0.016 |

### 2.3 消耗热点

1. **task-2（CSS 变量）**：435,343 input tokens，占总量 47%。经历 4 次 review rejection，session 复用导致每次 fix 都重读全部项目源文件并累积对话历史。
2. **task-3（svelte-spa-router）**：370,353 input tokens，占总量 40%。经历 3 次 review rejection + 2 次 guided retry，在 `{#key $location}` 问题上与审核者反复争论 10+ 轮。
3. **branch-merge-1** cache_read 高达 267,136 tokens —— 合并操作读取了大量 Git diff 内容。

---

## 三、失败原因诊断

### 3.1 直接原因：review-task-3 并发子代理 OOM

review-task-3 的失败模式是：

```
审核子代理「代码质量与测试」→ Pi 子进程退出：143 (SIGTERM)
审核子代理「正确性」       → Pi 子进程退出：143
审核子代理「边界与安全」   → Pi 子进程退出：143
并行审核未返回受管工具结果  → (子代理崩溃，无输出)
等待 Pi Agent 新输出空闲超时 → (主进程僵死)
```

**根因**：并行代码审核 orchestrator（`run_parallel_code_review`）同时启动 3 个 `--no-session` Pi 子进程。此时 task-3 的实现 session 已积累 370K+ input tokens（context 窗口 64.2% 使用率），加上 3 个子代理各自加载模型和扩展，总内存需求超过系统限制。

**证据**：
- 所有子代理失败均为 exit 143（SIGTERM）= 被系统 OOM killer 或资源限制杀死
- review-task-1 和 review-task-2 也出现过同样的 SIGTERM（msg[19], msg[41]），说明这是系统性问题而非偶发
- 子代理以 `--no-session` 模式运行，无上下文缓存复用，每个都需独立加载完整模型权重

### 3.2 深层原因：{#key $location} 争议导致无限 ping-pong

task-3 的实现代理和审核代理在 `{#key $location}` 包裹 `<Router>` 是否正确的问题上陷入循环：

| 轮次 | 实现方行为 | 审核方反馈 |
|------|-----------|-----------|
| 1 | 引入 `{#key $location}` 实现过渡动画 | 正确性拒绝：副作用问题 |
| 2 | 保留 `{#key $location}`，添加 NotFound | 边界与安全拒绝 |
| 3 | 修补 Router.svelte 内部实现 fly/fade | 正确性拒绝：反模式 |
| 4–6 | 在 `{#key}` vs Router 实例生命周期之间反复横跳 | 连续拒绝 |
| 7 | GuidedRetry：高档模型生成恢复方案 | — |
| 8 | 回退 Router.svelte 补丁 | 代码质量拒绝 |
| 9 | 声明当前状态正确，无需修改 | 正确性拒绝 |
| 10 | 改用 `{#key component}` 方案 | 边界与安全拒绝 |
| 11 | 添加注释说明 | 正确性拒绝：无法验证 |
| 12 | GuidedRetry #2 | — |
| 13–14 | 最终恢复方案 + 修复 | 审核子代理开始崩溃 |

**核心矛盾**：`svelte-spa-router` 的 Router 组件内部使用 `{#key}` 在销毁/重建时会丢失过渡动画。实现方认为 `{#key $location}` 是正确的 Svelte 惯用模式，而审核方认为这会破坏 Router 实例。实际上两者各有道理但互不承认 —— 框架限制导致没有完美方案。

### 3.3 架构缺陷：review rejection 与 execution failure 的耦合

按当前设计：
- `MAX_REVIEW_REJECTIONS = 5` —— 实现任务可以被拒绝 5 次 → 6 次（含 GuidedRetry + HighTierExecution）
- `MAX_EXECUTION_FAILURES = 4` —— 审核任务执行失败 4 次 → exhausted

但问题在于：**实现任务的每次 review rejection 都会让 session 上下文膨胀**（新增 review feedback + 新代码 diff + 又一轮文件读取），这反过来增加了审核任务的资源压力，最终导致审核子代理 OOM。两个计数器独立但实际相互影响。

---

## 四、优化建议

### 🔴 高优先级（影响任务成功率和核心稳定性）

#### 1. 审核子代理并发数限制与资源保护

**问题**：并行审核同时启动 3 个 Pi 子进程，加上主 session 共 4 个进程争夺内存。
**方案**：
- 将 3 个审核角度从完全并发改为**顺序执行**或**最多 2 个并发**
- 在启动子代理前检查当前系统可用内存（macOS: `sysctl hw.memsize` + `vm_stat`），内存不足时降级为串行
- 为子代理设置明确的 `--max-tokens` 或 context window 限制，避免单个子代理占用过多内存
- **预期效果**：消除 OOM 导致的 execution failure，review-task-3 可以不 exhausted

#### 2. 实现任务 session 上下文压缩

**问题**：task-2 和 task-3 的 input tokens 分别膨胀到 435K 和 370K，session 复用导致每次 fix 都重新传输全部项目文件。
**方案**：
- 在 session 复用前，对超过 N（如 100K）tokens 的对话历史进行**摘要压缩**，只保留：
  - 最近 K 轮 fix-review 的完整内容
  - 更早的对话用摘要替代
- 或者在 fix 阶段使用**新的子 session**（clone 主 session 的关键上下文），避免主 session 无限增长
- **预期效果**：实现任务 input tokens 可减少 60-70%（task-2: 435K → ~130K，task-3: 370K → ~110K）

#### 3. Review rejection 上限与上下文感知

**问题**：`MAX_REVIEW_REJECTIONS = 5` 但未考虑上下文膨胀的代价。Task 2 的 4 次 rejection 虽都指向实质问题，但 token 消耗线性增长。
**方案**：
- 在 rejection 计数中增加**上下文感知逻辑**：当同一任务的累计 input tokens 超过阈值（如 300K）时，触发一次"是否继续修复"的决策检查（由 Medium/High 模型评估修复的边际价值）
- 允许用户在前端 UI 中看到 review rejection 循环并手动介入（"接受当前状态 / 放弃此任务"）
- **预期效果**：避免无意义的 ping-pong 循环（如 {#key $location} 争议），节省 token 并防止连锁失败

### 🟡 中优先级（降低 token 消耗和运营成本）

#### 4. 审核子代理的模型缓存复用

**问题**：3 个 `--no-session` 子代理各自独立加载模型，每次 ~18K input tokens 中大量是重复的全局 prompt 和 contract JSON schema。
**方案**：
- 将全局 prompt、contract schema、git 限制等固定内容预加载到子代理的 prompt cache 中（利用现有 `cacheWrite`/`cacheRead` 机制）
- 或者在父 session 中将固定内容标记为 `cache_control`（如果 Pi Agent 支持 Anthropic 风格的 prompt caching）
- **预期效果**：每个子代理可节省 ~10K input tokens（减少 55% 重复传输），3 个角度共节省 ~30K tokens

#### 5. GuidedRetry 的高档模型调用优化

**问题**：GuidedRetry 先调用高档模型生成恢复方案，再调用同一个高档模型执行恢复方案 → 两次高档模型调用。
**方案**：
- 将"生成恢复方案"和"执行恢复"**合并为一次调用**：在同一个 session 中，先分析失败原因再直接执行修复，减少一次往返
- 或者将 GuidedRetry 改为使用 Medium 模型（与审核模型同档）生成恢复方案，仅 HighTierExecution 使用 High 模型
- **预期效果**：每次 GuidedRetry 可节省 1 次 deepseek-v4-flash 调用（约 $0.005–0.01）

#### 6. JSON repair 重试次数提升

**问题**：`MAX_JSON_REPAIR_ATTEMPTS = 1`，解析失败直接升级为 execution failure → 触发昂贵恢复链路。
**方案**：
- 将 repair 重试从 1 次提升到 **2–3 次**，每次提供更明确的错误提示（哪一行解析失败，期望什么格式）
- 仅在 3 次 repair 都失败后才计入 execution failure
- **预期效果**：减少因 JSON 格式问题导致的伪 failure，降低不必要的 GuidedRetry 触发

### 🟢 低优先级（长期架构优化）

#### 7. 实现任务使用独立短 session

**问题**：每个实现任务的 session 跨越多次 fix-review 周期，上下文无限增长。
**方案**：
- 初始实现使用一个完整 session（包含项目全局上下文）
- 每次 review 后 fix 时，clone 原 session 的关键摘要（需求草案 + 审核反馈 + diff 摘要）到新的短 session 中执行
- 这样每次 fix 的 input tokens 稳定在 ~30-50K，不会线性增长
- **预期效果**：task-2 的 7 次调用从 435K → ~250K（节省 42%），task-3 的 4 次调用从 370K → ~160K（节省 57%）

#### 8. 进程池复用

**问题**：每次任务执行都启动全新的 Pi Agent 子进程（本次运行记录了 75 次 "started Pi Agent RPC"），进程冷启动开销（加载扩展、初始化模型连接）被重复支付。
**方案**：
- 维护一个小型 Pi Agent 进程池（如 2-3 个常驻进程），按需分配/回收
- 任务完成后不销毁进程，而是在池中 idle 等待下一个任务
- 需要额外的 session 隔离和状态清理逻辑
- **预期效果**：减少进程启动延迟和初始化 token 消耗，但对本次测试案例影响较小（进程启动开销相对 token 消耗可忽略）

---

## 五、总结

### 5.1 数据一览

| 指标 | 数值 |
|------|------|
| 需求状态 | ❌ failed |
| 已完成任务 | 5/10（task-1/2 + review-1/2 + branch-merge-1） |
| 失败任务 | 1/10（review-task-3） |
| 阻塞任务 | 3/10（task-4/5 + merge-review） |
| 总 input tokens | ~918K |
| 总 output tokens | ~49K |
| 估算费用 | ~$0.52 |
| Pi Agent 启动次数 | 75 次 |
| Session 文件数 | 33 个 |
| 运行时长 | ~3 小时（14:42–17:28） |

### 5.2 核心问题

1. **并发审核子代理 OOM** 是导致最终失败的直接原因 —— 3 个 `--no-session` 子进程同时运行，内存不足
2. **上下文膨胀** 是 token 浪费的根因 —— session 复用导致 input tokens 从 ~30K 增长到 ~435K
3. **review 循环缺乏上下文预算意识** —— 系统不知道 fix-review 循环正在消耗大量 token，没有止损机制

### 5.3 建议优先级排序

| 优先级 | 建议 | 预期收益 |
|--------|------|---------|
| 🔴 #1 | 审核子代理并发限制 | **消除 OOM 失败，任务可完成** |
| 🔴 #2 | 实现 session 上下文压缩 | 减少 60-70% 实现任务 token |
| 🔴 #3 | Review rejection 上限感知 | 避免 ping-pong 循环 |
| 🟡 #4 | 审核子代理缓存复用 | 每个子代理节省 ~55% input |
| 🟡 #5 | GuidedRetry 合并调用 | 节省高档模型费用 |
| 🟡 #6 | JSON repair 重试 +1 | 减少伪 failure |
| 🟢 #7 | 短 session fix 模式 | 长期 token 节省 40-57% |
| 🟢 #8 | 进程池复用 | 减少冷启动延迟 |
