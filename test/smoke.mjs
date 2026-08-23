import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
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

/** True when the PNG buffer carries a tEXt chunk keyed mxfile. */
function hasMxfileChunk(png) {
  return png.includes(Buffer.concat([Buffer.from("tEXt"), Buffer.from("mxfile\0", "latin1")]));
}

const dir = mkdtempSync(join(tmpdir(), "drawio-cli-smoke-"));
try {
  const source = join(dir, "hello.drawio");
  writeFileSync(source, HELLO_DRAWIO);

  run(["render", source, "--png", "--svg"]);

  const png = readFileSync(join(dir, "hello.drawio.png"));
  assert.ok(png.length > 1000, "PNG export is implausibly small");
  assert.ok(hasMxfileChunk(png), "PNG export lacks the tEXt chunk keyed mxfile");

  const svg = readFileSync(join(dir, "hello.drawio.svg"), "utf8");
  assert.match(svg, /<svg\b[^>]*\scontent="/, "SVG root lacks the embedded content attribute");
  assert.ok(!svg.includes("img/lib/"), "SVG export references img/lib/ instead of inlined data URIs");

  run(["extract", join(dir, "hello.drawio.png"), "-o", join(dir, "roundtrip.drawio")]);
  const roundtrip = readFileSync(join(dir, "roundtrip.drawio"), "utf8");
  assert.ok(roundtrip.includes('value="Hello"'), "round-tripped XML lost the Hello label");
  assert.ok(roundtrip.includes('value="World"'), "round-tripped XML lost the World label");

  console.log("smoke test passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
