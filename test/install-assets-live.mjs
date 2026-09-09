import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

assert.ok(process.argv[2], "supply the pinned VSIX archive");
const archive = resolve(process.argv[2]);
assert.ok(readFileSync(archive).length > 0);
mkdirSync(".task-evidence", { recursive: true });
const root = mkdtempSync(".task-evidence/install-live-");
function install(destination, source = archive, env = process.env) {
  return spawnSync(process.execPath, ["src/cli.js", "install-assets", "--archive", source, "--directory", destination], { encoding: "utf8", env });
}
const first = join(root, "first");
const second = join(root, "second");
for (const destination of [first, second, first]) {
  const result = install(destination);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(destination, "extension/drawio/VERSION"), "utf8").trim(), "26.0.2");
  assert.ok(readFileSync(join(destination, "extension/LICENSE.md")).length > 0);
}
const receipt = readFileSync(join(first, "installation.json"), "utf8");
assert.equal(readFileSync(join(second, "installation.json"), "utf8"), receipt);
const bad = join(root, "bad.vsix");
writeFileSync(bad, "planted integrity violation");
const failure = install(first, bad);
assert.notEqual(failure.status, 0);
assert.match(failure.stderr, /SHA-256 mismatch/);
assert.equal(readFileSync(join(first, "installation.json"), "utf8"), receipt);
const missingUnzip = install(first, archive, { ...process.env, PATH: resolve(root) });
assert.notEqual(missingUnzip.status, 0);
assert.match(missingUnzip.stderr, /unzip/);
assert.equal(readFileSync(join(first, "installation.json"), "utf8"), receipt);
assert.equal(existsSync(`${first}.lock`), false);
const failingTools = join(root, "failing-tools");
mkdirSync(failingTools);
writeFileSync(join(failingTools, "unzip"), '#!/bin/sh\nif [ "$1" = "-v" ]; then exit 0; fi\necho "planted extraction failure" >&2\nexit 2\n', { mode: 0o755 });
const extractionFailure = install(first, archive, { ...process.env, PATH: resolve(failingTools) });
assert.notEqual(extractionFailure.status, 0);
assert.match(extractionFailure.stderr, /asset extraction failed.*planted extraction failure/);
assert.equal(readFileSync(join(first, "installation.json"), "utf8"), receipt);
assert.equal(existsSync(`${first}.lock`), false);
assert.equal(readdirSync(root).some(name => name.startsWith(".drawio-stage-")), false);
console.log(`install-assets: two clean installs, repeat install, licences, integrity, missing unzip and extraction failure verified in ${root}`);
