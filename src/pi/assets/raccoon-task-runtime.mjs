import * as fs from "node:fs";
import * as path from "node:path";

export const TASK_RUNTIME_PROTOCOL = "raccoon:task-runtime";
export const WORKFLOW_OUTPUT_PROTOCOL = "raccoon:workflow-output";
export const GIT_WRITE_BLOCK_REASON =
  "Raccoon 禁止任务 Agent 执行 Git 写操作；暂存、提交、分支和发布由外部调度器负责。请继续修改或验证代码，不要重试该 Git 操作。";
export const WORKSPACE_BLOCK_REASON =
  "Raccoon 只允许任务 Agent 访问当前分配工作区；其他任务、integration、项目根目录和 .raccoon-node 受管资源不可访问。请继续在当前工作区内修改或验证代码，不要重试该越界操作。";

const PATH_TOOL_FIELDS = new Map([
  ["read", ["path", "file_path"]],
  ["edit", ["path", "file_path"]],
  ["write", ["path", "file_path"]],
  ["grep", ["path", "directory", "root"]],
  ["find", ["path", "directory", "root"]],
  ["ls", ["path", "directory"]],
]);

const WORKSPACE_SENSITIVE_COMMANDS = new Set([
  "add-content",
  "cd",
  "chdir",
  "clear-content",
  "cp",
  "copy",
  "copy-item",
  "del",
  "erase",
  "install",
  "ln",
  "mkdir",
  "move",
  "move-item",
  "mv",
  "new-item",
  "out-file",
  "popd",
  "pushd",
  "rd",
  "remove-item",
  "ren",
  "rename-item",
  "rmdir",
  "rm",
  "set-location",
  "set-content",
  "tee",
  "touch",
  "truncate",
]);

const ALWAYS_READ_ONLY = new Set([
  "annotate",
  "blame",
  "cat-file",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "grep",
  "help",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
  "verify-commit",
  "verify-tag",
  "version",
  "whatchanged",
]);

const ALWAYS_WRITE = new Set([
  "add",
  "am",
  "bisect",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "fast-import",
  "fetch",
  "filter-branch",
  "gc",
  "index-pack",
  "init",
  "maintenance",
  "merge",
  "merge-file",
  "merge-index",
  "mktag",
  "mktree",
  "mv",
  "pack-objects",
  "prune",
  "pull",
  "push",
  "read-tree",
  "rebase",
  "repack",
  "replace",
  "reset",
  "restore",
  "revert",
  "rm",
  "send-pack",
  "sparse-checkout",
  "stash",
  "switch",
  "unpack-objects",
  "update-index",
  "update-ref",
  "update-server-info",
  "write-tree",
]);

const READ_ONLY_WITH_FILE_OUTPUT = new Set([
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "log",
  "show",
  "whatchanged",
]);

const CONTROL_PREFIXES = new Set([
  "!",
  "{",
  "}",
  "do",
  "elif",
  "else",
  "if",
  "then",
  "time",
  "until",
  "while",
]);

const SHELL_EXECUTABLES = new Set(["ash", "bash", "dash", "ksh", "sh", "zsh"]);
const WINDOWS_SHELL_EXECUTABLES = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

const ROLE_ALIASES = new Map([
  ["chat", null],
  ["requirement_analysis", null],
  ["plan", "work_plan"],
  ["work_plan", "work_plan"],
  ["work_item", "work_item"],
  ["rescue", "rescue"],
]);

const STRING = { type: "string", minLength: 1 };
const STRING_ARRAY = { type: "array", items: { type: "string" } };
const DESIGN_NOTES = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: STRING,
      statement: STRING,
      evidence: STRING_ARRAY,
      rationale: STRING,
    },
    required: ["id", "statement", "evidence", "rationale"],
    additionalProperties: false,
  },
};

