import { spawn } from "node:child_process";
import { Type } from "typebox";

const PROTOCOL = "raccoon:parallel-review:v1";
const MAX_DIFF_BYTES = 256 * 1024;

function runGit(args, cwd, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString().slice(0, 16 * 1024);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `git 退出码：${code}`));
      } else {
        resolve(stdout);
      }
    });
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}

export default function (pi) {
  pi.registerTool({
    name: "read_staged_diff",
    label: "读取暂存差异",
    description: "读取当前工作区的 git diff --cached；固定只读参数。",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const output = await runGit(["diff", "--cached", "--no-ext-diff", "--"], ctx.cwd, signal);
      const buf = Buffer.from(output, "utf8");
      const truncated = buf.length > MAX_DIFF_BYTES;
      const text = truncated
        ? `${buf.subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n...（diff 已截断）`
        : output;
      return { content: [{ type: "text", text: text || "暂存区没有差异。" }], details: { bytes: buf.length, truncated } };
    },
  });

  pi.registerTool({
    name: "submit_review_result",
    label: "提交审核结论",
    description: "完成指定角度审核后提交唯一结构化结论。",
    parameters: Type.Object({
      approved: Type.Boolean(),
      feedback: Type.String(),
      result_summary: Type.String(),
    }),
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: "审核结论已提交。" }],
        details: { protocol: PROTOCOL, kind: "review_result", ...params },
        terminate: true,
      };
    },
  });
}
