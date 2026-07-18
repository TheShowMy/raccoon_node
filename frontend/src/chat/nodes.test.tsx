import { fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ClarificationMode,
  ClarificationRound,
  ConversationNode,
  Requirement,
} from "../api/types";
import { useDomainStore } from "../store/domainStore";
import { ClarificationQuestionNode } from "./nodes";

const requirement: Requirement = {
  id: "req-clarification",
  title: "澄清模式",
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

const node: ConversationNode = {
  id: "node-clarification",
  graph_id: "g-main",
  kind: "clarification_question",
  state: "completed",
  content: "请选择影响范围",
  node_sequence: 0,
  intent: null,
  parent_ids: [],
  branch_ids: ["b-main"],
  created_at: "2026-01-01T00:00:01.000Z",
  completed_at: "2026-01-01T00:00:01.000Z",
  requirement_id: requirement.id,
  requirement_revision: null,
  clarification_round_id: "round-clarification",
  redacted_at: null,
  tool_activity: null,
};

function round(mode: ClarificationMode): ClarificationRound {
  return {
    id: "round-clarification",
    requirement_id: requirement.id,
    question: "请选择影响范围",
    mode,
    options:
      mode === "free_text"
        ? []
        : [
            {
              id: "canvas",
              label: "画布交互",
              description: "节点布局与定位",
              recommended: true,
            },
            {
              id: "runtime",
              label: "运行语义",
              description: null,
              recommended: false,
            },
          ],
    allow_custom: mode !== "free_text",
    answer: null,
    state: "pending",
    asked_at: "2026-01-01T00:00:01.000Z",
    answered_at: null,
  };
}

function renderRound(mode: ClarificationMode) {
  const clarification = round(mode);
  useDomainStore.setState({
    requirements: { [requirement.id]: requirement },
    clarifications: { [clarification.id]: clarification },
  });
  const props = {
    data: { node, branchId: "b-main" },
  } as unknown as NodeProps;
  return render(
    <ReactFlowProvider>
      <ClarificationQuestionNode {...props} />
    </ReactFlowProvider>,
  );
}

beforeEach(() => {
  useDomainStore.setState({ requirements: {}, clarifications: {} });
});

describe("澄清问题节点", () => {
  it("单选模式使用 radio 行且只有选择自定义后才展示文本框", () => {
    renderRound("single_choice");
    expect(screen.getByText("待回答")).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByText("推荐")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "自定义澄清回答" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /自定义回答/ }));
    expect(
      screen.getByRole("textbox", { name: "自定义澄清回答" }),
    ).toBeInTheDocument();
  });

  it("多选模式允许同时选择多个 checkbox", () => {
    renderRound("multiple_choice");
    const canvas = screen.getByRole("checkbox", { name: /画布交互/ });
    const runtime = screen.getByRole("checkbox", { name: /运行语义/ });
    fireEvent.click(canvas);
    fireEvent.click(runtime);
    expect(canvas).toHaveAttribute("aria-checked", "true");
    expect(runtime).toHaveAttribute("aria-checked", "true");
  });

  it("自由文本模式只展示不可替代的文本回答入口", () => {
    renderRound("free_text");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "自定义澄清回答" }),
    ).toBeInTheDocument();
  });
});