const WORK_PLAN_PARAMETERS = {
  type: "object",
  properties: {
    summary: STRING,
    design_notes: DESIGN_NOTES,
    work_items: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          id: STRING,
          objective: STRING,
          scenario_refs: { ...STRING_ARRAY, minItems: 1 },
          depends_on: STRING_ARRAY,
          group: { anyOf: [{ type: "string" }, { type: "null" }] },
          scope_hints: STRING_ARRAY,
          verification_goals: STRING_ARRAY,
        },
        required: [
          "id",
          "objective",
          "scenario_refs",
          "depends_on",
          "group",
          "scope_hints",
          "verification_goals",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "design_notes", "work_items"],
  additionalProperties: false,
};

const IMPLEMENTATION_PARAMETERS = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["completed", "blocked"] },
    changed: { type: "boolean" },
    no_op_reason: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    result_summary: STRING,
  },
  required: ["outcome", "changed", "no_op_reason", "result_summary"],
  additionalProperties: false,
};

const WORKFLOW_ROLES = {
  work_plan: {
    toolName: "submit_work_plan",
    label: "提交工作计划",
    description: "提交只包含真实工作项的结构化工作计划并结束本轮。",
    parameters: WORK_PLAN_PARAMETERS,
  },
  work_item: {
    toolName: "submit_workflow_result",
    label: "提交工作项结果",
    description: "提交当前真实工作项的结构化结果并结束本轮。",
    parameters: IMPLEMENTATION_PARAMETERS,
  },
  rescue: {
    toolName: "submit_workflow_result",
    label: "提交 Rescue 结果",
    description: "提交本 WorkflowRun 唯一一次高级 Rescue 的结构化结果并结束本轮。",
    parameters: IMPLEMENTATION_PARAMETERS,
  },
};

function executableBasename(value) {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function isGitExecutable(value) {
  const basename = executableBasename(value);
  return basename === "git" || basename === "git.exe";
}

function isAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function findClosingSubstitution(command, from) {
  let depth = 1;
  let quote = null;
  for (let index = from; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function heredocDelimiters(line) {
  const delimiters = [];
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (quote === '"' && character === "\\") index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (
      character !== "<" ||
      line[index + 1] !== "<" ||
      line[index + 2] === "<"
    ) {
      continue;
    }

    index += 2;
    let stripTabs = false;
    if (line[index] === "-") {
      stripTabs = true;
      index += 1;
    }
    while (/\s/.test(line[index] ?? "")) index += 1;
    let delimiter = "";
    const delimiterQuote = ["'", '"'].includes(line[index])
      ? line[index]
      : null;
    if (delimiterQuote) index += 1;
    while (index < line.length) {
      const value = line[index];
      if (delimiterQuote ? value === delimiterQuote : /[\s;&|()<>]/.test(value))
        break;
      if (value === "\\" && line[index + 1] !== undefined) {
        delimiter += line[index + 1];
        index += 2;
      } else {
        delimiter += value;
        index += 1;
      }
    }
    if (delimiter) delimiters.push({ delimiter, stripTabs });
  }
  return delimiters;
}

function stripHeredocBodies(command) {
  const output = [];
  const pending = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      const current = pending[0];
      const candidate = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === current.delimiter) pending.shift();
      continue;
    }
    output.push(line);
    pending.push(...heredocDelimiters(line));
  }
  return output.join("\n");
}

