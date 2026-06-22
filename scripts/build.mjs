import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "build");
const binaryName = process.platform === "win32" ? "raccoon_node.exe" : "raccoon_node";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

await rm(buildDir, { recursive: true, force: true });
await mkdir(path.join(buildDir, "bin"), { recursive: true });
await mkdir(path.join(buildDir, "data"), { recursive: true });

run(npmCommand, ["--prefix", "frontend", "run", "build"]);
run("cargo", ["build", "--release"]);

await cp(path.join(root, "target", "release", binaryName), path.join(buildDir, "bin", binaryName));
await cp(path.join(root, "frontend", "dist"), path.join(buildDir, "public"), { recursive: true });

const sourceData = path.join(root, "data", "app.json");
const targetData = path.join(buildDir, "data", "app.json");
if (await pathExists(sourceData)) {
  await cp(sourceData, targetData);
} else {
  await writeFile(
    targetData,
    JSON.stringify(
      {
        projects: [],
        settings_summary: {
          title: "设置",
          description: "基础设置待配置"
        },
        model_summary: {
          title: "模型设置",
          description: "默认模型待配置"
        }
      },
      null,
      2
    )
  );
}

await writeFile(
  path.join(buildDir, "README.md"),
  [
    "# Raccoon Node Build",
    "",
    "运行方式：",
    "",
    "```sh",
    `./bin/${binaryName}`,
    "```",
    "",
    "默认监听地址：127.0.0.1:3001",
    "",
    "本机访问：http://127.0.0.1:3001",
    "",
    "如需监听所有接口：RACCOON_HOST=0.0.0.0",
    "",
    "可选环境变量：",
    "",
    "```sh",
    "RACCOON_HOST=0.0.0.0 RACCOON_PORT=3001 ./bin/" + binaryName,
    "```",
    "",
    "生产数据文件：`data/app.json`",
    ""
  ].join("\n")
);

console.log(`Build output ready: ${buildDir}`);
