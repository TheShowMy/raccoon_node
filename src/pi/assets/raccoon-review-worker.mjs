import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const REVIEW_PROTOCOL = "raccoon:parallel-review";

const DEFAULT_PAGE_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 64 * 1024;
const MAX_STAGED_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_LIST_FILES = 2_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 16 * 1024 * 1024;
const INTERNAL_SEGMENTS = new Set([".git", ".raccoon-node"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "target"]);

const PAGED_PARAMETERS = {
  type: "object",
  properties: {
    offset: { type: "integer", minimum: 0, default: 0 },
    max_bytes: {
      type: "integer",
      minimum: 1,
      maximum: MAX_PAGE_BYTES,
      default: DEFAULT_PAGE_BYTES,
    },
  },
  additionalProperties: false,
};

const READ_FILE_PARAMETERS = {
  ...PAGED_PARAMETERS,
  properties: {
    path: { type: "string", minLength: 1 },
    ...PAGED_PARAMETERS.properties,
  },
  required: ["path"],
};

const LIST_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", default: "." },
  },
  additionalProperties: false,
};

const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 256 },
    path: { type: "string", default: "." },
  },
  required: ["query"],
  additionalProperties: false,
};

const FINDING_PARAMETERS = {
  type: "object",
  properties: {
    priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    category: { type: "string", minLength: 1, maxLength: 80 },
    path: { type: "string", minLength: 1, maxLength: 512 },
    location: { type: "string", minLength: 1, maxLength: 160 },
    summary: { type: "string", minLength: 1, maxLength: 160 },
    evidence: { type: "string", minLength: 1, maxLength: 480 },
    reproduction: { type: "string", minLength: 1, maxLength: 320 },
    remediation: { type: "string", minLength: 1, maxLength: 240 },
    scenario_ref: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: [
    "priority",
    "category",
    "path",
    "location",
    "summary",
    "evidence",
  ],
  additionalProperties: false,
};

const SUBMIT_PARAMETERS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      maxItems: 5,
      items: FINDING_PARAMETERS,
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(label, error) {
  return {
    content: [{ type: "text", text: `${label}失败：${errorMessage(error)}` }],
    isError: true,
  };
}

function isUtf8Continuation(byte) {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function utf8Page(output, requestedOffset, maxBytes) {
  let offset = Math.min(requestedOffset, output.length);
  while (offset < output.length && isUtf8Continuation(output[offset])) {
    offset += 1;
  }
  let end = Math.min(offset + maxBytes, output.length);
  if (end < output.length) {
    while (end > offset && isUtf8Continuation(output[end])) end -= 1;
    if (end === offset) {
      end = Math.min(offset + maxBytes, output.length);
      while (end < output.length && isUtf8Continuation(output[end])) end += 1;
    }
  }
  return { offset, end };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function safeRepoPath(cwd, requested = ".") {
  if (
    typeof requested !== "string" ||
    requested.includes("\0") ||
    path.isAbsolute(requested)
  ) {
    throw new Error("只允许仓库相对路径");
  }
  const root = await fs.promises.realpath(cwd);
  const lexical = path.resolve(root, requested || ".");
  if (!isWithin(root, lexical)) throw new Error("路径越出当前 worktree");
  const relative = path.relative(root, lexical);
  const segments = relative ? relative.split(path.sep) : [];
  if (segments.some((segment) => INTERNAL_SEGMENTS.has(segment))) {
    throw new Error("禁止读取 Git 或 Raccoon 内部目录");
  }
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const metadata = await fs.promises.lstat(current);
    if (metadata.isSymbolicLink())
      throw new Error("禁止通过符号链接读取仓库文件");
  }
  const resolved = await fs.promises.realpath(lexical);
  if (!isWithin(root, resolved)) throw new Error("真实路径越出当前 worktree");
  return { root, resolved };
}

async function collectRepoFiles(root, start, limit = MAX_LIST_FILES) {
  const files = [];
  const pending = [start];
  while (pending.length > 0 && files.length < limit) {
    const directory = pending.pop();
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        INTERNAL_SEGMENTS.has(entry.name) ||
        SKIPPED_DIRECTORIES.has(entry.name)
      )
        continue;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
        if (files.length >= limit) break;
      }
    }
  }
  return files.map((file) =>
    path.relative(root, file).split(path.sep).join("/"),
  );
}

