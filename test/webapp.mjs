import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { locateWebapp } from "../src/webapp.js";

assert.throws(() => locateWebapp({ webapp: "missing-explicit-webapp" }), /webapp.*missing|missing.*webapp/i);
console.log("webapp: invalid explicit selection refuses fallback");

mkdirSync(new URL("../.task-evidence/", import.meta.url), { recursive: true });
const root = mkdtempSync(new URL("../.task-evidence/webapp-", import.meta.url));
const required = ["js/app.min.js", "js/PreConfig.js", "js/PostConfig.js", "js/extensions.min.js", "js/stencils.min.js", "js/shapes-14-6-5.min.js", "styles/grapheditor.css"];
function fixture(path) {
  assert.ok(required.length > 0);
  for (const file of required) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), "App.main=function(){}; Menus.prototype={}; EditorUi.VERSION=\"26.0.2\";");
  }
  return path;
}
try {
  const explicit = fixture(join(root, "explicit"));
  const local = fixture(join(root, "local"));
  const extensions = join(root, "extensions");
  const older = fixture(join(extensions, "hediet.vscode-drawio-1.9.0/drawio/src/main/webapp"));
  const newer = fixture(join(extensions, "hediet.vscode-drawio-1.10.0/drawio/src/main/webapp"));
  const options = { standalone: local, roots: [extensions], env: {} };
  assert.equal(locateWebapp({ ...options, webapp: explicit }), explicit);
  assert.equal(locateWebapp({ ...options, env: { DRAWIO_WEBAPP: explicit } }), explicit);
  assert.equal(locateWebapp(options), local);
  assert.equal(locateWebapp({ ...options, standalone: join(root, "absent") }), newer);
  const otherExtensions = join(root, "z-extensions");
  fixture(join(otherExtensions, "hediet.vscode-drawio-1.8.0/drawio/src/main/webapp"));
  assert.equal(locateWebapp({ ...options, standalone: join(root, "absent"), roots: [extensions, otherExtensions] }), newer);
  assert.equal(locateWebapp({ standalone: join(root, "absent"), roots: [], env: {} }), null);
  for (const file of required) {
    rmSync(join(explicit, file));
    assert.throws(() => locateWebapp({ ...options, webapp: explicit }), /webapp/);
    fixture(explicit);
  }
  writeFileSync(join(explicit, "js/app.min.js"), "incompatible payload");
  assert.throws(() => locateWebapp({ ...options, webapp: explicit }), /incompatible/);
  assert.throws(() => locateWebapp({ ...options, webapp: "" }), /empty/);
  assert.throws(() => locateWebapp({ ...options, env: { DRAWIO_WEBAPP: "" } }), /empty/);
  const source = join(root, "empty.drawio");
  writeFileSync(source, '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>');
  for (const args of [["doctor"], ["render", source]]) {
    const result = spawnSync(process.execPath, ["src/cli.js", ...args, "--webapp", "missing-explicit-webapp"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /webapp missing/);
  }
  console.log("webapp: precedence, version ordering, missing and incompatible payloads pass");
} finally {
  rmSync(root, { recursive: true, force: true });
}
