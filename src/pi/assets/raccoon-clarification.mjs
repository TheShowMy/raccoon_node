import { Type } from "typebox";

const PROTOCOL = "raccoon:requirements";
const QuestionType = Type.Union([
  Type.Literal("single_choice"),
  Type.Literal("multi_choice"),
  Type.Literal("free_text"),
]);
const Option = Type.Object({
  value: Type.String(),
  label: Type.String(),
  description: Type.String(),
  recommended: Type.Optional(Type.Boolean()),
});
const Question = Type.Object({
  id: Type.String(),
  question: Type.String(),
  question_type: QuestionType,
  options: Type.Array(Option, { maxItems: 4 }),
});

function fail(message) {
  throw new Error(`${PROTOCOL}: ${message}`);
}

function validateQuestions(questions) {
  if (questions.length === 0 || questions.length > 6) fail("澄清问题数量必须为 1-6 个");
  const ids = new Set();
  for (const question of questions) {
    if (!question.id.trim() || !question.question.trim()) fail("问题 id 和内容不能为空");
    if (ids.has(question.id)) fail(`问题 id 重复：${question.id}`);
    ids.add(question.id);
    const optionCount = question.options.length;
    if (question.question_type === "free_text" && optionCount !== 0) {
      fail(`自由文本问题不能包含选项：${question.id}`);
    }
    if (question.question_type !== "free_text" && (optionCount < 2 || optionCount > 4)) {
      fail(`选择题必须包含 2-4 个选项：${question.id}`);
    }
    if (new Set(question.options.map((option) => option.value)).size !== optionCount) {
      fail(`选项值重复：${question.id}`);
    }
  }
}

function validateChangeSpec(changeSpec) {
  const ids = new Set();
  const forbidden = /```|`|\b(?:npm|npx|cargo|pytest|git|grep|rg)\s|(?:src|frontend|backend|tests|docs)\/|\.(?:rs|tsx?|jsx?|css|py|go)\b|--[a-z0-9-]+/i;
  for (const scenario of changeSpec.acceptance_scenarios) {
    if (!scenario.id || !scenario.given || !scenario.when || !scenario.then) {
      fail("acceptance_scenarios 的 id/given/when/then 不能为空");
    }
    if (ids.has(scenario.id)) fail(`行为场景 id 重复：${scenario.id}`);
    ids.add(scenario.id);
    for (const field of ["given", "when", "then"]) {
      if (forbidden.test(scenario[field])) {
        fail(`acceptance_scenarios[${scenario.id}].${field} 包含实现细节；请改写为用户可观察行为`);
      }
    }
  }
  for (const constraint of changeSpec.explicit_constraints) {
    if (!constraint.id || !constraint.statement || !constraint.source_message_id || !constraint.source_quote) {
      fail("explicit_constraints 必须包含 id、statement、source_message_id 和 source_quote");
    }
  }
}

export default function (pi) {
  pi.registerCommand("raccoon-requirements", {
    description: "Raccoon OpenSpec 需求确认协议（能力标记）",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Raccoon 需求确认协议已启用", "info");
    },
  });

  pi.registerTool({
    name: "request_clarifications",
    label: "请求需求澄清",
    description:
      "用户明确要求先给澄清项、候选方案或让其选择时必须使用；否则仅在仓库中无法推断且答案会改变实现时使用。候选方案只能放在问题选项中，不得提前写入确认草案。",
    parameters: Type.Object({
      progress: Type.String(),
      message: Type.String(),
      questions: Type.Array(Question, { minItems: 1, maxItems: 6 }),
    }),
    async execute(_toolCallId, params) {
      validateQuestions(params.questions);
      return {
        content: [
          {
            type: "text",
            text: "需求澄清问题已记录并展示给用户。请结束本轮，不要提交确认草案；用户回答或继续补充后系统会以新的用户消息继续分析。",
          },
        ],
        details: {
          protocol: PROTOCOL,
          kind: "clarification_request",
          progress: params.progress,
          message: params.message,
          questions: params.questions,
        },
      };
    },
  });

  pi.registerTool({
    name: "submit_change_spec",
    label: "提交 ChangeSpec",
    description:
      "需求足够明确后提交 ChangeSpec。普通目标和行为事实放入 intent/acceptance_scenarios；只有用户明确指定的技术限制才进入 explicit_constraints，并从 RequirementEvidenceIndex 复制真实消息 ID 与连续原文。",
    parameters: Type.Object({
      progress: Type.String(),
      message: Type.String(),
      intent: Type.String(),
      acceptance_scenarios: Type.Array(Type.Object({
        id: Type.String(),
        given: Type.String(),
        when: Type.String(),
        then: Type.String(),
      }), { minItems: 1 }),
      explicit_constraints: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        statement: Type.String(),
        source_message_id: Type.String(),
        source_quote: Type.String(),
      }))),
      non_goals: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      const changeSpec = {
        intent: params.intent.trim(),
        acceptance_scenarios: params.acceptance_scenarios.map((scenario) => ({
          id: scenario.id.trim(),
          given: scenario.given.trim(),
          when: scenario.when.trim(),
          then: scenario.then.trim(),
        })),
        explicit_constraints: (params.explicit_constraints ?? []).map((constraint) => ({
          id: constraint.id.trim(),
          statement: constraint.statement.trim(),
          source_message_id: constraint.source_message_id.trim(),
          source_quote: constraint.source_quote.trim(),
        })),
        non_goals: (params.non_goals ?? [])
          .map((item) => item.trim())
          .filter(Boolean),
      };
      if (!changeSpec.intent || changeSpec.acceptance_scenarios.length === 0) {
        fail("ChangeSpec intent 和行为场景不能为空");
      }
      validateChangeSpec(changeSpec);
      return {
        content: [{ type: "text", text: "ChangeSpec 已提交。" }],
        details: {
          protocol: PROTOCOL,
          kind: "change_spec",
          progress: params.progress,
          message: params.message,
          change_spec: changeSpec,
        },
      };
    },
  });
}
