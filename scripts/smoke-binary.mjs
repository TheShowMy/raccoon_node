import { spawnSync } from "node:child_process";

const binary = process.argv[2];
if (!binary) throw new Error("用法: node scripts/smoke-binary.mjs <binary>");

const result = spawnSync(binary, ["--help"], { stdio: "inherit", shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
