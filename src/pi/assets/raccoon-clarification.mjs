import { Type } from "typebox";

const PROTOCOL = "raccoon:requirements:v2";
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

export default function (pi) {
  pi.registerCommand("raccoon-requirements-v2", {
    description: "Raccoon 受管需求确认协议 v2（能力标记）",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Raccoon 需求确认协议 v2 已启用", "info");
    },
  });

  pi.registerCommand("raccoon-clarifications-v1", {
    description: "Raccoon 受管需求澄清协议 v1（兼容能力标记）",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Raccoon 需求澄清协议 v1 兼容模式已启用", "info");
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
    name: "submit_requirement_draft",
    label: "提交确认需求草案",
    description: "需求足够明确后，提交唯一的结构化确认草案。",
    parameters: Type.Object({
      progress: Type.String(),
      message: Type.String(),
      title: Type.String(),
      summary: Type.String(),
      acceptance_criteria: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_toolCallId, params) {
      const draft = {
        title: params.title.trim(),
        summary: params.summary.trim(),
        acceptance_criteria: params.acceptance_criteria.map((item) => item.trim()).filter(Boolean),
      };
      if (!draft.title || !draft.summary || draft.acceptance_criteria.length === 0) {
        fail("确认草案的标题、摘要和验收标准不能为空");
      }
      return {
        content: [{ type: "text", text: "确认需求草案已提交。" }],
        details: {
          protocol: PROTOCOL,
          kind: "draft",
          progress: params.progress,
          message: params.message,
          draft,
        },
      };
    },
  });
}
