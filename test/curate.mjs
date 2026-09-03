import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The curation marker and its mandate check, case by case: curate is
// idempotent and reversible byte-for-byte, cells and lint banner a curated
// model, and guard-diff convicts every kind of unauthorised change (value,
// style, geometry, waypoints, added and removed cells) while letting
// allow-listed ones through. The render round-trip of the marker itself lives
// in test/smoke.mjs, beside the renderer.

const testDir = dirname(fileURLToPath(import.meta.url));
const cli = join(dirname(testDir), "src", "cli.js");

const FIXTURE = `<mxfile>
  <diagram name="fixture" id="curate-test">
    <mxGraphModel dx="800" dy="600" grid="0" page="1" pageWidth="850" pageHeight="1100">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="box-a" value="A" style="rounded=0;html=1;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="box-b" value="B" style="rounded=1;html=1;" vertex="1" parent="1">
          <mxGeometry x="240" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="wire" style="edgeStyle=orthogonalEdgeStyle;html=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="box-a" target="box-b">
          <mxGeometry relative="1" as="geometry">
            <Array as="points"><mxPoint x="200" y="70" /></Array>
          </mxGeometry>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

function run(args, expectStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    expectStatus,
    `drawio-cli ${args.join(" ")} exited ${result.status}, want ${expectStatus}\n${result.stderr}\n${result.stdout}`,
  );
  return result;
}

const dir = mkdtempSync(join(tmpdir(), "curate-"));
try {
  const file = join(dir, "fixture.drawio");
  writeFileSync(file, FIXTURE);

  // Curate on, idempotent, and off restores the original bytes.
  run(["curate", file]);
  const marked = readFileSync(file, "utf8");
  assert.match(marked, /<mxCell id="curated" value="CURATED:[^"]*" parent="1" \/>/);
  run(["curate", file]);
  assert.equal(readFileSync(file, "utf8"), marked, "second curate must be a byte-identical no-op");
  run(["curate", file, "--off"]);
  assert.equal(readFileSync(file, "utf8"), FIXTURE, "curate --off must restore the original bytes");
  run(["curate", file, "--off"]);
  assert.equal(readFileSync(file, "utf8"), FIXTURE, "second --off stays a no-op");
  writeFileSync(file, marked);

  // cells and lint banner the curated model; the unmarked fixture stays quiet.
  assert.match(run(["cells", file]).stderr, /CURATED diagram:/);
  const lintRun = run(["lint", file]);
  assert.match(lintRun.stderr, /CURATED diagram:/);
  assert.match(lintRun.stdout, /0 error\(s\)/);
  const plain = join(dir, "plain.drawio");
  writeFileSync(plain, FIXTURE);
  assert.ok(!run(["cells", plain]).stderr.includes("CURATED"), "unmarked model must not banner");

  // guard-diff: identical files pass strict.
  const strictSame = run(["guard-diff", file, file]);
  assert.match(strictSame.stdout, /0 violation\(s\) \(strict: no ids allowed to change\)/);

  // One edit per violation kind, all in a single edited copy.
  const edited = join(dir, "edited.drawio");
  writeFileSync(
    edited,
    marked
      .replace('value="A"', 'value="A2"') // value change (will be allowed)
      .replace("rounded=1;html=1;", "rounded=1;html=1;fillColor=#ffcccc;") // style change (violation)
      .replace('x="200" y="70"', 'x="210" y="70"') // waypoint change (violation)
      .replace(
        "</root>",
        '<mxCell id="stray" value="new" style="text;html=1;" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry" /></mxCell></root>',
      ), // added cell (violation)
  );
  const caught = run(["guard-diff", file, edited, "--allow", "box-a"], 1);
  assert.match(caught.stdout, /allowed box-a: value/);
  assert.match(caught.stdout, /VIOLATION box-b: style/);
  assert.match(caught.stdout, /VIOLATION wire: waypoints/);
  assert.match(caught.stdout, /VIOLATION stray: added/);
  assert.match(caught.stdout, /1 allowed change\(s\), 3 violation\(s\)/);

  // The same edit passes once every changed id is on the allow-list, and a
  // removed cell is convicted like an added one.
  run(["guard-diff", file, edited, "--allow", "box-a", "--allow", "box-b", "--allow", "wire", "--allow", "stray"]);
  const removed = join(dir, "removed.drawio");
  writeFileSync(removed, marked.replace(/<mxCell id="box-b"[\s\S]*?<\/mxCell>\n/, ""));
  const gone = run(["guard-diff", file, removed], 1);
  assert.match(gone.stdout, /VIOLATION box-b: removed/);

  // Unmarking the diagram is itself a change guard-diff sees.
  const unmarked = join(dir, "unmarked.drawio");
  writeFileSync(unmarked, FIXTURE);
  const stripped = run(["guard-diff", file, unmarked], 1);
  assert.match(stripped.stdout, /VIOLATION curated: removed/);

  console.log("curate and guard-diff tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
