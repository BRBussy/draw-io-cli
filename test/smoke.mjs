import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);
const cli = join(repoRoot, "src", "cli.js");

const HELLO_DRAWIO = `<mxfile>
  <diagram name="Page-1" id="smoke-test">
    <mxGraphModel dx="800" dy="600" grid="0" page="1" pageWidth="850" pageHeight="1100">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="Hello" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="3" value="World" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="240" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="2" target="3">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `drawio-cli ${args.join(" ")} exited ${result.status}\n${result.stderr}`,
  );
  return result;
}

function runExpectingFailure(args, stderrNeedle) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.notEqual(result.status, 0, `drawio-cli ${args.join(" ")} unexpectedly succeeded`);
  assert.ok(
    result.stderr.includes(stderrNeedle),
    `stderr should mention "${stderrNeedle}", got:\n${result.stderr}`,
  );
  return result;
}

/** True when the PNG buffer carries a tEXt chunk keyed mxfile. */
function hasMxfileChunk(png) {
  return png.includes(Buffer.concat([Buffer.from("tEXt"), Buffer.from("mxfile\0", "latin1")]));
}

const dir = mkdtempSync(join(tmpdir(), "drawio-cli-smoke-"));
try {
  const source = join(dir, "hello.drawio");
  writeFileSync(source, HELLO_DRAWIO);

  run(["render", source, "--png", "--svg"]);

  // Keep the rendered output visible: each run leaves its exports in test/ as
  // gitignored artifacts, so a human or agent can open the hello world the
  // assertions below checked with their own eyes.
  const when = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..*$/, "");
  for (const ext of ["png", "svg"]) {
    const artifact = join(testDir, `smoke-${when}-test-result.drawio.${ext}`);
    copyFileSync(join(dir, `hello.drawio.${ext}`), artifact);
    console.log(artifact);
  }

  const png = readFileSync(join(dir, "hello.drawio.png"));
  assert.ok(png.length > 1000, "PNG export is implausibly small");
  assert.ok(hasMxfileChunk(png), "PNG export lacks the tEXt chunk keyed mxfile");

  const svg = readFileSync(join(dir, "hello.drawio.svg"), "utf8");
  assert.match(svg, /<svg\b[^>]*\scontent="/, "SVG root lacks the embedded content attribute");
  assert.ok(!svg.includes("img/lib/"), "SVG export references img/lib/ instead of inlined data URIs");

  // drawio.config.json in the source's directory sets render defaults, flags override it.
  writeFileSync(join(dir, "drawio.config.json"), JSON.stringify({ render: { scale: 1 } }));
  run(["render", source, "--png", join(dir, "configured.drawio.png")]);
  run(["render", source, "--png", join(dir, "flagged.drawio.png"), "--scale", "2"]);
  const pngWidth = (buffer) => buffer.readUInt32BE(16);
  const configured = pngWidth(readFileSync(join(dir, "configured.drawio.png")));
  const flagged = pngWidth(readFileSync(join(dir, "flagged.drawio.png")));
  assert.ok(
    flagged > configured * 1.8,
    `--scale 2 (${flagged}px) should dwarf config scale 1 (${configured}px)`,
  );

  run(["extract", join(dir, "hello.drawio.png"), "-o", join(dir, "roundtrip.drawio")]);
  const roundtrip = readFileSync(join(dir, "roundtrip.drawio"), "utf8");
  assert.ok(roundtrip.includes('value="Hello"'), "round-tripped XML lost the Hello label");
  assert.ok(roundtrip.includes('value="World"'), "round-tripped XML lost the World label");

  // The webapp silently drops the whole model when a cell id collides with one of
  // its builtins ("map" is a known case). The render guard must turn that into a
  // loud failure instead of a blank PNG.
  writeFileSync(join(dir, "landmine.drawio"), HELLO_DRAWIO.replace('id="2"', 'id="map"'));
  runExpectingFailure(
    ["render", join(dir, "landmine.drawio"), "--png", join(dir, "landmine.drawio.png")],
    "rejected the input silently",
  );

  console.log("smoke test passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
