import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { decodeNumericEntities } from "../src/extract.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = ".task-evidence/extract-entities";
mkdirSync(new URL(`../${evidence}/`, import.meta.url), { recursive: true });
function run(args) {
  const result = spawnSync(process.execPath, ["src/cli.js", ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const cells = (xml) => page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid XML");
    function canonical(node) {
      const attrs = [...node.attributes].map((attr) => [attr.name, attr.value])
        .filter(([key, value]) => !(["mxGeometry", "mxPoint"].includes(node.tagName) && ["x", "y"].includes(key) && Number(value) === 0))
        .sort(([a], [b]) => a.localeCompare(b));
      return [node.tagName, attrs, [...node.children].map(canonical)];
    }
    return [...doc.querySelectorAll("mxCell")].map(canonical);
  }, xml);
  const expected = await cells(read("docs/architecture.drawio"));
  assert.equal(expected.length, 19);
  assert.ok(JSON.stringify(expected).includes("\\n"), "fixture must contain multiline labels");
  const violation = structuredClone(expected);
  const edge = violation.find(([, attrs]) => attrs.some(([key]) => key === "target"));
  assert.ok(edge, "fixture must contain a connected edge");
  edge[1].find(([key]) => key === "target")[1] = "planted-wrong-target";
  assert.throws(() => assert.deepEqual(violation, expected), assert.AssertionError);
  console.log("Semantic comparison rejects a planted edge target change");
  for (const ext of ["png", "svg"]) {
    const input = `docs/architecture.drawio.${ext}`;
    const raw = `${evidence}/${ext}-raw.drawio`;
    const decoded = `${evidence}/${ext}-decoded.drawio`;
    run(["extract", input, "-o", raw, "--force"]);
    run(["extract", input, "--decode-entities", "-o", decoded, "--force"]);
    assert.deepEqual(await cells(read(raw)), expected, `${ext}: raw model semantics`);
    assert.deepEqual(await cells(read(decoded)), expected, `${ext}: decoded model semantics`);
    console.log(`${ext}: 19 cells preserve labels, attributes, geometry and waypoints`);
    for (const path of [raw, decoded]) run(["render", path, "--png", "--svg"]);
    for (const renderedExt of ["png", "svg"]) {
      const extracted = `${evidence}/${ext}-rendered-${renderedExt}.drawio`;
      run(["extract", `${decoded}.${renderedExt}`, "--decode-entities", "-o", extracted, "--force"]);
      assert.deepEqual(await cells(read(extracted)), expected, `${ext} rendered ${renderedExt}: model semantics`);
    }
    const pixels = (path) => PNG.sync.read(readFileSync(new URL(`../${path}.png`, import.meta.url)));
    const before = pixels(raw), after = pixels(decoded);
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);
    assert.deepEqual(after.data, before.data, `${ext}: decoding must preserve rendered pixels`);
    console.log(`${ext}: PNG/SVG rendered round trips preserve semantics, PNG pixels match raw extraction`);
  }
  for (const entity of ["&#9;", "&#10;", "&#13;", "&#x9;", "&#xA;", "&#xD;"]) {
    const xml = `<mxCell value="first${entity}second"/>`;
    assert.deepEqual(await cells(decodeNumericEntities(xml)), await cells(xml), entity);
  }
  assert.equal(decodeNumericEntities('<mxCell value="It&#39;s &#x1F600; &#65; &#34; &#38; &#60; &#62;"/>'),
    '<mxCell value="It\'s 😀 A &#34; &#38; &#60; &#62;"/>');
  console.log("Decimal/hexadecimal whitespace semantics and safe numeric decoding pass");
} finally {
  await browser.close();
}
