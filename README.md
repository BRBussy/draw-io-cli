# draw-io-cli

Extract and render draw.io diagrams from the command line. Rendering drives the draw.io
web app bundled inside the [hediet.vscode-drawio](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio)
VS Code extension with headless Chromium, fully offline.

## Install

Requires Node >= 20 and the hediet.vscode-drawio extension installed in VS Code or Cursor.

```
npm install
npx playwright install chromium
```

Installing the package globally exposes the `drawio-cli` binary. The examples below run
the CLI straight from the repository.

## Commands

### extract

Pulls the embedded draw.io model out of a `.drawio.png` (PNG `tEXt` chunk) or
`.drawio.svg` (root `content` attribute) and writes it as fully uncompressed `.drawio` XML.

```
node src/cli.js extract diagram.drawio.png
```

Writes `diagram.drawio` next to the input, refusing when that file already exists:
extracted XML is the webapp's re-serialisation of the model, not the original bytes,
so landing it on a pair's source is destructive. Use `-o <path>` to choose the
output, or `--force` to overwrite deliberately.

### render

Renders a `.drawio` file (or a `.drawio.png`/`.drawio.svg`, extracted first) to
`--png` (a PNG with the model embedded, reopenable by the extension) and/or `--svg`
(self-contained, model embedded, images inlined). With neither flag `--png` is assumed.

```
node src/cli.js render diagram.drawio --svg
```

Each flag takes an optional output path. Further options: `--page <name|index>` selects
one page of a multi-page file, `--scale <n>` and `--border <n>` shape the export.
Render outputs are derived artifacts, so existing outputs are overwritten.

Scale and border resolve in precedence order: the explicit flag, then the nearest
`drawio.config.json` searched upward from the input file, then the built-in defaults
(scale 3, border 10). A repository commits render settings once as, for example:

```json
{ "render": { "scale": 3, "border": 10 } }
```

Scale is the resolution lever: pixel dimensions grow linearly with it and file size
roughly with its square. Raise it when a diagram looks soft, lower it when files
get heavy.

### lint

Statically verifies a diagram's routing from the XML alone: every edge attached, no
diagonal segments, no near-straight stutters, no segment cutting through a shape, nearby
parallel runs exactly aligned, edge `strokeWidth` at least 2, no webapp-poisonous cell ids.
Verification requires edges to pin their connection points (`exitX`/`exitY`/`entryX`/`entryY`)
and declare jogs as explicit waypoints: edges with floating connections are reported as
warnings, since their rendered route is the router's guess. Errors exit 1, `--strict`
makes warnings fail too.

A cell value carrying editor-injected inline CSS is a warning: the webapp writes
`scrollbar-color`, `light-dark(...)` and stray `color:` / `background-color:` declarations
into a value the moment it is edited in place, and they survive into the committed file as
styling nobody chose. The one sanctioned inline CSS is a code cell's Menlo `font-family`
scaffold together with the plain single-colour spans nested inside it, which is how a
contract-member row carries its keyword colour.

Advisory `note:` lines never fail a run: estimated label boxes crossed by another edge's
run, overlapping label boxes, stacked runs out of column, code boxes not hugging their
text, and the three edge-label golden rules. A riding label must straddle its own edge's
nearest run through its centre band, or sit clear alongside with the run on its LEFT (a
vertical run) or its top or bottom (a horizontal one): a vertical run on the label's right
is always a strike. Its `align` token must be `left` when the run crosses it horizontally
and `center` when the run is vertical or the label sits alongside (a missing token counts
as the webapp default, `center`). Its first rendered line must be bold and
colon-terminated over a capitalised body, unless the whole text is a call expression (an
identifier immediately followed by parentheses), which is a code label and exempt.

An edge whose two endpoints are both degenerate specimen points (each 4 units or smaller)
demonstrates a style rather than connecting two shapes, so its label is a legend caption
naming the swatch: it has no acting party and no reading axis, and the alignment and
format rules skip it. Seating still holds, since a caption riding its swatch crookedly is
a defect on a copy-source card.

A check whose input set is empty says so rather than pass quietly: a diagram with no edge
labels reports the label checks as vacuous, not green, and so does one whose labels are
all legend captions, with the exempted count named.

```
node src/cli.js lint diagram.drawio
```

### cells

Prints the diagram as a readable table: one line per cell with kind, absolute geometry,
label and style summary, and for edges the endpoints, pinned anchors and waypoints. An
edge label's line (`ELBL`) shows its owning edge, relative position and offset point
instead of a meaningless absolute origin. Embedded images are elided to their byte size.
The fast way to read a diagram without scripting XML dumps. `--full` prints untruncated
style strings (image payloads stay elided), so exact styles never need a raw XML grep.

```
node src/cli.js cells diagram.drawio --full
```

### measure

Measures cells of a rendered `.drawio.png` against its embedded model: pixel ink extents
and per-side padding in model units, calibrated from the model bounds plus the render
config (the report opens with the calibration residual as its error bar, and a large
residual names its suspects: estimated edge-label boxes hanging past the model bounds,
or failing that the cells that set each bound). A container or group cell reports each
vertex child too, so box-hug questions are answerable directly. An edge label resolves
its anchor from the parent edge's pinned polyline and measures ink inside its estimated
box: the box is a character-count estimate, and the ink includes anything else inside it,
the edge's own stroke included, which is exactly what makes a line touching its label
visible in numbers.

```
node src/cli.js measure diagram.drawio.png --cell some-node --cell some-edge-label
```

### styles

Digests a palette file into a named style catalogue: each labelled cell's copyable style
string, image payloads elided.

```
node src/cli.js styles diagram.drawio
```

### doctor

Checks the render path: the extension webapp and the playwright Chromium build. Exits 0
when both are found, otherwise names the missing piece and its fix.

```
node src/cli.js doctor
```

## Test

```
npm test
```

Renders a small diagram to PNG and SVG, extracts the PNG back, and asserts the round trip.
Each run also leaves its rendered exports in `test/` as gitignored artifacts named
`smoke-<timestamp>-test-result.drawio.png` / `.drawio.svg`, so you can open the hello world
the test checked and see the renderer working with your own eyes.

## Claude Code skill

The repository carries a skill at `skills/drawio-diagrams` that teaches Claude Code to drive this
CLI (extract, edit, render, verify) whenever a task touches draw.io files. To enable it globally
while keeping it version controlled here, symlink it into your personal skills directory:

```
ln -sfn /Users/bernard/Projects/github.com/BRBussy/draw-io-cli/skills/drawio-diagrams ~/.claude/skills/drawio-diagrams
```

A `git pull` in this checkout then updates the skill everywhere, with nothing copied.
