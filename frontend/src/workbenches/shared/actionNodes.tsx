import { PixelButton } from "@pxlkit/ui-kit";
import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { WorkbenchAction } from "../../api/types";
import { DNode } from "../../components/DNode";
import { useDomainStore } from "../../store/domainStore";

/**
 * 工作台危险操作确认链节点（FE-CANVAS-019）：
 * 来源节点 → 本确认节点（prepare 事实）→ 结果节点（confirm 执行结果）。
 */
function ActionConfirmationContent({
  action,
  handles,
  width,
}: {
  action: WorkbenchAction;
  handles: boolean;
  width: number | string;
}) {
  const awaiting = action.state === "awaiting";
  const sessionSwitch = action.kind === "conversation_new_session";
  return (
    <DNode
      icon="action"
      label="操作确认"
      chip={
        sessionSwitch ? "会话切换" : action.irreversible ? "不可逆" : "两阶段"
      }
      chipTone={sessionSwitch ? "cyan" : "red"}
      width={width}
      handles={handles}
      ariaLabel={`${sessionSwitch ? "会话操作" : "危险操作"}确认:${action.title}`}
      className={sessionSwitch ? undefined : "dnode--danger"}
      actions={
        awaiting ? (
          <>
            <PixelButton
              size="sm"
              tone={sessionSwitch ? "cyan" : "red"}
              onClick={() =>
                void useDomainStore.getState().confirmWorkbenchAction(action)
              }
            >
              确认执行
            </PixelButton>
            <PixelButton
              size="sm"
              variant="outline"
              onClick={() =>
                void useDomainStore.getState().cancelWorkbenchAction(action.id)
              }
            >
              取消
            </PixelButton>
          </>
        ) : undefined
      }
    >
      <p className="dnode__text">
        <strong>{action.title}</strong>
      </p>
      <p className="dnode__text">{action.impact}</p>
      <p className="dnode__meta">
        {awaiting
          ? sessionSwitch
            ? "确认后停止当前生成并切换到独立空白会话。"
            : "prepare/confirm 两阶段；确认 token 绑定本次操作。"
          : action.state === "confirmed"
            ? "已确认；结果节点保留本次执行事实。"
            : "已取消；没有执行来源操作。"}
      </p>
    </DNode>
  );
}

function ActionResultContent({
  action,
  handles,
  width,
}: {
  action: WorkbenchAction;
  handles: boolean;
  width: number | string;
}) {
  const ok = action.result?.ok ?? false;
  return (
    <DNode
      icon="result"
      label="操作结果"
      chip={action.state === "cancelled" ? "已取消" : ok ? "成功" : "失败"}
      chipTone={action.state === "cancelled" ? "gray" : ok ? "green" : "red"}
      width={width}
      handles={handles}
      ariaLabel={`操作结果:${action.title}`}
    >
      <p className="dnode__text">
        <strong>{action.title}</strong>
      </p>
      <p className="dnode__text">{action.result?.message}</p>
      {action.irreversible && action.state === "confirmed" ? (
        <p className="dnode__meta">该确认是永久事实，进入事件日志与快照。</p>
      ) : null}
    </DNode>
  );
}

/** 纯卡片形态（React Flow 之外渲染，如会话竖排列表）。 */
export function ActionConfirmationCard({
  action,
}: {
  action: WorkbenchAction;
}) {
  return (
    <ActionConfirmationContent action={action} handles={false} width="100%" />
  );
}

export function ActionResultCard({ action }: { action: WorkbenchAction }) {
  return <ActionResultContent action={action} handles={false} width="100%" />;
}

export const WorkbenchActionConfirmationNode = memo(
  function WorkbenchActionConfirmationNode({ data }: NodeProps) {
    const { action } = data as { action: WorkbenchAction };
    return <ActionConfirmationContent action={action} handles width={340} />;
  },
);

export const WorkbenchActionResultNode = memo(
  function WorkbenchActionResultNode({ data }: NodeProps) {
    const { action } = data as { action: WorkbenchAction };
    return <ActionResultContent action={action} handles width={340} />;
  },
);
