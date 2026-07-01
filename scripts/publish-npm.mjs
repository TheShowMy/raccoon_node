import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

for (const directory of process.argv.slice(2)) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  const spec = `${manifest.name}@${manifest.version}`;
  const exists = spawnSync("npm", ["view", spec, "version"], {
    stdio: "ignore",
    shell: false,
  }).status === 0;
  if (exists) {
    console.log(`${spec} 已发布，跳过`);
    continue;
  }
  const result = spawnSync(
    "npm",
    ["publish", path.resolve(directory), "--provenance", "--access", "public"],
    { stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
