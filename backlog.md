# Backlog

Ordered by priority. Findings come from a full review of the CLI (2026-08-31). Every
bug marked "reproduced" was confirmed by running the CLI against a planted fixture.

- [x] Detect compressed models in `lint` and `cells` instead of passing green
  - category: bug (silent false pass), reproduced
  - description: `readStoredXml` (src/cli.js) never uncompresses a deflate-compressed
    `.drawio` (the draw.io desktop default save format). `lint` exits 0 with
    "0 error(s), 0 warning(s)" and `cells` prints an empty table. The cell-count guard
    in src/lint.js cannot fire since the raw text contains no `<mxCell`. Fix: detect a
    non-empty `<diagram>` payload containing no `<`, then uncompress it for `lint` and
    the `cells` table, and fail loudly ("compressed model: run extract first") for
    `cells --xml`, whose byte-verbatim contract cannot survive uncompression.
  - definition of done: `lint` on a compressed file reports on the real model, `cells`
    prints the real table, `cells --xml` refuses with a message naming `extract`.
  - test: build a compressed fixture with `deflateRawSync(encodeURIComponent(model))`
    base64-wrapped in a `<diagram>` tag. Assert `lint` finds a violation planted inside
    the compressed model, and assert `cells --xml` exits 1 with the refusal message.

- [ ] Lint errors on duplicate cell ids
  - category: bug (silent false pass), reproduced
  - description: `parseCells` stores cells in a Map, so the last duplicate silently
    wins and lint passes a model that src/cells.js itself calls webapp-breaking.
    Count ids during `collectCells`, before the Map collapses them, and push an
    error-tier finding naming each duplicated id.
  - definition of done: a model with two cells sharing an id exits 1 from `lint` with
    the id named. A clean model stays clean.
  - test: add a planted-violation case to test/lint-violations.mjs with two `id="a"`
    cells firing, and a control with unique ids staying quiet.

- [ ] Validate `measure --scale` and `--border` as finite numbers
  - category: bug, reproduced
  - description: the parsers in src/cli.js use bare `Number(value)`, so
    `measure --scale abc` publishes a NaN calibration and bogus "no ink found" lines
    with exit 0. NaN also blinds the wrong-scale guard in src/measure.js, since every
    NaN comparison is false. Reuse `finiteNumber` from the same file, and refuse
    `--scale 0` the way `render` does.
  - definition of done: non-numeric or non-positive `--scale` (and non-numeric
    `--border`) fail loudly before any measurement prints.
  - test: extend test/args.mjs with `--scale abc`, `--scale 0` and `--border abc`
    cases asserting nonzero exit, the message on stderr, and nothing on stdout.

- [ ] Block network egress during render
  - category: security
  - description: `renderDiagram` loads untrusted XML into headless Chromium with full
    network access. `html=1` labels carry arbitrary markup, and `offline=1` is
    app-level configuration, not a browser restriction, so a hostile diagram can
    trigger requests to external hosts during render. Route all page requests through
    playwright and abort anything not addressed to `127.0.0.1:<server port>`.
  - definition of done: a render of a diagram whose label embeds a remote resource
    completes with zero requests leaving localhost.
  - test: render a fixture whose label references an external URL while a request log
    (playwright route handler) records aborted requests, and assert the external
    request was aborted and the export still succeeds.

- [ ] Wire test/lint-violations.mjs into `npm test`
  - category: tests, reproduced
  - description: package.json runs only args.mjs and smoke.mjs, and nothing references
    lint-violations.mjs, so the suite proving the lint checks fire never runs. A guard
    never seen failing is not known to work.
  - definition of done: `npm test` runs all three suites and fails when any planted
    violation stops firing.
  - test: run `npm test` and see the lint-violations output. Then break one lint check
    deliberately, watch `npm test` fail, and restore it.

