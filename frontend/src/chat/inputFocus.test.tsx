import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type {
  ClarificationRound,
  ConversationNode,
  Requirement,
} from "../api/types";
import { useDomainStore } from "../store/domainStore";
import { ClarificationQuestionNode, ComposerNode } from "./nodes";

/**
 * 输入节点自动聚焦（FE-CHAT-027）：出现即聚焦，窗口化滚动重挂载不重复聚焦。
 * autofocusedKeys 是模块级守卫，各用例使用互不相同的节点 id 避免串扰。
 */

const requirement: Requirement = {
  id: "req-focus",
  title: "聚焦需求",
  state: "clarifying",
  source_session_id: "s-main",
  source_branch_id: "b-main",
  source_node_ids: [],
  latest_revision: 0,
  confirmed_revision: null,
  queue_position: null,
  latest_run_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

function clarificationNode(roundId: string): ConversationNode {
  return {
    id: `node-${roundId}`,
    graph_id: "g-main",
    kind: "clarification_question",
    state: "completed",
    content: "问题",
    node_sequence: 0,
    intent: null,
    parent_ids: [],
    branch_ids: ["b-main"],
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    requirement_id: requirement.id,
    requirement_revision: null,
    clarification_round_id: roundId,
    redacted_at: null,
    tool_activity: null,
  };
}

function seedRound(round: ClarificationRound) {
  useDomainStore.setState({
    requirements: { [requirement.id]: requirement },
    clarifications: { [round.id]: round },
  });
}

function freeTextRound(id: string): ClarificationRound {
  return {
    id,
    requirement_id: requirement.id,
    question: "关键约束是什么？",
    mode: "free_text",
    options: [],
    allow_custom: false,
    answer: null,
    state: "pending",
    asked_at: "2026-01-01T00:00:00.000Z",
    answered_at: null,
  };
}

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("输入节点自动聚焦", () => {
  it("Composer 出现时自动聚焦消息输入框", () => {
    renderWithQuery(
      <ComposerNode sessionId="s-focus-1" branchId="b-focus-1" />,
    );
    expect(screen.getByLabelText("消息内容")).toHaveFocus();
  });

  it("同 head 卸载重挂载（窗口化滚动）不重复抢焦点", () => {
    const first = renderWithQuery(
      <ComposerNode sessionId="s-focus-2" branchId="b-focus-2" />,
    );
    expect(screen.getByLabelText("消息内容")).toHaveFocus();
    first.unmount();
    const second = renderWithQuery(
      <ComposerNode sessionId="s-focus-2" branchId="b-focus-2" />,
    );
    expect(screen.getByLabelText("消息内容")).not.toHaveFocus();
    second.unmount();
  });

  it("pending 自由文本澄清轮次出现时聚焦回答输入框", () => {
    seedRound(freeTextRound("round-focus-1"));
    renderWithQuery(
      <ClarificationQuestionNode
        node={clarificationNode("round-focus-1")}
        sessionId="s-main"
        branchId="b-main"
      />,
    );
    expect(screen.getByLabelText("自定义澄清回答")).toHaveFocus();
  });

  it("选择「自定义回答」后展开的文本框获得焦点", () => {
    seedRound({
      ...freeTextRound("round-focus-2"),
      mode: "single_choice",
      allow_custom: true,
      options: [
        {
          id: "opt-1",
          label: "选项一",
          description: null,
          recommended: false,
        },
      ],
    });
    renderWithQuery(
      <ClarificationQuestionNode
        node={clarificationNode("round-focus-2")}
        sessionId="s-main"
        branchId="b-main"
      />,
    );
    expect(screen.queryByLabelText("自定义澄清回答")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("自定义回答").closest("button")!);
    expect(screen.getByLabelText("自定义澄清回答")).toHaveFocus();
  });
});
