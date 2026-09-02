#!/usr/bin/env node
// PreToolUse hook: reject Write/Edit tool calls that target a draw.io file.
//
// Diagram files carry embedded base64 payloads, so composing their content in
// model output dies on the per-response output-token cap. This hook turns that
// slow death into an instant refusal at the first attempt, redirecting the
// agent to drawio-cli editing verbs and file-to-file scripts.
//
// Contract (Claude Code PreToolUse):
//   stdin  - JSON {tool_name, tool_input: {file_path, ...}}
//   exit 0 - allow the call
//   exit 2 - block the call, stderr is fed back to the model
// Anything unparseable fails open: this hook must never break unrelated tools.

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const DRAWIO_FILE = /\.drawio(\.(png|svg))?$/i;

let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const toolName = payload?.tool_name;
  const filePath = payload?.tool_input?.file_path;
  if (!EDIT_TOOLS.has(toolName) || typeof filePath !== "string") {
    process.exit(0);
  }
  if (!DRAWIO_FILE.test(filePath)) {
    process.exit(0);
  }
  process.stderr.write(
    `BLOCKED: ${toolName} on ${filePath}. draw.io file content never passes ` +
      "through model output. Edit it with a drawio-cli verb (set-geometry, " +
      "set-waypoints, set-label-offset) or a stdlib script that reads the " +
      "file from disk and writes it back, printing only counts and asserts. " +
      "Do not retry this tool call. See the drawio-diagrams skill.\n",
  );
  process.exit(2);
});