function tokenizeShell(command) {
  const segments = [];
  const nested = [];
  let words = [];
  let word = "";
  let quote = null;

  const finishWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const finishSegment = () => {
    finishWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else word += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        const next = command[index + 1];
        if (next && '$`"\\\n'.includes(next)) {
          if (next !== "\n") word += next;
          index += 1;
        } else {
          word += character;
        }
      } else if (character === "$" && command[index + 1] === "(") {
        const end = findClosingSubstitution(command, index + 2);
        if (end < 0) {
          word += command.slice(index);
          break;
        }
        nested.push(command.slice(index + 2, end));
        word += "__raccoon_substitution__";
        index = end;
      } else {
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "\\") {
      if (command[index + 1] !== undefined) {
        if (command[index + 1] === "\n") {
          index += 1;
        } else if (/^[A-Za-z]:/.test(word)) {
          word += character;
        } else {
          word += command[index + 1];
          index += 1;
        }
      }
    } else if (character === "$" && command[index + 1] === "(") {
      const end = findClosingSubstitution(command, index + 2);
      if (end < 0) {
        word += command.slice(index);
        break;
      }
      nested.push(command.slice(index + 2, end));
      word += "__raccoon_substitution__";
      index = end;
    } else if (character === "`") {
      let end = index + 1;
      while (end < command.length && command[end] !== "`") {
        if (command[end] === "\\") end += 1;
        end += 1;
      }
      if (end >= command.length) {
        word += command.slice(index);
        break;
      }
      nested.push(command.slice(index + 1, end));
      word += "__raccoon_substitution__";
      index = end;
    } else if (/\s/.test(character)) {
      finishWord();
      if (character === "\n") finishSegment();
    } else if (";&|()<>".includes(character)) {
      finishSegment();
      if (
        (character === ";" || character === "&" || character === "|") &&
        command[index + 1] === character
      ) {
        index += 1;
      }
    } else if (character === "#" && word === "") {
      const newline = command.indexOf("\n", index + 1);
      if (newline < 0) break;
      index = newline;
      finishSegment();
    } else {
      word += character;
    }
  }
  finishSegment();
  return { segments, nested };
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function hasForeignAbsolutePath(value) {
  if (process.platform === "win32") return value.startsWith("/");
  return path.win32.isAbsolute(value);
}

