#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { extractMxfile, uncompressMxfile, elideImagePayloads, decodeNumericEntities } from "./extract.js";
import { measure } from "./measure.js";
import { renderDiagram, selectPage } from "./render.js";
import { doctor } from "./doctor.js";
import { loadRenderConfig } from "./config.js";
import { lint } from "./lint.js";
import { cellsReport, cellXml, stylesReport } from "./cells.js";
import { setGeometry, setWaypoints, setLabelOffset, verifyEdit } from "./edit.js";
import { diffCells } from "./diff.js";

const USAGE = `Usage:
  drawio-cli extract <input> [-o <output>] [--force] [--elide-images] [--decode-entities]
  drawio-cli render <input.drawio> [--png [path]] [--svg [path]] [--page <name|index>] [--scale <n>] [--border <n>]
  drawio-cli lint <input> [--strict]
  drawio-cli cells <input> [--full]
  drawio-cli cells <input> --xml <id> [--elide-images]
  drawio-cli styles <input>
  drawio-cli measure <input.drawio.png> [--cell <id> ...] [--fit <id> ...] [--gaps <id> ...] [--affine] [--quiet-calibration] [--scale <n>] [--border <n>]
  drawio-cli set-geometry <input.drawio> <id> [--x <n>] [--y <n>] [--width <n>] [--height <n>]
  drawio-cli set-waypoints <input.drawio> <id> "x1,y1 x2,y2 ..."   (an empty string clears them)
  drawio-cli set-label-offset <input.drawio> <id> <dx> <dy>
  drawio-cli diff-cells <a> <b>
  drawio-cli doctor`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function writeOutput(path, data) {
  // Write-then-rename, so an observer (editor, file watcher) never sees a torn file.
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, data);
  renameSync(temp, path);
  console.log(path);
}

/** Strips a trailing .png or .svg, then guarantees a .drawio suffix. */
function defaultExtractOutput(input) {
  const stripped = input.replace(/\.(png|svg)$/i, "");
  return stripped.endsWith(".drawio") ? stripped : `${stripped}.drawio`;
}

/** Reads any .drawio/.drawio.png/.drawio.svg into uncompressed mxfile XML. */
function readModel(input) {
  const raw = readFileSync(input);
  const text = raw.toString("utf8");
  return text.includes("<mxfile") && !(raw[0] === 0x89 && raw[1] === 0x50)
    ? uncompressMxfile(text)
    : extractMxfile(raw);
}

function runExtract(args) {
  let input = null;
  let output = null;
  let force = false;
  let elide = false;
  let decode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-o") {
      output = args[i + 1] ?? fail("-o requires a path");
      i += 1;
    } else if (arg === "--force") force = true;
    else if (arg === "--elide-images") elide = true;
    else if (arg === "--decode-entities") decode = true;
    else if (input === null) input = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (input === null) fail(USAGE);
  let xml = readModel(input);
  // Name what was extracted, so a wrong input file (a scratch copy a sibling
  // process overwrote, a stale path) is visible immediately. A single-page
  // file whose page name disagrees with its basename gets a louder line.
  const pages = [...xml.matchAll(/<diagram\b[^>]*?\sname="([^"]*)"/g)].map((m) => m[1]);
  if (pages.length > 0) {
    console.error(`extract: diagram name(s): ${pages.join(", ")}`);
    const base = input.replace(/\.(png|svg)$/i, "").replace(/\.drawio$/i, "").split("/").pop();
    if (pages.length === 1 && pages[0] !== base) {
      console.error(`extract: note page name "${pages[0]}" differs from the file's basename "${base}": confirm this is the file you meant`);
    }
  }
  if (elide) xml = elideImagePayloads(xml);
  if (decode) xml = decodeNumericEntities(xml);
  if (elide && output === null) {
    // An elided model no longer renders, so it never lands on the default
    // path where it could shadow (or overwrite) the real file.
    console.log(xml);
    return;
  }
  const target = output ?? defaultExtractOutput(input);
  if (elide && target === input) fail("refusing to overwrite the input with an elided (non-rendering) model");
  // The default target is the sibling .drawio, which for a rendered pair is
  // the source of truth, and extracted XML is the webapp's re-serialisation
  // of the model, not that file's original bytes.
  if (existsSync(target) && !force) {
    fail(
      `refusing to overwrite ${target}: extracted XML is a re-serialisation, not the file's original bytes. Write elsewhere with -o <path>, or overwrite with --force.`,
    );
  }
  writeOutput(target, xml);
}

