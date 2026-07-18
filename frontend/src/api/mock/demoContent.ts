import type {
  AcceptanceScenario,
  AngleReview,
  RequirementSpec,
  Run,
  ValidationEntry,
  WorkItem,
  WorkPlan,
} from "../types";
import { validateWorkPlan } from "../workplan";

/**
 * 演示内容模板（假数据层）：规格、计划、验证、审核、Diff 的预设文案。
 * 后端阶段由 clarifier/planner/implementer/reviewer 角色产出替换。
 */

export const DEMO_MODEL_ROLES = [
  { role: "qa", model: "fake-chat-medium" },
  { role: "clarifier", model: "fake-chat-medium" },
  { role: "planner", model: "fake-large" },
  { role: "implementer", model: "fake-code-large" },
  { role: "reviewer", model: "fake-large" },
];

export const DEMO_SCENARIOS: AcceptanceScenario[] = [
  {
    id: "SC-1",
    given: "仓库主工作区干净且五个模型角色已配置",
    when: "用户确认最新规格 revision",
    then: "系统自动规划、执行、验证、审核并交付，返回提交或 PR/MR 与完整报告",
  },
  {
    id: "SC-2",
    given: "基线中存在一个历史失败检查",
    when: "最终候选没有新增失败",
    then: "允许交付，但显著展示 baseline_issues_only 与原失败摘要",
  },
];

export function demoSpec(title: string, answer: string): RequirementSpec {
  return {
    goal: `实现「${title}」：在保持现有交互与像素视觉语言的前提下完成该开发目标。`,
    user_value:
      "用户无需手工编排多个 Agent，即可获得可运行、可验证、可回退的代码变更。",
    in_scope: ["需求涉及的核心模块改动", "与改动直接相关的验证命令与测试"],
    out_of_scope: ["与目标无关的重构", "引入新的第三方依赖", "移动端适配"],
    scenarios: DEMO_SCENARIOS,
    constraints: [
      {
        id: "C-1",
        text: "不修改公共 API 的既有签名",
        source: { kind: "user_message", ref: "来源对话（用户消息）" },
      },
      {
        id: "C-2",
        text: "验证命令以仓库 manifest 为准",
        source: { kind: "repo_fact", ref: "package.json scripts" },
      },
    ],
    non_goals: ["不解决与本次需求无关的历史测试失败"],
    risks: ["受影响模块的测试覆盖有限，审核需关注边界条件"],
    assumptions: [`澄清回答：${answer}`],
    evidence: ["来源对话分支与节点（见来源节点）", "澄清回答（见澄清节点）"],
  };
}

const now = () => new Date().toISOString();

function workItem(
  partial: Partial<WorkItem> &
    Pick<WorkItem, "id" | "plan_id" | "kind" | "title" | "position" | "batch">,
): WorkItem {
  return {
    depends_on: [],
    scope_hint: "",
    scenario_ids: [],
    verification_target: "",
    status: "pending",
    attempts: [],
    artifact_summary: null,
    conflict_resolution: null,
    ...partial,
  };
}

/** 演示 WorkPlan：2 个并行切片 → 显式合并任务 → 1 个串行收尾（PRD-RUN-006） */
export function buildDemoPlan(
  planId: string,
  runId: string,
  revision: number,
): WorkPlan {
  const items: WorkItem[] = [
    workItem({
      id: `${planId}-wi-1`,
      plan_id: planId,
      kind: "work_item",
      title: "工作流运行时状态切片",
      position: 1,
      batch: 0,
      scope_hint: "src/workflow/**",
      scenario_ids: ["SC-1"],
      verification_target: "npm run typecheck",
    }),
    workItem({
      id: `${planId}-wi-2`,
      plan_id: planId,
      kind: "work_item",
      title: "需求列表投影切片",
      position: 2,
      batch: 0,
      scope_hint: "src/store/**",
      scenario_ids: ["SC-2"],
      verification_target: "npm test -- store",
    }),
    workItem({
      id: `${planId}-mt-1`,
      plan_id: planId,
      kind: "merge_task",
      title: "合并任务：并行批 1 → integration",
      position: 3,
      batch: 0,
      depends_on: [`${planId}-wi-1`, `${planId}-wi-2`],
      scope_hint: "integration worktree",
      verification_target: "git merge --no-ff（后端独占）",
    }),
    workItem({
      id: `${planId}-wi-3`,
      plan_id: planId,
      kind: "work_item",
      title: "交付报告组合切片",
      position: 4,
      batch: 1,
      depends_on: [`${planId}-mt-1`],
      scope_hint: "src/report/**",
      scenario_ids: ["SC-1"],
      verification_target: "npm test -- report",
    }),
  ];
  return {
    id: planId,
    run_id: runId,
    revision,
    items,
    validation: validateWorkPlan(items, DEMO_SCENARIOS),
    created_at: now(),
  };
}

