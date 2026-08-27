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

A second hard constraint: file content moves FILE-TO-FILE, never through your own output.
Diagram files carry embedded base64 icon payloads that overflow output-token limits when
retyped: an agent has died mid-task doing exactly that. Copy with `cp`, capture with shell
redirection, and transform with scripts that read the source file and write the destination
file, printing only short confirmations (counts, asserts). Never paste file regions into
heredocs, Edit/Write calls, or your own messages.

## Reading a diagram

START with the built-in reports instead of scripting XML dumps:

```sh
drawio-cli cells <file.drawio>          # readable cell table: kinds, absolute geometry, labels, edge routes
drawio-cli cells <file.drawio> --full   # same, with untruncated style strings (exact styles, no XML grep)
drawio-cli styles <palette.drawio>      # named style catalogue from a palette file
```

They replace the exploratory parsing phase entirely: script your own XML analysis only for
questions these do not answer. Edge-label rows (`ELBL`) show the owning edge, the label's
relative position and its offset point: an edge label has no absolute geometry of its own. When a
.drawio is too large to read raw, the bulk is embedded icon payloads:

```sh
drawio-cli extract <file> --elide-images            # full model XML to stdout, payloads as [elided NKB]
drawio-cli extract <file> --elide-images -o dump.xml
```

It accepts .drawio, .drawio.png and .drawio.svg inputs alike. The elided model no longer
renders, so it never lands on the input path. When extracting a reference file from a directory you
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

0. For geometry, waypoints and label offsets, prefer the in-place editing verbs over hand
   regex surgery — they splice the file's own bytes (serialisation preserved), verify the
   parsed result, and fail loudly on a missing or duplicate id:

```sh
drawio-cli set-geometry <file.drawio> <id> --x 24 --width 208    # any of --x/--y/--width/--height
drawio-cli set-waypoints <file.drawio> <id> "1090,193 1090,160"  # "" clears them
drawio-cli set-label-offset <file.drawio> <id> -78 0
```

   Values are written verbatim: geometry x/y are PARENT-RELATIVE model units (the `cells`
   table prints absolute positions — subtract the parent chain before setting). After any
   edit batch, re-render the pair.
0b. Concurrent-editor guard: hash the target `.drawio` (e.g. `md5 -q`) before and after every
   edit batch, and re-check just before finishing. An open draw.io editor can re-serialise
   the file under you (cell order rewritten, waypoints collapsed) and a stale buffer can save
   over finished work; only the hash comparison catches it.
0c. `drawio-cli diff-cells <a> <b>` compares two models cell-level (ids, values, styles —
   geometry excluded): the membership-proof primitive. A style delta confined to
   exit/entry anchor tokens is named "edge re-anchored", the silent way an inherited
   edge's route breaks byte-identity.
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
   `extract --decode-entities` restores apostrophes and friends (&#39;) to their source
   spelling so greps against the extracted model match, keeping structural entities encoded.
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
   anchor rule (anchors always win); never just ignore the line. A note that says a check
   was "vacuous, not green" means that check's input set was empty: treat it as a gap in
   coverage, not as a pass.
0c. Edge labels get three checks of their own, all ERROR tier (they fail the run): a riding
   label must straddle its own edge's nearest run through its centre band, or sit clear
   alongside with the run on its LEFT (vertical run) or its top or bottom (horizontal run),
   never on its right; `align=left` when the run crosses it horizontally and `align=center`
   when the run is vertical or the label sits alongside; and the first rendered line bold
   and colon-terminated over a capitalised body, with a whole-text call expression
   (`transfer(vaultEvmAddress, amount)`) exempt as a code label. Label boxes are estimated
   align-aware (an `align=left` label's LEFT edge sits on its anchor, not its centre) with
   calibrated per-character widths, so the seating verdicts are trustworthy. Two labels
   whose boxes overlap well beyond the estimate's error are an error too; a graze is a note.
   A label hanging past the geometry bounds does NOT clip: the exporter extends its bounds
   to include edge labels (proven by residual arithmetic on rendered pairs), and measure's
   calibration names such extensions. An edge whose two endpoints are BOTH degenerate
   specimen points (each 4 units or smaller) demonstrates a style instead of connecting
   shapes, so its label is a legend caption naming the swatch: alignment and format skip it,
   seating does not, and such edges are also exempt from the floating-connection warning.
   Editor-injected inline CSS inside a cell value (`scrollbar-color`, `light-dark(`, a stray
   `color:`/`background-color:` span, or a `<font color="...">` wrapper) is a WARNING, so
   `--strict` fails on it: strip the styling the editor wrote. A code cell's Menlo font
   scaffold and the plain colour spans nested in it are the sanctioned exception, since that
   is how a contract-member row gets its keyword colour. A remote `image=` URL in any style
   is an error (it renders blank offline), and so is a model whose parsed cell count falls
   far below its `<mxCell` count (a malformed splice must never lint green).
6. Line jumps (`jumpStyle=arc;jumpSize=10`): the edge carrying the style renders a hop
   wherever it crosses another edge, on either side of it in declaration order. Choose
   which edge of a crossing pair should visually break, put the style on that one, and
   verify the hop actually renders by eye:
   no static check can see it. Z-order bites shapes the same way: a filled shape paints over
   any cell declared before it, so an icon embedded in a box must be declared AFTER the
   box or it renders invisible. Only the eyeball pass catches this.
7. `sips --cropOffset` silently leaves the file uncropped when passed a 0 offset (and its
   placement is unreliable in general): never pass 0, and always assert the output
   dimensions after a crop before trusting what you Read.

0b. For padding and box-hug questions, measure the rendered pixels instead of squinting:
   `drawio-cli measure <file.drawio.png> --cell <id>` reports each cell's ink extents and
   per-side padding in model units, with a calibration line carrying its own error bar.
   Calibration folds estimated edge-label boxes into the content bounds (labels are the
   usual reason an export outgrows the geometry), a residual explained by bound-setting
   EDGES demotes to a note, a scale that cannot match the PNG fails loudly with the
   implied scale named, and `--affine` prints the model-to-pixel mapping but REFUSES while
   a live calibration WARNING stands. The affine changes whenever an edit moves the model
   bounds: re-read it after every render, never cache it across edits. Passing a container
   or group id reports every vertex child too, and `--gaps <container-id>` reports each
   child's clearance to the container's sides plus the largest empty rectangle inside it
   (the dead-space question in one line). Passing an edge label's id measures its TEXT box
   (align-aware) with foreign ink named separately (the edge's own stroke no longer reads
   as zero padding), and appends a `visible run` line: how many units of the edge's own run
   stay visible on each side of the knockout, under 20u flagged as an orphaned stub.
   `--fit <id>` peels a stroked shape's border before sizing (so a hexagon's slanted border
   is not counted as text ink) and names any declared spacing tokens the delta restates.
1. Downscale the PNG and Read it as an image. Check labels, arrows, and that no broken-image
   placeholders appear.
2. `drawio-cli extract` the PNG and confirm the round-tripped XML still contains the labels you
   changed (grep the exact strings).
3. If the target repo defines diagram label conventions (in its AGENTS.md or a check script),
   run its checks before finishing.
