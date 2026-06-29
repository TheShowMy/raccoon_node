import { copyFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const binary = process.platform === "win32" ? "raccoon.exe" : "raccoon";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!npmCli) throw new Error("请通过 npm run build 执行构建");

run(process.execPath, [npmCli, "--prefix", "frontend", "run", "build"]);
run("cargo", ["build", "--release"], {
  env: { ...process.env, RACCOON_SKIP_FRONTEND_BUILD: "1" },
});

const output = path.join(root, "build", "bin");
await rm(path.dirname(output), { recursive: true, force: true });
await mkdir(output, { recursive: true });
await copyFile(path.join(root, "target", "release", binary), path.join(output, binary));
console.log(`Build output ready: ${output}`);