function nearestExistingPath(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

export function workspacePathIsAllowed(value, cwd = process.cwd()) {
  if (typeof value !== "string" || value.trim() === "") return true;
  if (value.includes("\0") || hasForeignAbsolutePath(value)) return false;

  let root;
  try {
    root = fs.realpathSync.native(cwd);
  } catch {
    return false;
  }
  const candidate = path.resolve(root, value);
  if (!pathIsInside(root, candidate)) return false;

  const existing = nearestExistingPath(candidate);
  if (!existing) return false;
  try {
    if (existing === candidate && fs.lstatSync(existing).isSymbolicLink()) {
      return false;
    }
    return pathIsInside(root, fs.realpathSync.native(existing));
  } catch {
    return false;
  }
}

function inputPathValues(toolName, input) {
  const fields = PATH_TOOL_FIELDS.get(toolName);
  if (!fields || !input || typeof input !== "object") return [];
  return fields.flatMap((field) => {
    const value = input[field];
    if (Array.isArray(value)) return value;
    return value === undefined || value === null ? [] : [value];
  });
}

export function containsBlockedToolPath(
  toolName,
  input,
  cwd = process.cwd(),
) {
  return inputPathValues(toolName, input).some(
    (value) => !workspacePathIsAllowed(value, cwd),
  );
}

function stripShellQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function looksLikePath(value) {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.startsWith("/") ||
    path.win32.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function pathArgumentIsBlocked(value, cwd) {
  const candidate = stripShellQuotes(value.trim());
  if (
    candidate === "" ||
    candidate === "-" ||
    candidate === "/dev/null" ||
    candidate === "NUL" ||
    candidate.startsWith("$") ||
    candidate.startsWith("%") ||
    candidate.startsWith("${") ||
    candidate.startsWith("$(")
  ) {
    return false;
  }
  if (!looksLikePath(candidate)) return false;
  return !workspacePathIsAllowed(candidate, cwd);
}

function segmentHasBlockedWorkspacePath(words, cwd) {
  const index = commandIndex(words);
  if (index >= words.length) return false;
  const executable = executableBasename(words[index]);

  if (SHELL_EXECUTABLES.has(executable) || WINDOWS_SHELL_EXECUTABLES.has(executable)) {
    const commandFlag = words.findIndex(
      (word, position) =>
        position > index &&
        ["/c", "-c", "-command"].includes(word.toLowerCase()),
    );
    return commandFlag >= 0 && commandFlag + 1 < words.length
      ? containsBlockedWorkspacePath(words.slice(commandFlag + 1).join(" "), cwd)
      : false;
  }
  if (executable === "eval") {
    return containsBlockedWorkspacePath(words.slice(index + 1).join(" "), cwd);
  }
  if (!WORKSPACE_SENSITIVE_COMMANDS.has(executable)) return false;

  return words
    .slice(index + 1)
    .filter((argument) => !argument.startsWith("-"))
    .some((argument) => pathArgumentIsBlocked(argument, cwd));
}

function redirectionTargets(command) {
  const targets = [];
  const pattern = /(?:^|[\s;|&])(?:\d*>>?|&>|\*>)[ \t]*("[^"]+"|'[^']+'|[^\s;|&]+)/gm;
  for (const match of command.matchAll(pattern)) targets.push(match[1]);
  return targets;
}

function referencesOtherManagedWorkspace(command, cwd) {
  const normalizedCommand = command.replaceAll("\\", "/");
  if (!normalizedCommand.includes(".raccoon-node/worktrees/")) return false;
  const normalizedRoot = path.resolve(cwd).replaceAll("\\", "/");
  const candidates = normalizedCommand.match(
    /(?:[A-Za-z]:)?[^\s'";|&]*\.raccoon-node\/worktrees\/[^\s'";|&]*/g,
  );
  return (candidates ?? []).some((candidate) => {
    const cleaned = candidate.replace(/[),]+$/, "");
    if (cleaned === normalizedRoot || cleaned.startsWith(`${normalizedRoot}/`)) {
      return false;
    }
    if (!path.posix.isAbsolute(cleaned) && !path.win32.isAbsolute(cleaned)) {
      return !workspacePathIsAllowed(cleaned, cwd);
    }
    return true;
  });
}

export function containsBlockedWorkspacePath(command, cwd = process.cwd()) {
  if (typeof command !== "string" || command.trim() === "") return false;
  const withoutHeredocs = stripHeredocBodies(command);
  if (referencesOtherManagedWorkspace(withoutHeredocs, cwd)) return true;
  if (
    redirectionTargets(withoutHeredocs).some((target) =>
      pathArgumentIsBlocked(target, cwd),
    )
  ) {
    return true;
  }
  const tokenInput =
    process.platform === "win32" ||
    /(?:^|\s)(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)(?:\s|$)/i.test(
      withoutHeredocs,
    )
      ? withoutHeredocs.replaceAll("\\", "/")
      : withoutHeredocs;
  const { segments, nested } = tokenizeShell(tokenInput);
  return (
    segments.some((words) => segmentHasBlockedWorkspacePath(words, cwd)) ||
    nested.some((nestedCommand) =>
      containsBlockedWorkspacePath(nestedCommand, cwd),
    )
  );
}

function commandIndex(words) {
  let index = 0;
  while (CONTROL_PREFIXES.has(words[index]) || isAssignment(words[index] ?? ""))
    index += 1;

  while (index < words.length) {
    const executable = executableBasename(words[index]);
    if (
      executable === "command" ||
      executable === "builtin" ||
      executable === "exec"
    ) {
      index += 1;
      while (words[index]?.startsWith("-")) index += 1;
      continue;
    }
    if (executable === "env" || executable === "env.exe") {
      index += 1;
      while (index < words.length) {
        const argument = words[index];
        if (isAssignment(argument)) {
          index += 1;
          continue;
        }
        if (
          ["-C", "-S", "-u", "--chdir", "--split-string", "--unset"].includes(
            argument,
          )
        ) {
          index += 2;
          continue;
        }
        if (argument.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return index;
}

function gitSubcommand(args) {
  const consumesNext = new Set([
    "-C",
    "-c",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--work-tree",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (consumesNext.has(argument)) {
      index += 1;
      continue;
    }
    if (
      argument.startsWith("--exec-path=") ||
      argument.startsWith("--git-dir=") ||
      argument.startsWith("--namespace=") ||
      argument.startsWith("--super-prefix=") ||
      argument.startsWith("--work-tree=")
    ) {
      continue;
    }
    if (argument === "--help" || argument === "--version")
      return { name: "version", args: [] };
    if (argument.startsWith("-")) continue;
    return { name: argument.toLowerCase(), args: args.slice(index + 1) };
  }
  return { name: "version", args: [] };
}

function hasAny(args, values) {
  return args.some(
    (argument) =>
      values.has(argument) ||
      [...values].some((value) => argument.startsWith(`${value}=`)),
  );
}

function positionalArgs(args) {
  return args.filter((argument) => !argument.startsWith("-"));
}

function hasShortFlag(args, flags) {
  return args.some(
    (argument) =>
      argument.startsWith("-") &&
      !argument.startsWith("--") &&
      [...argument.slice(1)].some((flag) => flags.includes(flag)),
  );
}

function isConditionalReadOnly(name, args) {
  switch (name) {
    case "apply":
      return hasAny(
        args,
        new Set(["--check", "--numstat", "--stat", "--summary"]),
      );
    case "branch": {
      const writeFlags = new Set([
        "-c",
        "-C",
        "-d",
        "-D",
        "-m",
        "-M",
        "--copy",
        "--delete",
        "--edit-description",
        "--move",
        "--set-upstream-to",
        "--unset-upstream",
      ]);
      if (hasAny(args, writeFlags) || hasShortFlag(args, "cCdDmM"))
        return false;
      const permitsPatterns = hasAny(
        args,
        new Set([
          "-l",
          "--list",
          "--contains",
          "--merged",
          "--no-contains",
          "--no-merged",
          "--points-at",
        ]),
      );
      return positionalArgs(args).length === 0 || permitsPatterns;
    }
    case "config": {
      const writeFlags = new Set([
        "-e",
        "--add",
        "--edit",
        "--remove-section",
        "--rename-section",
        "--replace-all",
        "--unset",
        "--unset-all",
      ]);
      if (hasAny(args, writeFlags)) return false;
      return hasAny(
        args,
        new Set([
          "-l",
          "--get",
          "--get-all",
          "--get-regexp",
          "--get-urlmatch",
          "--list",
        ]),
      );
    }
    case "commit-graph":
      return args[0]?.toLowerCase() === "verify";
    case "fsck":
      return !hasAny(args, new Set(["--lost-found"]));
    case "hash-object":
      return !hasShortFlag(args, "w");
    case "reflog":
      return (
        args[0]?.toLowerCase() === "show" &&
        !hasAny(args.slice(1), new Set(["--output"]))
      );
    case "remote":
      return (
        args.length === 0 ||
        (args.length === 1 && args[0] === "-v") ||
        args[0]?.toLowerCase() === "get-url"
      );
    case "submodule":
      return ["status", "summary"].includes(args[0]?.toLowerCase());
    case "tag": {
      const writeFlags = new Set([
        "-a",
        "-d",
        "-f",
        "-m",
        "-s",
        "-u",
        "--annotate",
        "--delete",
        "--force",
        "--local-user",
        "--message",
        "--sign",
      ]);
      if (hasAny(args, writeFlags) || hasShortFlag(args, "adfmsu"))
        return false;
      const permitsPatterns = hasAny(
        args,
        new Set([
          "-l",
          "--list",
          "--contains",
          "--merged",
          "--no-merged",
          "--points-at",
        ]),
      );
      return positionalArgs(args).length === 0 || permitsPatterns;
    }
    case "worktree":
      return args[0]?.toLowerCase() === "list";
    case "symbolic-ref":
      return (
        !hasAny(args, new Set(["-d", "--delete"])) &&
        positionalArgs(args).length === 1
      );
    default:
      return false;
  }
}

export function classifyGitArguments(args) {
  const { name, args: subcommandArgs } = gitSubcommand(args);
  if (ALWAYS_READ_ONLY.has(name)) {
    const writesOutputFile =
      READ_ONLY_WITH_FILE_OUTPUT.has(name) &&
      hasAny(subcommandArgs, new Set(["--output"]));
    return { blocked: writesOutputFile, subcommand: name };
  }
  if (ALWAYS_WRITE.has(name)) return { blocked: true, subcommand: name };
  return {
    blocked: !isConditionalReadOnly(name, subcommandArgs),
    subcommand: name,
  };
}

function segmentHasBlockedGit(words) {
  const index = commandIndex(words);
  if (index >= words.length) return false;
  const executable = executableBasename(words[index]);

  if (SHELL_EXECUTABLES.has(executable)) {
    const commandFlag = words.findIndex(
      (word, position) =>
        position > index &&
        (word === "-c" || (word.endsWith("c") && word.startsWith("-"))),
    );
    if (commandFlag < 0) return false;
    const nestedCommandIndex =
      words[commandFlag + 1] === "--" ? commandFlag + 2 : commandFlag + 1;
    return nestedCommandIndex < words.length
      ? containsBlockedGitWrite(words.slice(nestedCommandIndex).join(" "))
      : false;
  }
  if (WINDOWS_SHELL_EXECUTABLES.has(executable)) {
    const commandFlag = words.findIndex(
      (word, position) =>
        position > index &&
        ["/c", "-c", "-command"].includes(word.toLowerCase()),
    );
    return commandFlag >= 0 && commandFlag + 1 < words.length
      ? containsBlockedGitWrite(words.slice(commandFlag + 1).join(" "))
      : false;
  }
  if (executable === "eval") {
    return containsBlockedGitWrite(words.slice(index + 1).join(" "));
  }
  if (!isGitExecutable(words[index])) return false;
  return classifyGitArguments(words.slice(index + 1)).blocked;
}

export function containsBlockedGitWrite(command) {
  if (typeof command !== "string" || command.trim() === "") return false;
  const { segments, nested } = tokenizeShell(stripHeredocBodies(command));
  return (
    segments.some(segmentHasBlockedGit) ||
    nested.some((nestedCommand) => containsBlockedGitWrite(nestedCommand))
  );
}

function requireNonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: ${label}不能为空`);
  }
}

function validateStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: ${label}必须为字符串数组`);
  }
}

function safeEvidencePath(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) =>
      ["", ".", "..", ".git", ".raccoon-node"].includes(segment),
    )
  ) {
    return false;
  }
  return true;
}

