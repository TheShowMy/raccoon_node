import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../types";
import { MockPty, TerminalModule } from "./terminal";

function makeModule() {
  const events: EventEnvelope[] = [];
  const module = new TerminalModule({
    idPrefix: "test",
    emit: (aggregateType, aggregateId, eventType, payload) => {
      events.push({
        schema_version: 1,
        sequence: events.length + 1,
        event_id: `e-${events.length + 1}`,
        occurred_at: new Date().toISOString(),
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        event_type: eventType,
        payload,
      } as EventEnvelope);
    },
    latency: () => Promise.resolve(),
  });
  return { module, events };
}

describe("mock PTY 会话状态机（FE-TERM-001/002）", () => {
  it("本地回显 + 预设命令", () => {
    const pty = new MockPty(
      () => {},
      () => true,
    );
    let output = "";
    pty.subscribe((data) => {
      output += data;
    });
    pty.input("echo hello\r");
    expect(output).toContain("echo hello\r\nhello\r\n");
    pty.input("help\r");
    expect(output).toContain("可用命令（mock）");
    pty.input("rm -rf /\r");
    expect(output).toContain("mock: 不支持的命令");
  });

  it("退格编辑", () => {
    const pty = new MockPty(
      () => {},
      () => true,
    );
    let output = "";
    pty.subscribe((data) => {
      output += data;
    });
    pty.input("echx\x7fo ok\r");
    // 回显保留原始按键序列，命令行为编辑后的 echo ok
    expect(output).toContain("\b \b");
    expect(output).toContain("\r\nok\r\n");
  });

  it("exit：进程退出并回调 exit code", () => {
    let exitCode: number | null = null;
    const pty = new MockPty(
      (code) => {
        exitCode = code;
      },
      () => true,
    );
    pty.input("exit\r");
    expect(exitCode).toBe(0);
    // 退出后不再接受输入
    let output = "";
    pty.subscribe((data) => {
      output += data;
    });
    pty.input("help\r");
    expect(output).toBe("");
  });

  it("断开后输入暂停，重连恢复（断开 ≠ 退出）", async () => {
    const { module } = makeModule();
    const { session_id } = await module.create();
    let output = "";
    module.subscribeOutput(session_id, (data) => {
      output += data;
    });
    await module.disconnect(session_id);
    module.input({ session_id, data: "help\r" });
    expect(output).not.toContain("可用命令（mock）");
    expect(module.snapshotState()[0].state).toBe("disconnected");
    await module.reconnect(session_id);
    module.input({ session_id, data: "help\r" });
    expect(output).toContain("可用命令（mock）");
    expect(module.snapshotState()[0].state).toBe("running");
  });
});

describe("终端会话生命周期（事件投影）", () => {
  it("创建/重命名/退出产生会话事件；关闭非运行会话发出 closed 标记", async () => {
    const { module, events } = makeModule();
    const { session_id } = await module.create();
    await module.rename({ session_id, title: "构建终端" });
    module.input({ session_id, data: "exit\r" });
    await module.close(session_id);
    const types = events.map((event) => event.event_type);
    expect(types.every((type) => type === "terminal.session_updated")).toBe(
      true,
    );
    const last = events.at(-1);
    expect(last?.event_type).toBe("terminal.session_updated");
    const payload = last?.payload as { closed?: boolean };
    expect(payload.closed).toBe(true);
    expect(module.snapshotState()).toHaveLength(0);
  });

  it("运行中会话不能直接 close，需走 forceClose（确认链）", async () => {
    const { module } = makeModule();
    const { session_id } = await module.create();
    await module.close(session_id);
    expect(module.snapshotState()).toHaveLength(1);
    const result = module.forceClose(session_id);
    expect(result.ok).toBe(true);
    expect(module.snapshotState()).toHaveLength(0);
  });
});
