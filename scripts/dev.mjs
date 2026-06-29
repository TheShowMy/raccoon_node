import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const frontendDir = resolve(repoRoot, "frontend");
const projectRoot = process.env.RACCOON_PROJECT_ROOT || "";

const cargoArgs = ["run", "--"];
if (projectRoot) {
  cargoArgs.push("--project-root", projectRoot);
}
cargoArgs.push(
  "--dev-frontend",
  "http://localhost:5173",
  "--dev-managed-vite",
  "--dev-frontend-dir",
  frontendDir,
);

console.log(
  `▸ cargo ${cargoArgs.join(" ")}${projectRoot ? "" : "（未设置 $RACCOON_PROJECT_ROOT，使用当前目录）"}`,
);
console.log("▸ tui enabled; Vite is managed by the backend and shown in the TUI Vite log panel\n");

const cargo = spawn("cargo", cargoArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    RACCOON_DEV_NODE_EXEC_PATH: process.execPath,
  },
});

let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  cargo.kill(process.platform === "win32" ? undefined : "SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const exitCode = await new Promise((resolveExit) => {
  cargo.on("exit", (code, signal) => {
    if (signal) {
      resolveExit(1);
    } else {
      resolveExit(code || 0);
    }
  });
});

process.exit(exitCode);
