#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { extractMxfile } from "./extract.js";
import { renderDiagram, selectPage } from "./render.js";
import { doctor } from "./doctor.js";
import { loadRenderConfig } from "./config.js";

const USAGE = `Usage:
  drawio-cli extract <input> [-o <output>] [--force]
  drawio-cli render <input.drawio> [--png [path]] [--svg [path]] [--page <name|index>] [--scale <n>] [--border <n>] [--force]
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

function runExtract(args) {
  let input = null;
  let output = null;
  let force = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-o") {
      output = args[i + 1] ?? fail("-o requires a path");
      i += 1;
    } else if (arg === "--force") force = true;
    else if (input === null) input = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (input === null) fail(USAGE);
  const xml = extractMxfile(readFileSync(input));
  writeOutput(output ?? defaultExtractOutput(input), xml, force);
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
  let force = false;
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
    } else if (arg === "--force") force = true;
    else if (input === null) input = arg;
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
    writeOutput(png === true ? `${base}.drawio.png` : png, results.xmlpng, force);
  }
  if (svg !== null) {
    writeOutput(svg === true ? `${base}.drawio.svg` : svg, results.xmlsvg, force);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "extract") runExtract(args);
  else if (command === "render") await runRender(args);
  else if (command === "doctor") process.exit(doctor());
  else fail(USAGE);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
