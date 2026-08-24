---
name: drawio-diagrams
description: >
  Work with draw.io diagrams: read or interpret a .drawio, .drawio.png or
  .drawio.svg file, extract the embedded model, edit diagram XML, render it
  back to PNG/SVG, or create a new draw.io diagram. Use whenever a task
  touches draw.io files (also written drawio or diagrams.net).
---

# draw.io diagrams via drawio-cli

The CLI lives beside this skill in its checkout: `/Users/bernard/Projects/github.com/BRBussy/draw-io-cli`.
Run it as `node /Users/bernard/Projects/github.com/BRBussy/draw-io-cli/src/cli.js <command>` (or plain
`drawio-cli` if it is on PATH via `npm link`). Before first use in a session, `... doctor` verifies the
render path (the hediet.vscode-drawio extension's bundled webapp plus playwright Chromium) and names
the fix for anything missing (`npm install` + `npx playwright install chromium` in the checkout).
To see the render path working with your own eyes, run `npm test` in the checkout and Read the
newest `test/smoke-*-test-result.drawio.png` it leaves behind (gitignored) as an image.

## Hard constraint on helper scripts

Every helper script in this workflow uses the Python or Node STANDARD LIBRARY plus tools
already on the machine (`sips` for image downscaling and cropping). NEVER install a package
into any global or user-level environment (`pip install`, `pip install --user`, `npm -g`):
if stdlib plus system tools cannot do it, report that as friction instead of installing.

## Reading a diagram

START with the built-in reports instead of scripting XML dumps:

```sh
drawio-cli cells <file.drawio>    # readable cell table: kinds, absolute geometry, labels, edge routes
drawio-cli styles <palette.drawio> # named style catalogue from a palette file
```

They replace the exploratory parsing phase entirely: script your own XML analysis only for
questions these two do not answer. When extracting a reference file from a directory you
must not modify, ALWAYS pass `-o <scratchpad-path>`: the default writes next to the input.


Never interpret a draw.io PNG from pixels. Files saved by the VS Code extension embed the full model:

```sh
drawio-cli extract <file.drawio.png>     # or .drawio.svg; writes <file>.drawio XML
```

The XML gives every cell exactly: labels (`value`), containment (`parent` chains into swimlanes),
geometry, styles, and every edge's `source`/`target`. Answer structural questions from the XML,
and use a downscaled raster (`sips -Z 1600 in.png --out small.png`, then Read small.png) only to
judge visual layout.

## Editing or creating

1. Edit the `.drawio` XML directly (or author fresh XML: `<mxfile><diagram><mxGraphModel>...`).
2. Every edge MUST reference `source` and `target` cell ids. Free coordinate polylines break
   silently on the next layout edit.
3. Keep labels plain text. HTML-markup labels export as foreignObject and degrade outside draw.io.
4. To restyle consistently, copy style strings from existing cells in the same file rather than
   inventing new ones.
5. XML landmines that make the webapp silently load ZERO cells (the render guard catches both
   and names them, but avoid them up front):
   - A cell id that collides with a webapp builtin. `id="map"` is confirmed poison. Use
     hyphenated descriptive ids (`event-map`, `target-fn`) and never bare builtin-ish names
     (`map`, `filter`, `target`, `constructor`).
   - Single-quoted attribute values. Valid XML, rejected anyway. Always emit double-quoted
     attributes and escape inner quotes as `&quot;` (beware `xml.sax.saxutils.quoteattr`,
     which switches to single quotes when the value contains `"`).
6. A `dashed=1` text shape renders as a borderless note, the intended look for behaviour notes.
7. Round-trip comparisons (extracted PNG model vs source) are cell-level, never byte-level:
   the webapp re-serialises, adding host/agent/version to mxfile and dropping zero-valued
   coordinates. Compare cell ids and attributes, not bytes.

## Rendering

```sh
drawio-cli render <file.drawio> --png            # default: also what READMEs should embed
drawio-cli render <file.drawio> --png --svg      # svg only when explicitly needed
drawio-cli render <file.drawio> --page <name|i> --scale <n> --border <n>
```

- The exported PNG embeds the model (a `tEXt` chunk keyed `mxfile`), so it stays editable in the
  VS Code extension. Commit the `.drawio` source and the rendered `.drawio.png` together.
- Do NOT embed draw.io SVG exports in READMEs: they carry theme-adaptive CSS (`light-dark(...)`)
  and render half-inverted in dark-mode GitHub and VS Code previews. PNG renders identically
  everywhere.
- Scale and border resolve as: explicit flag, then the nearest `drawio.config.json` searched
  upward from the input file, then built-in defaults (scale 3, border 10). In a repository
  that commits a `drawio.config.json`, render WITHOUT `--scale`/`--border` so the committed
  settings apply, and change resolution by editing that file, not by passing flags.

## Verify after every render

0. `drawio-cli lint <file.drawio>` FIRST, before rendering: it statically catches unattached
   edges, diagonal segments, near-straight stutters, segments cutting through shapes,
   misaligned parallel runs, thin edges and poisonous cell ids. For it to verify routes,
   author every edge with pinned connection points (`exitX`/`exitY`/`entryX`/`entryY` in the
   style) and declare each jog as an explicit waypoint: never leave routing to the router.
   Fractional attachment points (exitX as a fraction of the shape's width) rarely land on
   integer coordinates: use the exitDx/exitDy and entryDx/entryDy pixel offsets to pin a
   run to an exact x or y. Read every `note:` line lint prints — notes never fail the run
   because only an eyeball can judge them (an oversized code box, stacked runs slightly out
   of column). For each note either fix the geometry or confirm the layout is forced by an
   anchor rule (anchors always win); never just ignore the line.
6. Line jumps (`jumpStyle=arc;jumpSize=10`) are z-order dependent: draw.io renders the hop
   on the edge that crosses another declared EARLIER in the XML. Put the style on the
   later-declared edge of the crossing pair, and verify the hop actually renders by eye:
   no static check can see it. Z-order bites shapes the same way: a filled shape paints over
   any cell declared before it, so an icon embedded in a box must be declared AFTER the
   box or it renders invisible. Only the eyeball pass catches this.
7. `sips --cropOffset` silently leaves the file uncropped when passed a 0 offset (and its
   placement is unreliable in general): never pass 0, and always assert the output
   dimensions after a crop before trusting what you Read.

1. Downscale the PNG and Read it as an image. Check labels, arrows, and that no broken-image
   placeholders appear.
2. `drawio-cli extract` the PNG and confirm the round-tripped XML still contains the labels you
   changed (grep the exact strings).
3. If the target repo defines diagram label conventions (in its AGENTS.md or a check script),
   run its checks before finishing.
