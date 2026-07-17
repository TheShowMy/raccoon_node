import { useMemo } from "react";
import { useDomainStore } from "../../store/domainStore";
import { SubCanvas } from "../shared/SubCanvas";
import {
  WorkbenchActionConfirmationNode,
  WorkbenchActionResultNode,
} from "../shared/actionNodes";
import { LauncherNode, TerminalSessionNode } from "./nodes";
import { projectTerminal } from "./projection";

const nodeTypes = {
  term_launcher: LauncherNode,
  term_session: TerminalSessionNode,
  term_action_confirmation: WorkbenchActionConfirmationNode,
  term_action_result: WorkbenchActionResultNode,
};

/** 终端工作台（FE-TERM-*）：独立 PTY 会话节点 + 断连/退出状态 */
export function TerminalWorkbench() {
  const terminals = useDomainStore((state) => state.terminals);
  const workbenchActions = useDomainStore((state) => state.workbenchActions);
  const projection = useMemo(
    () =>
      projectTerminal({
        sessions: Object.values(terminals),
        actions: Object.values(workbenchActions),
      }),
    [terminals, workbenchActions],
  );
  return (
    <SubCanvas
      kind="terminal"
      nodeTypes={nodeTypes}
      projection={projection}
      ariaLabel="终端子画布"
    />
  );
}
