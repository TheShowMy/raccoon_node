import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const PROTOCOL = "raccoon:parallel-review:v1";
const ANGLES = ["正确性", "边界与安全", "代码质量与测试"];
const MAX_EVENT_BYTES = 128 * 1024;
let latestPrompt = "";

function section(prompt, name) {
  const start = `<!-- raccoon:managed:start ${name} -->`;
  const end = `<!-- raccoon:managed:end ${name} -->`;
  const from = prompt.indexOf(start);
  const to = prompt.indexOf(end);
  if (from < 0 || to <= from) throw new Error(`缺少受管审核 section: ${name}`);
  return prompt.slice(from + start.length, to).trim();
}

function invocation(args) {
  const script = process.argv[1];
  if (script && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  return { command: "pi", args };
}

function runChild(angle, prompt, ctx, workerPath, signal, onUpdate) {
  return new Promise((resolve) => {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
    const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", workerPath,
      "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--tools", "read,grep,find,ls,read_staged_diff,submit_review_result"];
    if (model) args.push("--model", model);
    const call = invocation(args);
    const child = spawn(call.command, call.args, { cwd: ctx.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    let eventBytes = 0;
    let buffer = "";
    let stderr = "";
    let result = null;
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: { tokens: 0, window: 0, percent: 0 } };
    let finished = false;
    let statsReceived = false;
    const finish = (value) => { if (!finished) { finished = true; resolve(value); } };
    const processLine = (line) => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (value.type === "tool_execution_end" && value.toolName === "submit_review_result" && !value.isError) {
        result = value.result?.details ?? null;
      }
      if (value.type === "agent_end") {
        child.stdin.write(`${JSON.stringify({ id: "stats", type: "get_session_stats" })}\n`);
      }
      if (value.type === "response" && value.id === "stats") {
        statsReceived = true;
        const tokens = value.data?.tokens ?? {};
        const context = value.data?.contextUsage ?? {};
        usage = { input: tokens.input ?? 0, output: tokens.output ?? 0, cacheRead: tokens.cacheRead ?? 0,
          cacheWrite: tokens.cacheWrite ?? 0, context: { tokens: context.tokens ?? 0, window: context.contextWindow ?? 0, percent: context.percent ?? 0 } };
        child.kill();
      }
      const encoded = Buffer.byteLength(line, "utf8");
      if (eventBytes + encoded <= MAX_EVENT_BYTES) { events.push(value); eventBytes += encoded; }
      onUpdate?.();
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString().slice(0, 16 * 1024); });
    child.on("error", (error) => finish({ angle, ok: false, error: error.message, events, usage }));
    child.on("close", (code) => finish({ angle, ok: result?.protocol === PROTOCOL && statsReceived, error: result && statsReceived ? null : (stderr || `Pi 子进程退出：${code}`), result, events, usage, truncated: eventBytes >= MAX_EVENT_BYTES }));
    signal?.addEventListener("abort", () => child.kill(), { once: true });
    child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: prompt })}\n`);
  });
}

export default function (pi) {
  pi.on("before_agent_start", (event) => { latestPrompt = event.prompt; });
  pi.registerCommand("raccoon-parallel-review-v1", { description: "Raccoon 并行审核协议 v1", handler: async () => {} });
  pi.registerTool({
    name: "run_parallel_code_review",
    label: "并行代码审核",
    description: "并发运行三个固定、隔离、只读的代码审核子代理。",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, onUpdate, ctx) {
      const policy = section(latestPrompt, "review-policy");
      const packet = section(latestPrompt, "review-packet");
      const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "raccoon-review-worker.mjs");
      const states = ANGLES.map((angle) => ({ angle, status: "running" }));
      const emit = () => onUpdate?.({ content: [{ type: "text", text: `并行审核：${states.filter((item) => item.status !== "running").length}/3 完成` }], details: { protocol: PROTOCOL, subagents: states } });
      emit();
      const reviews = await Promise.all(ANGLES.map(async (angle, index) => {
        const childPrompt = `${policy}\n\n审核角度：${angle}\n\n${packet}\n\n必须先读取 staged diff，完成审核后调用 submit_review_result。`;
        const review = await runChild(angle, childPrompt, ctx, workerPath, signal, emit);
        states[index] = { angle, status: review.ok ? "done" : "error" };
        emit();
        return review;
      }));
      const failed = reviews.filter((review) => !review.ok);
      return {
        content: [{ type: "text", text: failed.length ? `并行审核技术失败：${failed.map((item) => item.angle).join("、")}` : "三个隔离角度审核已完成。" }],
        details: { protocol: PROTOCOL, kind: "parallel_review", reviews },
        isError: failed.length > 0,
        terminate: true,
      };
    },
  });
}
