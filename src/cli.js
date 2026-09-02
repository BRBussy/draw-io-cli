#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { extractMxfile, uncompressMxfile, hasCompressedDiagram, elideImagePayloads, decodeNumericEntities } from "./extract.js";
import { measure, ICON_GAP_FLAG } from "./measure.js";
import { renderDiagram, selectPage } from "./render.js";
import { doctor } from "./doctor.js";
import { loadRenderConfig } from "./config.js";
import { lint } from "./lint.js";
import { cellsReport, cellXml, stylesReport } from "./cells.js";
import { setGeometry, setWaypoints, setLabelOffset, verifyEdit } from "./edit.js";
import { diffCells } from "./diff.js";

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * A command whose parse failures leave by the same door as a verb's own
 * failures: the bare message on stderr and exit 1. A missing positional prints
 * the command's help, which is the shape of the invocation the reader needs.
 */
class DrawioCommand extends Command {
  createCommand(name) {
    return new DrawioCommand(name);
  }

  error(message) {
    fail(message.replace(/^error: /, ""));
  }

  optionMissingArgument(option) {
    fail(option.missingValueMessage ?? `option '${option.flags}' argument missing`);
  }

  unknownOption(flag) {
    fail(`unexpected argument: ${flag}`);
  }

  _excessArguments(receivedArgs) {
    fail(`unexpected argument: ${receivedArgs[this.registeredArguments.length]}`);
  }

  missingArgument() {
    this.help({ error: true });
  }
}

/**
 * An option taking a value, carrying the message it prints when the value is
 * absent. Commander detects the absence before any parser runs, so the message
 * belongs on the option itself.
 */
function valueOption(flags, description, missingValueMessage, parse) {
  const option = new Option(flags, description);
  option.missingValueMessage = missingValueMessage;
  if (parse) option.argParser(parse);
  return option;
}

/**
 * Collects a repeatable cell id. A flag mistaken for an id measures garbage
 * silently, so an id argument may never begin with a dash.
 */
function collectId(flag) {
  return (value, previous) => {
    if (value.startsWith("-")) fail(`${flag} requires a cell id (got ${value})`);
    return [...(previous ?? []), value];
  };
}

/** Parses a number, failing when the text is not one. */
function finiteNumber(flag) {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) fail(`${flag} requires a number`);
    return parsed;
  };
}

/**
 * The scale a render used, shared with measure, which reads that render back.
 * An unvalidated value would reach measure as NaN, which its wrong-scale guard
 * cannot catch: every comparison against NaN is false.
 */
function scaleOption(description) {
  return valueOption("--scale <n>", description, "--scale requires a number", (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) fail("--scale must be a positive number");
    return parsed;
  });
}

/** The border partner of scaleOption, on the same two verbs. */
function borderOption(description) {
  return valueOption("--border <n>", description, "--border requires a number", (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) fail("--border must be a non-negative number");
    return parsed;
  });
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

function runExtract(input, options) {
  const output = options.o ?? null;
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
  if (options.elideImages) xml = elideImagePayloads(xml);
  if (options.decodeEntities) xml = decodeNumericEntities(xml);
  if (options.elideImages && output === null) {
    // An elided model no longer renders, so it never lands on the default
    // path where it could shadow (or overwrite) the real file.
    console.log(xml);
    return;
  }
  const target = output ?? defaultExtractOutput(input);
  // Two spellings (a "./" segment, "..", a relative path) name one file, so
  // the identity this guard needs is between resolved paths.
  if (options.elideImages && resolve(target) === resolve(input)) {
    fail("refusing to overwrite the input with an elided (non-rendering) model");
  }
  // The default target is the sibling .drawio, which for a rendered pair is
  // the source of truth, and extracted XML is the webapp's re-serialisation
  // of the model, not that file's original bytes.
  if (existsSync(target) && !options.force) {
    fail(
      `refusing to overwrite ${target}: extracted XML is a re-serialisation, not the file's original bytes. Write elsewhere with -o <path>, or overwrite with --force.`,
    );
  }
  writeOutput(target, xml);
}

