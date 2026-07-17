import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PixelButton } from "@pxlkit/ui-kit";
import { getApi } from "../../api";
import type { ScenarioCommand, ScenarioState } from "../../api/client";

const FLAG_LABELS: {
  flag: keyof ScenarioState["flags"];
  label: string;
  hint: string;
}[] = [
  {
    flag: "remote_ready",
    label: "远端 ready",
    hint: "开：冻结 PR 路径；关：本地 FF",
  },
  {
    flag: "dirty_workspace",
    label: "脏工作区",
    hint: "下一个 Run 停在 waiting_workspace",
  },
  {
    flag: "new_regression",
    label: "新回归",
    hint: "validating 出现新增失败 → 修复不收敛 → blocked",
  },
  {
    flag: "review_unavailable",
    label: "审核不可用",
    hint: "reviewing unavailable → blocked → 可强制交付",
  },
  {
    flag: "rescue_demo",
    label: "rescue",
    hint: "收尾工作项 1 实现 + 2 修复失败 → rescue 成功",
  },
  {
    flag: "ci_fail_once",
    label: "CI 失败一次",
    hint: "PR 路径远端 CI 失败 → 一次修复推送",
  },
  {
    flag: "ci_reject",
    label: "CI 拒绝合并",
    hint: "修复后仍失败 → blocked → 重试发布确认链",
  },
  {
    flag: "local_sync_fail",
    label: "本地同步失败",
    hint: "远端已交付 · 本地待同步",
  },
];

/**
 * 演示控制台（假数据层专用，FE-DELIVERY 验收走查用）：
 * 逐步推进 / 自动播放 / 分支场景触发。后端阶段移除。
 */
export function DevScenarioBar() {
  const queryClient = useQueryClient();
  const { data: state } = useQuery({
    queryKey: ["scenario-state"],
    queryFn: () => getApi().getScenarioState(),
    refetchInterval: 700,
  });
  const send = async (command: ScenarioCommand) => {
    const next = await getApi().scenarioControl(command);
    queryClient.setQueryData(["scenario-state"], next);
  };
  if (!state) return null;
  return (
    <aside
      className="dev-scenario px-cut px-shadowed-sm nodrag nowheel"
      aria-label="演示控制台"
    >
      <header className="dev-scenario__head">
        <span className="px-font-pixel">演示控制台</span>
        <span className="dev-scenario__mode">
          {state.autoplay
            ? `自动播放 · ${(state.step_delay_ms / 1000).toFixed(1)}s/步`
            : state.awaiting_step_run_id
              ? `等待步进：${state.awaiting_step_run_id}`
              : "手动模式"}
        </span>
      </header>
      <div className="dev-scenario__row">
        <PixelButton
          size="sm"
          tone={state.autoplay ? "green" : "cyan"}
          variant="outline"
          onClick={() =>
            void send({ type: "set_autoplay", value: !state.autoplay })
          }
        >
          {state.autoplay ? "自动播放：开" : "自动播放：关"}
        </PixelButton>
        <PixelButton
          size="sm"
          tone="cyan"
          disabled={state.autoplay || !state.awaiting_step_run_id}
          onClick={() => void send({ type: "step" })}
        >
          步进 →
        </PixelButton>
      </div>
      <div
        className="dev-scenario__flags"
        role="group"
        aria-label="分支场景触发"
      >
        {FLAG_LABELS.map(({ flag, label, hint }) => (
          <button
            key={flag}
            type="button"
            className="dev-scenario__flag"
            data-on={state.flags[flag] || undefined}
            title={hint}
            aria-pressed={state.flags[flag]}
            onClick={() =>
              void send({ type: "set_flag", flag, value: !state.flags[flag] })
            }
          >
            {label}
          </button>
        ))}
      </div>
    </aside>
  );
}
