import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ANGLES,
  constrainReviewSelection,
  PROTOCOL,
  convergeLateFindings,
  reviewPrompt,
  reviewSystemPrompt,
  runReviewAgent,
  runReviewBatch,
  selectReviewAngles,
} from "./raccoon-review-orchestrator.mjs";
import {
  createReviewWorkerTools,
  loadReviewDiffSnapshot,
  loadStagedDiffSnapshot,
} from "./raccoon-review-worker.mjs";

const context = {
  cwd: process.cwd(),
  model: { provider: "test", id: "review-model" },
  modelRegistry: {},
  sessionManager: {
    getBranch: () => [{ type: "thinking_level_change", thinkingLevel: "high" }],
  },
};

test("blind review prompt excludes requirement-only contract text", () => {
  const secret = "SECRET_REQUIREMENT_MARKER_91B7";
  const packet = {
    contract: `行为契约：\n- [behavior-1] ${secret}`,
    evidence: "neutral staged evidence",
    ledger: "[]",
  };
  const selection = selectReviewAngles("diff --git a/src/a.rs b/src/a.rs\n+x");

  assert.match(reviewPrompt(packet, selection, "contract"), new RegExp(secret));
  assert.doesNotMatch(
    reviewPrompt(packet, selection, "blind"),
    new RegExp(secret),
  );
  assert.doesNotMatch(
    reviewSystemPrompt("代码质量与测试", selection, "blind"),
    new RegExp(secret),
  );
});

test("parallel orchestrator never forwards requirement contract to blind angles", async () => {
  const secret = "SECRET_REQUIREMENT_MARKER_5CF2";
  const received = new Map();
  const reviews = await runReviewBatch({
    packet: {
      contract: `行为契约：\n- [behavior-1] ${secret}`,
      evidence: "neutral evidence",
      ledger: [],
    },
    ctx: context,
    stagedDiff: Buffer.from(
      "diff --git a/src/auth.rs b/src/auth.rs\n+unsafe {}",
    ),
    selection: {
      ...selectReviewAngles(
        "diff --git a/src/auth.rs b/src/auth.rs\n+unsafe {}",
      ),
      angles: [...ANGLES],
    },
    runReview: async ({ angle, packet }) => {
      received.set(angle, packet);
      return { angle, transport_status: "completed", result: { findings: [] } };
    },
  });

  assert.match(received.get("正确性").contract, new RegExp(secret));
  assert.equal(received.get("边界与安全").contract, "");
  assert.equal(received.get("代码质量与测试").contract, "");
  assert.doesNotMatch(JSON.stringify(reviews.slice(1)), new RegExp(secret));
});

test("late ordinary blockers become advisories while severe regressions remain blocking", () => {
  const common = {
    priority: "P1",
    path: "src/app.rs",
    location: "run",
    summary: "late issue",
    evidence: "repository evidence",
    remediation: "repair it",
  };
  const result = convergeLateFindings(
    {
      findings: [
        { ...common, category: "quality_debt" },
        { ...common, category: "regression", path: "src/regression.rs" },
      ],
    },
    JSON.stringify([
      {
        status: "resolved",
        category: "quality_debt",
        path: "src/old.rs",
        location: "old",
      },
    ]),
  );

  assert.deepEqual(
    result.findings.map((finding) => finding.priority),
    ["P2", "P1"],
  );
});

