import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebappFixture } from "./webapp-fixture.mjs";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "drawio-cli-chromium-"));
const webapp = join(root, "webapp");

function invoke(args, executable) {
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: join(root, "no-playwright-browsers"),
  };
  // Isolate the unset case even when the surrounding shell configures an override.
  delete env.DRAWIO_CHROMIUM_EXECUTABLE_PATH;
  if (executable !== undefined) env.DRAWIO_CHROMIUM_EXECUTABLE_PATH = executable;
  const result = spawnSync(process.execPath, [cli, ...args, "--webapp", webapp], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}

try {
  createWebappFixture(webapp);

  // doctor checks executable presence, not whether it can launch a browser.
  const executable = join(root, "custom chromium");
  writeFileSync(executable, "", { mode: 0o755 });
  const result = invoke(["doctor"], executable);
  assert.ok(
    result.stdout.includes(`playwright chromium: ${executable}`),
    `doctor must report the configured Chromium executable\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.status, 0, `doctor must succeed with a configured executable\n${result.stderr}`);
  console.log("chromium: doctor checks the configured executable without a bundled browser");

  const missing = join(root, "missing chromium");
  const refused = invoke(["doctor"], missing);
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(missing), `doctor must identify the missing override\n${refused.stderr}`);
  assert.ok(refused.stderr.includes("DRAWIO_CHROMIUM_EXECUTABLE_PATH"));
  console.log("chromium: doctor identifies an invalid override without fallback");

  const source = join(root, "empty.drawio");
  writeFileSync(source, '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>');
  const render = invoke(["render", source, "--png"], missing);
  assert.equal(render.status, 1);
  assert.ok(render.stderr.includes(missing), `render must attempt to launch the configured executable\n${render.stderr}`);
  console.log("chromium: render attempts the configured executable, not the bundled browser");

  const relative = invoke(["doctor"], "./custom chromium");
  assert.equal(relative.status, 0, relative.stderr);
  assert.ok(relative.stdout.includes(`playwright chromium: ${executable}`));
  console.log("chromium: relative paths resolve from the working directory, including spaces");

  const unconfigured = invoke(["doctor"]);
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stderr, /playwright chromium: NOT FOUND/);
  assert.ok(!unconfigured.stderr.includes("DRAWIO_CHROMIUM_EXECUTABLE_PATH"));
  const defaultRender = invoke(["render", source, "--png"]);
  assert.equal(defaultRender.status, 1);
  assert.ok(defaultRender.stderr.includes(join(root, "no-playwright-browsers")), defaultRender.stderr);
  console.log("chromium: unset override preserves Playwright's browser selection");

  for (const args of [["doctor"], ["render", source, "--png"]]) {
    for (const value of ["", "   "]) {
      const empty = invoke(args, value);
      assert.equal(empty.status, 1, `${args[0]} must reject an explicitly empty override`);
      assert.match(empty.stderr, /DRAWIO_CHROMIUM_EXECUTABLE_PATH.*empty/);
    }
  }
  console.log("chromium: doctor and render reject empty overrides");
} finally {
  rmSync(root, { recursive: true, force: true });
}
