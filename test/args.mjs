import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Argument parsing, verb by verb: which flags each verb takes, which
// invocations it must refuse, and which stream each answer leaves on. One
// render is needed, for the scale/border defaults a measurement reads back.

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);
const cli = join(repoRoot, "src", "cli.js");

const FIXTURE = `<mxfile>
  <diagram name="fixture" id="args-test">
    <mxGraphModel dx="800" dy="600" grid="0" page="1" pageWidth="850" pageHeight="1100">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="frame" value="" style="rounded=0;html=1;fillColor=none;" vertex="1" parent="1">
          <mxGeometry x="0" y="0" width="400" height="200" as="geometry" />
        </mxCell>
        <mxCell id="padded" value="MEASURED" style="rounded=0;whiteSpace=wrap;html=1;align=left;spacingLeft=20;" vertex="1" parent="1">
          <mxGeometry x="100" y="60" width="200" height="60" as="geometry" />
        </mxCell>
        <mxCell id="other" value="OTHER" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="100" y="140" width="120" height="40" as="geometry" />
        </mxCell>
        <mxCell id="e" style="html=1;strokeWidth=2;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" edge="1" parent="1" source="padded" target="other">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="el" value="&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Reads the ledger" style="edgeLabel;html=1;align=center;verticalAlign=middle;" vertex="1" connectable="0" parent="e">
          <mxGeometry x="0" relative="1" as="geometry">
            <mxPoint x="4" y="0" as="offset" />
          </mxGeometry>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

// A source whose points array and offset point are spelled other than the
// canonical forms the editing verbs splice in: a double space before the
// attribute, and a separate closing tag where the canonical point self-closes.
const ODD_SPELLING = `<mxfile>
  <diagram name="odd" id="odd-test">
    <mxGraphModel dx="800" dy="600" grid="0" page="1" pageWidth="850" pageHeight="1100">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="e" style="html=1;" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <Array  as="points">
              <mxPoint x="10" y="10" />
            </Array>
          </mxGeometry>
        </mxCell>
        <mxCell id="el" value="LABEL" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="e">
          <mxGeometry x="0" relative="1" as="geometry">
            <mxPoint x="4" y="0" as="offset"></mxPoint>
          </mxGeometry>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

// The model a desktop-saved .drawio hides inside a compressed payload. It
// carries a planted violation (an id the webapp reserves) that only a reader
// which uncompresses can ever see.
const COMPRESSED_MODEL = `<mxGraphModel dx="800" dy="600" grid="0" page="1" pageWidth="850" pageHeight="1100">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="map" value="POISONED" style="rounded=0;whiteSpace=wrap;html=1;spacingLeft=13;" vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="160" height="60" as="geometry" />
    </mxCell>
  </root>
</mxGraphModel>`;

/** Wraps a model the way the desktop app stores it: deflated, base64, URL-encoded. */
function compressedMxfile(model) {
  const payload = deflateRawSync(Buffer.from(encodeURIComponent(model), "utf8")).toString("base64");
  return `<mxfile host="Electron" version="24.7.17">\n  <diagram name="packed" id="packed-1">${payload}</diagram>\n</mxfile>\n`;
}

let passed = 0;