test("runReviewBatch starts all three angles concurrently and isolates failures", async () => {
  const started = [];
  const attempts = new Map();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const batch = runReviewBatch({
    packet: "packet",
    ctx: context,
    selection: {
      angles: [...ANGLES],
      classification: "high_risk",
      reasons: ["test"],
      focus: "test",
    },
    runReview: async ({ angle }) => {
      started.push(angle);
      attempts.set(angle, (attempts.get(angle) ?? 0) + 1);
      await gate;
      if (angle === "边界与安全") {
        return {
          angle,
          transport_status: "failed",
          error: "synthetic failure",
          events: [{ type: "agent_end" }],
          usage: {
            input: 7,
            output: 2,
            cacheRead: 1,
            cacheWrite: 0,
          },
          turns: 1,
          duration_ms: 2,
        };
      }
      return { angle, transport_status: "completed", result: { findings: [] }, usage: { input: 1 } };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ANGLES);
  release();
  const reviews = await batch;
  assert.deepEqual(
    reviews.map((review) => [review.angle, review.transport_status]),
    [
      ["正确性", "completed"],
      ["边界与安全", "failed"],
      ["代码质量与测试", "completed"],
    ],
  );
  assert.match(reviews[1].error, /synthetic failure/);
  assert.equal(
    started.filter((angle) => angle === "边界与安全").length,
    2,
    "only the failed angle should be retried once",
  );
  assert.equal(started.filter((angle) => angle === "正确性").length, 1);
  assert.equal(started.filter((angle) => angle === "代码质量与测试").length, 1);
  assert.equal(reviews[1].usage.input, 14);
  assert.equal(reviews[1].turns, 2);
  assert.equal(reviews[1].retry_count, 1);
});

test("runReviewBatch has no absolute batch timeout while agents are active", async () => {
  const startedAt = Date.now();
  const reviews = await runReviewBatch({
    packet: "packet",
    ctx: context,
    stagedDiff: Buffer.from(
      "diff --git a/src/app.rs b/src/app.rs\n+unsafe {}",
      "utf8",
    ),
    runReview: async ({ angle }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { angle, transport_status: "completed", result: { findings: [] } };
    },
  });

  assert.equal(reviews.length, 3);
  assert.equal(
    reviews.every((review) => review.transport_status === "completed"),
    true,
  );
  assert.ok(Date.now() - startedAt >= 15);
});

test("runReviewAgent constructs an isolated in-memory SDK session", async () => {
  const loaders = [];
  const sessionManagers = [];
  let receivedOptions;
  let disposed = false;
  class FakeLoader {
    constructor(options) {
      this.options = options;
      loaders.push(this);
    }

    async reload() {}
  }
  const fakeSdk = {
    DefaultResourceLoader: FakeLoader,
    getAgentDir: () => "/managed/pi",
    SettingsManager: {
      inMemory: (settings) => ({ settings }),
    },
    SessionManager: {
      inMemory: (cwd) => {
        const manager = { cwd, inMemory: true };
        sessionManagers.push(manager);
        return manager;
      },
    },
    createAgentSession: async (options) => {
      receivedOptions = options;
      const listeners = new Set();
      return {
        session: {
          sessionFile: undefined,
          isStreaming: false,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async prompt() {
            const readDiff = options.customTools.find(
              (tool) => tool.name === "read_staged_diff",
            );
            await readDiff.execute("read", {}, undefined, undefined, {
              cwd: options.cwd,
            });
            const submit = options.customTools.find(
              (tool) => tool.name === "submit_review_result",
            );
            await submit.execute(
              "submit",
              { findings: [] },
              undefined,
              undefined,
              { cwd: options.cwd },
            );
            for (const listener of listeners) listener({ type: "turn_end" });
          },
          async steer() {},
          async abort() {},
          getSessionStats() {
            return {
              tokens: {
                input: 11,
                output: 2,
                cacheRead: 3,
                cacheWrite: 4,
              },
              contextUsage: {
                tokens: 10,
                contextWindow: 100,
                percent: 10,
              },
            };
          },
          dispose() {
            disposed = true;
          },
        },
      };
    },
  };

  const stagedDiff = Buffer.from("diff", "utf8");
  const review = await runReviewAgent({
    angle: ANGLES[0],
    packet: {
      contract: "[behavior-1] works",
      evidence: "neutral",
      ledger: "[]",
    },
    ctx: context,
    stagedDiff,
    selection: selectReviewAngles(stagedDiff),
    sdk: fakeSdk,
  });

  assert.equal(review.transport_status, "completed");
  assert.equal(review.result.protocol, PROTOCOL);
  assert.equal(review.session_persisted, false);
  assert.equal(review.usage.input, 11);
  assert.equal(loaders.length, 1);
  assert.equal(loaders[0].options.noExtensions, true);
  assert.equal(loaders[0].options.noContextFiles, true);
  assert.deepEqual(receivedOptions.tools, [
    "read_repo_file",
    "list_repo_files",
    "search_repo",
    "read_staged_diff",
    "submit_review_result",
  ]);
  assert.equal(receivedOptions.thinkingLevel, "high");
  assert.equal(sessionManagers[0].inMemory, true);
  assert.equal(disposed, true);
});

test("runReviewAgent corrects a missing structured result in the same isolated session", async () => {
  const secret = "SECRET_REQUIREMENT_MARKER_CORRECTION_4D2A";
  const prompts = [];
  let createdSessions = 0;
  let disposed = false;
  class FakeLoader {
    async reload() {}
  }
  const fakeSdk = {
    DefaultResourceLoader: FakeLoader,
    getAgentDir: () => "/managed/pi",
    SettingsManager: { inMemory: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (options) => {
      createdSessions += 1;
      const listeners = new Set();
      return {
        session: {
          sessionFile: undefined,
          isStreaming: false,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async prompt(prompt) {
            prompts.push(prompt);
            if (prompts.length === 1) {
              const readDiff = options.customTools.find(
                (tool) => tool.name === "read_staged_diff",
              );
              await readDiff.execute("read", {});
              const submit = options.customTools.find(
                (tool) => tool.name === "submit_review_result",
              );
              const invalid = await submit.execute("submit", { invalid: [] });
              assert.equal(invalid.isError, true);
            } else {
              const submit = options.customTools.find(
                (tool) => tool.name === "submit_review_result",
              );
              await submit.execute("submit", { findings: [] });
            }
            for (const listener of listeners) listener({ type: "turn_end" });
          },
          async steer() {},
          async abort() {},
          getSessionStats: () => ({ tokens: {} }),
          dispose() {
            disposed = true;
          },
        },
      };
    },
  };

  const stagedDiff = Buffer.from(
    "diff --git a/src/app.rs b/src/app.rs\n+fn app() {}",
    "utf8",
  );
  const review = await runReviewAgent({
    angle: "代码质量与测试",
    packet: {
      contract: `行为契约：${secret}`,
      evidence: "neutral evidence",
      ledger: "[]",
    },
    ctx: context,
    stagedDiff,
    selection: selectReviewAngles(stagedDiff),
    sdk: fakeSdk,
  });

  assert.equal(review.transport_status, "completed");
  assert.equal(createdSessions, 1);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /重新调用 submit_review_result/);
  assert.doesNotMatch(prompts[1], new RegExp(secret));
  assert.equal(review.submission_correction_count, 1);
  assert.equal(disposed, true);
});

test("runReviewAgent aborts its in-memory session on per-agent timeout", async () => {
  let aborted = 0;
  let disposed = false;
  class FakeLoader {
    async reload() {}
  }
  const fakeSession = {
    sessionFile: undefined,
    isStreaming: true,
    subscribe: () => () => {},
    prompt: () => new Promise(() => {}),
    steer: async () => {},
    abort: async () => {
      aborted += 1;
    },
    getSessionStats: () => ({ tokens: {} }),
    dispose: () => {
      disposed = true;
    },
  };
  const fakeSdk = {
    DefaultResourceLoader: FakeLoader,
    getAgentDir: () => "/managed/pi",
    SettingsManager: { inMemory: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({ session: fakeSession }),
  };

  const review = await runReviewAgent({
    angle: ANGLES[0],
    packet: "dynamic packet",
    ctx: context,
    sdk: fakeSdk,
    selection: selectReviewAngles(Buffer.alloc(0)),
    warningAfterMs: 2,
    idleTimeoutMs: 5,
  });

  assert.equal(review.transport_status, "failed");
  assert.match(review.error, /审核空闲超时/);
  assert.ok(aborted >= 1);
  assert.equal(disposed, true);
});

test("subagent system prompt cannot recursively orchestrate reviews", () => {
  for (const angle of ANGLES) {
    const prompt = reviewSystemPrompt(
      angle,
      selectReviewAngles(Buffer.alloc(0)),
    );
    assert.match(prompt, new RegExp(angle));
    assert.doesNotMatch(prompt, /run_parallel_code_review/);
    assert.match(prompt, /不得修改文件/);
  }
});

test("risk selection adapts review angles to the staged diff", () => {
  const none = selectReviewAngles(Buffer.alloc(0));
  assert.deepEqual(none.angles, ["正确性"]);

  const docs = selectReviewAngles(
    Buffer.from("diff --git a/docs/a.md b/docs/a.md\n-old\n+new\n"),
  );
  assert.equal(docs.classification, "documentation");
  assert.deepEqual(docs.angles, ["正确性"]);

  const textData = selectReviewAngles(
    Buffer.from("diff --git a/src/data.txt b/src/data.txt\n-old\n+new\n"),
  );
  assert.equal(textData.classification, "source");
  assert.deepEqual(textData.angles, ["正确性", "代码质量与测试"]);

  const tests = selectReviewAngles(
    Buffer.from("diff --git a/src/app.test.ts b/src/app.test.ts\n-old\n+new\n"),
  );
  assert.equal(tests.classification, "tests");
  assert.deepEqual(tests.angles, ["正确性", "代码质量与测试"]);

  const source = selectReviewAngles(
    Buffer.from("diff --git a/src/view.tsx b/src/view.tsx\n-old\n+new\n"),
  );
  assert.equal(source.classification, "source");
  assert.deepEqual(source.angles, ["正确性", "代码质量与测试"]);

  const risky = selectReviewAngles(
    Buffer.from(
      "diff --git a/src/api/auth.rs b/src/api/auth.rs\n-old\n+unsafe {}\n",
    ),
  );
  assert.equal(risky.classification, "high_risk");
  assert.deepEqual(risky.angles, ANGLES);
});

test("WorkflowRun incremental selection is authoritative over full diff risk", () => {
  const selected = constrainReviewSelection(
    selectReviewAngles(
      "diff --git a/src/auth.rs b/src/auth.rs\n+Command::new(\"git\")\n",
    ),
    ["代码质量与测试"],
  );
  assert.deepEqual(selected.angles, ["代码质量与测试"]);
  assert.deepEqual(selected.skippedAngles, ["正确性", "边界与安全"]);
});

test("read_staged_diff paginates without splitting UTF-8 content", async () => {
  const stagedDiff = Buffer.from(
    "diff --git a/review.txt b/review.txt\n+中文边界\n",
    "utf8",
  );
  const readDiff = createReviewWorkerTools({
    angle: ANGLES[0],
    stagedDiff,
  }).find((tool) => tool.name === "read_staged_diff");
  let offset = 0;
  let combined = "";
  let pages = 0;
  do {
    const page = await readDiff.execute(`page-${pages}`, {
      offset,
      max_bytes: 7,
    });
    assert.equal(page.isError, undefined);
    combined += page.content[0].text;
    offset = page.details.next_offset;
    pages += 1;
  } while (offset !== null);

  assert.match(combined, /中文边界/);
  assert.doesNotMatch(combined, /�/);
  assert.ok(pages > 1);
});

test("managed repo tools reject absolute paths and symlink escapes", async () => {
  const parent = mkdtempSync(join(tmpdir(), "raccoon-review-safe-"));
  const cwd = join(parent, "repo");
  const outside = join(parent, "outside.txt");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
    writeFileSync(outside, "secret", "utf8");
    symlinkSync(outside, join(cwd, "escape.txt"));
    const read = createReviewWorkerTools({ stagedDiff: Buffer.alloc(0) }).find(
      (tool) => tool.name === "read_repo_file",
    );
    const absolute = await read.execute(
      "absolute",
      { path: outside },
      undefined,
      undefined,
      { cwd },
    );
    const escaped = await read.execute(
      "escape",
      { path: "escape.txt" },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(absolute.isError, true);
    assert.equal(escaped.isError, true);
    assert.match(absolute.content[0].text, /仓库相对路径/);
    assert.match(escaped.content[0].text, /符号链接/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("staged diff snapshot ignores inherited Git repository selectors", async () => {
  const parent = mkdtempSync(join(tmpdir(), "raccoon-review-git-env-"));
  const cwd = join(parent, "repo");
  const git = execFileSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["git"],
    {
      encoding: "utf8",
    },
  )
    .split(/\r?\n/)
    .find(Boolean);
  const previous = {
    executable: process.env.RACCOON_GIT_EXECUTABLE,
    directory: process.env.GIT_DIR,
    index: process.env.GIT_INDEX_FILE,
    worktree: process.env.GIT_WORK_TREE,
  };
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
    execFileSync(git, ["init", "--quiet"], { cwd });
    writeFileSync(join(cwd, "review.txt"), "fixed snapshot\n", "utf8");
    execFileSync(git, ["add", "review.txt"], { cwd });
    process.env.RACCOON_GIT_EXECUTABLE = git;
    process.env.GIT_DIR = join(parent, "hostile-git-dir");
    process.env.GIT_INDEX_FILE = join(parent, "hostile-index");
    process.env.GIT_WORK_TREE = parent;

    const snapshot = await loadStagedDiffSnapshot(cwd);
    assert.match(snapshot.toString("utf8"), /fixed snapshot/);
  } finally {
    for (const [key, value] of [
      ["RACCOON_GIT_EXECUTABLE", previous.executable],
      ["GIT_DIR", previous.directory],
      ["GIT_INDEX_FILE", previous.index],
      ["GIT_WORK_TREE", previous.worktree],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("integration review snapshot reads the managed base-to-worktree range", async () => {
  const root = mkdtempSync(join(tmpdir(), "raccoon-review-range-"));
  const git = execFileSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["git"],
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .find(Boolean);
  const previousExecutable = process.env.RACCOON_GIT_EXECUTABLE;
  try {
    process.env.RACCOON_GIT_EXECUTABLE = git;
    execFileSync(git, ["init"], { cwd: root });
    execFileSync(git, ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    execFileSync(git, ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "app.txt"), "base\n");
    execFileSync(git, ["add", "app.txt"], { cwd: root });
    execFileSync(git, ["commit", "-m", "base"], { cwd: root });
    const base = execFileSync(git, ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(root, "app.txt"), "integrated\n");
    execFileSync(git, ["add", "app.txt"], { cwd: root });

    const snapshot = await loadReviewDiffSnapshot(root, undefined, base);

    assert.match(snapshot.toString("utf8"), /\+integrated/);
  } finally {
    if (previousExecutable === undefined) {
      delete process.env.RACCOON_GIT_EXECUTABLE;
    } else {
      process.env.RACCOON_GIT_EXECUTABLE = previousExecutable;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("submit_review_result rejects verdicts before staged diff is read", async () => {
  const submit = createReviewWorkerTools({ angle: ANGLES[0] }).find(
    (tool) => tool.name === "submit_review_result",
  );
  const result = await submit.execute("submit", {
    findings: [],
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /read_staged_diff/);
});

test("submit_review_result accepts ordered v5 priority findings without approval", async () => {
  const tools = createReviewWorkerTools({
    angle: ANGLES[0],
    stagedDiff: Buffer.alloc(0),
  });
  const read = tools.find((tool) => tool.name === "read_staged_diff");
  const submit = tools.find((tool) => tool.name === "submit_review_result");
  await read.execute("read", {});
  const rejected = await submit.execute("submit", {
    findings: [
      {
        priority: "P1",
        category: "regression",
        path: "src/app.rs",
        location: "run",
        summary: "run always fails",
        evidence: "staged diff returns an error unconditionally",
        remediation: "restore the success branch",
      },
    ],
  });
  assert.equal(rejected.isError, undefined);
  assert.equal(rejected.details.approved, undefined);
  assert.equal(rejected.details.findings[0].priority, "P1");
});

test("submit_review_result rejects unknown behavior scenario references", async () => {
  const tools = createReviewWorkerTools({
    angle: ANGLES[0],
    contextMode: "contract",
    allowedBehaviorRefs: ["behavior-1"],
    stagedDiff: Buffer.alloc(0),
  });
  await tools
    .find((tool) => tool.name === "read_staged_diff")
    .execute("read", {});
  const result = await tools
    .find((tool) => tool.name === "submit_review_result")
    .execute("submit", {
      findings: [
        {
          priority: "P1",
          category: "regression",
          path: "src/app.rs",
          location: "run",
          summary: "behavior fails",
          evidence: "the success branch is unreachable",
          scenario_ref: "invented-scenario",
        },
      ],
    });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /不存在的行为场景/);
});
