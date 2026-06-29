#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { binaryPath, platformPackage } = require("../lib/binary");
const platform = `${process.platform}-${process.arch}`;
const packageName = platformPackage(process.platform, process.arch);

if (!packageName) {
  console.error(`raccoon-node 不支持当前平台: ${platform}`);
  process.exit(1);
}

let packageJson;
try {
  packageJson = require.resolve(`${packageName}/package.json`);
} catch {
  console.error(
    `缺少 ${packageName}。请重新安装 raccoon-node，且不要使用 --omit=optional。`,
  );
  process.exit(1);
}

const binary = binaryPath(packageJson, process.platform);
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`无法启动 raccoon: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
