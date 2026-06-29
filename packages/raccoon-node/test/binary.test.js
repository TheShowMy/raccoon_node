const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { binaryPath, platformPackage } = require("../lib/binary");

test("resolves supported platform packages and binary names", () => {
  assert.equal(platformPackage("darwin", "arm64"), "raccoon-node-darwin-arm64");
  assert.equal(platformPackage("linux", "x64"), "raccoon-node-linux-x64");
  assert.equal(platformPackage("win32", "x64"), "raccoon-node-win32-x64");
  assert.equal(platformPackage("linux", "arm64"), undefined);
  assert.equal(path.basename(binaryPath("/tmp/pkg/package.json", "linux")), "raccoon");
  assert.equal(path.basename(binaryPath("/tmp/pkg/package.json", "win32")), "raccoon.exe");
});