- [ ] Lazy-import playwright so static verbs work without it
  - category: bug (availability), reproduced
  - description: src/cli.js statically imports render.js and doctor.js, which import
    playwright at module top, so even `lint` dies with a raw ERR_MODULE_NOT_FOUND when
    playwright is absent. Make the import dynamic inside `renderDiagram` and `doctor`,
    so lint, cells, extract, measure, diff-cells and the editing verbs run on machines
    that never render, and `doctor` diagnoses the missing install instead of crashing.
  - definition of done: with playwright unavailable, every non-rendering verb works,
    `doctor` exits 1 naming the fix, and `render` fails with the doctor guidance.
  - test: temporarily rename node_modules/playwright, run `lint`, `cells` and
    `doctor`, assert the behaviours above, restore the directory.

- [ ] Compare resolved paths in the elide self-overwrite guard
  - category: bug, reproduced
  - description: the guard in src/cli.js checks `target === input` as strings, so
    `extract x.drawio --elide-images -o ./x.drawio --force` writes the elided
    (non-rendering) model over the input. Resolve both paths before comparing.
  - definition of done: any spelling of the input path is refused as the elide target,
    `--force` included.
  - test: extend test/args.mjs with the `./` spelling plus `--force`, asserting a
    nonzero exit, the refusal message, and an unchanged input file.

- [ ] Guard `setWaypoints` against duplicating the points array
  - category: bug
  - description: the regex in src/edit.js matches only the exact spelling
    `<Array as="points">`. An existing array spelled differently (attribute spacing or
    order) gets a second array prepended, and `verifyEdit` passes since the parser
    finds the new one first. Add a post-condition asserting the edited slice contains
    exactly one points array, failing the command before anything lands on disk.
  - definition of done: an edit that would produce two points arrays fails loudly and
    writes nothing.
  - test: fixture with `<Array  as="points">` (double space), run `set-waypoints`,
    assert nonzero exit and a byte-identical file.

- [ ] Make render's cell-count guard see compressed input
  - category: bug
  - description: `cellCount` in src/cli.js counts `<mxCell` in the raw text, which is
    0 for a compressed `.drawio`, so the loaded-fewer-cells guard can never fire on
    one. Uncompress before counting (or count on the uncompressed model the render
    check extracts anyway).
  - definition of done: rendering a compressed file still trips the guard when the
    webapp drops cells, and renders normally otherwise.
  - test: compress the existing `id="map"` landmine fixture and assert `render` fails
    with the guard's message instead of writing a blank PNG.

- [ ] Harden the local webapp server
  - category: security (minor)
  - description: two nits in src/render.js. The traversal guard uses
    `startsWith(webappDir)` without a trailing separator, the classic sibling-prefix
    bypass. `decodeURIComponent(req.url)` throws on a malformed `%`, and in Node 20
    an unhandled throw there can take the process down mid-render. Compare against
    `webappDir + sep` and wrap the decode, answering 400 on failure.
  - definition of done: a sibling-prefix path and a malformed-percent URL both get an
    error response while the render continues.
  - test: during a render (or against `serveWebapp` directly), request
    `/webapp/../webappX/x` and `/webapp/%zz`, assert 404/400 responses and no crash.

- [ ] Name the real mistake when `measure` gets a `.drawio`
  - category: usability
  - description: `measure` on a `.drawio` fails with "no content attribute found on
    the root svg element", which describes the parser's confusion rather than the
    user's mistake. Detect a non-PNG, non-SVG input and say measure needs the
    rendered `.drawio.png`.
  - definition of done: `measure x.drawio --cell a` fails with a message naming the
    rendered PNG as the required input.
  - test: extend test/args.mjs asserting the new message on stderr.

- [ ] Drop the dead third argument to `writeOutput`
  - category: tech debt clean up
  - description: `runRender` in src/cli.js passes a third argument `writeOutput` does
    not take, in both the PNG and SVG calls.
  - definition of done: the calls pass exactly (path, data) and behaviour is
    unchanged.
  - test: `npm test` passes.

- [ ] Hoist `absOrigin` and `bbox` into a shared geometry module
  - category: tech debt clean up
  - description: `absOrigin` exists byte-identically in src/lint.js, src/measure.js
    and src/cells.js, and `bbox` twice with diverged signatures. Three copies is one
    past the hoist-at-the-second-consumer line. Extract one module, one signature,
    and import it everywhere.
  - definition of done: one definition of each, all callers importing it, no
    behavioural change.
  - test: `npm test` passes, and `grep -rn "function absOrigin" src/` returns one hit.

