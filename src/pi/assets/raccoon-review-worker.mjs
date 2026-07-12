import { execFile } from "node:child_process";
import { Type } from "typebox";

const PROTOCOL = "raccoon:parallel-review:v1";
const MAX_DIFF_BYTES = 256 * 1024;

function runGit(args, cwd, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_DIFF_BYTES * 2 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
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
      const bytes = Buffer.byteLength(output, "utf8");
      const text = bytes > MAX_DIFF_BYTES ? `${output.slice(0, MAX_DIFF_BYTES)}\n...（diff 已截断）` : output;
      return { content: [{ type: "text", text: text || "暂存区没有差异。" }], details: { bytes, truncated: bytes > MAX_DIFF_BYTES } };
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