function runMeasure(input, options) {
  const fitIds = options.fit ?? [];
  const gapIds = options.gaps ?? [];
  const cellIds = [...(options.cell ?? [])];
  const affine = options.affine === true;
  const iconGaps = options.iconGaps === true;
  if (options.minIconGap !== undefined && !iconGaps) {
    fail("--min-icon-gap only tunes --icon-gaps: add --icon-gaps, or drop the flag");
  }
  // A fit is a measurement plus a sizing verdict, so its cell is measured
  // whether or not --cell also names it.
  for (const id of fitIds) if (!cellIds.includes(id)) cellIds.push(id);
  if (cellIds.length === 0 && gapIds.length === 0 && !affine && !iconGaps) {
    fail("measure needs at least one --cell <id>, --fit <id> or --gaps <id>, --icon-gaps for the sweep, or --affine for the mapping alone");
  }
  const config = loadRenderConfig(input);
  if (config.path !== null && (options.scale === undefined || options.border === undefined)) {
    console.error(`config: ${config.path}`);
  }
  const scale = options.scale ?? config.scale ?? 3;
  const border = options.border ?? config.border ?? 10;
  const raw = readFileSync(input);
  const xml = extractMxfile(raw);
  const report = measure(raw, xml, {
    cellIds, fitIds, gapIds, affine, scale, border,
    quietCalibration: options.quietCalibration === true,
    iconGaps, minIconGap: options.minIconGap ?? 8,
  });
  console.log(report);
  // A flagged icon gap is a style-guide violation: the report still prints in
  // full, and the exit code makes the sweep scriptable as a gate.
  if (iconGaps && report.includes(ICON_GAP_FLAG)) process.exitCode = 1;
}

/** Strips render input suffixes down to the base name shared by all outputs. */
function renderBase(input) {
  return input.replace(/\.(png|svg)$/i, "").replace(/\.drawio$/i, "");
}

