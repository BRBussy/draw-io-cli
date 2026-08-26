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

  // cells --xml: one cell's element sliced out of the file's own bytes, so a
  // substring copied from it matches the file during string surgery. The
  // report forms cannot do this: extract's XML is the webapp's spelling of the
  // model, with its own attribute order and its own `/>` spacing.
  const sliced = run(["cells", source, "--xml", "2"]).stdout.replace(/\n$/, "");
  assert.ok(sliced.includes('id="2"') && sliced.includes("<mxGeometry"), `--xml must slice the whole element, got:\n${sliced}`);
  assert.ok(HELLO_DRAWIO.includes(sliced), `--xml must be byte-verbatim source, got:\n${sliced}`);
  assert.ok(
    !readFileSync(join(dir, "roundtrip.drawio"), "utf8").includes(sliced),
    "the re-serialised model spells this cell identically, so --xml has nothing to solve here: pick a cell the webapp respells",
  );
  // An id held by a wrapper element slices the wrapper, never a headless mxCell.
  const wrapped = `<mxfile><diagram id="w" name="w"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <object id="ob" label="wrapped"><mxCell style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></object>
  </root></mxGraphModel></diagram></mxfile>`;
  writeFileSync(join(dir, "wrapped.drawio"), wrapped);
  const wrappedSlice = run(["cells", join(dir, "wrapped.drawio"), "--xml", "ob"]).stdout;
  assert.ok(wrappedSlice.startsWith("<object") && wrappedSlice.includes("</object>"), `--xml must slice the id-bearing wrapper whole, got:\n${wrappedSlice}`);
  // A 32KB base64 style would flood the output, so --elide-images marks it the
  // way extract does, and the surrounding bytes stay untouched.
  const imageCell = '<mxCell id="ic" value="" style="shape=image;image=data:image/png,iVBORw0KGgoAAAANSUhEUg%2BAAAA;" vertex="1" parent="1"><mxGeometry x="500" y="40" width="20" height="20" as="geometry"/></mxCell>';
  writeFileSync(join(dir, "xmlicon.drawio"), HELLO_DRAWIO.replace("</root>", `${imageCell}</root>`));
  const elidedSlice = run(["cells", join(dir, "xmlicon.drawio"), "--xml", "ic", "--elide-images"]).stdout;
  assert.ok(!elidedSlice.includes("iVBOR"), "cells --xml --elide-images left the base64 payload in place");
  assert.ok(elidedSlice.includes("[elided") && elidedSlice.includes('as="geometry"/>'), `elided slice must keep the source's own spelling, got:\n${elidedSlice}`);
  // An id nobody carries, and an id two elements carry, both fail loudly.
  runExpectingFailure(["cells", source, "--xml", "nosuch"], 'no element carries id="nosuch"');
  writeFileSync(join(dir, "twins.drawio"), HELLO_DRAWIO.replace('id="3"', 'id="2"'));
  runExpectingFailure(["cells", join(dir, "twins.drawio"), "--xml", "2"], '2 elements carry id="2"');
  // The table's flags and the slice's flags are not interchangeable.
  runExpectingFailure(["cells", source, "--xml", "2", "--full"], "different reports");
  runExpectingFailure(["cells", source, "--elide-images"], "belongs to cells --xml");

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
  const straightResult = run(["lint", join(dir, "straight.drawio"), "--strict"]);
  runExpectingFailure(["lint", join(dir, "diagonal.drawio")], "DIAGONAL");
  // A label check with an empty input set is vacuous, not green, and must say so
  // rather than let a diagram with no edge labels read as three checks passed.
  assert.ok(
    straightResult.stderr.includes("carries 0 edge labels") &&
      straightResult.stderr.includes("(vacuous, not green)"),
    `a label-free diagram must declare the label checks vacuous, got:\n${straightResult.stderr}`,
  );

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

  // The edge-label golden rules, all advisory. Each fixture below is the clean
  // seat with ONE rule broken, so a check that stops firing shows up here as a
  // planted violation nobody reports.
  const ACTOR_LABEL = "&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Reads the ledger";
  // Vertical run at x=160 between y=100 and y=240, the label riding it.
  const ridingVertical = (offsetX, align, value = ACTOR_LABEL) => `<mxfile><diagram id="o" name="o"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="a" value="A" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="100" y="40" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="100" y="240" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="e" style="html=1;strokeWidth=2;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
    <mxCell id="el" value="${value}" style="edgeLabel;html=1;align=${align};" vertex="1" connectable="0" parent="e"><mxGeometry x="0" relative="1" as="geometry"><mxPoint x="${offsetX}" y="0" as="offset" /></mxGeometry></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  // Horizontal run at y=170 between x=160 and x=360, the label riding it.
  const ridingHorizontal = (align, value = ACTOR_LABEL) => `<mxfile><diagram id="p" name="p"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="a" value="A" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="140" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="360" y="140" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="e" style="html=1;strokeWidth=2;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
    <mxCell id="el" value="${value}" style="edgeLabel;html=1;align=${align};" vertex="1" connectable="0" parent="e"><mxGeometry x="0" relative="1" as="geometry" /></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const lintNotes = (name, xml) => {
    writeFileSync(join(dir, `${name}.drawio`), xml);
    return run(["lint", join(dir, `${name}.drawio`), "--strict"]).stderr;
  };

  // Run-through-centre: straddling the run centred is the sanctioned seat, and
  // so is sitting clear on a vertical run's LEFT.
  const seatClean = lintNotes("seat-centred", ridingVertical(0, "center"));
  assert.ok(!seatClean.includes("RIGHT") && !seatClean.includes("midpoint"), `a centred riding label must not be flagged, got:\n${seatClean}`);
  // The clean fixture must reach the checks, not pass them by being empty.
  assert.ok(!seatClean.includes("vacuous"), `the seat fixture's labels must reach the checks, got:\n${seatClean}`);
  const seatLeft = lintNotes("seat-left", ridingVertical(60, "center"));
  assert.ok(!seatLeft.includes("RIGHT") && !seatLeft.includes("midpoint"), `a label clear on the run's left must not be flagged, got:\n${seatLeft}`);
  // Planted: slide the label left, which puts the run on its right.
  const seatRight = lintNotes("seat-right", ridingVertical(-60, "center"));
  assert.ok(seatRight.includes("clear on the label's RIGHT"), `a run on the label's right must be flagged, got:\n${seatRight}`);
  // Planted: slide it just far enough to cut the text off-centre.
  const seatOff = lintNotes("seat-offcentre", ridingVertical(-20, "center"));
  assert.ok(seatOff.includes("off the horizontal midpoint"), `an off-centre crossing must be flagged, got:\n${seatOff}`);
  // Planted: slide it right off its run altogether.
  const seatAdrift = lintNotes("seat-adrift", ridingVertical(200, "center"));
  assert.ok(seatAdrift.includes("too far to ride or to sit alongside"), `an adrift label must be flagged, got:\n${seatAdrift}`);

  // Alignment follows the crossing axis: center on a vertical run, left on a
  // horizontal one. A missing token counts as the webapp default, center.
  assert.ok(!lintNotes("align-v-ok", ridingVertical(0, "center")).includes("wants align"), "align=center on a vertical run must pass");
  assert.ok(!lintNotes("align-h-ok", ridingHorizontal("left")).includes("wants align"), "align=left on a horizontal run must pass");
  const alignV = lintNotes("align-v-bad", ridingVertical(0, "left"));
  assert.ok(alignV.includes("wants align=center"), `align=left on a vertical run must be flagged, got:\n${alignV}`);
  const alignH = lintNotes("align-h-bad", ridingHorizontal("center"));
  assert.ok(alignH.includes("wants align=left"), `align=center on a horizontal crossing must be flagged, got:\n${alignH}`);

  // Format: bold colon-terminated first line over a capitalised body. A label
  // whose whole text is a call expression is code, and exempt.
  assert.ok(!lintNotes("fmt-ok", ridingHorizontal("left")).includes("colon-terminated"), "a well-formed label must not be flagged");
  const fmtCode = lintNotes("fmt-code", ridingHorizontal("left", "transfer(&lt;b&gt;vaultEvmAddress&lt;/b&gt;, amount)"));
  assert.ok(!fmtCode.includes("colon-terminated"), `a code label must be exempt, got:\n${fmtCode}`);
  const fmtBad = lintNotes("fmt-bad", ridingHorizontal("left", "reads the ledger"));
  for (const needle of ["is not fully bold", "is not colon-terminated", "no body under its first line"]) {
    assert.ok(fmtBad.includes(needle), `a malformed label should report "${needle}", got:\n${fmtBad}`);
  }

  // Editor junk is a WARNING, so --strict fails on it. The palette's Menlo code
  // scaffold and the plain colour spans nested in it stay sanctioned.
  const junkDiagram = (value) => `<mxfile><diagram id="j" name="j"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="n" value="${value}" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="200" height="40" as="geometry" /></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const SCAFFOLD = "&lt;div style=&quot;font-family: Menlo, Monaco, &amp;#39;Courier New&amp;#39;, monospace; font-size: 12px; line-height: 18px; white-space: pre;&quot;&gt;&lt;span style=&quot;color: rgb(175, 0, 219);&quot;&gt;ledger&lt;/span&gt;&lt;span style=&quot;color: rgb(32, 32, 32);&quot;&gt; &lt;b&gt;vaultEvmAddress&lt;/b&gt;&lt;/span&gt;&lt;/div&gt;";
  writeFileSync(join(dir, "junk-clean.drawio"), junkDiagram(SCAFFOLD));
  const junkClean = run(["lint", join(dir, "junk-clean.drawio"), "--strict"]);
  assert.ok(!junkClean.stderr.includes("editor-injected"), `the palette code scaffold must stay sanctioned, got:\n${junkClean.stderr}`);
  assert.ok(!junkClean.stderr.includes("editor junk: this diagram"), `the junk fixture's value must reach the check, got:\n${junkClean.stderr}`);
  for (const [name, planted, token] of [
    ["junk-scrollbar", "&lt;b style=&quot;scrollbar-color: rgb(226, 226, 226) rgb(251, 251, 251);&quot;&gt;MPC:&lt;/b&gt;", "scrollbar-color"],
    ["junk-lightdark", "&lt;span style=&quot;background-color: light-dark(#ffffff, #121212);&quot;&gt;MPC&lt;/span&gt;", "light-dark("],
    ["junk-colour", "&lt;span style=&quot;color: rgb(0, 0, 0);&quot;&gt;MPC&lt;/span&gt;", "color: rgb(0, 0, 0)"],
  ]) {
    writeFileSync(join(dir, `${name}.drawio`), junkDiagram(planted));
    runExpectingFailure(["lint", join(dir, `${name}.drawio`), "--strict"], `editor-injected inline CSS in its value ("${token}")`);
  }

  // A swatch edge connects two degenerate specimen points, so its label is a
  // legend caption naming the style it demonstrates: exempt from alignment and
  // format, still held to its seat. The control below is the same label on an
  // edge with real endpoints, where both rules apply.
  const swatch = (endpointSize, offsetX) => `<mxfile><diagram id="w" name="w"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="src" value="" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="200" y="100" width="${endpointSize}" height="${endpointSize}" as="geometry" /></mxCell>
    <mxCell id="tgt" value="" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="200" y="300" width="${endpointSize}" height="${endpointSize}" as="geometry" /></mxCell>
    <mxCell id="e" style="html=1;strokeWidth=2;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" edge="1" parent="1" source="src" target="tgt"><mxGeometry relative="1" as="geometry" /></mxCell>
    <mxCell id="el" value="request phase" style="edgeLabel;html=1;align=left;" vertex="1" connectable="0" parent="e"><mxGeometry x="0" relative="1" as="geometry"><mxPoint x="${offsetX}" y="0" as="offset" /></mxGeometry></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const specimenSeated = lintNotes("swatch-specimen", swatch(1, 0));
  assert.ok(!specimenSeated.includes("wants align"), `a legend caption on a specimen edge must be exempt from alignment, got:\n${specimenSeated}`);
  assert.ok(!specimenSeated.includes("colon-terminated"), `a legend caption on a specimen edge must be exempt from format, got:\n${specimenSeated}`);
  // Exempting every label is lost coverage, not two rules held.
  assert.ok(
    specimenSeated.includes("1 legend caption(s) on specimen edges exempt") && specimenSeated.includes("(vacuous, not green)"),
    `an all-specimen diagram must declare the exempted checks vacuous, got:\n${specimenSeated}`,
  );
  // Seating still applies to a specimen: its run may not sit on the caption's right.
  const specimenCrooked = lintNotes("swatch-crooked", swatch(1, -60));
  assert.ok(specimenCrooked.includes("clear on the label's RIGHT"), `a crooked legend caption must still be flagged, got:\n${specimenCrooked}`);
  // The control: real endpoints make the same label a description again.
  const swatchControl = lintNotes("swatch-control", swatch(60, 0));
  assert.ok(swatchControl.includes("wants align=center"), `a label on an edge with real endpoints must be aligned, got:\n${swatchControl}`);
  assert.ok(swatchControl.includes("is not colon-terminated"), `a label on an edge with real endpoints must be formatted, got:\n${swatchControl}`);

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

  // measure --fit: the box the uniform padding rule implies for the ink just
  // measured, and how far the declared box is from it. The expectation is
  // recomputed here from the ink the same run reported, so a fit that stopped
  // following the rule cannot pass by agreeing with itself.
  const fitOut = run(["measure", join(dir, "measured.drawio.png"), "--fit", "padded", "--scale", "3", "--border", "10"]).stdout;
  const inkMatch = fitOut.match(/cell padded: .*ink ([\d.]+)x([\d.]+)u/);
  assert.ok(inkMatch, `--fit must measure the cell as usual first:\n${fitOut}`);
  const [inkW, inkH] = [Number(inkMatch[1]), Number(inkMatch[2])];
  assert.ok(inkW > 0 && inkH > 0, "the fit fixture must have ink to size against");
  const round1 = (n) => Math.round(n * 10) / 10;
  const expected =
    `fit padded: ink ${inkW}x${inkH}u + padding 8u L/R 6u T/B -> implied box ` +
    `${round1(inkW + 16)}x${round1(inkH + 12)}u, declared 200x60u, ` +
    `delta ${round1(inkW + 16 - 200)}x${round1(inkH + 12 - 60)}u`;
  assert.ok(fitOut.includes(expected), `fit line should read "${expected}", got:\n${fitOut}`);
  // A fit id needs no --cell of its own, and an edge label has no declared box to fit.
  const fitLabel = run(["measure", join(dir, "hello.drawio.png"), "--fit", "4l"]).stdout;
  assert.match(fitLabel, /fit 4l: an edge label declares no box/, "a fit on an edge label must say there is nothing to fit");

  // measure --affine: the model-to-pixel mapping written out, per axis and both
  // ways. The numbers are re-derived here from the calibration line of the same
  // run, so an affine drifting from the calibration it claims to publish fails.
  const affineOut = run(["measure", join(dir, "measured.drawio.png"), "--affine", "--scale", "3", "--border", "10"]).stdout;
  const cal = affineOut.match(/model=\((-?[\d.]+),(-?[\d.]+)\).* residual=(-?\d+),(-?\d+)px/);
  assert.ok(cal, `--affine must still print the calibration it derives from:\n${affineOut}`);
  const [minX, minY, resW, resH] = cal.slice(1, 5).map(Number);
  const offX = 10 * 3 + Math.trunc(resW / 2);
  const offY = 10 * 3 + Math.trunc(resH / 2);
  for (const line of [
    `affine x: px = (mx - ${minX}) * 3 + ${offX}`,
    `affine x: mx = (px - ${offX}) / 3 + ${minX}`,
    `affine y: py = (my - ${minY}) * 3 + ${offY}`,
    `affine y: my = (py - ${offY}) / 3 + ${minY}`,
  ]) {
    assert.ok(affineOut.includes(line), `affine should publish "${line}", got:\n${affineOut}`);
  }
  // --affine stands alone: it is the mapping, not a measurement of any cell.
  assert.ok(!affineOut.includes("cell "), `--affine alone must measure nothing, got:\n${affineOut}`);
  runExpectingFailure(["measure", join(dir, "measured.drawio.png")], "measure needs at least one");

  // A residual attributed to named label overhangs and no wider than the render
  // border's own pixel slack is a known, harmless mismatch: a one-line note, not
  // the warning an agent learns to grep away. The same PNG read against a border
  // too small to absorb it warns as before.
  const overhanging = `<mxfile><diagram id="oh" name="oh"><mxGraphModel><root>
    <mxCell id="0" /><mxCell id="1" parent="0" />
    <mxCell id="a" value="A" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="300" y="40" width="120" height="60" as="geometry" /></mxCell>
    <mxCell id="e" style="html=1;strokeWidth=2;exitX=1;exitY=1;entryX=0;entryY=1;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
    <mxCell id="el" value="hop" style="edgeLabel;html=1;align=center;" vertex="1" connectable="0" parent="e"><mxGeometry x="0" relative="1" as="geometry" /></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const ohSource = join(dir, "overhang.drawio");
  writeFileSync(ohSource, overhanging);
  run(["render", ohSource, "--png", "--scale", "3", "--border", "25"]);
  const ohPng = join(dir, "overhang.drawio.png");
  const demoted = run(["measure", ohPng, "--cell", "a", "--scale", "3", "--border", "25"]).stdout;
  assert.match(demoted, /calibration: note residual -?\d+,-?\d+px is within the render border \(25u = 75px\) and attributed\. Estimated edge-label overhangs: el /, `an attributed residual inside the border must demote to a note, got:\n${demoted}`);
  assert.ok(!demoted.includes("WARNING"), `a demoted residual must not also warn, got:\n${demoted}`);
  // Same pixels, a border too small to absorb the same overhang: still a warning.
  const loud = run(["measure", ohPng, "--cell", "a", "--scale", "3", "--border", "10"]).stdout;
  assert.ok(loud.includes("calibration: WARNING") && loud.includes("overhangs: el "), `a residual past the border must stay a warning, got:\n${loud}`);
  // Small but unattributed (no edge labels at all, so the suspects are a guess):
  // never demoted, since nothing has explained it.
  const vague = run(["measure", join(dir, "measured.drawio.png"), "--cell", "padded", "--scale", "3", "--border", "12"]).stdout;
  assert.ok(vague.includes("calibration: WARNING") && vague.includes("Bounds are set by"), `an unattributed residual must stay a warning, got:\n${vague}`);
  // --quiet-calibration drops the line and the note, and keeps the warning: it
  // is the error bar on every number under it.
  const quiet = run(["measure", ohPng, "--cell", "a", "--scale", "3", "--border", "25", "--quiet-calibration"]).stdout;
  assert.ok(!quiet.includes("calibration:"), `--quiet-calibration must drop the calibration lines, got:\n${quiet}`);
  assert.ok(quiet.includes("cell a: box"), "--quiet-calibration must keep the measurements");
  const quietLoud = run(["measure", ohPng, "--cell", "a", "--scale", "3", "--border", "10", "--quiet-calibration"]).stdout;
  assert.ok(quietLoud.includes("calibration: WARNING"), `--quiet-calibration must never hide a warning, got:\n${quietLoud}`);

  console.log("smoke test passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
