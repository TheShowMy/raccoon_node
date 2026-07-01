const path = require("node:path");

const packages = {
  "darwin-arm64": "raccoon-node-darwin-arm64",
  "linux-x64": "raccoon-node-linux-x64",
  "win32-x64": "raccoon-node-windows-x64",
};

exports.platformPackage = (platform, arch) => packages[`${platform}-${arch}`];
exports.binaryPath = (packageJson, platform) =>
  path.join(
    path.dirname(packageJson),
    "bin",
    platform === "win32" ? "raccoon.exe" : "raccoon",
  );
