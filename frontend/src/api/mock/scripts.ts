/**
 * 假 LLM 预设脚本（P1 假数据层）：发送消息后按关键词选择脚本，
 * 流式产出"过程 / 工具 / 回答"。后端阶段由真实 qa/planner 角色替换。
 */

export type ScriptStep =
  | { kind: "process"; chunks: string[] }
  | {
      kind: "tool";
      name: string;
      purpose: string;
      summary: string;
      duration_ms: number;
      fails?: boolean;
    }
  | { kind: "answer"; chunks: string[] };

const QA_SCRIPT: ScriptStep[] = [
  {
    kind: "process",
    chunks: [
      "理解问题：这是一个项目问答请求。\n",
      "检索证据：查看仓库结构与现有文档。\n",
      "结论：可以直接回答，无需进入开发流程。",
    ],
  },
  {
    kind: "answer",
    chunks: [
      "这是一个本地优先的 Agent 工作台：",
      "对话、需求、Git、终端都以画布节点呈现。\n\n",
      "当前回答来自**假数据层**的预设脚本，",
      "用于验收流式节点交互；接入真实后端后由 qa 角色模型生成。",
    ],
  },
];

const DEV_SCRIPT: ScriptStep[] = [
  {
    kind: "process",
    chunks: [
      "理解目标：识别为开发需求（change）。\n",
      "下一步：扫描仓库结构，评估影响面。",
    ],
  },
  {
    kind: "tool",
    name: "repo.scan",
    purpose: "扫描仓库结构以评估改动范围",
    summary: "发现 3 个相关模块：api / workflow / store；入口在 src/lib.rs。",
    duration_ms: 1400,
  },
  {
    kind: "process",
    chunks: [
      "证据：相关模块已定位。\n",
      "动作：生成需求草稿并准备澄清问题。\n",
      "结论：影响面可控，可以进入规格阶段。",
    ],
  },
  {
    kind: "answer",
    chunks: [
      "已为你创建**需求草稿**（演示数据）。\n\n",
      "- 意图判定为 change，按流程将进入澄清环节\n",
      "- 真实澄清/规格/Run 流程在 P2 交付工作台验收\n",
      "- 你可以继续追问，或从历史消息开新分支对比方案",
    ],
  },
];

const DEFAULT_SCRIPT: ScriptStep[] = [
  {
    kind: "process",
    chunks: ["理解输入：自由对话。\n", "结论：按一般问答处理。"],
  },
  {
    kind: "answer",
    chunks: [
      "收到。我是假数据层的预设应答：",
      "试试问一个带「?」的问题，或描述一个需求/功能，",
      "我会走不同的演示脚本。",
    ],
  },
];

const FAILING_TOOL_SCRIPT: ScriptStep[] = [
  {
    kind: "process",
    chunks: [
      "理解目标：演示工具失败路径。\n",
      "下一步：运行一个会失败的工具。",
    ],
  },
  {
    kind: "tool",
    name: "repo.scan",
    purpose: "演示工具失败的节点状态",
    summary: "退出码 1：模拟的工具执行失败（演示数据）。",
    duration_ms: 900,
    fails: true,
  },
  {
    kind: "answer",
    chunks: [
      "工具执行失败了（演示）。失败状态会保留在节点上，",
      "你可以停止响应、重述问题，或从历史消息分支重试。",
    ],
  },
];

/** 按消息文本选择预设脚本（含"失败"触发工具失败演示） */
export function selectScript(text: string, isChange: boolean): ScriptStep[] {
  if (/失败|错误|报错/.test(text)) return FAILING_TOOL_SCRIPT;
  if (isChange || /需求|功能|做|开发|实现/.test(text)) return DEV_SCRIPT;
  if (/[?？]|如何|什么|为什么|吗|怎么/.test(text)) return QA_SCRIPT;
  return DEFAULT_SCRIPT;
}
