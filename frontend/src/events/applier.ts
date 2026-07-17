import { EVENT_SCHEMA_VERSION, type EventEnvelope } from "../api/types";

/**
 * 全局 sequence 对账（FE-EVENT-003/006/007）：
 * - sequence ≤ 已应用序号 → 去重丢弃；
 * - sequence > 期望序号 → 停止应用并触发 resync，不猜测缺失状态；
 * - system.resync_required → 停止并触发 resync；
 * - 未知 schema_version → 版本不兼容，同样走 resync/诊断路径。
 */
export type EventApplierHandlers = {
  apply: (envelope: EventEnvelope) => void;
  onResyncNeeded: (reason: "gap" | "resync_required" | "version") => void;
};

export type EventApplier = {
  handle: (envelope: EventEnvelope) => void;
  readonly halted: boolean;
  readonly expectedSequence: number;
};

export function createEventApplier(
  lastAppliedSequence: number,
  handlers: EventApplierHandlers,
): EventApplier {
  let expected = lastAppliedSequence + 1;
  let halted = false;

  const halt = (reason: "gap" | "resync_required" | "version") => {
    if (halted) return;
    halted = true;
    handlers.onResyncNeeded(reason);
  };

  return {
    get halted() {
      return halted;
    },
    get expectedSequence() {
      return expected;
    },
    handle(envelope) {
      if (halted) return;
      if (envelope.event_type === "system.resync_required") {
        halt("resync_required");
        return;
      }
      if (envelope.schema_version !== EVENT_SCHEMA_VERSION) {
        halt("version");
        return;
      }
      if (envelope.sequence < expected) return; // 去重
      if (envelope.sequence > expected) {
        halt("gap");
        return;
      }
      expected += 1;
      handlers.apply(envelope);
    },
  };
}
