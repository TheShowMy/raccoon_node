import type {
  DomainEventPayload,
  EventAggregateType,
  EventType,
  TerminalSession,
} from "../types";

type Emit = <T extends EventType>(
  aggregateType: EventAggregateType,
  aggregateId: string,
  eventType: T,
  payload: DomainEventPayload[T],
) => void;

const now = () => new Date().toISOString();

const LS_OUTPUT = [
  "README.md",
  "Cargo.toml",
  "docs/",
  "frontend/",
  "src/",
].join("  ");
const GIT_STATUS_OUTPUT = [
  "On branch main",
  "Changes not staged for commit:",
  "  modified:   frontend/src/canvas/nodes.tsx",
  "Untracked files:",
  "  docs/rewrite/TODO.md",
].join("\r\n");

/**
 * 假 PTY：本地回显 + 行编辑 + 预设命令。
 * 终端正文只经订阅回调输出（模拟 WebSocket 侧信道），不进入业务事件（FE-TERM-002）。
 */
export class MockPty {
  private buffer = "";
  private exited = false;
  private readonly listeners = new Set<(data: string) => void>();

  constructor(
    private readonly onExit: (code: number) => void,
    private readonly isConnected: () => boolean,
  ) {
    this.write("Raccoon Node 演示终端（mock PTY）——输入 help 查看可用命令\r\n");
    this.prompt();
  }

  private prompt() {
    this.write("raccoon@demo:~$ ");
  }

  private write(data: string) {
    for (const listener of this.listeners) listener(data);
  }

  subscribe(listener: (data: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyDisconnected() {
    this.write("\r\n\x1b[33m[连接已断开——输入输出暂停]\x1b[0m\r\n");
  }

  notifyReconnected() {
    this.write("\x1b[32m[已重连]\x1b[0m\r\n");
    this.prompt();
  }

  input(data: string) {
    if (this.exited || !this.isConnected()) return;
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.write("\r\n");
        const command = this.buffer;
        this.buffer = "";
        this.runCommand(command.trim());
        if (this.exited) return;
        this.prompt();
      } else if (ch === "\x7f") {
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          this.write("\b \b");
        }
      } else if (ch >= " ") {
        this.buffer += ch;
        this.write(ch);
      }
      // 其他控制字符（方向键等）在 mock 中忽略
    }
  }

  private runCommand(command: string) {
    if (!command) return;
    const [head, ...args] = command.split(/\s+/);
    switch (head) {
      case "help":
        this.write(
          [
            "可用命令（mock）：",
            "  help        显示本帮助",
            "  ls          列出演示仓库根目录",
            "  git status  显示演示 Git 状态",
            "  echo <文本> 原样回显",
            "  exit        结束会话（进程退出 ≠ 连接断开）",
          ].join("\r\n") + "\r\n",
        );
        return;
      case "ls":
        this.write(`${LS_OUTPUT}\r\n`);
        return;
      case "git":
        if (args[0] === "status") {
          this.write(`${GIT_STATUS_OUTPUT}\r\n`);
        } else {
          this.write(
            `mock: git ${args[0] ?? ""} 不支持，仅支持 git status\r\n`,
          );
        }
        return;
      case "echo":
        this.write(`${args.join(" ")}\r\n`);
        return;
      case "exit":
        this.write("[进程已退出，exit code 0]\r\n");
        this.exited = true;
        this.onExit(0);
        return;
      default:
        this.write(
          `mock: 不支持的命令「${command}」（输入 help 查看可用命令）\r\n`,
        );
    }
  }
}

type SessionEntry = {
  session: TerminalSession;
  pty: MockPty;
};

/**
 * 终端模块（假数据层）：会话生命周期经 terminal.session_updated 事件投影；
 * 连接断开与进程退出是不同状态（FE-TERM-002）。
 */
export class TerminalModule {
  private counter = 0;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly deps: {
      idPrefix: string;
      emit: Emit;
      latency: () => Promise<void>;
    },
  ) {}

  private publish(entry: SessionEntry, closed = false) {
    this.deps.emit("terminal", entry.session.id, "terminal.session_updated", {
      session: { ...entry.session },
      ...(closed ? { closed: true } : {}),
    });
  }

  snapshotState(): TerminalSession[] {
    return [...this.sessions.values()].map((entry) => ({ ...entry.session }));
  }

  async create(): Promise<{ session_id: string }> {
    await this.deps.latency();
    const id = `t-${this.deps.idPrefix}-${++this.counter}`;
    const entry: SessionEntry = {
      session: {
        id,
        title: `会话 ${this.counter}`,
        state: "running",
        exit_code: null,
        created_at: now(),
      },
      pty: undefined as unknown as MockPty,
    };
    entry.pty = new MockPty(
      (code) => {
        entry.session = { ...entry.session, state: "exited", exit_code: code };
        this.publish(entry);
      },
      () => entry.session.state === "running",
    );
    this.sessions.set(id, entry);
    this.publish(entry);
    return { session_id: id };
  }

  async rename(input: { session_id: string; title: string }): Promise<void> {
    await this.deps.latency();
    const entry = this.sessions.get(input.session_id);
    if (!entry) return;
    entry.session = {
      ...entry.session,
      title: input.title.trim() || entry.session.title,
    };
    this.publish(entry);
  }

  /** 直接关闭（仅 exited/disconnected；running 走 terminal_close 确认链） */
  async close(sessionId: string): Promise<void> {
    await this.deps.latency();
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.session.state === "running") return;
    this.sessions.delete(sessionId);
    this.publish(entry, true);
  }

  /** 确认链执行：关闭运行中会话（终止完整进程树语义） */
  forceClose(sessionId: string): { ok: boolean; message: string } {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: false, message: "会话不存在或已关闭。" };
    this.sessions.delete(sessionId);
    this.publish(entry, true);
    return { ok: true, message: `已关闭终端会话「${entry.session.title}」。` };
  }

  input(input: { session_id: string; data: string }) {
    this.sessions.get(input.session_id)?.pty.input(input.data);
  }

  resize(_input: { session_id: string; cols: number; rows: number }) {
    // mock：尺寸变化只影响前端 xterm fit，无 PTY 状态
  }

  async disconnect(sessionId: string): Promise<void> {
    await this.deps.latency();
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.session.state !== "running") return;
    entry.session = { ...entry.session, state: "disconnected" };
    entry.pty.notifyDisconnected();
    this.publish(entry);
  }

  async reconnect(sessionId: string): Promise<void> {
    await this.deps.latency();
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.session.state !== "disconnected") return;
    entry.session = { ...entry.session, state: "running" };
    entry.pty.notifyReconnected();
    this.publish(entry);
  }

  subscribeOutput(
    sessionId: string,
    onData: (data: string) => void,
  ): () => void {
    return this.sessions.get(sessionId)?.pty.subscribe(onData) ?? (() => {});
  }

  summaryLines(): string[] {
    const all = [...this.sessions.values()];
    const running = all.filter(
      (entry) => entry.session.state === "running",
    ).length;
    return [
      `会话 ${all.length}（运行 ${running}）`,
      running > 0 ? "PTY 回显可用（help）" : "从「新建会话」开始",
      "断开与退出分开展示",
    ];
  }
}
