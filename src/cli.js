#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { extractMxfile, uncompressMxfile, elideImagePayloads, decodeNumericEntities } from "./extract.js";
import { measure } from "./measure.js";
import { renderDiagram, selectPage } from "./render.js";
import { doctor } from "./doctor.js";
import { loadRenderConfig } from "./config.js";
import { lint } from "./lint.js";
import { cellsReport, stylesReport } from "./cells.js";

const USAGE = `Usage:
  drawio-cli extract <input> [-o <output>] [--force] [--elide-images] [--decode-entities]
  drawio-cli render <input.drawio> [--png [path]] [--svg [path]] [--page <name|index>] [--scale <n>] [--border <n>]
  drawio-cli lint <input> [--strict]
  drawio-cli cells <input>
  drawio-cli styles <input>
  drawio-cli measure <input.drawio.png> --cell <id> [--cell <id> ...] [--scale <n>] [--border <n>]
  drawio-cli doctor`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function writeOutput(path, data, force) {
  if (existsSync(path) && !force) {
    fail(`refusing to overwrite ${path} (use --force)`);
  }
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
  writeOutput(target, xml, force);
}

function runMeasure(args) {
  let input = null;
  let scale = null;
  let border = null;
  const cellIds = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cell") {
      cellIds.push(args[i + 1] ?? fail("--cell requires a cell id"));
      i += 1;
    } else if (arg === "--scale") {
      scale = Number(args[i + 1] ?? fail("--scale requires a number"));
      i += 1;
    } else if (arg === "--border") {
      border = Number(args[i + 1] ?? fail("--border requires a number"));
      i += 1;
    } else if (input === null) input = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (input === null) fail(USAGE);
  if (cellIds.length === 0) fail("measure needs at least one --cell <id>");
  const config = loadRenderConfig(input);
  if (config.path !== null && (scale === null || border === null)) console.error(`config: ${config.path}`);
  scale = scale ?? config.scale ?? 3;
  border = border ?? config.border ?? 10;
  const raw = readFileSync(input);
  const xml = extractMxfile(raw);
  console.log(measure(raw, xml, { cellIds, scale, border }));
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

function runLint(args) {
  let input = null;
  let strict = false;
  for (const arg of args) {
    if (arg === "--strict") strict = true;
    else if (input === null) input = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (input === null) fail(USAGE);
  const raw = readFileSync(input);
  const xml = /\.(png|svg)$/i.test(input) ? extractMxfile(raw) : raw.toString("utf8");
  const { errors, warnings, notes } = lint(xml);
  for (const n of notes) console.error(`note: ${n}`);
  for (const w of warnings) console.error(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  const failing = errors.length + (strict ? warnings.length : 0);
  console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
  if (failing > 0) process.exit(1);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "extract") runExtract(args);
  else if (command === "lint") runLint(args);
  else if (command === "cells" || command === "styles") {
    const input = args[0] ?? fail(USAGE);
    const raw = readFileSync(input);
    const xml = /\.(png|svg)$/i.test(input) ? extractMxfile(raw) : raw.toString("utf8");
    console.log(command === "cells" ? cellsReport(xml) : stylesReport(xml));
  }
  else if (command === "render") await runRender(args);
  else if (command === "measure") runMeasure(args);
  else if (command === "doctor") process.exit(doctor());
  else fail(USAGE);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
