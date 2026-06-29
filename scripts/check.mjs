import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("请通过 npm run check 执行检查");

async function run(command, args, timeout = 60_000) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    const timer = timeout
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`命令超过 60 秒: ${command} ${args.join(" ")}`));
        }, timeout)
      : undefined;
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`命令失败 (${signal ?? code}): ${command} ${args.join(" ")}`));
    });
  });
}

await run(process.execPath, [npmCli, "--prefix", "frontend", "run", "check"]);
await run(process.execPath, [npmCli, "--prefix", "frontend", "run", "test", "--", "--run"]);
await run(process.execPath, ["--test", "packages/raccoon-node/test/binary.test.js"]);
await run("cargo", ["test", "--no-run"], 0);
await run("cargo", ["test"]);