- [ ] Reuse `decodeEntities` in the cells table's label renderer
  - category: tech debt clean up
  - description: `label()` in src/cells.js hand-decodes entities with chained
    regexes and misses `&#x27;`, `&nbsp;` and double encoding, while
    `decodeEntities` in src/lint.js already does it to a fixpoint. Replace the hand
    copy with the shared function plus the tag-stripping and truncation it adds.
  - definition of done: one entity decoder in the codebase, and a label containing
    `&#x27;` or a doubly encoded `&amp;lt;b&amp;gt;` renders correctly in the table.
  - test: fixture cell with those values, assert the `cells` output spells them
    decoded.

- [ ] Lint: single-quoted attribute values are an error
  - category: lint rule (codify a textual rule)
  - description: the skill names single-quoted attributes as a landmine that makes
    the webapp load zero cells, but only the render-time count guard catches them,
    after the fact. Scan the stored bytes for `='...'` attribute spellings inside
    element start tags and report error tier.
  - definition of done: a single-quoted fixture exits 1 from `lint` naming the rule,
    a double-quoted control stays clean.
  - test: planted violation plus control in test/lint-violations.mjs.

- [ ] Lint: corner anchors are an error
  - category: lint rule (codify a textual rule)
  - description: the style guide forbids anchoring at or near a shape corner. An
    edge whose exit or entry fractions are both extreme (each 0 or 1) anchors at a
    corner and is a pure style lookup on data lint already parses.
  - definition of done: an edge pinned to `exitX=1;exitY=1` fires, a mid-side anchor
    stays clean. Specimen edges stay exempt.
  - test: planted violation plus control in test/lint-violations.mjs.

- [ ] Lint: cross-colour crossings must carry `jumpStyle=arc`
  - category: lint rule (codify a textual rule)
  - description: lint already computes every run and reports same-colour crossings.
    The same loop can flag a proper crossing of two different-colour edges where
    neither carries `jumpStyle`, per the routing rule that cross-colour crossings
    read as a jump. Token presence is exact, whether the hop renders stays an
    eyeball job, so warning tier fits.
  - definition of done: a jumpless cross-colour crossing warns naming both edges, a
    crossing with `jumpStyle=arc` on either edge stays clean.
  - test: planted violation plus control in test/lint-violations.mjs.

- [ ] Lint config section for repo-specific rules (phase palette, verb table)
  - category: lint rule (codify textual rules), design
  - description: several style-guide rules need repo knowledge the generic tool
    should not hard-code: coloured step edges must carry `rounded=1;arcSize=20`,
    derivation edges `rounded=0`, and an edge label's first body word must come from
    the verb table. Add an optional `lint` section to `drawio.config.json` (phase
    colours, allowed verbs) and check these rules only when it is present.
  - definition of done: with a config declaring the palette and verbs, a sharp-
    cornered step edge and an off-table verb both fire, and without the section lint
    behaves exactly as today.
  - test: planted violations against a fixture config, plus a no-config control
    asserting unchanged output on an existing fixture.

- [ ] Lint: note an unlabelled coloured step edge
  - category: lint rule (codify a textual rule)
  - description: the style guide calls an unlabelled step arrow a defect, with a
    judgement exemption for bundle segments continuing an already-labelled arrow.
    Note tier fits: flag a non-black edge carrying no child label cell.
  - definition of done: an unlabelled coloured edge produces a note, a labelled one
    stays quiet, and the note never fails the run.
  - test: planted note plus control in test/lint-violations.mjs.

- [ ] Lint: advisory working-size note
  - category: lint rule (codify a textual rule)
  - description: the guide sets an advisory content budget of 1300 x 800 model
    units. `modelBounds` is already computed, so emit a note when the content
    exceeds it, naming the actual size.
  - definition of done: an oversized fixture notes its dimensions, an in-budget one
    stays quiet, and the note never fails the run.
  - test: planted note plus control in test/lint-violations.mjs.

