import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The PreToolUse guard, case by case: which tool calls it blocks (exit 2 with
// guidance on stderr), which it allows (exit 0, silent), and that malformed
// input fails open rather than breaking unrelated tools.

const testDir = dirname(fileURLToPath(import.meta.url));
const hook = join(dirname(testDir), "hooks", "deny-drawio-write.js");

function runHook(stdin) {
  const result = spawnSync("node", [hook], { input: stdin, encoding: "utf8" });
  return { code: result.status, stderr: result.stderr };
}

const CASES = [
  // [description, stdin, expected exit code, stderr must contain]
  ["Write .drawio", { tool_name: "Write", tool_input: { file_path: "/tmp/a.drawio" } }, 2, "BLOCKED"],
  ["Edit .drawio", { tool_name: "Edit", tool_input: { file_path: "map.drawio" } }, 2, "BLOCKED"],
  ["MultiEdit .drawio", { tool_name: "MultiEdit", tool_input: { file_path: "x.drawio" } }, 2, "BLOCKED"],
  ["Write .drawio.png", { tool_name: "Write", tool_input: { file_path: "a.drawio.png" } }, 2, "BLOCKED"],
  ["Write .drawio.svg", { tool_name: "Write", tool_input: { file_path: "a.drawio.svg" } }, 2, "BLOCKED"],
  ["Write .DRAWIO uppercase", { tool_name: "Write", tool_input: { file_path: "A.DRAWIO" } }, 2, "BLOCKED"],
  ["Write .md", { tool_name: "Write", tool_input: { file_path: "notes.md" } }, 0, ""],
  ["Write plain .png", { tool_name: "Write", tool_input: { file_path: "shot.png" } }, 0, ""],
  ["Write .drawio.md lookalike", { tool_name: "Write", tool_input: { file_path: "a.drawio.md" } }, 0, ""],
  ["Read .drawio (not an edit tool)", { tool_name: "Read", tool_input: { file_path: "a.drawio" } }, 0, ""],
  ["Bash (no file_path)", { tool_name: "Bash", tool_input: { command: "cat a.drawio" } }, 0, ""],
  ["missing tool_input", { tool_name: "Write" }, 0, ""],
];

for (const [description, stdin, expectedCode, stderrContains] of CASES) {
  const { code, stderr } = runHook(JSON.stringify(stdin));
  assert.equal(code, expectedCode, `${description}: exit ${code}, want ${expectedCode}`);
  if (stderrContains) {
    assert.ok(stderr.includes(stderrContains), `${description}: stderr missing "${stderrContains}"`);
    assert.ok(stderr.includes("drawio-cli"), `${description}: stderr must name the sanctioned mechanism`);
  } else {
    assert.equal(stderr, "", `${description}: expected silent stderr, got "${stderr}"`);
  }
}

// Malformed input fails open, never breaking the tool call it rides on.
for (const junk of ["", "not json {", "[1,2,3]"]) {
  const { code } = runHook(junk);
  assert.equal(code, 0, `malformed stdin ${JSON.stringify(junk)}: exit ${code}, want 0`);
}

assert.ok(CASES.length > 0, "case table must never be empty");
console.log(`deny-drawio-write: ${CASES.length + 3} cases pass`);
