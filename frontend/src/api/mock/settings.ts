import { settingsRequiringRestart } from "../settings";
import type {
  AppSettings,
  DiagnosticsInfo,
  DomainEventPayload,
  EventAggregateType,
  EventType,
  NotificationSeverity,
  NotificationSourceWorkbench,
} from "../types";

type Emit = <T extends EventType>(
  aggregateType: EventAggregateType,
  aggregateId: string,
  eventType: T,
  payload: DomainEventPayload[T],
) => void;

type Notify = (
  severity: NotificationSeverity,
  message: string,
  sourceWorkbench: NotificationSourceWorkbench,
  sourceNodeId: string | null,
) => string;

const now = () => new Date().toISOString();

/** 设置模块（假数据层）：事件化业务设置 + restart_required 结果（FE-SET-002） */
export class SettingsModule {
  private settings: AppSettings = {
    network_policy: "git_remote",
    default_task_budget_usd: 25,
    listen_host: "127.0.0.1",
    listen_port: 4173,
    pending_restart: [],
    last_result: null,
  };

  constructor(
    private readonly deps: {
      emit: Emit;
      notify: Notify;
      latency: () => Promise<void>;
      lastSequence: () => number;
    },
  ) {}

  private publish() {
    this.deps.emit("settings", "app", "settings.updated", {
      settings: this.settings,
    });
  }

  snapshotState(): AppSettings {
    return this.settings;
  }

  async update(patch: Partial<AppSettings>): Promise<void> {
    await this.deps.latency();
    const restartKeys = settingsRequiringRestart(this.settings, patch);
    this.settings = {
      ...this.settings,
      ...patch,
      pending_restart: [
        ...new Set([...this.settings.pending_restart, ...restartKeys]),
      ],
      last_result: {
        ok: true,
        message:
          restartKeys.length > 0
            ? `已保存。${restartKeys.join("、")} 需重启后生效（restart_required：保存和重启是两个动作）。`
            : "已保存，立即生效。",
        at: now(),
      },
    };
    this.publish();
  }

  /** 模拟重启：pending_restart 清空（保存和重启是两个动作） */
  async restart(): Promise<void> {
    await this.deps.latency();
    const hadPending = this.settings.pending_restart.length > 0;
    this.settings = {
      ...this.settings,
      pending_restart: [],
      last_result: {
        ok: true,
        message: hadPending
          ? "已模拟重启，监听设置生效。"
          : "已模拟重启（没有待生效的重启项）。",
        at: now(),
      },
    };
    this.publish();
    this.deps.notify(
      "success",
      "系统已模拟重启，全部设置生效。",
      "settings",
      null,
    );
  }

  async diagnostics(): Promise<DiagnosticsInfo> {
    await this.deps.latency();
    return {
      event_store_health: "active.jsonl 正常 · 封存段 2 个 · 无损坏",
      last_sequence: this.deps.lastSequence(),
      backups: [
        "backups/2026-07-15-pre-compaction/",
        "backups/2026-07-10-manual/",
      ],
      archive_hint:
        "发现旧布局时：mv .raccoon-node <归档目录>/raccoon-node-v1，然后重启（只读诊断不自动覆盖）。",
    };
  }

  summaryLines(): string[] {
    const pending = this.settings.pending_restart.length;
    return [
      `网络策略：${this.settings.network_policy}`,
      pending > 0 ? `待重启生效 ${pending} 项` : "无待重启修改",
      "诊断：事件存储正常",
    ];
  }
}
