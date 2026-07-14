import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import taskRuntime, {
  GIT_WRITE_BLOCK_REASON,
  TASK_RUNTIME_PROTOCOL,
  WORKSPACE_BLOCK_REASON,
  WORKFLOW_OUTPUT_PROTOCOL,
  classifyGitArguments,
  containsBlockedGitWrite,
  containsBlockedToolPath,
  containsBlockedWorkspacePath,
  createWorkflowTool,
  validateWorkflowPayload,
  workflowKindFromEnvironment,
} from "./raccoon-task-runtime.mjs";

function fakePi() {
  const commands = [];
  const tools = [];
  const handlers = new Map();
  return {
    commands,
    tools,
    handlers,
    registerCommand(name, command) {
      commands.push({ name, command });
    },
    registerTool(tool) {
      tools.push(tool);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function loadForRole(role) {
  const previous = process.env.RACCOON_WORKFLOW_ROLE;
  if (role === undefined) delete process.env.RACCOON_WORKFLOW_ROLE;
  else process.env.RACCOON_WORKFLOW_ROLE = role;
  try {
    const pi = fakePi();
    taskRuntime(pi);
    return pi;
  } finally {
    if (previous === undefined) delete process.env.RACCOON_WORKFLOW_ROLE;
    else process.env.RACCOON_WORKFLOW_ROLE = previous;
  }
}

test("classifies ordinary read-only and write Git subcommands", () => {
  for (const command of [
    "git status --short",
    "git diff --cached",
    "git log -5 --oneline",
    "git show HEAD:file",
    "git rev-parse --show-toplevel",
    "git ls-files",
    "git ls-tree HEAD",
    "git cat-file -p HEAD",
    "git describe --always",
    "git fsck --connectivity-only",
    "git hash-object README.md",
    "git symbolic-ref HEAD",
    "git commit-graph verify",
    "git diff --output-indicator-new=+",
  ]) {
    assert.equal(containsBlockedGitWrite(command), false, command);
  }

  for (const command of [
    "git add src/lib.rs",
    "git reset --hard",
    "git restore .",
    "git checkout main",
    "git switch feature",
    "git clean -fd",
    "git mv old new",
    "git rm file",
    "git commit -m change",
    "git merge topic",
    "git rebase main",
    "git cherry-pick HEAD~1",
    "git revert HEAD",
    "git stash",
    "git fetch origin",
    "git pull",
    "git push",
    "git clone https://example.invalid/repo.git",
    "git init",
    "git update-ref refs/heads/main HEAD",
    "git update-index --add file",
    "git write-tree",
    "git gc",
    "git maintenance run",
    "git fsck --lost-found",
    "git hash-object -w README.md",
    "git symbolic-ref HEAD refs/heads/main",
    "git commit-graph write",
    "git diff --output patch.diff",
    "git log --output=history.txt -1",
    "git show --output result.patch HEAD",
    "git diff-tree --output=tree.patch HEAD",
    "git whatchanged --output=history.patch",
    "git reflog show --output=reflog.txt HEAD",
    "git hash-object -wt blob README.md",
  ]) {
    assert.equal(containsBlockedGitWrite(command), true, command);
  }
});

test("recognizes Git executable paths and supported command wrappers", () => {
  const writes = [
    "git.exe commit -m change",
    '"/usr/local/bin/git" add file',
    '"C:\\Program Files\\Git\\cmd\\git.exe" push origin main',
    "C:\\Git\\cmd\\git.exe commit -m change",
    "command git reset --hard",
    "env -i HOME=/tmp /usr/bin/git commit -m change",
    "env -u GIT_DIR git commit -m change",
    "FOO=bar git add file",
    "bash -c 'git commit -m nested'",
    "bash -c -- 'git commit -m nested'",
    'sh -lc "git checkout main"',
    "eval 'git push origin main'",
    'cmd.exe /c "git reset --hard"',
    'powershell.exe -Command "git push origin main"',
  ];
  for (const command of writes)
    assert.equal(containsBlockedGitWrite(command), true, command);

  const reads = [
    "git.exe status",
    '"/usr/local/bin/git" diff',
    '"C:\\Program Files\\Git\\cmd\\git.exe" log -1',
    "C:\\Git\\cmd\\git.exe status",
    "command git status",
    "env -i HOME=/tmp /usr/bin/git show HEAD",
    "bash -c 'git diff --cached'",
    "bash -c -- 'git diff --cached'",
    'cmd.exe /c "git status"',
    'pwsh -c "git log -1"',
  ];
  for (const command of reads)
    assert.equal(containsBlockedGitWrite(command), false, command);
});

test("checks compound commands, control clauses, and command substitutions", () => {
  const writes = [
    "npm test && git commit -m done",
    "git status; git add file",
    "git diff || git reset --hard",
    "git log | git apply patch.diff",
    "git status\ngit push",
    "if git commit -m done; then echo ok; fi",
    "{ git add file; git status; }",
    "echo $(git add file)",
    "echo `git push origin main`",
    'printf "%s" "$(git checkout main)"',
  ];
  for (const command of writes)
    assert.equal(containsBlockedGitWrite(command), true, command);

  for (const command of [
    "git status && git diff",
    "git \\\n status",
    "echo 'git commit -m example'",
    'printf "%s" "git push is forbidden text"',
    "echo note # git commit -m commented; git push commented",
    "# git commit -m ignored\ngit status",
    "cat <<'EOF'\ngit commit -m example\nEOF\ngit status",
    "cat <<-EOF\n\tgit push origin main\n\tEOF\ngit diff",
  ]) {
    assert.equal(containsBlockedGitWrite(command), false, command);
  }
});

test("splits read/write forms of conditional Git subcommands", () => {
  const reads = [
    "git branch",
    "git branch --list 'feature/*'",
    "git branch --show-current",
    "git tag",
    "git tag --list 'v*'",
    "git remote -v",
    "git remote get-url origin",
    "git config --get user.name",
    "git config --show-origin --list",
    "git worktree list",
    "git submodule status --recursive",
    "git submodule summary",
    "git reflog show HEAD",
    "git apply --check patch.diff",
    "git apply --stat patch.diff",
  ];
  for (const command of reads)
    assert.equal(containsBlockedGitWrite(command), false, command);

  const writes = [
    "git branch feature",
    "git branch -D feature",
    "git branch -Dfeature",
    "git branch --set-upstream-to=origin/main",
    "git tag v1.0.0",
    "git tag -d v1.0.0",
    "git tag -dv1.0.0",
    "git remote add origin https://example.invalid/repo.git",
    "git remote set-url origin https://example.invalid/repo.git",
    "git config user.name Raccoon",
    "git config --global --unset user.name",
    "git config --get --unset user.name",
    "git worktree add ../topic topic",
    "git submodule update --init",
    "git reflog expire --all",
    "git apply patch.diff",
  ];
  for (const command of writes)
    assert.equal(containsBlockedGitWrite(command), true, command);
});

test("blocks unknown aliases and external Git subcommands", () => {
  assert.deepEqual(classifyGitArguments(["status"]), {
    blocked: false,
    subcommand: "status",
  });
  assert.equal(containsBlockedGitWrite("git publish"), true);
  assert.equal(
    containsBlockedGitWrite("git -c alias.ship='!echo ship' ship"),
    true,
  );
  assert.equal(containsBlockedGitWrite("git custom-helper --dry-run"), true);
});

test("extension blocks only matching bash calls with the managed reason", () => {
  const pi = loadForRole("chat");
  assert.equal(pi.commands.length, 1);
  assert.equal(pi.commands[0].name, "raccoon-task-runtime");
  assert.equal(pi.tools.length, 0);
  const handler = pi.handlers.get("tool_call");
  assert.equal(
    handler({ toolName: "read", input: { path: "file" } }),
    undefined,
  );
  assert.equal(
    handler({ toolName: "bash", input: { command: "git status" } }),
    undefined,
  );
  assert.deepEqual(
    handler({ toolName: "bash", input: { command: "git commit -m done" } }),
    {
      block: true,
      reason: GIT_WRITE_BLOCK_REASON,
    },
  );
});

test("blocks path tools outside the assigned workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "raccoon-workspace-"));
  const outside = mkdtempSync(join(tmpdir(), "raccoon-outside-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.rs"), "fn main() {}\n");
  try {
    assert.equal(
      containsBlockedToolPath("read", { path: "src/main.rs" }, root),
      false,
    );
    assert.equal(
      containsBlockedToolPath("write", { path: "src/new.rs" }, root),
      false,
    );
    assert.equal(
      containsBlockedToolPath("edit", { path: "../outside.rs" }, root),
      true,
    );
    assert.equal(
      containsBlockedToolPath("write", { path: join(outside, "new.rs") }, root),
      true,
    );
    if (process.platform !== "win32") {
      symlinkSync(outside, join(root, "linked"));
      assert.equal(
        containsBlockedToolPath("read", { path: "linked/file.rs" }, root),
        true,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("blocks shell navigation and writes outside the assigned workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "raccoon-shell-workspace-"));
  mkdirSync(join(root, "src"));
  try {
    for (const command of [
      "cd ..",
      "pushd ../integration",
      "cp src/main.rs ../../integration/main.rs",
      "mv src/main.rs ../other/main.rs",
      "rm ../other/file.rs",
      "echo changed > ../integration/file.rs",
      "echo changed | sh -c 'cat > ../../integration/file.rs'",
      "echo $(cd ../../integration && pwd)",
      "cmd.exe /c cd ..\\integration",
      "powershell -Command Set-Location ..\\integration",
      "pwsh -Command Set-Content ../integration/file.txt changed",
      "powershell -Command Copy-Item src/main.rs ../integration/main.rs",
    ]) {
      assert.equal(containsBlockedWorkspacePath(command, root), true, command);
    }
    for (const command of [
      "cd src && pwd",
      "cp src/main.rs src/copy.rs",
      "echo changed > src/main.rs",
      "npm test && git status --short",
      "cat /dev/null > /dev/null",
    ]) {
      assert.equal(containsBlockedWorkspacePath(command, root), false, command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks direct references to sibling managed worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "raccoon-managed-shell-"));
  const item = join(
    root,
    ".raccoon-node",
    "worktrees",
    "run-1",
    "items",
    "item-001",
  );
  const sibling = join(root, ".raccoon-node", "worktrees", "run-1", "integration");
  mkdirSync(item, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  try {
    assert.equal(
      containsBlockedWorkspacePath(`cat ${join(item, "README.md")}`, item),
      false,
    );
    assert.equal(
      containsBlockedWorkspacePath(`cat ${join(sibling, "README.md")}`, item),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension returns the managed workspace reason for boundary violations", () => {
  const pi = loadForRole("work_item");
  const handler = pi.handlers.get("tool_call");
  assert.deepEqual(
    handler({ toolName: "write", input: { path: "../outside.txt" } }),
    { block: true, reason: WORKSPACE_BLOCK_REASON },
  );
  assert.deepEqual(
    handler({ toolName: "bash", input: { command: "cd .." } }),
    { block: true, reason: WORKSPACE_BLOCK_REASON },
  );
});

test("guard-only and unknown roles do not expose workflow submit tools", () => {
  assert.equal(workflowKindFromEnvironment("chat"), null);
  assert.equal(workflowKindFromEnvironment("requirement_analysis"), null);
  assert.equal(workflowKindFromEnvironment("not-a-role"), undefined);
  assert.equal(loadForRole("requirement_analysis").tools.length, 0);
  assert.equal(loadForRole("not-a-role").tools.length, 0);
  assert.equal(loadForRole(undefined).tools.length, 0);
});

test("registers exactly one role-specific structured submission tool", async () => {
  const cases = [
    ["plan", "work_plan", "submit_work_plan"],
    ["work_plan", "work_plan", "submit_work_plan"],
    ["work_item", "work_item", "submit_workflow_result"],
    ["rescue", "rescue", "submit_workflow_result"],
  ];
  for (const [role, kind, toolName] of cases) {
    const pi = loadForRole(role);
    assert.equal(pi.tools.length, 1, role);
    assert.equal(pi.tools[0].name, toolName, role);
    assert.equal(workflowKindFromEnvironment(role), kind);
  }

  const tool = createWorkflowTool("work_item");
  const payload = {
    outcome: "completed",
    changed: true,
    no_op_reason: null,
    result_summary: "实现并验证任务",
  };
  const result = await tool.execute("call", payload);
  assert.deepEqual(result.details, {
    protocol: WORKFLOW_OUTPUT_PROTOCOL,
    kind: "work_item",
    payload,
  });
  assert.equal(result.terminate, true);
});

test("workflow payload validation rejects semantically empty submissions", () => {
  assert.throws(
    () =>
      validateWorkflowPayload("work_plan", {
        summary: " ",
        tasks: [],
      }),
    new RegExp(WORKFLOW_OUTPUT_PROTOCOL),
  );
  assert.throws(
    () =>
      validateWorkflowPayload("work_item", {
        outcome: "completed",
        changed: false,
        no_op_reason: " ",
        result_summary: "done",
      }),
    /未修改原因不能为空/,
  );
  assert.throws(
    () => createWorkflowTool("unknown"),
    new RegExp(TASK_RUNTIME_PROTOCOL),
  );
});

test("work plan evidence must resolve to a real repository file", async () => {
  const root = mkdtempSync(join(tmpdir(), "raccoon-plan-evidence-"));
  writeFileSync(join(root, "Cargo.toml"), "[package]\nname='demo'\n");
  const payload = {
    summary: "plan",
    design_notes: [{
      id: "design-1",
      statement: "use existing dependency",
      evidence: ["Cargo.toml"],
      rationale: "the dependency is already installed",
    }],
    work_items: [{
        id: "task-1",
        objective: "deliver observable behavior",
        scenario_refs: ["scenario-1"],
        depends_on: [],
        group: null,
        scope_hints: ["src"],
        verification_goals: ["the behavior is observable"],
      }],
  };
  try {
    const tool = createWorkflowTool("work_plan");
    const result = await tool.execute("call", payload, undefined, undefined, {
      cwd: root,
    });
    assert.equal(result.terminate, true);
    payload.work_items[0].verification_goals = ["run npm test"];
    assert.throws(
      () => validateWorkflowPayload("work_plan", payload),
      /verification_goals 不能包含命令/,
    );
    payload.work_items[0].verification_goals = ["the behavior is observable"];
    payload.design_notes[0].evidence = ["missing.toml"];
    await assert.rejects(
      tool.execute("call", payload, undefined, undefined, { cwd: root }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
