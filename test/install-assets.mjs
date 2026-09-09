import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { installAssets } from "../src/install-assets.js";

const result = spawnSync(process.execPath, ["src/cli.js", "install-assets", "--archive", "missing.vsix"], { encoding: "utf8" });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /ENOENT/);
console.log("install-assets: missing archive fails before installation");

mkdirSync(".task-evidence", { recursive: true });
const root = mkdtempSync(".task-evidence/install-");
try {
  const archive = join(root, "corrupt.vsix");
  const destination = join(root, "assets");
  writeFileSync(archive, "planted checksum violation");
  const corrupt = spawnSync(process.execPath, ["src/cli.js", "install-assets", "--archive", archive, "--directory", destination], { encoding: "utf8" });
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /SHA-256 mismatch/);
  assert.equal(existsSync(destination), false);
  console.log("install-assets: checksum mismatch leaves no installation");
  const server = createServer((req, res) => { res.writeHead(503); res.end("planted download failure"); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    await assert.rejects(installAssets({ directory: destination, url: `http://127.0.0.1:${server.address().port}/assets` }), /download failed.*503/);
    assert.equal(existsSync(destination), false);
  } finally {
    await new Promise((done) => server.close(done));
  }
  console.log("install-assets: failed download leaves no installation");
} finally {
  rmSync(root, { recursive: true, force: true });
}
