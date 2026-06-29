import { spawn } from "node:child_process";
import { platform } from "node:os";

const projectRoot = process.env.RACCOON_PROJECT_ROOT || "";

const cargoArgs = ["run", "--"];
if (projectRoot) {
  cargoArgs.push("--project-root", projectRoot);
}
cargoArgs.push("--dev-frontend", "http://localhost:5173");

const isWin = platform() === "win32";

console.log(
  `▸ cargo ${cargoArgs.join(" ")}${projectRoot ? "" : "（未设置 $RACCOON_PROJECT_ROOT，使用当前目录）"}`,
);
console.log(`▸ vite (frontend, port 5173)\n`);

const children = [];
let exiting = false;

function shutdown() {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    child.kill(isWin ? undefined : "SIGTERM");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const cargo = spawn("cargo", cargoArgs, {
  stdio: "inherit",
  shell: isWin,
});
children.push(cargo);

const vite = spawn("npm", ["--prefix", "frontend", "run", "dev"], {
  stdio: "inherit",
  shell: isWin,
});
children.push(vite);

let exitCode = 0;
for (const child of children) {
  await new Promise((resolve) => {
    child.on("exit", (code) => {
      exitCode ||= code || 0;
      resolve();
    });
  });
  shutdown(); // 任一个退出都停掉另一个
}

process.exit(exitCode);
