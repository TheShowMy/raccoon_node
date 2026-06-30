import { Type } from "typebox";

const PROTOCOL = "raccoon:clarifications:v1";
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

function parseAnswers(text, questions) {
  if (text === undefined) fail("用户取消了需求澄清");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail("澄清答案不是合法 JSON");
  }
  if (!payload || !Array.isArray(payload.answers)) fail("澄清答案缺少 answers");
  const answers = new Map(payload.answers.map((answer) => [answer.id, answer]));
  if (answers.size !== questions.length || payload.answers.length !== questions.length) {
    fail("澄清答案与问题数量不匹配");
  }

  return questions.map((question) => {
    const answer = answers.get(question.id);
    if (!answer || !Array.isArray(answer.selected_options)) {
      fail(`问题缺少有效答案：${question.id}`);
    }
    const selected = answer.selected_options;
    const customText =
      typeof answer.custom_text === "string" && answer.custom_text.trim()
        ? answer.custom_text.trim()
        : null;
    if (new Set(selected).size !== selected.length) fail(`答案选项重复：${question.id}`);

    const validOptions = new Set(question.options.map((option) => option.value));
    if (selected.some((value) => typeof value !== "string" || !validOptions.has(value))) {
      fail(`答案包含未知选项：${question.id}`);
    }
    if (question.question_type === "single_choice" && selected.length !== 1) {
      fail(`单选题必须选择一个选项：${question.id}`);
    }
    if (question.question_type === "multi_choice" && selected.length === 0) {
      fail(`多选题至少选择一个选项：${question.id}`);
    }
    if (question.question_type === "free_text" && (selected.length !== 0 || !customText)) {
      fail(`自由文本问题必须填写文本：${question.id}`);
    }
    return { selected_options: selected, custom_text: customText };
  });
}

export default function (pi) {
  pi.registerCommand("raccoon-clarifications-v1", {
    description: "Raccoon 受管需求澄清协议 v1（能力标记）",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Raccoon 需求澄清协议 v1 已启用", "info");
    },
  });

  pi.registerTool({
    name: "request_clarifications",
    label: "请求需求澄清",
    description: "仅在仓库中无法推断且答案会改变实现时，批量请求用户澄清。",
    parameters: Type.Object({
      progress: Type.String(),
      message: Type.String(),
      questions: Type.Array(Question, { minItems: 1, maxItems: 6 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      validateQuestions(params.questions);
      const response = await ctx.ui.editor(
        PROTOCOL,
        JSON.stringify({ protocol: PROTOCOL, questions: params.questions }),
      );
      const answers = parseAnswers(response, params.questions);
      const clarifications = params.questions.map((question, index) => ({
        ...question,
        answer: answers[index],
      }));
      return {
        content: [{ type: "text", text: "用户已完成需求澄清，请据此提交确认草案。" }],
        details: {
          protocol: PROTOCOL,
          kind: "clarifications",
          progress: params.progress,
          message: params.message,
          clarifications,
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