/** 验证命令：typecheck / test（含一个历史失败）/ lint */
export function demoValidationEntries(): ValidationEntry[] {
  return [
    {
      command: "npm run typecheck",
      blocking: true,
      baseline: { exit_code: 0, summary: "0 errors" },
      final: null,
      verdict: "unavailable",
    },
    {
      command: "npm test",
      blocking: true,
      baseline: {
        exit_code: 1,
        summary: "1 个历史失败：legacy/parser.test.ts",
      },
      final: null,
      verdict: "unavailable",
    },
    {
      command: "npm run lint",
      blocking: false,
      baseline: { exit_code: 0, summary: "0 warnings" },
      final: null,
      verdict: "unavailable",
    },
  ];
}

/** 三角度审核骨架（PRD-QUAL-007：correctness 恒有；源码改动 +quality；敏感路径 +security） */
export function demoReviewAngles(): AngleReview[] {
  return [
    {
      angle: "correctness",
      verdict: "approved",
      rounds: 1,
      input_scope: "RequirementSpec × 验收场景 × diff",
      findings: [],
    },
    {
      angle: "quality",
      verdict: "blocking_findings",
      rounds: 1,
      input_scope: "仅 diff 与中性证据（输入隔离，不看需求意图）",
      findings: [
        {
          id: "F-Q1",
          angle: "quality",
          priority: "P1",
          title: "优先级比较未处理相等情况",
          detail:
            "runtime.ts:42 的排序比较器在 priority 相等时返回 undefined，顺序不稳定。",
          resolved: false,
        },
        {
          id: "F-Q2",
          angle: "quality",
          priority: "P2",
          title: "enqueue 全量排序可增量维护",
          detail: "每次入队 sort 全队列，量大时可改堆结构；当前规模可接受。",
          resolved: false,
        },
      ],
    },
    {
      angle: "security",
      verdict: "approved",
      rounds: 1,
      input_scope: "仅 diff 与中性证据（输入隔离，不看需求意图）",
      findings: [
        {
          id: "F-S1",
          angle: "security",
          priority: "P3",
          title: "命令模板未转义展示文本",
          detail: "诊断展示中的命令字符串直接拼接，当前来源可信，仅作建议。",
          resolved: false,
        },
      ],
    },
  ];
}

/** 合并任务的演示 Diff（等宽字体渲染，+绿/-红） */
export const DEMO_MERGE_DIFF = `diff --git a/src/workflow/runtime.ts b/src/workflow/runtime.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/workflow/runtime.ts
+++ b/src/workflow/runtime.ts
@@ -12,8 +12,11 @@ export class WorkflowRuntime {
   private queue: Task[] = [];

-  enqueue(task: Task) {
-    this.queue.push(task);
-  }
+  enqueue(task: Task, priority = 0) {
+    this.queue.push({ ...task, priority });
+    this.queue.sort((a, b) => b.priority - a.priority);
+  }
+
+  peek(): Task | undefined {
+    return this.queue[0];
+  }

   drain(): Task[] {
diff --git a/src/store/queue.ts b/src/store/queue.ts
index 9f8e7d6..2b4c8a1 100644
--- a/src/store/queue.ts
+++ b/src/store/queue.ts
@@ -3,6 +3,7 @@ import type { Task } from "./types";
 export function selectQueued(tasks: Task[]) {
-  return tasks.filter((t) => t.state === "queued");
+  return tasks
+    .filter((t) => t.state === "queued")
+    .sort((a, b) => a.position - b.position);
 }`;

/** 发布冻结原因（PRD-PUB-003：Run 启动时计算 readiness 并冻结） */
export function frozenReason(path: Run["publication_path"]): string {
  return path === "local"
    ? "Run 启动时远端未 ready（readiness 检查未通过），冻结为本地主分支 fast-forward；运行期间远端变化不改变路径。"
    : "Run 启动时远端 ready，冻结为自动创建并合并 PR/MR；运行期间远端变化不改变路径。";
}

export const DEMO_PR_URL = "https://github.com/example/raccoon-demo/pull/42";
export const DEMO_BRANCH = "raccoon/run-integration";
export const DEMO_COMMIT = "a1b2c3d";