async function runRender(input, options) {
  if (options.force) {
    fail("render always overwrites its derived outputs, no flag needed: drop --force");
  }
  let png = options.png ?? null;
  const svg = options.svg ?? null;
  if (png === null && svg === null) png = true;

  // Precedence: explicit flag, then the nearest drawio.config.json, then built-in default.
  const config = loadRenderConfig(input);
  if (config.path !== null && (options.scale === undefined || options.border === undefined)) {
    console.error(`config: ${config.path}`);
  }
  const scale = options.scale ?? config.scale ?? 3;
  const border = options.border ?? config.border ?? 10;

  const raw = readFileSync(input);
  let xml = /\.(png|svg)$/i.test(input) ? extractMxfile(raw) : raw.toString("utf8");
  if (options.page !== undefined) xml = selectPage(xml, options.page);

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

/**
 * Reads a diagram for a report that reads the model rather than the file's
 * bytes. The desktop app saves a .drawio with its pages deflated, and the
 * stored text of such a file carries no cells at all, so every reading report
 * expands the payload first rather than inspecting nothing and passing.
 */
function readModelXml(input) {
  return uncompressMxfile(readStoredXml(input));
}

function runCells(input, options) {
  const full = options.full === true;
  const elide = options.elideImages === true;
  if (options.xml === undefined) {
    if (elide) fail("--elide-images belongs to cells --xml <id>: the cells table always elides image payloads");
    console.log(cellsReport(readModelXml(input), { full }));
    return;
  }
  if (full) fail("--full and --xml are different reports: --xml prints one cell's source bytes, never truncated");
  const stored = readStoredXml(input);
  // --xml prints the file's own bytes, and a compressed page has no bytes to
  // slice: uncompressing would print text that appears nowhere in the file.
  if (hasCompressedDiagram(stored)) {
    fail(`compressed model: run extract first, then slice the uncompressed file, since --xml prints ${input}'s own bytes and this page holds none`);
  }
  console.log(cellXml(stored, options.xml, { elideImages: elide }));
}

function runLint(input, options) {
  const { errors, warnings, notes } = lint(readModelXml(input));
  for (const n of notes) console.error(`note: ${n}`);
  for (const w of warnings) console.error(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  const failing = errors.length + (options.strict ? warnings.length : 0);
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

/**
 * A cell id positional. An id may never begin with a dash: the invocation shape
 * is what the reader got wrong, so the command's help is the answer.
 */
function requirePlainId(command, id) {
  if (id.startsWith("-")) command.help({ error: true });
}

function runSetGeometry(input, id, options, command) {
  requirePlainId(command, id);
  const geo = {};
  for (const key of ["x", "y", "width", "height"]) {
    if (options[key] !== undefined) geo[key] = options[key];
  }
  if (Object.keys(geo).length === 0) fail("set-geometry needs at least one of --x/--y/--width/--height");
  const edited = setGeometry(readEditable(input), id, geo);
  finishEdit(input, edited, id, { geo });
}

function runSetWaypoints(input, id, list, options, command) {
  requirePlainId(command, id);
  const points = list.trim() === "" ? [] : list.trim().split(/\s+/).map((pair) => {
    const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(pair);
    if (!m) fail(`waypoint "${pair}" is not x,y`);
    return { x: Number(m[1]), y: Number(m[2]) };
  });
  const edited = setWaypoints(readEditable(input), id, points);
  finishEdit(input, edited, id, { points });
}

function runSetLabelOffset(input, id, dxRaw, dyRaw, options, command) {
  requirePlainId(command, id);
  const dx = Number(dxRaw), dy = Number(dyRaw);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) fail("set-label-offset requires numeric dx and dy");
  const edited = setLabelOffset(readEditable(input), id, dx, dy);
  finishEdit(input, edited, id, { offset: { x: dx, y: dy } });
}

function runDiffCells(a, b) {
  const lines = diffCells(readModel(a), readModel(b));
  for (const line of lines) console.log(line);
  console.log(lines.length === 0 ? "cells match (ids, values, styles)" : `${lines.length} difference line(s)`);
  if (lines.length > 0) process.exit(1);
}

const program = new DrawioCommand()
  .name("drawio-cli")
  .description("Extract, render, lint, measure and edit draw.io diagrams from the command line.");

program
  .command("extract")
  .description("write the embedded model of a diagram out as uncompressed .drawio XML")
  .argument("<input>", "a .drawio, .drawio.png or .drawio.svg file")
  .addOption(valueOption("-o <output>", "the output path, in place of the default sibling .drawio", "-o requires a path"))
  .option("--force", "overwrite the output file when it already exists")
  .option("--elide-images", "replace embedded image payloads with size markers, printing to stdout")
  .option("--decode-entities", "decode numeric character entities such as &#39;")
  .action(runExtract);

program
  .command("render")
  .description("render a diagram to PNG and/or SVG with the model embedded")
  .argument("<input.drawio>", "a .drawio, .drawio.png or .drawio.svg file")
  .option("--png [path]", "write a PNG, at this path when given (the default with neither format)")
  .option("--svg [path]", "write an SVG, at this path when given")
  .addOption(valueOption("--page <name|index>", "render one page of a multi-page file", "--page requires a name or zero-based index"))
  .addOption(scaleOption("export scale, overriding drawio.config.json"))
  .addOption(borderOption("export border, overriding drawio.config.json"))
  .addOption(new Option("--force").hideHelp())
  .action(runRender);

program
  .command("lint")
  .description("verify a diagram's routing, labels and cell values from the XML alone")
  .argument("<input>", "a .drawio, .drawio.png or .drawio.svg file")
  .option("--strict", "fail on warnings as well as errors")
  .action(runLint);

program
  .command("cells")
  .description("print the diagram as a readable cell table, or one cell's source bytes")
  .argument("<input>", "a .drawio, .drawio.png or .drawio.svg file")
  .option("--full", "print untruncated style strings in the table")
  .addOption(valueOption("--xml <id>", "print this cell's element verbatim, in place of the table", "--xml requires a cell id"))
  .option("--elide-images", "replace the printed cell's image payload with a size marker")
  .action(runCells);

program
  .command("styles")
  .description("digest a palette file into a named catalogue of copyable style strings")
  .argument("<input>", "a .drawio, .drawio.png or .drawio.svg file")
  .action((input) => {
    console.log(stylesReport(readModelXml(input)));
  });

program
  .command("measure")
  .description("measure rendered cells against the model embedded in a PNG")
  .argument("<input.drawio.png>", "a rendered .drawio.png")
  .addOption(valueOption("--cell <id>", "measure this cell (repeatable)", "--cell requires a cell id (got nothing)", collectId("--cell")))
  .addOption(valueOption("--fit <id>", "measure this cell and size its box to its ink (repeatable)", "--fit requires a cell id (got nothing)", collectId("--fit")))
  .addOption(valueOption("--gaps <id>", "report this cell's gaps to its neighbours (repeatable)", "--gaps requires a cell id (got nothing)", collectId("--gaps")))
  .option("--affine", "print the model-unit to pixel mapping this calibration implies")
  .option("--icon-gaps", "sweep every labelled box containing an image cell and report the icon-ink-to-glyph gap")
  .addOption(valueOption("--min-icon-gap <n>", "minimum gap in model units the --icon-gaps sweep flags under (default 8)", "--min-icon-gap requires a number", finiteNumber("--min-icon-gap")))
  .option("--quiet-calibration", "drop the calibration line and note, never the warning")
  .addOption(scaleOption("the scale the PNG was rendered at"))
  .addOption(borderOption("the border the PNG was rendered with"))
  .action(runMeasure);

program
  .command("set-geometry")
  .description("set any of x, y, width, height on one cell of a .drawio, in place")
  .argument("<input.drawio>", "the .drawio source to edit")
  .argument("<id>", "the cell to edit")
  .addOption(valueOption("--x <n>", "geometry x", "--x requires a number", finiteNumber("--x")))
  .addOption(valueOption("--y <n>", "geometry y", "--y requires a number", finiteNumber("--y")))
  .addOption(valueOption("--width <n>", "geometry width", "--width requires a number", finiteNumber("--width")))
  .addOption(valueOption("--height <n>", "geometry height", "--height requires a number", finiteNumber("--height")))
  .action(runSetGeometry);

program
  .command("set-waypoints")
  .description("replace an edge's waypoints in a .drawio, in place")
  .argument("<input.drawio>", "the .drawio source to edit")
  .argument("<id>", "the edge to edit")
  .argument("<points>", 'space-separated "x1,y1 x2,y2 ...", or an empty string to clear them')
  .action(runSetWaypoints);

program
  .command("set-label-offset")
  .description("set an edge label's offset point in a .drawio, in place")
  .argument("<input.drawio>", "the .drawio source to edit")
  .argument("<id>", "the label cell to edit")
  .argument("<dx>", "offset x in model units")
  .argument("<dy>", "offset y in model units")
  .action(runSetLabelOffset);

program
  .command("diff-cells")
  .description("compare two models cell by cell: ids, values and styles")
  .argument("<a>", "a .drawio, .drawio.png or .drawio.svg file")
  .argument("<b>", "a .drawio, .drawio.png or .drawio.svg file")
  .action(runDiffCells);

program
  .command("doctor")
  .description("check the render path: the extension webapp, the playwright package and its Chromium build")
  .action(async () => {
    process.exit(await doctor());
  });

program.parseAsync(process.argv).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