function invoke(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

/**
 * Runs the CLI with the playwright package made unresolvable, the state of a
 * checkout that never installed it. The resolve hook stands in for renaming
 * the directory away, so the suite never mutates node_modules.
 */
function invokeWithoutPlaywright(args) {
  const hider = join(testDir, "hide-playwright.mjs");
  return spawnSync(process.execPath, ["--import", pathToFileURL(hider).href, cli, ...args], {
    encoding: "utf8",
  });
}

/** Asserts the invocation succeeds, and hands back its streams. */
function succeeds(name, args) {
  const result = invoke(args);
  assert.equal(result.status, 0, `${name}: expected exit 0 from "${args.join(" ")}", got ${result.status}\n${result.stderr}`);
  passed += 1;
  console.log(`ok  ${name}`);
  return result;
}

/**
 * Asserts the invocation fails loudly: a nonzero exit, the needle on stderr,
 * and nothing on stdout, so a refused run can never read as a report.
 */
function failsLoudly(name, args, needle) {
  const result = invoke(args);
  assert.notEqual(result.status, 0, `${name}: "${args.join(" ")}" unexpectedly succeeded\n${result.stdout}`);
  assert.ok(
    result.stderr.includes(needle),
    `${name}: stderr should mention "${needle}", got:\n${result.stderr}`,
  );
  assert.equal(result.stdout, "", `${name}: a refused run must print no report, got:\n${result.stdout}`);
  passed += 1;
  console.log(`ok  ${name}`);
  return result;
}

const dir = mkdtempSync(join(tmpdir(), "drawio-cli-args-"));
try {
  const source = join(dir, "fixture.drawio");
  writeFileSync(source, FIXTURE);
  const missing = join(dir, "absent.drawio");
  const missingPng = join(dir, "absent.drawio.png");

  // ---------------------------------------------------------------- measure
  // Repeatable id options accumulate, and every id is measured.
  {
    // The config in this directory sets the render defaults the measurement
    // below reads back, so the render and the measure agree on the geometry.
    writeFileSync(join(dir, "drawio.config.json"), JSON.stringify({ render: { scale: 2, border: 8 } }));
    succeeds("render: writes the PNG the measure tests read", ["render", source, "--png"]);
    const png = join(dir, "fixture.drawio.png");
    assert.ok(existsSync(png), "render --png must write the sibling .drawio.png");

    const two = succeeds("measure: --cell repeats", ["measure", png, "--cell", "padded", "--cell", "frame"]);
    assert.ok(two.stdout.includes("cell padded:"), `--cell padded must be measured, got:\n${two.stdout}`);
    assert.ok(two.stdout.includes("cell frame:"), `a second --cell must be measured too, got:\n${two.stdout}`);

    const fit = succeeds("measure: --fit repeats and implies a measurement", ["measure", png, "--fit", "padded", "--fit", "other"]);
    assert.ok(fit.stdout.includes("fit padded:") && fit.stdout.includes("fit other:"), `both fits must report, got:\n${fit.stdout}`);
    assert.ok(fit.stdout.includes("cell padded:") && fit.stdout.includes("cell other:"), `a fit id is measured as a cell too, got:\n${fit.stdout}`);

    const gaps = succeeds("measure: --gaps repeats", ["measure", png, "--gaps", "padded", "--gaps", "other"]);
    assert.ok(gaps.stdout.includes("padded") && gaps.stdout.includes("other"), `both gap ids must reach the report, got:\n${gaps.stdout}`);

    // Scale and border default from the nearest drawio.config.json, and the
    // config note names the file that supplied them.
    const defaulted = succeeds("measure: scale and border default from drawio.config.json", ["measure", png, "--cell", "padded"]);
    assert.match(defaulted.stdout, /calibration: scale=2 border=8/, `config defaults must reach the calibration, got:\n${defaulted.stdout}`);
    assert.ok(
      defaulted.stderr.includes(`config: ${join(dir, "drawio.config.json")}`),
      `the config note must name the file, got:\n${defaulted.stderr}`,
    );
    // Both values given on the command line: the config has nothing to supply,
    // so the note stays quiet.
    const flagged = succeeds("measure: explicit scale and border silence the config note", ["measure", png, "--cell", "padded", "--scale", "2", "--border", "8"]);
    assert.ok(!flagged.stderr.includes("config:"), `explicit flags must silence the note, got:\n${flagged.stderr}`);
    assert.match(flagged.stdout, /calibration: scale=2 border=8/, "explicit flags must still calibrate");
    // One value given, the other still coming from the config: the note stands.
    const half = succeeds("measure: a half-given pair keeps the config note", ["measure", png, "--cell", "padded", "--scale", "2"]);
    assert.ok(half.stderr.includes("config:"), `a missing border still reads the config, got:\n${half.stderr}`);

    succeeds("measure: --affine alone needs no cell", ["measure", png, "--affine", "--scale", "2", "--border", "8"]);
    const quiet = succeeds("measure: --quiet-calibration drops the calibration line", ["measure", png, "--cell", "padded", "--quiet-calibration"]);
    assert.ok(!quiet.stdout.includes("calibration:"), `--quiet-calibration must drop the line, got:\n${quiet.stdout}`);
    assert.ok(quiet.stdout.includes("cell padded:"), "--quiet-calibration must keep the measurements");

    // A refused scale or border must stop the run before any measurement
    // prints. These cases use the rendered PNG on purpose: a measurable input
    // is what lets an unvalidated NaN reach the report as a calibration line
    // and a run of "no ink found" verdicts, under exit 0.
    failsLoudly("measure: --scale must be a number", ["measure", png, "--cell", "padded", "--scale", "abc"], "--scale must be a positive number");
    failsLoudly("measure: --scale must be positive", ["measure", png, "--cell", "padded", "--scale", "0"], "--scale must be a positive number");
    failsLoudly("measure: --border must be a number", ["measure", png, "--cell", "padded", "--border", "abc"], "--border must be a non-negative number");
    failsLoudly("measure: --border must be non-negative", ["measure", png, "--cell", "padded", "--border", "-1"], "--border must be a non-negative number");
  }

  // An id argument may never begin with a dash, on any of the three options.
  for (const flag of ["--cell", "--fit", "--gaps"]) {
    failsLoudly(
      `measure: ${flag} refuses a flag as an id`,
      ["measure", missingPng, flag, "--affine"],
      `${flag} requires a cell id (got --affine)`,
    );
  }

  // The first of the two invocation forms the hand parser got wrong: a
  // trailing --fit with no id must fail, never be swallowed.
  failsLoudly(
    "measure: a trailing --fit after --cell <id> fails loudly",
    ["measure", missingPng, "--cell", "padded", "--fit"],
    "--fit requires a cell id (got nothing)",
  );
  // The second: the flag that follows an id option is not an id.
  failsLoudly(
    "measure: --cell --fit never consumes the flag as an id",
    ["measure", missingPng, "--cell", "--fit"],
    "--cell requires a cell id (got --fit)",
  );

  failsLoudly("measure: refuses an empty request", ["measure", missingPng], "measure needs at least one --cell <id>");
  failsLoudly("measure: --scale needs a value", ["measure", missingPng, "--cell", "padded", "--scale"], "--scale requires a number");
  failsLoudly("measure: --border needs a value", ["measure", missingPng, "--cell", "padded", "--border"], "--border requires a number");
  failsLoudly("measure: refuses an unknown flag", ["measure", missingPng, "--cell", "padded", "--bogus"], "unexpected argument: --bogus");

  // ----------------------------------------------------------------- render
  // --png and --svg take an OPTIONAL path. A path that follows is consumed as
  // the flag's value, so it never lands as a second positional.
  {
    const withPath = invoke(["render", missing, "--png", join(dir, "out.drawio.png")]);
    assert.notEqual(withPath.status, 0, "a missing input must fail");
    assert.ok(
      withPath.stderr.includes("ENOENT") && withPath.stderr.includes(missing),
      `--png <path> must be consumed as the flag's value, leaving only the input, got:\n${withPath.stderr}`,
    );
    passed += 1;
    console.log("ok  render: --png consumes a following path");

    const svgWithPath = invoke(["render", missing, "--svg", join(dir, "out.drawio.svg")]);
    assert.ok(
      svgWithPath.status !== 0 && svgWithPath.stderr.includes("ENOENT"),
      `--svg <path> must be consumed as the flag's value, got:\n${svgWithPath.stderr}`,
    );
    passed += 1;
    console.log("ok  render: --svg consumes a following path");

    const bare = invoke(["render", missing, "--png", "--svg"]);
    assert.ok(
      bare.status !== 0 && bare.stderr.includes("ENOENT"),
      `--png and --svg must both be usable without a path, got:\n${bare.stderr}`,
    );
    passed += 1;
    console.log("ok  render: --png and --svg are usable without a path");

    failsLoudly(
      "render: only one path per format flag",
      ["render", missing, "--png", join(dir, "out.drawio.png"), "spare"],
      "unexpected argument: spare",
    );
  }

  // --force is a misconception the error corrects, never accepts.
  failsLoudly(
    "render: --force is refused with its teaching message",
    ["render", source, "--png", "--force"],
    "render always overwrites its derived outputs, no flag needed: drop --force",
  );

  failsLoudly("render: --scale must be positive", ["render", source, "--png", "--scale", "0"], "--scale must be a positive number");
  failsLoudly("render: --scale must be a number", ["render", source, "--png", "--scale", "wide"], "--scale must be a positive number");
  failsLoudly("render: --border must be non-negative", ["render", source, "--png", "--border", "-1"], "--border must be a non-negative number");
  failsLoudly("render: --scale needs a value", ["render", source, "--png", "--scale"], "--scale requires a number");
  failsLoudly("render: --border needs a value", ["render", source, "--png", "--border"], "--border requires a number");
  failsLoudly("render: --page needs a value", ["render", source, "--png", "--page"], "--page requires a name or zero-based index");

  // The config note follows the same rule here as it does for measure.
  {
    const noted = invoke(["render", missing, "--png"]);
    assert.ok(
      noted.stderr.includes(`config: ${join(dir, "drawio.config.json")}`),
      `render must name the config it read, got:\n${noted.stderr}`,
    );
    passed += 1;
    console.log("ok  render: names the config supplying its defaults");

    const silent = invoke(["render", missing, "--png", "--scale", "3", "--border", "10"]);
    assert.ok(!silent.stderr.includes("config:"), `explicit flags must silence the note, got:\n${silent.stderr}`);
    passed += 1;
    console.log("ok  render: explicit scale and border silence the config note");
  }

  // ---------------------------------------------------------------- extract
  {
    const elided = succeeds("extract: --elide-images prints to stdout", ["extract", source, "--elide-images"]);
    assert.ok(elided.stdout.includes("<mxfile"), "the model belongs on stdout");
    assert.ok(elided.stderr.includes("extract: diagram name(s): fixture"), "the diagnostic belongs on stderr");

    const target = join(dir, "written.drawio");
    const written = succeeds("extract: -o chooses the output path", ["extract", source, "-o", target]);
    assert.equal(written.stdout.trim(), target, "the written path is the report");
    assert.ok(existsSync(target), "-o must write the file it names");
    failsLoudly("extract: refuses to overwrite without --force", ["extract", source, "-o", target], "refusing to overwrite");
    succeeds("extract: --force overwrites", ["extract", source, "-o", target, "--force"]);
    succeeds("extract: --decode-entities is accepted with --elide-images", ["extract", source, "--elide-images", "--decode-entities"]);

    // An elided model no longer renders, so the input is refused as its target
    // under any spelling. --force answers the overwrite guard, never this one.
    {
      const before = readFileSync(source);
      const spelled = `${dir}/./fixture.drawio`;
      failsLoudly(
        "extract: --elide-images refuses another spelling of the input, --force included",
        ["extract", source, "--elide-images", "-o", spelled, "--force"],
        "refusing to overwrite the input with an elided (non-rendering) model",
      );
      assert.deepEqual(readFileSync(source), before, "a refused elide must leave the input byte-identical");
      passed += 1;
      console.log("ok  extract: the refused elide leaves the input untouched");
    }

    failsLoudly("extract: -o needs a path", ["extract", source, "-o"], "-o requires a path");
    failsLoudly("extract: refuses a second positional", ["extract", source, "spare"], "unexpected argument: spare");
    failsLoudly("extract: refuses an unknown flag", ["extract", source, "--bogus"], "unexpected argument: --bogus");
  }

  // ------------------------------------------------------------------ cells
  {
    const table = succeeds("cells: the table lands on stdout alone", ["cells", source]);
    assert.ok(table.stdout.includes("SHAPE padded"), `the table must list the cells, got:\n${table.stdout}`);
    assert.equal(table.stderr, "", `a clean cells run says nothing on stderr, got:\n${table.stderr}`);

    const full = succeeds("cells: --full untruncates styles", ["cells", source, "--full"]);
    assert.ok(full.stdout.includes("spacingLeft=20;"), `--full must print the whole style, got:\n${full.stdout}`);

    const sliced = succeeds("cells: --xml slices one cell", ["cells", source, "--xml", "padded"]);
    assert.ok(FIXTURE.includes(sliced.stdout.replace(/\n$/, "")), "--xml must be byte-verbatim source");

    failsLoudly("cells: --xml needs an id", ["cells", source, "--xml"], "--xml requires a cell id");
    failsLoudly("cells: --full and --xml are different reports", ["cells", source, "--xml", "padded", "--full"], "different reports");
    failsLoudly("cells: --elide-images belongs to --xml", ["cells", source, "--elide-images"], "belongs to cells --xml");
    succeeds("cells: --xml takes --elide-images", ["cells", source, "--xml", "padded", "--elide-images"]);
    failsLoudly("cells: refuses a second positional", ["cells", source, source], `unexpected argument: ${source}`);
  }

  // ------------------------------------------------------------------- lint
  {
    const plain = invoke(["lint", source]);
    assert.match(plain.stdout, /^\d+ error\(s\), \d+ warning\(s\)\n$/, `lint's count line is its whole report, got:\n${plain.stdout}`);
    passed += 1;
    console.log("ok  lint: the count lands on stdout, the findings on stderr");

    const strict = invoke(["lint", source, "--strict"]);
    assert.ok(strict.status === 0 || strict.status === 1, "lint exits 0 or 1");
    passed += 1;
    console.log("ok  lint: --strict is accepted");

    failsLoudly("lint: refuses a second positional", ["lint", source, source], `unexpected argument: ${source}`);
    failsLoudly("lint: refuses an unknown flag", ["lint", source, "--picky"], "unexpected argument: --picky");
  }

  // ----------------------------------------------------------------- styles
  {
    const styles = succeeds("styles: the catalogue lands on stdout", ["styles", source]);
    assert.ok(styles.stdout.includes("spacingLeft=20"), `styles must print the style strings, got:\n${styles.stdout}`);
    failsLoudly("styles: refuses a second positional", ["styles", source, source], `unexpected argument: ${source}`);
  }

  // ------------------------------------------------- compressed .drawio files
  // The desktop app's default save format. Every reading report must see the
  // real model, and the one byte-verbatim report must refuse it loudly rather
  // than print bytes the file does not contain.
  {
    const packed = join(dir, "packed.drawio");
    writeFileSync(packed, compressedMxfile(COMPRESSED_MODEL));

    const linted = invoke(["lint", packed]);
    assert.equal(linted.status, 1, `lint must fail on the violation planted inside the payload, got ${linted.status}\n${linted.stderr}`);
    assert.ok(
      linted.stderr.includes('cell id "map" collides with a webapp builtin'),
      `lint must report the compressed model's own cells, got:\n${linted.stderr}`,
    );
    assert.match(linted.stdout, /^[1-9]\d* error\(s\)/, `the count must name the errors found, got:\n${linted.stdout}`);
    passed += 1;
    console.log("ok  lint: reports on the model inside a compressed .drawio");

    const table = succeeds("cells: the table reads a compressed model", ["cells", packed]);
    assert.ok(table.stdout.includes("SHAPE map"), `the table must list the compressed model's cells, got:\n${table.stdout}`);
    assert.ok(table.stdout.includes("POISONED"), `the table must carry the cell's label, got:\n${table.stdout}`);

    const styles = succeeds("styles: the catalogue reads a compressed model", ["styles", packed]);
    assert.ok(styles.stdout.includes("spacingLeft=13"), `styles must print the compressed model's styles, got:\n${styles.stdout}`);

    failsLoudly(
      "cells: --xml refuses a compressed model and names extract",
      ["cells", packed, "--xml", "map"],
      "compressed model: run extract first",
    );
  }

  // ------------------------------------------------------------- diff-cells
  {
    const twin = join(dir, "twin.drawio");
    copyFileSync(source, twin);
    const same = succeeds("diff-cells: matching models exit 0", ["diff-cells", source, twin]);
    assert.equal(same.stdout.trim(), "cells match (ids, values, styles)");

    const changed = join(dir, "changed.drawio");
    writeFileSync(changed, FIXTURE.replace('value="OTHER"', 'value="CHANGED"'));
    const differ = invoke(["diff-cells", source, changed]);
    assert.equal(differ.status, 1, "a difference must exit 1");
    assert.ok(differ.stdout.includes("cell other: value differs"), `the difference lines belong on stdout, got:\n${differ.stdout}`);
    passed += 1;
    console.log("ok  diff-cells: differing models exit 1 with their lines on stdout");

    failsLoudly("diff-cells: refuses a third positional", ["diff-cells", source, twin, twin], `unexpected argument: ${twin}`);
  }

  // --------------------------------------------------------- editing verbs
  {
    const editable = join(dir, "editable.drawio");
    const fresh = () => {
      writeFileSync(editable, FIXTURE);
      return editable;
    };

    const geo = succeeds("set-geometry: takes any of --x/--y/--width/--height", ["set-geometry", fresh(), "padded", "--x", "50", "--width", "130"]);
    assert.equal(geo.stdout.trim(), editable, "the written path is the report");
    assert.ok(readFileSync(editable, "utf8").includes('x="50"'), "set-geometry must write the value");
    assert.ok(geo.stderr.includes("edited in place"), "the re-render reminder belongs on stderr");

    succeeds("set-geometry: --y and --height are accepted too", ["set-geometry", fresh(), "padded", "--y", "70", "--height", "80"]);
    failsLoudly("set-geometry: needs at least one dimension", ["set-geometry", fresh(), "padded"], "set-geometry needs at least one of --x/--y/--width/--height");
    failsLoudly("set-geometry: --x must be a number", ["set-geometry", fresh(), "padded", "--x", "abc"], "--x requires a number");
    failsLoudly("set-geometry: --x needs a value", ["set-geometry", fresh(), "padded", "--x"], "--x requires a number");
    failsLoudly("set-geometry: refuses an unknown flag", ["set-geometry", fresh(), "padded", "--z", "1"], "unexpected argument: --z");

    const waypoints = succeeds("set-waypoints: takes the point list as one argument", ["set-waypoints", fresh(), "e", "200,130 240,130"]);
    assert.ok(readFileSync(editable, "utf8").includes('<Array as="points">'), "set-waypoints must write the array");
    assert.ok(waypoints.stderr.includes("edited in place"), "the re-render reminder belongs on stderr");
    succeeds("set-waypoints: an empty string clears them", ["set-waypoints", fresh(), "e", ""]);
    failsLoudly("set-waypoints: refuses a malformed point", ["set-waypoints", fresh(), "e", "nope"], 'waypoint "nope" is not x,y');
    failsLoudly("set-waypoints: refuses a fourth positional", ["set-waypoints", fresh(), "e", "", "spare"], "unexpected argument: spare");

    // dx and dy are plain positionals, and a negative offset is the common case.
    const offset = succeeds("set-label-offset: takes negative dx and dy", ["set-label-offset", fresh(), "el", "-78", "-4"]);
    assert.ok(readFileSync(editable, "utf8").includes('x="-78" y="-4" as="offset"'), "set-label-offset must write the negative point");
    assert.ok(offset.stderr.includes("edited in place"), "the re-render reminder belongs on stderr");
    failsLoudly("set-label-offset: refuses non-numeric offsets", ["set-label-offset", fresh(), "el", "a", "b"], "set-label-offset requires numeric dx and dy");
    failsLoudly("set-label-offset: refuses a fifth positional", ["set-label-offset", fresh(), "el", "1", "2", "3"], "unexpected argument: 3");

    // An element the exact-spelling replace misses would be joined by a second
    // one, not replaced. The prepended array reads back as the intended
    // waypoints, and an offset set to the values already there reads back as
    // intended too, so only the post-condition can refuse these.
    const odd = join(dir, "odd-spelling.drawio");
    writeFileSync(odd, ODD_SPELLING);
    failsLoudly(
      "set-waypoints: refuses a source whose points array is spelled differently",
      ["set-waypoints", odd, "e", "200,130"],
      "would leave two of them",
    );
    assert.equal(readFileSync(odd, "utf8"), ODD_SPELLING, "a refused set-waypoints must leave the file byte-identical");
    failsLoudly(
      "set-label-offset: refuses a source whose offset point is spelled differently",
      ["set-label-offset", odd, "el", "4", "0"],
      "would leave two of them",
    );
    assert.equal(readFileSync(odd, "utf8"), ODD_SPELLING, "a refused set-label-offset must leave the file byte-identical");

    // Editing verbs write the .drawio source, never a rendered output.
    failsLoudly(
      "set-geometry: refuses a rendered input",
      ["set-geometry", join(dir, "fixture.drawio.png"), "padded", "--x", "1"],
      "editing verbs write the .drawio source in place",
    );
  }

  // ------------------------------------------------------------ the program
  {
    const help = invoke(["--help"]);
    assert.equal(help.status, 0, "--help exits 0");
    assert.ok(help.stdout.includes("Usage: drawio-cli"), `--help prints the generated help on stdout, got:\n${help.stdout}`);
    for (const verb of ["extract", "render", "lint", "cells", "styles", "measure", "set-geometry", "set-waypoints", "set-label-offset", "diff-cells", "doctor"]) {
      assert.ok(help.stdout.includes(`  ${verb}`), `the help must list ${verb}, got:\n${help.stdout}`);
    }
    passed += 1;
    console.log("ok  program: --help lists every verb");

    const bare = invoke([]);
    assert.notEqual(bare.status, 0, "an empty invocation must fail");
    assert.ok(bare.stderr.includes("Usage: drawio-cli"), `an empty invocation prints the help on stderr, got:\n${bare.stderr}`);
    passed += 1;
    console.log("ok  program: an empty invocation fails with the help on stderr");

    failsLoudly("program: refuses an unknown verb", ["nonsuch"], "unknown command 'nonsuch'");
    succeeds("doctor: reports the render path", ["doctor"]);
  }

  // ------------------------------------------------- the render path absent
  // Playwright is loaded when a render starts, never at module load, so the
  // static verbs answer identically on a checkout without it.
  {
    for (const verb of ["lint", "cells"]) {
      const withPlaywright = invoke([verb, source]);
      const without = invokeWithoutPlaywright([verb, source]);
      assert.ok(withPlaywright.stdout.length > 0, `${verb} must report something for the comparison to mean anything, got nothing`);
      assert.equal(without.status, withPlaywright.status, `${verb} must exit the same without playwright, got ${without.status}\n${without.stderr}`);
      assert.equal(without.stdout, withPlaywright.stdout, `${verb} must report the same without playwright, got:\n${without.stdout}`);
      assert.ok(!without.stderr.includes("ERR_MODULE_NOT_FOUND"), `${verb} must not die on the missing module, got:\n${without.stderr}`);
      passed += 1;
      console.log(`ok  ${verb}: unchanged without playwright`);
    }

    const sick = invokeWithoutPlaywright(["doctor"]);
    assert.equal(sick.status, 1, `doctor must exit 1 without playwright, got ${sick.status}\n${sick.stderr}`);
    assert.ok(
      sick.stderr.includes("playwright package: NOT INSTALLED") && sick.stderr.includes("npm install"),
      `doctor must name the missing package and its fix, got:\n${sick.stderr}`,
    );
    passed += 1;
    console.log("ok  doctor: names the missing playwright package");

    const refused = invokeWithoutPlaywright(["render", source, "--png"]);
    assert.notEqual(refused.status, 0, "render must fail without playwright");
    assert.ok(
      refused.stderr.includes("playwright not installed") && refused.stderr.includes("doctor"),
      `render must fail with the doctor guidance, got:\n${refused.stderr}`,
    );
    assert.ok(!refused.stderr.includes("ERR_MODULE_NOT_FOUND"), `render must not leak a module-not-found stack, got:\n${refused.stderr}`);
    passed += 1;
    console.log("ok  render: fails with the doctor guidance without playwright");
  }

  console.log(`argument parsing tests passed (${passed} checks)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