function runMeasure(args) {
  let input = null;
  let scale = null;
  let border = null;
  let affine = false;
  let quietCalibration = false;
  const cellIds = [];
  const fitIds = [];
  const gapIds = [];
  // A flag mistaken for an id measures garbage silently, so an id argument
  // may never begin with a dash.
  const idArg = (flag, value) => {
    if (value === undefined || value.startsWith("-")) fail(`${flag} requires a cell id (got ${value ?? "nothing"})`);
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cell") {
      cellIds.push(idArg("--cell", args[i + 1]));
      i += 1;
    } else if (arg === "--fit") {
      fitIds.push(idArg("--fit", args[i + 1]));
      i += 1;
    } else if (arg === "--gaps") {
      gapIds.push(idArg("--gaps", args[i + 1]));
      i += 1;
    } else if (arg === "--affine") affine = true;
    else if (arg === "--quiet-calibration") quietCalibration = true;
    else if (arg === "--scale") {
      scale = Number(args[i + 1] ?? fail("--scale requires a number"));
      i += 1;
    } else if (arg === "--border") {
      border = Number(args[i + 1] ?? fail("--border requires a number"));
      i += 1;
    } else if (input === null) input = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (input === null) fail(USAGE);
  // A fit is a measurement plus a sizing verdict, so its cell is measured
  // whether or not --cell also names it.
  for (const id of fitIds) if (!cellIds.includes(id)) cellIds.push(id);
  if (cellIds.length === 0 && gapIds.length === 0 && !affine) {
    fail("measure needs at least one --cell <id>, --fit <id> or --gaps <id>, or --affine for the mapping alone");
  }
  const config = loadRenderConfig(input);
  if (config.path !== null && (scale === null || border === null)) console.error(`config: ${config.path}`);
  scale = scale ?? config.scale ?? 3;
  border = border ?? config.border ?? 10;
  const raw = readFileSync(input);
  const xml = extractMxfile(raw);
  console.log(measure(raw, xml, { cellIds, fitIds, gapIds, affine, scale, border, quietCalibration }));
}

/** Strips render input suffixes down to the base name shared by all outputs. */
function renderBase(input) {
  return input.replace(/\.(png|svg)$/i, "").replace(/\.drawio$/i, "");
}

async function runRender(args) {
  let input = null;
  let png = null;
  let svg = null;
  let page = null;
  let scale = null;
  let border = null;
  const takesOptionalPath = (i) =>
    args[i + 1] !== undefined && !args[i + 1].startsWith("-") ? args[i + 1] : true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--png") {
      png = takesOptionalPath(i);
      if (png !== true) i += 1;
    } else if (arg === "--svg") {
      svg = takesOptionalPath(i);
      if (svg !== true) i += 1;
    } else if (arg === "--page") {
      page = args[i + 1] ?? fail("--page requires a name or zero-based index");
      i += 1;
    } else if (arg === "--scale") {
      scale = Number(args[i + 1] ?? fail("--scale requires a number"));
      if (!Number.isFinite(scale) || scale <= 0) fail("--scale must be a positive number");
      i += 1;
    } else if (arg === "--border") {
      border = Number(args[i + 1] ?? fail("--border requires a number"));
      if (!Number.isFinite(border) || border < 0) fail("--border must be a non-negative number");
      i += 1;
    } else if (arg === "--force") {
      fail("render always overwrites its derived outputs, no flag needed: drop --force");
    } else if (input === null) input = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (input === null) fail(USAGE);
  if (png === null && svg === null) png = true;

  // Precedence: explicit flag, then the nearest drawio.config.json, then built-in default.
  const config = loadRenderConfig(input);
  if (config.path !== null && (scale === null || border === null)) console.error(`config: ${config.path}`);
  scale = scale ?? config.scale ?? 3;
  border = border ?? config.border ?? 10;

  const raw = readFileSync(input);
  let xml = /\.(png|svg)$/i.test(input) ? extractMxfile(raw) : raw.toString("utf8");
  if (page !== null) xml = selectPage(xml, page);

  const base = renderBase(input);
  const formats = [];
  if (png !== null) formats.push("xmlpng");
  if (svg !== null) formats.push("xmlsvg");
  const results = await renderDiagram(xml, { formats, scale, border });
  const cellCount = (text) => (String(text).match(/<mxCell[\s>]/g) ?? []).length;
  const inputCells = cellCount(xml);
  for (const format of formats) {
    const exported = cellCount(extractMxfile(Buffer.from(results[format])));
    if (exported < inputCells) {
      fail(
        `render loaded ${exported} of ${inputCells} cells (${format}): the webapp rejected the ` +
          `input silently. Known causes: single-quoted XML attributes, or a cell id that ` +
          `collides with a webapp builtin (e.g. id="map"). Fix the source, nothing was written.`,
      );
    }
  }
  if (png !== null) {
    writeOutput(png === true ? `${base}.drawio.png` : png, results.xmlpng, true);
  }
  if (svg !== null) {
    writeOutput(svg === true ? `${base}.drawio.svg` : svg, results.xmlsvg, true);
  }
}

/**
 * Reads a diagram as its stored text: a .drawio's own bytes, or the model a
 * rendered pair embeds. Nothing is re-serialised, so a slice of the result is
 * a slice of the file.
 */
function readStoredXml(input) {
  const raw = readFileSync(input);
  return /\.(png|svg)$/i.test(input) ? extractMxfile(raw) : raw.toString("utf8");
}

