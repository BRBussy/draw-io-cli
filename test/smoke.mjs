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
        <mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;html=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="2" target="3">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="4l" value="hop label" style="edgeLabel;html=1;align=center;verticalAlign=middle;labelBackgroundColor=none;fontSize=12;fontColor=#333333;spacing=2;" vertex="1" connectable="0" parent="4">
          <mxGeometry x="0" relative="1" as="geometry">
            <mxPoint x="12" y="-8" as="offset" />
          </mxGeometry>
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

  // Render outputs are derived artifacts: re-rendering over an existing pair is the
  // standard workflow and must succeed without any flag.
  run(["render", source, "--png", join(dir, "configured.drawio.png")]);

  run(["extract", join(dir, "hello.drawio.png"), "-o", join(dir, "roundtrip.drawio")]);
  const roundtrip = readFileSync(join(dir, "roundtrip.drawio"), "utf8");
  assert.ok(roundtrip.includes('value="Hello"'), "round-tripped XML lost the Hello label");
  assert.ok(roundtrip.includes('value="World"'), "round-tripped XML lost the World label");

  // extract's default target is the sibling .drawio, which for a rendered pair
  // is the source of truth: an existing file there must refuse without --force
  // and stay byte-identical.
  runExpectingFailure(["extract", join(dir, "hello.drawio.png")], "refusing to overwrite");
  assert.equal(
    readFileSync(source, "utf8"),
    HELLO_DRAWIO,
    "refused extract must leave the existing .drawio untouched",
  );

  // render always overwrites its derived outputs: --force is a misconception
  // the error must correct rather than silently accept.
  runExpectingFailure(["render", source, "--png", "--force"], "render always overwrites");

  // cells: an edge label row carries its owning edge, relative position and
  // offset point; styles truncate at 90 chars unless --full.
  const labelCells = run(["cells", source]).stdout;
  assert.ok(labelCells.includes("ELBL  4l  on=4 pos=0 offset=(12,-8)"), "cells must report the edge label's position and offset");
  assert.ok(!labelCells.includes("spacing=2;"), "cells without --full must truncate the long style");
  const labelCellsFull = run(["cells", source, "--full"]).stdout;
  assert.ok(labelCellsFull.includes("spacing=2;"), "cells --full must print the untruncated style");

  // measure: an edge label resolves its anchor on the parent edge's pinned
  // polyline and reports ink inside its estimated box.
  const labelMeasure = run(["measure", join(dir, "hello.drawio.png"), "--cell", "4l"]).stdout;
  assert.match(labelMeasure, /label 4l on edge 4: .*anchor \(212,62\)/, "measure must anchor the edge label on its polyline");
  assert.match(labelMeasure, /ink \d/, "measure must find the label's text ink");

  // The webapp silently drops the whole model when a cell id collides with one of
  // its builtins ("map" is a known case). The render guard must turn that into a
  // loud failure instead of a blank PNG.
  writeFileSync(join(dir, "landmine.drawio"), HELLO_DRAWIO.replace('id="2"', 'id="map"'));
  runExpectingFailure(
    ["render", join(dir, "landmine.drawio"), "--png", join(dir, "landmine.drawio.png")],
    "rejected the input silently",
  );

  // lint: a pinned orthogonal edge passes, a pinned diagonal fails.
  const lintable = (entryX) => `<mxfile><diagram id="l" name="l"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="a" value="A" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="100" y="40" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="100" y="240" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="e" style="html=1;strokeWidth=2;exitX=0.5;exitY=1;entryX=${entryX};entryY=0;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  writeFileSync(join(dir, "straight.drawio"), lintable("0.5"));
  writeFileSync(join(dir, "diagonal.drawio"), lintable("0.9"));
  run(["lint", join(dir, "straight.drawio"), "--strict"]);
  runExpectingFailure(["lint", join(dir, "diagonal.drawio")], "DIAGONAL");

  // Two stacked parallel runs slightly out of column surface as an advisory note
  // (never failing: the offset may be anchor-caused, which only an eyeball can tell).
  const stacked = `<mxfile><diagram id="s" name="s"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="a" value="A" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="100" y="20" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="200" y="140" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="c" value="C" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="100" y="220" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="d" value="D" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="220" y="380" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="e1" style="html=1;strokeWidth=2;exitX=0.5;exitY=1;entryX=0;entryY=0.5;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="130" y="160" /></Array></mxGeometry></mxCell>
    <mxCell id="e2" style="html=1;strokeWidth=2;exitX=0.7;exitY=1;entryX=0;entryY=0.5;" edge="1" parent="1" source="c" target="d"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="142" y="400" /></Array></mxGeometry></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  writeFileSync(join(dir, "stacked.drawio"), stacked);
  const stackedResult = run(["lint", join(dir, "stacked.drawio"), "--strict"]);
  assert.ok(
    stackedResult.stderr.includes("out of column"),
    `stacked runs should surface an out-of-column note, got:\n${stackedResult.stderr}`,
  );

  // Same-colour edges properly crossing each other must fail lint; a T-junction must not.
  const crossing = `<mxfile><diagram id="x" name="x"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="a" value="A" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="20" y="80" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="320" y="80" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="c" value="C" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="170" y="0" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="d" value="D" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="170" y="200" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="e1" style="html=1;strokeWidth=2;strokeColor=#E73F74;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
    <mxCell id="e2" style="html=1;strokeWidth=2;strokeColor=#E73F74;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" edge="1" parent="1" source="c" target="d"><mxGeometry relative="1" as="geometry" /></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  writeFileSync(join(dir, "selfcross.drawio"), crossing);
  runExpectingFailure(["lint", join(dir, "selfcross.drawio")], "same-colour");
  // Different colours crossing is legal.
  writeFileSync(join(dir, "crosscolour.drawio"), crossing.replace('strokeColor=#E73F74;exitX=0.5', 'strokeColor=#3969AC;exitX=0.5'));
  run(["lint", join(dir, "crosscolour.drawio"), "--strict"]);

  // A cramped lead into the arrowhead (corner 12 units before landing) must fail.
  const cramped = `<mxfile><diagram id="t" name="t"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="a" value="A" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="220" y="150" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="e" style="html=1;strokeWidth=2;exitX=0.5;exitY=1;entryX=0;entryY=0.5;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="50" y="170" /><mxPoint x="208" y="170" /></Array></mxGeometry></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  writeFileSync(join(dir, "cramped.drawio"), cramped);
  runExpectingFailure(["lint", join(dir, "cramped.drawio")], "into the arrowhead");

  // A backgroundless label crossed by its own edge's vertical run is a
  // touching knockout gap: advisory note. A background colour silences it.
  const ownEdgeLabel = (labelStyle) => `<mxfile><diagram id="o" name="o"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="a" value="A" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="100" y="40" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="100" y="240" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="e" style="html=1;strokeWidth=2;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
    <mxCell id="el" value="own edge label" style="${labelStyle}" vertex="1" connectable="0" parent="e"><mxGeometry x="0" relative="1" as="geometry" /></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  writeFileSync(join(dir, "ownlabel.drawio"), ownEdgeLabel("edgeLabel;html=1;"));
  const ownLabelResult = run(["lint", join(dir, "ownlabel.drawio"), "--strict"]);
  assert.ok(
    ownLabelResult.stderr.includes("touching knockout gap"),
    `backgroundless own-edge label should surface a note, got:\n${ownLabelResult.stderr}`,
  );
  writeFileSync(join(dir, "ownlabel-bg.drawio"), ownEdgeLabel("edgeLabel;html=1;labelBackgroundColor=#FFFFFF;"));
  const ownLabelBg = run(["lint", join(dir, "ownlabel-bg.drawio"), "--strict"]);
  assert.ok(
    !ownLabelBg.stderr.includes("touching knockout gap"),
    `a label with a background must not be flagged, got:\n${ownLabelBg.stderr}`,
  );

  // cells and styles reports render without dumping base64.
  const cellsOut = run(["cells", source]).stdout;
  assert.ok(cellsOut.includes("SHAPE") && cellsOut.includes("EDGE"), "cells report lacks shapes or edges");
  assert.ok(!cellsOut.includes("iVBOR"), "cells report leaks base64");
  const stylesOut = run(["styles", source]).stdout;
  assert.ok(stylesOut.includes("rounded=0"), "styles report lacks style strings");

  // extract --elide-images turns payloads into size markers (stdout by default,
  // never onto the input path), --decode-entities makes apostrophes greppable.
  const iconCell = '<mxCell id="ic" value="" style="shape=image;image=data:image/png,iVBORw0KGgoAAAANSUhEUg%2BAAAA;" vertex="1" parent="1"><mxGeometry x="500" y="40" width="20" height="20" as="geometry" /></mxCell>';
  const withIcon = HELLO_DRAWIO.replace('value="Hello"', 'value="It&#39;s Hello"').replace("</root>", `${iconCell}</root>`);
  const iconSource = join(dir, "icon.drawio");
  writeFileSync(iconSource, withIcon);
  const elided = run(["extract", iconSource, "--elide-images"]).stdout;
  assert.ok(!elided.includes("iVBOR"), "elide left the base64 payload in place");
  assert.ok(elided.includes("[elided"), "elide did not mark the removed payload");
  assert.ok(elided.includes("&#39;"), "elide alone must not touch entities");
  runExpectingFailure(
    ["extract", iconSource, "--elide-images", "-o", iconSource],
    "refusing to overwrite the input",
  );
  const decoded = run(["extract", iconSource, "--elide-images", "--decode-entities"]).stdout;
  assert.ok(decoded.includes("It's Hello"), "decode-entities left &#39; encoded");
  assert.ok(decoded.includes("&lt;") || !withIcon.includes("&lt;"), "structural entities must stay encoded");

  // Edge-label collision notes: a riding label whose estimated box sits on
  // another edge's run gets a note, and two stacked labels get a pair note.
  const labelled = (labelY) => `<mxfile><diagram id="lb" name="lb"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="a" value="A" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="20" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="c" value="C" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="20" y="${labelY}" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="d" value="D" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="${labelY}" width="60" height="40" as="geometry" /></mxCell>
    <mxCell id="e1" style="html=1;strokeWidth=2;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
    <mxCell id="e2" style="html=1;strokeWidth=2;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="c" target="d"><mxGeometry relative="1" as="geometry" /></mxCell>
    <mxCell id="e2l" value="a fairly long riding label" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="e2"><mxGeometry x="0" relative="1" as="geometry"><mxPoint x="0" y="OFFSET" as="offset" /></mxGeometry></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  // Label pushed up from its own edge (y=labelY+20) onto e1's run at y=40.
  const collideY = 70; // e2 run at y=90, offset -50 puts the label box across y=40
  writeFileSync(join(dir, "labelhit.drawio"), labelled(collideY).replace('y="OFFSET"', 'y="-50"'));
  const hit = run(["lint", join(dir, "labelhit.drawio"), "--strict"]);
  assert.ok(hit.stderr.includes("estimated box of label"), `expected a label-strike note, got:\n${hit.stderr}`);
  // The same label left in place on its own edge produces no label note.
  writeFileSync(join(dir, "labelclean.drawio"), labelled(300).replace('y="OFFSET"', 'y="0"'));
  const clean = run(["lint", join(dir, "labelclean.drawio"), "--strict"]);
  assert.ok(!clean.stderr.includes("estimated box"), `clean label wrongly flagged:\n${clean.stderr}`);

  // measure: a rendered box with known text reports its pixel-true padding.
  const measurable = `<mxfile><diagram id="m" name="m"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="frame" value="" style="rounded=0;html=1;fillColor=none;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="400" height="200" as="geometry" /></mxCell>
    <mxCell id="padded" value="MEASURED" style="rounded=0;whiteSpace=wrap;html=1;align=left;spacingLeft=20;" vertex="1" parent="1"><mxGeometry x="100" y="60" width="200" height="60" as="geometry" /></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const msource = join(dir, "measured.drawio");
  writeFileSync(msource, measurable);
  run(["render", msource, "--png", "--scale", "3", "--border", "10"]);
  const mOut = run(["measure", join(dir, "measured.drawio.png"), "--cell", "padded", "--scale", "3", "--border", "10"]).stdout;
  assert.match(mOut, /calibration: scale=3 border=10/, "measure lacks the calibration line");
  const padMatch = mOut.match(/padding L=([\d.]+)/);
  assert.ok(padMatch, `measure lacks a padding readout:\n${mOut}`);
  const left = Number(padMatch[1]);
  assert.ok(left > 12 && left < 28, `spacingLeft=20 should measure ~20u of left padding, got ${left}`);

  console.log("smoke test passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
