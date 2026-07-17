import { describe, expect, it } from "vitest";
import { settingsRequiringRestart } from "./settings";
import type { AppSettings } from "./types";

const base: AppSettings = {
  network_policy: "offline",
  soft_threshold_usd: 25,
  listen_host: "127.0.0.1",
  listen_port: 4173,
  pending_restart: [],
  last_result: null,
};

describe("restart_required 逻辑（FE-SET-002）", () => {
  it("修改监听 host/port 需要重启", () => {
    expect(settingsRequiringRestart(base, { listen_host: "0.0.0.0" })).toEqual([
      "listen_host",
    ]);
    expect(settingsRequiringRestart(base, { listen_port: 8080 })).toEqual([
      "listen_port",
    ]);
    expect(
      settingsRequiringRestart(base, {
        listen_host: "0.0.0.0",
        listen_port: 8080,
      }),
    ).toEqual(["listen_host", "listen_port"]);
  });

  it("其他设置保存即生效，不需要重启", () => {
    expect(
      settingsRequiringRestart(base, { network_policy: "git_remote" }),
    ).toEqual([]);
    expect(settingsRequiringRestart(base, { soft_threshold_usd: 50 })).toEqual(
      [],
    );
  });

  it("值未变化不产生重启要求", () => {
    expect(settingsRequiringRestart(base, { listen_port: 4173 })).toEqual([]);
  });
});
