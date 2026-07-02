import { readFile } from "node:fs/promises";

const expected = process.env.GITHUB_REF_NAME?.replace(/^v/, "") ?? "0.2.1";
const files = [
  "package.json",
  "packages/raccoon-node/package.json",
  "packages/raccoon-node-darwin-arm64/package.json",
  "packages/raccoon-node-linux-x64/package.json",
  "packages/raccoon-node-windows-x64/package.json",
];

for (const file of files) {
  const { version } = JSON.parse(await readFile(file, "utf8"));
  if (version !== expected) throw new Error(`${file}: ${version} != ${expected}`);
}

const cargo = await readFile("Cargo.toml", "utf8");
const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (!new RegExp(`^version = "${escaped}"$`, "m").test(cargo)) {
  throw new Error(`Cargo.toml version != ${expected}`);
}