- [ ] Lint: hexagon slope rule
  - category: lint rule (codify a textual rule)
  - description: the guide requires event hexagons to use `fixedSize=1` with `size`
    equal to half the height, and forbids width-relative slopes. Both are style and
    geometry lookups.
  - definition of done: a hexagon without `fixedSize=1`, or whose `size` differs
    from half its height, fires. A compliant one stays clean.
  - test: planted violation plus control in test/lint-violations.mjs.

- [ ] Lint: lane borders stay thin
  - category: lint rule (codify a textual rule)
  - description: "edges thicker than lane borders" is only checked from the edge
    side. A swimlane carrying `strokeWidth` of 2 or more breaks the same rule from
    the other side and nothing reports it.
  - definition of done: a thick-bordered swimlane warns, a default one stays clean.
  - test: planted violation plus control in test/lint-violations.mjs.

- [ ] Lint: captioned icons carry their caption above
  - category: lint rule (codify a textual rule)
  - description: the guide puts every icon caption above the icon. An image-styled
    cell with a value but without `verticalLabelPosition=top` breaks it, and the
    check is a style lookup.
  - definition of done: a captioned icon without the token fires, one with it (and
    an uncaptioned icon) stays clean.
  - test: planted violation plus control in test/lint-violations.mjs.

- [ ] Command: `check-pair` plus multi-file `lint`
  - category: feature (CI enablement)
  - description: the docs repo's "the pair moves together" rule has no gate. Add
    `check-pair <file.drawio>...` asserting each committed rendered sibling still
    matches its source cell-level (diff-cells does the comparison today), and let
    `lint` accept multiple inputs with an aggregated exit code, so a repo enforces
    its whole style guide in one CI line.
  - definition of done: `check-pair` exits 0 on a fresh pair, 1 on a stale one
    naming the differing cells, and `lint a.drawio b.drawio` exits 1 when either
    fails.
  - test: render a pair, assert check-pair passes, edit the source without
    re-rendering, assert it fails. Args-suite cases for multi-input lint.

- [ ] Command: `crop` in model units via the affine mapping
  - category: feature
  - description: the skill documents `sips --cropOffset` silently failing and needs
    post-crop assertions. The CLI already owns pngjs and the calibration, so a
    `crop <png> --region x,y,w,h` (model units, affine-mapped to pixels) retires
    that failure mode. Refuse while a live calibration warning stands, as `--affine`
    does.
  - definition of done: cropping a known cell's region yields a PNG whose
    dimensions match the affine prediction exactly, and a live calibration warning
    refuses the crop.
  - test: smoke-test crop of a rendered fixture, asserting output dimensions, plus
    a refusal case at a wrong `--scale`.

- [ ] Command: `pages` lists a file's diagrams
  - category: feature
  - description: page names surface only as an `extract` stderr side effect, yet
    `render --page` needs them. Add `pages <input>` printing index and name per
    diagram.
  - definition of done: `pages` lists every page of a multi-page fixture with
    zero-based indices matching what `render --page` accepts.
  - test: args-suite case on a two-page fixture asserting both lines.

- [ ] Command: `render --all-pages`
  - category: feature
  - description: rendering a multi-page file currently takes one invocation per
    page. Add `--all-pages`, deriving each output name from the base plus the page
    name, and refuse combining it with `--page`.
  - definition of done: one invocation writes one output per page, and
    `--all-pages --page x` fails loudly.
  - test: smoke-test on a two-page fixture asserting both outputs exist and embed
    their own page's model, plus an args-suite refusal case.

- [ ] Housekeeping: cap the smoke artifact pile in test/
  - category: housekeeping
  - description: every `npm test` leaves a timestamped PNG and SVG in test/ forever
    (60-odd files today). Keep the newest pair and delete older
    `smoke-*-test-result.drawio.*` files at the start of each smoke run, preserving
    the see-it-with-your-own-eyes purpose without unbounded growth.
  - definition of done: after any number of runs, test/ holds at most the newest
    pair (or a small fixed count), and the smoke test still prints the artifact
    paths it wrote.
  - test: run `npm test` twice and count the artifacts.
