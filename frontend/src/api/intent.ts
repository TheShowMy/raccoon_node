import type { DetectedIntent } from "./types";

const CHANGE_PATTERN = /需求|功能|开发|实现|修改|添加|做一|做个|新增/;
const QUESTION_PATTERN = /[?？]|如何|什么|为什么|吗|怎么/;

/**
 * question | change | ambiguous 的本地演示判定。
 * P1 阶段前后端共用同一启发式：Composer 用于意图预览，FakeBackend 用于脚本选择；
 * 后端阶段由 qa 角色模型的分类结果替换（PRD-CHAT-002）。
 */
export function detectIntent(text: string): DetectedIntent {
  const trimmed = text.trim();
  if (!trimmed) return "ambiguous";
  const change = CHANGE_PATTERN.test(trimmed);
  const question = QUESTION_PATTERN.test(trimmed);
  if (change && !question) return "change";
  if (question && !change) return "question";
  return "ambiguous";
}
