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

Writes `diagram.drawio` next to the input. Use `-o <path>` to choose the output and
`--force` to overwrite an existing file.

### render

Renders a `.drawio` file (or a `.drawio.png`/`.drawio.svg`, extracted first) to
`--png` (a PNG with the model embedded, reopenable by the extension) and/or `--svg`
(self-contained, model embedded, images inlined). With neither flag `--png` is assumed.

```
node src/cli.js render diagram.drawio --svg
```

Each flag takes an optional output path. Further options: `--page <name|index>` selects
one page of a multi-page file, `--scale <n>` and `--border <n>` shape the export,
`--force` overwrites existing outputs.

Scale and border resolve in precedence order: the explicit flag, then the nearest
`drawio.config.json` searched upward from the input file, then the built-in defaults
(scale 3, border 10). A repository commits render settings once as, for example:

```json
{ "render": { "scale": 3, "border": 10 } }
```

Scale is the resolution lever: pixel dimensions grow linearly with it and file size
roughly with its square. Raise it when a diagram looks soft, lower it when files
get heavy.

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