function runCells(args) {
  let input = null;
  let full = false;
  let xmlId = null;
  let elide = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--full") full = true;
    else if (arg === "--xml") {
      xmlId = args[i + 1] ?? fail("--xml requires a cell id");
      i += 1;
    } else if (arg === "--elide-images") elide = true;
    else if (input === null) input = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (input === null) fail(USAGE);
  if (xmlId === null) {
    if (elide) fail("--elide-images belongs to cells --xml <id>: the cells table always elides image payloads");
    console.log(cellsReport(readStoredXml(input), { full }));
    return;
  }
  if (full) fail("--full and --xml are different reports: --xml prints one cell's source bytes, never truncated");
  console.log(cellXml(readStoredXml(input), xmlId, { elideImages: elide }));
}

function runLint(args) {
  let input = null;
  let strict = false;
  for (const arg of args) {
    if (arg === "--strict") strict = true;
    else if (input === null) input = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (input === null) fail(USAGE);
  const { errors, warnings, notes } = lint(readStoredXml(input));
  for (const n of notes) console.error(`note: ${n}`);
  for (const w of warnings) console.error(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  const failing = errors.length + (strict ? warnings.length : 0);
  console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
  if (failing > 0) process.exit(1);
}

/** Reads a .drawio for in-place editing, refusing rendered inputs. */
function readEditable(input) {
  if (/\.(png|svg)$/i.test(input)) {
    fail("editing verbs write the .drawio source in place: edit the source, then re-render the pair");
  }
  return readFileSync(input, "utf8");
}

function finishEdit(input, edited, id, expect) {
  verifyEdit(edited, id, expect);
  writeOutput(input, edited);
  console.error("edited in place: re-render the pair before committing");
}

function runSetGeometry(args) {
  const [input, id, ...rest] = args;
  if (!input || !id || id.startsWith("-")) fail(USAGE);
  const geo = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = { "--x": "x", "--y": "y", "--width": "width", "--height": "height" }[rest[i]];
    if (!key) fail(`unexpected argument: ${rest[i]}`);
    const value = Number(rest[i + 1]);
    if (!Number.isFinite(value)) fail(`${rest[i]} requires a number`);
    geo[key] = value;
    i += 1;
  }
  if (Object.keys(geo).length === 0) fail("set-geometry needs at least one of --x/--y/--width/--height");
  const edited = setGeometry(readEditable(input), id, geo);
  finishEdit(input, edited, id, { geo });
}

function runSetWaypoints(args) {
  const [input, id, list, ...rest] = args;
  if (!input || !id || id.startsWith("-") || list === undefined) fail(USAGE);
  if (rest.length > 0) fail(`unexpected argument: ${rest[0]}`);
  const points = list.trim() === "" ? [] : list.trim().split(/\s+/).map((pair) => {
    const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(pair);
    if (!m) fail(`waypoint "${pair}" is not x,y`);
    return { x: Number(m[1]), y: Number(m[2]) };
  });
  const edited = setWaypoints(readEditable(input), id, points);
  finishEdit(input, edited, id, { points });
}

function runSetLabelOffset(args) {
  const [input, id, dxRaw, dyRaw, ...rest] = args;
  if (!input || !id || id.startsWith("-") || dxRaw === undefined || dyRaw === undefined) fail(USAGE);
  if (rest.length > 0) fail(`unexpected argument: ${rest[0]}`);
  const dx = Number(dxRaw), dy = Number(dyRaw);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) fail("set-label-offset requires numeric dx and dy");
  const edited = setLabelOffset(readEditable(input), id, dx, dy);
  finishEdit(input, edited, id, { offset: { x: dx, y: dy } });
}

function runDiffCells(args) {
  const [a, b, ...rest] = args;
  if (!a || !b) fail(USAGE);
  if (rest.length > 0) fail(`unexpected argument: ${rest[0]}`);
  const lines = diffCells(readModel(a), readModel(b));
  for (const line of lines) console.log(line);
  console.log(lines.length === 0 ? "cells match (ids, values, styles)" : `${lines.length} difference line(s)`);
  if (lines.length > 0) process.exit(1);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "extract") runExtract(args);
  else if (command === "set-geometry") runSetGeometry(args);
  else if (command === "set-waypoints") runSetWaypoints(args);
  else if (command === "set-label-offset") runSetLabelOffset(args);
  else if (command === "diff-cells") runDiffCells(args);
  else if (command === "lint") runLint(args);
  else if (command === "cells") runCells(args);
  else if (command === "styles") {
    const [input, ...rest] = args;
    if (input === undefined) fail(USAGE);
    if (rest.length > 0) fail(`unexpected argument: ${rest[0]}`);
    console.log(stylesReport(readStoredXml(input)));
  }
  else if (command === "render") await runRender(args);
  else if (command === "measure") runMeasure(args);
  else if (command === "doctor") process.exit(doctor());
  else fail(USAGE);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