function runGit(args, cwd, signal) {
  const executable = process.env.RACCOON_GIT_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable)) {
    return Promise.reject(new Error("受管 Git 可执行文件未配置"));
  }
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...inheritedEnv,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_PAGER: "cat",
      },
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;

    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const abort = () => {
      child.kill();
      finish(reject, new Error("读取 staged diff 已中止"));
    };

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STAGED_DIFF_BYTES) {
        child.kill();
        finish(
          reject,
          new Error("staged diff 超过 8 MiB 审核上限，请拆分任务"),
        );
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_STDERR_BYTES) {
        stderr += chunk.toString().slice(0, MAX_STDERR_BYTES);
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(reject, new Error(stderr || `git 退出码：${code}`));
      } else {
        finish(resolve, Buffer.concat(stdout, stdoutBytes));
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function loadStagedDiffSnapshot(cwd, signal) {
  return runGit(
    ["--no-pager", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--"],
    cwd,
    signal,
  );
}

export function loadReviewDiffSnapshot(cwd, signal, baseRef) {
  if (baseRef === undefined || baseRef === null || baseRef === "") {
    return loadStagedDiffSnapshot(cwd, signal);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseRef)) {
    return Promise.reject(new Error("集成审核基线不是合法 commit id"));
  }
  return runGit(
    [
      "--no-pager",
      "diff",
      baseRef,
      "--no-ext-diff",
      "--no-textconv",
      "--",
    ],
    cwd,
    signal,
  );
}

export function createReviewWorkerTools({
  angle,
  contextMode = "blind",
  allowedBehaviorRefs = [],
  protocol = REVIEW_PROTOCOL,
  stagedDiff,
  onSubmit,
} = {}) {
  const fixedDiff = stagedDiff === undefined ? null : Buffer.from(stagedDiff);
  let diffRead = false;
  let submitted = false;

  const readRepoFile = {
    name: "read_repo_file",
    label: "读取仓库文件",
    description:
      "按 UTF-8 字节分页读取当前 worktree 内的普通文件；拒绝绝对路径、路径逃逸、内部目录和符号链接。",
    parameters: READ_FILE_PARAMETERS,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const { root, resolved } = await safeRepoPath(ctx.cwd, params.path);
        const metadata = await fs.promises.stat(resolved);
        if (!metadata.isFile()) throw new Error("目标不是普通文件");
        const requestedOffset = Math.min(params.offset ?? 0, metadata.size);
        const maxBytes = Math.min(
          params.max_bytes ?? DEFAULT_PAGE_BYTES,
          MAX_PAGE_BYTES,
        );
        const handle = await fs.promises.open(resolved, "r");
        try {
          const buffer = Buffer.alloc(
            Math.min(maxBytes + 4, metadata.size - requestedOffset),
          );
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            requestedOffset,
          );
          const chunk = buffer.subarray(0, bytesRead);
          const { offset, end } = utf8Page(chunk, 0, maxBytes);
          const absoluteOffset = requestedOffset + offset;
          const nextOffset = absoluteOffset + (end - offset);
          return {
            content: [
              {
                type: "text",
                text:
                  chunk.subarray(offset, end).toString("utf8") ||
                  "文件分页为空。",
              },
            ],
            details: {
              path: path.relative(root, resolved).split(path.sep).join("/"),
              total_bytes: metadata.size,
              offset: absoluteOffset,
              returned_bytes: end - offset,
              next_offset: nextOffset < metadata.size ? nextOffset : null,
            },
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        return errorResult("读取仓库文件", error);
      }
    },
  };

  const listRepoFiles = {
    name: "list_repo_files",
    label: "列出仓库文件",
    description:
      "列出当前 worktree 安全相对路径下的普通文件，最多 2000 项；跳过内部目录、依赖目录和符号链接。",
    parameters: LIST_PARAMETERS,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const { root, resolved } = await safeRepoPath(
          ctx.cwd,
          params.path ?? ".",
        );
        if (!(await fs.promises.stat(resolved)).isDirectory())
          throw new Error("目标不是目录");
        const files = await collectRepoFiles(root, resolved);
        return {
          content: [
            { type: "text", text: files.join("\n") || "没有可读取文件。" },
          ],
          details: {
            count: files.length,
            truncated: files.length >= MAX_LIST_FILES,
          },
        };
      } catch (error) {
        return errorResult("列出仓库文件", error);
      }
    },
  };

  const searchRepo = {
    name: "search_repo",
    label: "搜索仓库文本",
    description:
      "在当前 worktree 的安全相对路径内做不区分大小写的纯文本搜索；结果和读取总量均受限。",
    parameters: SEARCH_PARAMETERS,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const query = params.query.trim();
        if (!query) throw new Error("搜索文本不能为空");
        const { root, resolved } = await safeRepoPath(
          ctx.cwd,
          params.path ?? ".",
        );
        const metadata = await fs.promises.stat(resolved);
        const files = metadata.isFile()
          ? [path.relative(root, resolved).split(path.sep).join("/")]
          : await collectRepoFiles(root, resolved);
        const matches = [];
        let readBytes = 0;
        for (const relative of files) {
          const absolute = path.join(root, ...relative.split("/"));
          const stat = await fs.promises.stat(absolute);
          if (
            stat.size > MAX_SEARCH_FILE_BYTES ||
            readBytes + stat.size > MAX_SEARCH_TOTAL_BYTES
          )
            continue;
          const content = await fs.promises.readFile(absolute);
          readBytes += content.length;
          if (content.includes(0)) continue;
          const needle = query.toLocaleLowerCase();
          for (const [index, line] of content
            .toString("utf8")
            .split(/\r?\n/)
            .entries()) {
            if (!line.toLocaleLowerCase().includes(needle)) continue;
            matches.push(`${relative}:${index + 1}:${line.slice(0, 500)}`);
            if (matches.length >= MAX_SEARCH_RESULTS) break;
          }
          if (matches.length >= MAX_SEARCH_RESULTS) break;
        }
        return {
          content: [
            { type: "text", text: matches.join("\n") || "没有匹配结果。" },
          ],
          details: {
            count: matches.length,
            truncated: matches.length >= MAX_SEARCH_RESULTS,
            read_bytes: readBytes,
          },
        };
      } catch (error) {
        return errorResult("搜索仓库文本", error);
      }
    },
  };

  const readStagedDiff = {
    name: "read_staged_diff",
    label: "读取暂存差异",
    description:
      "分页读取本审核批次启动时固定的 git diff --cached 快照；offset 和 max_bytes 为 UTF-8 字节数。",
    parameters: PAGED_PARAMETERS,
    async execute(_id, params) {
      if (!fixedDiff)
        return errorResult(
          "读取 staged diff",
          new Error("审核批次没有固定 diff 快照"),
        );
      const requestedOffset = params.offset ?? 0;
      const maxBytes = Math.min(
        params.max_bytes ?? DEFAULT_PAGE_BYTES,
        MAX_PAGE_BYTES,
      );
      const { offset, end } = utf8Page(fixedDiff, requestedOffset, maxBytes);
      const nextOffset = end < fixedDiff.length ? end : null;
      const text = fixedDiff.subarray(offset, end).toString("utf8");
      diffRead = true;
      return {
        content: [
          {
            type: "text",
            text:
              text ||
              (fixedDiff.length === 0
                ? "暂存区没有差异。"
                : "当前分页范围没有内容。"),
          },
        ],
        details: {
          total_bytes: fixedDiff.length,
          requested_offset: requestedOffset,
          offset,
          returned_bytes: end - offset,
          next_offset: nextOffset,
          truncated: nextOffset !== null,
        },
      };
    },
  };

  const submitReviewResult = {
    name: "submit_review_result",
    label: "提交审核结论",
    description: "完成当前固定角度审核后提交唯一结构化结论。",
    parameters: SUBMIT_PARAMETERS,
    async execute(_id, params) {
      if (!diffRead)
        return errorResult(
          "提交审核结论",
          new Error("提交前必须先调用 read_staged_diff"),
        );
      if (submitted)
        return errorResult(
          "提交审核结论",
          new Error("当前角度已经提交过审核结论"),
        );
      if (!Array.isArray(params?.findings)) {
        return errorResult(
          "提交审核结论",
          new Error("$.findings: 必须为数组"),
        );
      }
      const findings = params.findings;
      if (
        contextMode === "blind" &&
        findings.some((finding) => finding.scenario_ref)
      ) {
        return errorResult(
          "提交审核结论",
          new Error("$.findings[].scenario_ref: 盲审角度不得引用行为场景"),
        );
      }
      const behaviorRefs = new Set(allowedBehaviorRefs);
      if (
        findings.some(
          (finding) =>
            finding.scenario_ref && !behaviorRefs.has(finding.scenario_ref),
        )
      ) {
        return errorResult(
          "提交审核结论",
          new Error("$.findings[].scenario_ref: 引用了不存在的行为场景"),
        );
      }
      const findingKeys = findings.map(
        (finding) =>
          `${finding.category}\0${finding.path}\0${finding.location}`,
      );
      if (new Set(findingKeys).size !== findingKeys.length) {
        return errorResult(
          "提交审核结论",
          new Error("$.findings: 包含重复 category/path/location"),
        );
      }
      const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
      if (findings.some((finding, index) => index > 0 && rank[findings[index - 1].priority] > rank[finding.priority])) {
        return errorResult("提交审核结论", new Error("$.findings: 必须按 P0 到 P3 排序"));
      }
      submitted = true;
      const details = {
        protocol,
        kind: "review_result",
        angle,
        ...params,
      };
      await onSubmit?.(details);
      return {
        content: [{ type: "text", text: "审核结论已提交。" }],
        details,
        terminate: true,
      };
    },
  };

  return [
    readRepoFile,
    listRepoFiles,
    searchRepo,
    readStagedDiff,
    submitReviewResult,
  ];
}

export default function (pi) {
  for (const tool of createReviewWorkerTools()) pi.registerTool(tool);
}