export function validateWorkflowPayload(kind, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: 提交内容必须为对象`);
  }
  if (kind === "work_plan") {
    requireNonEmpty(payload.summary, "计划摘要");
    if (!Array.isArray(payload.design_notes))
      throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: design_notes 必须为数组`);
    for (const note of payload.design_notes) {
      requireNonEmpty(note?.id, "DesignNote id");
      requireNonEmpty(note?.statement, "DesignNote 内容");
      validateStringArray(note?.evidence, "DesignNote 仓库证据");
      requireNonEmpty(note?.rationale, "DesignNote 理由");
    }
    if (!Array.isArray(payload.work_items) || payload.work_items.length < 1 || payload.work_items.length > 100) {
      throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: work_items 数量必须为 1-100 个`);
    }
    for (const task of payload.work_items) {
      requireNonEmpty(task?.id, "任务 id");
      requireNonEmpty(task?.objective, "任务 objective");
      validateStringArray(task?.scenario_refs, "行为场景引用");
      if (task.scenario_refs.length === 0)
        throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: scenario_refs 不能为空`);
      validateStringArray(task?.depends_on, "任务依赖");
      validateStringArray(task?.scope_hints, "范围线索");
      validateStringArray(task?.verification_goals, "验证目标");
      const commandLike = /\b(?:npm|npx|cargo|pytest|git|grep|rg)\s/i;
      if (task.verification_goals.some((goal) => commandLike.test(goal)))
        throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: verification_goals 不能包含命令`);
      if (task.scope_hints.some((value) => !safeEvidencePath(value)))
        throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: scope_hints 包含不安全路径`);
    }
  } else if (["work_item", "rescue"].includes(kind)) {
    requireNonEmpty(payload.result_summary, "结果摘要");
    if (!["completed", "blocked"].includes(payload.outcome))
      throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: outcome 必须为 completed 或 blocked`);
    if (typeof payload.changed !== "boolean")
      throw new Error(`${WORKFLOW_OUTPUT_PROTOCOL}: changed 必须为布尔值`);
    if (!payload.changed) requireNonEmpty(payload.no_op_reason, "未修改原因");
  }
}

export function workflowKindFromEnvironment(value) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return ROLE_ALIASES.get(normalized);
}

async function validatePlanEvidenceFiles(payload, cwd) {
  if (!cwd) return;
  const root = await fs.promises.realpath(cwd);
  for (const note of payload.design_notes ?? []) {
    for (const evidencePath of note.evidence ?? []) {
        const resolved = path.resolve(root, evidencePath);
        const relative = path.relative(root, resolved);
        if (
          relative === "" ||
          relative.startsWith(`..${path.sep}`) ||
          relative === ".." ||
          path.isAbsolute(relative)
        ) {
          throw new Error(
            `${WORKFLOW_OUTPUT_PROTOCOL}: DesignNote 证据必须是仓库内文件`,
          );
        }
        const metadata = await fs.promises.lstat(resolved);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error(
            `${WORKFLOW_OUTPUT_PROTOCOL}: DesignNote 证据必须是非符号链接普通文件`,
          );
        }
        const real = await fs.promises.realpath(resolved);
        const realRelative = path.relative(root, real);
        if (
          realRelative.startsWith(`..${path.sep}`) ||
          realRelative === ".." ||
          path.isAbsolute(realRelative)
        ) {
          throw new Error(
            `${WORKFLOW_OUTPUT_PROTOCOL}: DesignNote 证据路径逃逸仓库`,
          );
        }
    }
  }
}

export function createWorkflowTool(kind) {
  const role = WORKFLOW_ROLES[kind];
  if (!role)
    throw new Error(`${TASK_RUNTIME_PROTOCOL}: 未知工作流角色 ${kind}`);
  return {
    name: role.toolName,
    label: role.label,
    description: role.description,
    parameters: role.parameters,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      validateWorkflowPayload(kind, params);
      if (kind === "work_plan") {
        await validatePlanEvidenceFiles(params, ctx?.cwd);
      }
      return {
        content: [{ type: "text", text: "结构化结果已提交。" }],
        details: {
          protocol: WORKFLOW_OUTPUT_PROTOCOL,
          kind,
          payload: params,
        },
        terminate: true,
      };
    },
  };
}

export default function (pi) {
  pi.registerCommand("raccoon-task-runtime", {
    description: "Raccoon 受管任务运行时协议（能力标记）",
    handler: async () => {},
  });

  pi.on("tool_call", (event) => {
    if (containsBlockedToolPath(event.toolName, event.input)) {
      return { block: true, reason: WORKSPACE_BLOCK_REASON };
    }
    if (event.toolName !== "bash") return undefined;
    if (containsBlockedGitWrite(event.input?.command)) {
      return { block: true, reason: GIT_WRITE_BLOCK_REASON };
    }
    if (containsBlockedWorkspacePath(event.input?.command)) {
      return { block: true, reason: WORKSPACE_BLOCK_REASON };
    }
    return undefined;
  });

  const kind = workflowKindFromEnvironment(process.env.RACCOON_WORKFLOW_ROLE);
  if (kind) pi.registerTool(createWorkflowTool(kind));
}
