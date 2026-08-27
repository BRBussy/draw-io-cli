/**
 * Static geometry lint over an uncompressed mxfile. Works entirely from the
 * XML: it requires edges to pin their connection points (exitX/exitY and
 * entryX/entryY) and declare jogs as explicit waypoints, which makes every
 * route a literal polyline the checks below can verify exactly.
 */

import he from "he";
import { XMLParser } from "fast-xml-parser";

const MICRO = 15; // units: a nonzero run shorter than this is a stutter, not a jog
const TAIL = 40; // units: minimum first/last segment on an edge that has a corner
const CLEAR = 20; // units: minimum distance from an arrowhead to any other edge
const CLEAR_SAME = 40; // units: minimum distance from an arrowhead to an unrelated edge of the SAME colour
const NEAR = 15; // units: overlapping parallel runs closer than this must be exactly aligned
const STACK_OFFSET = 30; // units: stacked runs in one gutter closer than this read as one broken column
const STACK_GAP = 120; // units: how far apart along their axis stacked runs still read as one column
const CENTRE_TOL_H = 4; // units: a horizontal run this far off a label's vertical midpoint still reads as riding it
const CENTRE_TOL_FRAC = 0.15; // a label's width is a character estimate (~10% out), so the vertical-run tolerance scales with it
const CENTRE_TOL_V = 8; // units: floor under the scaled tolerance, so a short label still gets one
const ALONGSIDE = 60; // units: clear of the box by more than this and the label has drifted off its run
const POISON_IDS = new Set(["map", "filter", "target", "constructor", "proto", "__proto__"]);
// The whole label text is one call expression: an identifier immediately followed
// by a parenthesised argument list. Such a label is code, not a description, so
// the "bold actor prefix, capitalised body" format does not apply to it.
const CODE_LABEL = /^[A-Za-z_$][\w$.]*\([^()]*\)$/;

// Every switch here holds an attribute to the exact characters the file spells
// it with, which the whole model view depends on: entities stay encoded (a
// value reaches decodeEntities raw and is decoded to a fixpoint there), nothing
// is coerced to a number or a boolean (vertex="1" and every geometry figure are
// compared and converted as strings by their readers), and no value is trimmed.
// preserveOrder additionally keeps the file's element sequence, which is the
// order the cell listing prints in.
const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  processEntities: false,
  allowBooleanAttributes: false,
  preserveOrder: true,
  trimValues: false,
});

// Under preserveOrder a node is one element: its tag name keyed to its child
// list, plus an optional ":@" holding its attributes. Text lands under "#text"
// with a string payload instead of a child list.
const ATTRS = ":@";
const tagOf = (node) => Object.keys(node).find((k) => k !== ATTRS);
const attrsOf = (node) => node[ATTRS] ?? {};
const childrenOf = (node, tag) => (Array.isArray(node[tag]) ? node[tag] : []);

/** Appends every mxCell element under `nodes`, in document order. */
function collectCells(nodes, out) {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === undefined || tag === "#text") continue;
    if (tag === "mxCell") out.push(node);
    collectCells(childrenOf(node, tag), out);
  }
  return out;
}

/**
 * The first element named `tag` whose attributes satisfy `accept`, searched
 * depth first inside ONE cell's own subtree. A nested mxCell opens another
 * cell's subtree and is not descended into, so a cell claims only its own
 * geometry, waypoints and offset.
 */
function findIn(nodes, tag, accept) {
  for (const node of nodes) {
    const name = tagOf(node);
    if (name === undefined || name === "#text" || name === "mxCell") continue;
    if (name === tag && accept(attrsOf(node))) return node;
    const hit = findIn(childrenOf(node, name), tag, accept);
    if (hit) return hit;
  }
  return undefined;
}

const pointOf = (a) => ({ x: Number(a.x ?? 0), y: Number(a.y ?? 0) });

function styleMap(style) {
  const out = {};
  for (const part of (style ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) { if (part) out[part] = ""; }
    else out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/**
 * Parses every mxCell in the mxfile into a map keyed by cell id, in document
 * order. Attribute values are the file's own characters, entities and all.
 * A cell wrapped in an `<object>`/`<UserObject>` carries its id on the wrapper,
 * so the wrapped mxCell has none and is skipped along with any other id-less
 * cell.
 *
 * @throws When the text is not well-formed XML.
 */
export function parseCells(xml) {
  let doc;
  try {
    doc = XML.parse(xml);
  } catch (cause) {
    throw new Error(`the model is not well-formed XML (${cause.message}), fix the source before trusting any check`, { cause });
  }
  const cells = new Map();
  for (const node of collectCells(doc, [])) {
    const a = attrsOf(node);
    // A cell without an id cannot be addressed or parented to, and storing it
    // under the key undefined would make absOrigin's parent walk cyclic (the
    // root's missing parent attribute resolves to it).
    if (a.id === undefined) continue;
    const own = childrenOf(node, "mxCell");
    const geoNode = findIn(own, "mxGeometry", () => true);
    const arrayNode = findIn(own, "Array", (at) => at.as === "points");
    const offsetNode = findIn(own, "mxPoint", (at) => at.as === "offset");
    const points = arrayNode === undefined
      ? []
      : childrenOf(arrayNode, "Array").filter((p) => tagOf(p) === "mxPoint").map((p) => pointOf(attrsOf(p)));
    cells.set(a.id, {
      id: a.id,
      attrs: a,
      style: styleMap(a.style),
      geo: geoNode === undefined ? null : attrsOf(geoNode),
      points,
      offset: offsetNode === undefined ? null : pointOf(attrsOf(offsetNode)),
    });
  }
  return cells;
}

function absOrigin(cells, id) {
  let x = 0, y = 0, cur = cells.get(id);
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur); // a parent cycle in a malformed model must not hang the walk
    if (cur.geo && cur.attrs.vertex === "1") { x += Number(cur.geo.x ?? 0); y += Number(cur.geo.y ?? 0); }
    cur = cells.get(cur.attrs.parent);
  }
  return { x, y };
}

function bbox(cells, id) {
  const c = cells.get(id);
  if (!c?.geo) return null;
  const o = absOrigin(cells, c.attrs.parent);
  return {
    x: o.x + Number(c.geo.x ?? 0),
    y: o.y + Number(c.geo.y ?? 0),
    w: Number(c.geo.width ?? 0),
    h: Number(c.geo.height ?? 0),
  };
}

/**
 * Model-space bounds over every vertex box and edge waypoint, remembering
 * which cell sets each extreme so a calibration mismatch can name suspects.
 * Edge labels never count: they have no committed geometry.
 */
export function modelBounds(cells) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const setBy = { minX: null, minY: null, maxX: null, maxY: null };
  const take = (id, x1, y1, x2, y2) => {
    if (x1 < minX) { minX = x1; setBy.minX = id; }
    if (y1 < minY) { minY = y1; setBy.minY = id; }
    if (x2 > maxX) { maxX = x2; setBy.maxX = id; }
    if (y2 > maxY) { maxY = y2; setBy.maxY = id; }
  };
  for (const c of cells.values()) {
    if (c.attrs.vertex === "1" && c.geo && !(cells.get(c.attrs.parent)?.attrs.edge === "1")) {
      const b = bbox(cells, c.id);
      take(c.id, b.x, b.y, b.x + b.w, b.y + b.h);
    }
    if (c.attrs.edge === "1") {
      const eo = absOrigin(cells, c.attrs.parent);
      for (const p of c.points) take(c.id, p.x + eo.x, p.y + eo.y, p.x + eo.x, p.y + eo.y);
    }
  }
  if (!Number.isFinite(minX)) throw new Error("no geometry found to calibrate against");
  return { minX, minY, maxX, maxY, setBy };
}

const SPECIMEN = 4; // units: an endpoint this small is a degenerate anchor point, not a shape

/**
 * True when BOTH of an edge's endpoints are degenerate specimen points. Such an
 * edge demonstrates a style rather than connecting two shapes, so its label is a
 * legend caption naming what the swatch shows, not a description of an action.
 */
export function isSpecimenEdge(cells, e) {
  const point = (id) => {
    const box = bbox(cells, id);
    return box !== null && box.w <= SPECIMEN && box.h <= SPECIMEN;
  };
  return point(e.attrs.source) && point(e.attrs.target);
}

function pinnedPoint(box, fx, fy, dx, dy) {
  return { x: box.x + Number(fx) * box.w + Number(dx ?? 0), y: box.y + Number(fy) * box.h + Number(dy ?? 0) };
}

/**
 * Resolves an edge's pinned polyline in absolute model coordinates.
 * Returns {pts} on success, or the reason it cannot be resolved:
 * {missing: "source"|"target"}, {nogeo: true}, or {unpinned: true}.
 */
export function pinnedPolyline(cells, e) {
  const s = e.attrs.source, t = e.attrs.target;
  if (!s || !t) return { missing: !s ? "source" : "target" };
  const sb = bbox(cells, s), tb = bbox(cells, t);
  if (!sb || !tb) return { nogeo: true };
  if (e.style.exitX === undefined || e.style.exitY === undefined ||
      e.style.entryX === undefined || e.style.entryY === undefined) return { unpinned: true };
  const eo = absOrigin(cells, e.attrs.parent);
  return {
    pts: [
      pinnedPoint(sb, e.style.exitX, e.style.exitY, e.style.exitDx, e.style.exitDy),
      ...e.points.map((p) => ({ x: p.x + eo.x, y: p.y + eo.y })),
      pinnedPoint(tb, e.style.entryX, e.style.entryY, e.style.entryDx, e.style.entryDy),
    ],
  };
}

/**
 * Resolves an edge label's absolute anchor point: the label's relative
 * position (geometry x in -1..1) walked along the polyline's arc length,
 * plus its offset point. Returns null when the polyline has no length.
 */
export function labelAnchor(pts, t, offset) {
  const segs = [];
  let arc = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const len = Math.abs(pts[i].x - pts[i + 1].x) + Math.abs(pts[i].y - pts[i + 1].y);
    segs.push({ a: pts[i], b: pts[i + 1], len, at: arc });
    arc += len;
  }
  if (arc === 0) return null;
  const clamped = Math.max(-1, Math.min(1, Number(t ?? 0)));
  const target = ((clamped + 1) / 2) * arc;
  let anchor = pts[pts.length - 1];
  for (const seg of segs) {
    if (target <= seg.at + seg.len) {
      const f = seg.len === 0 ? 0 : (target - seg.at) / seg.len;
      anchor = { x: seg.a.x + (seg.b.x - seg.a.x) * f, y: seg.a.y + (seg.b.y - seg.a.y) * f };
      break;
    }
  }
  return offset ? { x: anchor.x + offset.x, y: anchor.y + offset.y } : anchor;
}

/**
 * Decodes a cell value's XML entities to a fixpoint. A value round-tripped
 * through the webapp's editor is often doubly encoded (`&amp;lt;b&amp;gt;`),
 * so a single pass leaves markup still spelled as text. A non-breaking space
 * lands as a plain space: the measurements downstream size it as one, and a
 * label's text reads as one.
 */
export function decodeEntities(value) {
  let text = value ?? "";
  for (let pass = 0; pass < 8; pass += 1) {
    const next = he.decode(text, { isAttributeValue: true }).replaceAll("\u00a0", " ");
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Splits a cell value's markup into its rendered lines, entities decoded to a
 * fixpoint. Each line carries its full text and the part of it inside a bold
 * span, so a `<b>` spanning a `<br>` (which the editor writes freely) still
 * reports the first line as fully bold. Empty lines are dropped.
 */
export function renderedLines(value) {
  const html = decodeEntities(value);
  const lines = [{ text: "", bold: "" }];
  let bold = 0;
  const put = (s) => {
    const cur = lines[lines.length - 1];
    cur.text += s;
    if (bold > 0) cur.bold += s;
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { put(html.slice(i)); break; }
    put(html.slice(i, lt));
    const gt = html.indexOf(">", lt);
    if (gt === -1) { put(html.slice(lt)); break; }
    const raw = html.slice(lt + 1, gt);
    const name = raw.replace(/^\//, "").split(/[\s/]/)[0].toLowerCase();
    if (name === "br" || name === "div" || name === "p") lines.push({ text: "", bold: "" });
    else if (name === "b" || name === "strong") bold = Math.max(0, bold + (raw.startsWith("/") ? -1 : 1));
    i = gt + 1;
  }
  return lines
    .map((l) => ({ text: l.text.trim(), bold: l.bold.trim() }))
    .filter((l) => l.text !== "");
}

/**
 * Estimates one line's rendered advance in model units. Calibrated against
 * probe renders (Helvetica 12px: lowercase run 5.65 u/char, caps run 7.32,
 * Menlo 7.07): uppercase and digits are wide, spaces and thin punctuation
 * narrow, everything else lowercase-width. Within about 4% on mixed text.
 */
export function estimateAdvance(text, menlo) {
  if (menlo) return text.length * 7.1;
  let w = 0;
  for (const ch of text) {
    if (/[A-Z0-9@#%&]/.test(ch)) w += 7.9;
    else if (/[ ]/.test(ch)) w += 3.4;
    else if (/[.,:;'|!()[\]{}lijft-]/.test(ch)) w += 3.8;
    else w += 6.2;
  }
  return w;
}

/**
 * Estimates a label's rendered box from its character counts: width from the
 * longest line's advance, height from the line count. An estimate, never
 * exact: callers must treat it as advisory.
 */
export function estimateLabelBox(value) {
  const lines = renderedLines(value);
  const menlo = /font-family:\s*Menlo/.test(decodeEntities(value));
  // Bold widens Helvetica by a few percent, so a line's advance gains 5% of
  // its bold portion's width on top of the plain estimate.
  const lineW = (l) => estimateAdvance(l.text, menlo) + (menlo ? 0 : 0.05 * estimateAdvance(l.bold, false));
  const w = Math.max(...lines.map(lineW), 6);
  return {
    w: w + 4,
    h: Math.max(lines.length, 1) * 16,
    text: lines.map((l) => l.text).join(" ").slice(0, 30),
  };
}

/**
 * Places a label's estimated box around its anchor the way mxGraph does:
 * `align=left` puts the text's LEFT edge on the anchor, `align=right` its
 * right edge, and only `align=center` (the default) centres it. Vertically,
 * `verticalAlign=middle` centres the text on the anchor, while the default
 * hangs it about 4 units below. Pixel-confirmed on a synthetic fixture.
 */
export function labelBoxFor(anchor, est, style = {}) {
  const align = style.align ?? "center";
  const x = align === "left" ? anchor.x : align === "right" ? anchor.x - est.w : anchor.x - est.w / 2;
  const y = (style.verticalAlign ?? null) === "middle" ? anchor.y - est.h / 2 : anchor.y + 4;
  return { x, y, w: est.w, h: est.h };
}

/**
 * Finds editor-injected inline CSS in a cell value, returning one token per
 * distinct offence (empty when the value is clean). The webapp writes theme
 * and scrollbar declarations into a value the moment it is edited in place,
 * and they survive into the committed file as styling nobody chose.
 *
 * The palette's code-cell scaffold is the ONE sanctioned inline CSS: a Menlo
 * `font-family` declaration plus the plain single-colour spans nested in it,
 * which is how every contract-member row carries its keyword colour. A colour
 * span in a value carrying no such scaffold is the editor's, not the palette's,
 * and `scrollbar-color` or `light-dark(` is the editor's anywhere at all.
 */
export function editorJunk(value) {
  const html = decodeEntities(value ?? "");
  const found = [];
  for (const token of ["scrollbar-color", "light-dark("]) if (html.includes(token)) found.push(token);
  // The editor wraps residue (an invisible line break, a re-coloured span) in
  // <font> tags, which the inline-CSS matching below cannot see.
  if (/<font\b[^>]*\scolor="/i.test(html)) found.push('<font color="...">');
  const scaffolded = /font-family:\s*Menlo/.test(html);
  for (const attr of html.matchAll(/style="([^"]*)"/g)) {
    for (const decl of attr[1].split(";")) {
      const colon = decl.indexOf(":");
      if (colon === -1) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const val = decl.slice(colon + 1).trim();
      if (prop !== "color" && prop !== "background-color") continue;
      // A literal colour inside the code scaffold is the palette's member-row span.
      if (scaffolded && prop === "color" && /^(rgb\([\d,\s]+\)|#[0-9a-fA-F]{3,8})$/.test(val)) continue;
      found.push(`${prop}: ${val}`);
    }
  }
  return [...new Set(found)];
}

function segmentCrossesBox(a, b, box) {
  const pad = 4; // hexagons and rounded shapes are narrower than their bbox
  const x1 = box.x + pad, y1 = box.y + pad, x2 = box.x + box.w - pad, y2 = box.y + box.h - pad;
  if (x2 <= x1 || y2 <= y1) return false;
  if (a.x === b.x) {
    return a.x > x1 && a.x < x2 && Math.min(a.y, b.y) < y2 && Math.max(a.y, b.y) > y1;
  }
  if (a.y === b.y) {
    return a.y > y1 && a.y < y2 && Math.min(a.x, b.x) < x2 && Math.max(a.x, b.x) > x1;
  }
  return false; // diagonal segments are reported separately
}

/**
 * Lints the given mxfile XML. Returns {errors, warnings}, each an array of
 * strings. Edges with floating (unpinned) connection points are warnings:
 * their geometry cannot be verified statically until pinned.
 */
export function lint(xml) {
  const errors = [], warnings = [];
  const cells = parseCells(xml);
  const edges = [...cells.values()].filter((c) => c.attrs.edge === "1");
  const isContainer = new Set([...cells.values()].map((c) => c.attrs.parent));
  const shapes = [...cells.values()].filter(
    (c) => c.attrs.vertex === "1" && c.geo && !isContainer.has(c.id) &&
      Number(c.geo.width ?? 0) > 2 && Number(c.geo.height ?? 0) > 2 &&
      !(cells.get(c.attrs.parent)?.attrs.edge === "1"),
  );

  // A parse that lost most of the file must fail loudly, never lint the
  // remainder as if it were the diagram. The count it is held against is taken
  // from the raw text on purpose, so the check stays independent of the parse
  // it is checking: deriving it from the parsed model would make the two sides
  // agree by construction and the check vacuous.
  const rawCount = (xml.match(/<mxCell[\s>/]/g) ?? []).length;
  if (rawCount > 0 && cells.size < rawCount / 2) {
    errors.push(
      `parsed ${cells.size} of ${rawCount} mxCell elements: the model is malformed ` +
        `(a splice that buried cells in a comment or a CDATA block is the usual cause), ` +
        `fix the source before trusting any check`,
    );
  }

  for (const c of cells.values()) {
    if (POISON_IDS.has(c.id)) errors.push(`cell id "${c.id}" collides with a webapp builtin and kills rendering`);
    // A remote image renders BLANK in the offline renderer and violates the
    // icons rule, and the failure is invisible in the XML.
    const image = c.style.image ?? "";
    if (/^https?:\/\//.test(image)) {
      errors.push(`cell ${c.id}: style references a remote image (${image.slice(0, 60)}...), embed the payload as a data: URI instead`);
    }
  }

  const runs = []; // {edge, vertical, coord, lo, hi, colour}
  const polylines = new Map(); // edge id -> pinned polyline points
  const entries = []; // {edge, p} arrowhead landing points
  for (const e of edges) {
    const s = e.attrs.source, t = e.attrs.target;
    const res = pinnedPolyline(cells, e);
    if (res.missing) { errors.push(`edge ${e.id}: unattached (missing ${res.missing})`); continue; }
    const sw = Number(e.style.strokeWidth ?? 1);
    if (sw < 2) warnings.push(`edge ${e.id}: strokeWidth=${sw}, edges must be thicker than lane borders (>=2)`);
    if (res.nogeo) { warnings.push(`edge ${e.id}: terminal without geometry, cannot verify route`); continue; }
    if (res.unpinned) {
      // A specimen edge joins two degenerate points, where exit and entry
      // sides are geometrically meaningless, so pinning it adds noise to
      // satisfy a check that cannot apply.
      if (!isSpecimenEdge(cells, e)) {
        warnings.push(`edge ${e.id}: floating connection (pin exitX/exitY and entryX/entryY to make the route verifiable)`);
      }
      continue;
    }
    const pts = res.pts;
    if (pts.length > 2) {
      const seg = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      const first = seg(pts[0], pts[1]);
      const last = seg(pts[pts.length - 2], pts[pts.length - 1]);
      if (first > 0.01 && first < TAIL) errors.push(`edge ${e.id}: tail of ${first} units before its first corner, minimum ${TAIL}`);
      if (last > 0.01 && last < TAIL) errors.push(`edge ${e.id}: lead of ${last} units into the arrowhead, minimum ${TAIL}`);
    }
    entries.push({ edge: e.id, p: pts[pts.length - 1], colour: e.style.strokeColor ?? "default" });
    polylines.set(e.id, pts);
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i], b = pts[i + 1];
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      if (dx > 0.01 && dy > 0.01) {
        errors.push(`edge ${e.id}: DIAGONAL segment (${a.x},${a.y}) -> (${b.x},${b.y})`);
        continue;
      }
      const len = Math.max(dx, dy);
      if (len > 0.01 && len < MICRO) {
        errors.push(`edge ${e.id}: near-straight stutter of ${len} units at (${a.x},${a.y}), make it 0 or a deliberate jog`);
      }
      if (len >= MICRO) {
        const colour = e.style.strokeColor ?? "default";
        runs.push(dx < 0.01
          ? { edge: e.id, vertical: true, coord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), colour }
          : { edge: e.id, vertical: false, coord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), colour });
      }
      for (const shape of shapes) {
        if (shape.id === s || shape.id === t) continue;
        const box = bbox(cells, shape.id);
        if (box && segmentCrossesBox(a, b, box)) {
          errors.push(`edge ${e.id}: segment cuts through shape ${shape.id} ("${(shape.attrs.value ?? "").slice(0, 30)}"), route around it`);
        }
      }
    }
  }

  // An arrowhead must land clear of every other edge. Arrowheads deliberately
  // sharing one anchor point are the allowed confluence.
  const distToRun = (p, r) => {
    const along = r.vertical ? p.y : p.x;
    const across = Math.abs((r.vertical ? p.x : p.y) - r.coord);
    if (along >= r.lo && along <= r.hi) return across;
    return across + Math.min(Math.abs(along - r.lo), Math.abs(along - r.hi));
  };
  for (const ent of entries) for (const r of runs) {
    if (r.edge === ent.edge) continue;
    const other = entries.find((o) => o.edge === r.edge);
    if (other && Math.abs(other.p.x - ent.p.x) < 2 && Math.abs(other.p.y - ent.p.y) < 2) continue;
    const d = distToRun(ent.p, r);
    const floor = r.colour === ent.colour ? CLEAR_SAME : CLEAR;
    if (d < floor) {
      const same = r.colour === ent.colour ? " (SAME colour, reads as a junction)" : "";
      errors.push(`edge ${ent.edge}: arrowhead at (${ent.p.x},${ent.p.y}) is ${Math.round(d)} units from edge ${r.edge}${same}, minimum ${floor}`);
    }
  }

  // A run passing hard alongside an unrelated shape reads as touching it.
  // Advisory: a step circle deliberately hugs its own step's edge (same stroke
  // colour), so same-colour furniture is exempt, as are the run's own
  // endpoints. Crossing the shape outright is the error above, not this note.
  const clearanceNotes = [];
  for (const r of runs) {
    const e = cells.get(r.edge);
    for (const shape of shapes) {
      if (shape.id === e.attrs.source || shape.id === e.attrs.target) continue;
      if ((shape.style.strokeColor ?? "default") === r.colour) continue;
      const box = bbox(cells, shape.id);
      if (!box) continue;
      const nearLo = r.vertical ? box.y : box.x;
      const nearHi = r.vertical ? box.y + box.h : box.x + box.w;
      if (r.hi < nearLo || r.lo > nearHi) continue; // no run alongside the shape
      const acrossLo = r.vertical ? box.x : box.y;
      const acrossHi = r.vertical ? box.x + box.w : box.y + box.h;
      const d = r.coord < acrossLo ? acrossLo - r.coord : r.coord > acrossHi ? r.coord - acrossHi : 0;
      if (d > 0 && d < CLEAR) {
        clearanceNotes.push(
          `edge ${r.edge}: run passes ${Math.round(d)}u from shape ${shape.id} ("${(shape.attrs.value ?? "").slice(0, 24)}"), minimum clearance ${CLEAR}u`,
        );
      }
    }
  }

  // Two edges of the same colour (the same step) must never properly cross each
  // other. A T-junction, an endpoint landing ON the other run, is the sanctioned
  // shared-trunk fan-out and is excluded by the strict-interior margins.
  for (let i = 0; i < runs.length; i += 1) for (let j = 0; j < runs.length; j += 1) {
    const v = runs[i], h = runs[j];
    if (!v.vertical || h.vertical || v.edge === h.edge || v.colour !== h.colour) continue;
    const M = 0.5;
    if (v.coord > h.lo + M && v.coord < h.hi - M && h.coord > v.lo + M && h.coord < v.hi - M) {
      errors.push(
        `edges ${v.edge} and ${h.edge}: same-colour (${v.colour}) edges cross at (${v.coord},${h.coord}), share a base or reroute`,
      );
    }
  }

  const stackNotes = [];
  for (let i = 0; i < runs.length; i += 1) for (let j = i + 1; j < runs.length; j += 1) {
    const a = runs[i], b = runs[j];
    if (a.vertical !== b.vertical || a.edge === b.edge) continue;
    const gap = Math.abs(a.coord - b.coord);
    if (gap <= 0.01) continue;
    const axis = a.vertical ? "vertical" : "horizontal";
    if (gap < NEAR && a.lo < b.hi && b.lo < a.hi) {
      errors.push(
        `edges ${a.edge} and ${b.edge}: parallel ${axis} runs ${gap} units apart, align them exactly or separate them`,
      );
    }
    // Stacked in one gutter: disjoint spans whose void is small read as one
    // column, so a small cross-axis offset reads as a broken column. Advisory
    // only: an offset forced by the anchor rules is legitimate, and only an
    // eyeball can tell that apart from a broken column.
    const voidBetween = Math.max(a.lo, b.lo) - Math.min(a.hi, b.hi);
    if (gap < STACK_OFFSET && voidBetween > 0 && voidBetween < STACK_GAP) {
      // Disjoint runs far apart along their axis are the weaker signal: on
      // real diagrams aligning them was still usually right, so the void is
      // named rather than the hit silenced.
      stackNotes.push(
        `edges ${a.edge} and ${b.edge}: stacked ${axis} runs ${gap} units out of column ` +
          `(disjoint spans, ${Math.round(voidBetween)}u void between them), align them, separate them, or confirm the offset is anchor-caused`,
      );
    }
  }

  // Advisory only: a monospace code cell much wider than its text suggests the box
  // is not hugging its content. Char-count estimate, so these never fail a run.
  const notes = [...stackNotes, ...clearanceNotes];
  for (const c of cells.values()) {
    if (c.attrs.vertex !== "1" || !c.geo || !c.attrs.value) continue;
    if (cells.get(c.attrs.parent)?.attrs.edge === "1") continue; // riding labels size themselves
    // An icon's caption renders OUTSIDE its box (verticalLabelPosition), so
    // the box width says nothing about the caption's fit.
    if (c.style.verticalLabelPosition !== undefined || c.style.image !== undefined) continue;
    const width = Number(c.geo.width ?? 0);
    if (width <= 0) continue;
    const menlo = /font-family:\s*Menlo/.test(decodeEntities(c.attrs.value));
    const lines = renderedLines(c.attrs.value);
    if (lines.length === 0) continue;
    if (menlo) {
      const est = Math.max(...lines.map((l) => estimateAdvance(l.text, true))) + 8;
      if (width > est + 40) {
        notes.push(`cell ${c.id}: box ${width}u wide for ~${Math.round(est)}u of text, likely not hugging its content`);
      }
    }
    // The other direction: an unbreakable token wider than the box overflows
    // and paints over neighbours, invisible in the XML. Wrapping cannot save
    // it, since a token has no break point. Estimate tier, so a note.
    const longestToken = lines
      .flatMap((l) => l.text.split(/\s+/))
      .reduce((a, t) => (estimateAdvance(t, menlo) > estimateAdvance(a, menlo) ? t : a), "");
    const tokenW = estimateAdvance(longestToken, menlo);
    if (tokenW > width * 1.1 + 6) {
      notes.push(
        `cell ${c.id}: token "${longestToken.slice(0, 30)}" is ~${Math.round(tokenW)}u wide in a ${width}u box, ` +
          `likely overflowing it (an unbreakable token ignores wrapping)`,
      );
    }
  }
  // Advisory only: edge labels have no committed geometry, so their boxes are
  // estimated from character counts and the label's position along its edge.
  // Estimates never fail a run; they point the eyeball at likely collisions.
  const labelBoxes = [];
  const labelCells = [];
  for (const c of cells.values()) {
    if (c.attrs.vertex !== "1" || !c.geo) continue;
    const parentEdge = cells.get(c.attrs.parent);
    if (parentEdge?.attrs.edge !== "1") continue;
    const specimen = isSpecimenEdge(cells, parentEdge);
    labelCells.push({ cell: c, edge: parentEdge.id, specimen });
    const pts = polylines.get(parentEdge.id);
    if (!pts) continue;
    const anchor = labelAnchor(pts, c.geo.x, c.offset);
    if (!anchor) continue;
    const est = estimateLabelBox(c.attrs.value);
    const box = labelBoxFor(anchor, est, c.style);
    labelBoxes.push({ id: c.id, edge: parentEdge.id, x: box.x, y: box.y,
      w: box.w, h: box.h, text: est.text, align: c.style.align, specimen });
  }
  const PEN = 2; // units a run must penetrate an estimated box before it is worth a note
  for (const lb of labelBoxes) {
    for (const r of runs) {
      if (r.edge === lb.edge) continue;
      const acrossLo = r.vertical ? lb.x : lb.y;
      const acrossHi = r.vertical ? lb.x + lb.w : lb.y + lb.h;
      const alongLo = r.vertical ? lb.y : lb.x;
      const alongHi = r.vertical ? lb.y + lb.h : lb.x + lb.w;
      if (r.coord > acrossLo + PEN && r.coord < acrossHi - PEN && r.lo < alongHi - PEN && r.hi > alongLo + PEN) {
        notes.push(`edge ${r.edge} runs through the estimated box of label ${lb.id} ("${lb.text}"), likely striking the text`);
      }
    }
  }
  // Label-over-label: boxes are estimates (about 5% out), so a marginal graze
  // stays advisory, while an overlap that survives shrinking both boxes by 20%
  // per side is real beyond the estimate's error and fails the run.
  const shrink = (b) => ({ x: b.x + b.w * 0.2, y: b.y + b.h * 0.2, w: b.w * 0.6, h: b.h * 0.6 });
  for (let i = 0; i < labelBoxes.length; i += 1) for (let j = i + 1; j < labelBoxes.length; j += 1) {
    const a = labelBoxes[i], b = labelBoxes[j];
    if (a.x + PEN < b.x + b.w && b.x + PEN < a.x + a.w && a.y + PEN < b.y + b.h && b.y + PEN < a.y + a.h) {
      const sa = shrink(a), sb = shrink(b);
      const certain = sa.x < sb.x + sb.w && sb.x < sa.x + sa.w && sa.y < sb.y + sb.h && sb.y < sa.y + sa.h;
      if (certain) {
        errors.push(`labels ${a.id} ("${a.text}") and ${b.id} ("${b.text}"): text boxes overlap well beyond the estimate's error, colliding text`);
      } else {
        notes.push(`labels ${a.id} ("${a.text}") and ${b.id} ("${b.text}"): estimated boxes graze, check the render for colliding text`);
      }
    }
  }

  // The exporter extends its bounds to include edge labels (a rendered pair's
  // residual proves it: folding label boxes into the predicted bounds lands
  // within a few pixels), so a label past the geometry bounds does NOT clip.
  // No check is needed; measure's calibration names such extensions.
  // Golden rule, ERROR tier (promoted once every committed diagram met the
  // label rules): a riding label either straddles its own edge's
  // nearest run through its centre band (the knockout breaking the line behind
  // the text) or sits clear alongside, the run on its LEFT (vertical) or its
  // top or bottom (horizontal). A vertical run on the label's RIGHT is always a
  // strike. The centre band's tolerance is absolute across a horizontal run
  // (line height is 16 units, known exactly) and proportional across a vertical
  // one (the box width is a character estimate, roughly 10% out).
  //
  // The same nearest run fixes the alignment rule: `align=left` when the run
  // crosses the label horizontally, `align=center` when the run is vertical or
  // the label sits alongside. A missing token is the webapp default, center.
  // Alignment is the acting party's reading axis, which a legend caption on a
  // specimen edge has none of, so specimens are exempt from it. Seating is not:
  // a caption riding its swatch crookedly is a defect on a copy-source card.
  let seated = 0, aligned = 0;
  for (const lb of labelBoxes) {
    const centre = { x: lb.x + lb.w / 2, y: lb.y + lb.h / 2 };
    const own = runs.filter((r) => r.edge === lb.edge);
    if (own.length === 0) continue;
    seated += 1;
    const nearest = own.reduce((a, b) => (distToRun(centre, a) <= distToRun(centre, b) ? a : b));
    const where = `label ${lb.id} ("${lb.text}") on edge ${lb.edge}`;
    const axis = nearest.vertical ? "vertical" : "horizontal";
    const half = (nearest.vertical ? lb.w : lb.h) / 2;
    const tol = nearest.vertical ? Math.max(CENTRE_TOL_V, lb.w * CENTRE_TOL_FRAC) : CENTRE_TOL_H;
    const off = nearest.coord - (nearest.vertical ? centre.x : centre.y); // + is right of / below the centre
    const alongLo = nearest.vertical ? lb.y : lb.x;
    const alongHi = nearest.vertical ? lb.y + lb.h : lb.x + lb.w;
    const overlaps = nearest.lo < alongHi && nearest.hi > alongLo;
    const clearance = Math.round(Math.abs(off) - half);
    const centred = overlaps && Math.abs(off) <= tol;
    let crossing = centred;
    if (!centred) {
      if (nearest.vertical && off > 0 && Math.abs(off) >= half) {
        errors.push(`${where}: its own vertical run sits ${clearance}u clear on the label's RIGHT, a run alongside may only sit on the label's left`);
      } else if (overlaps && Math.abs(off) < half) {
        crossing = true;
        errors.push(`${where}: its own ${axis} run cuts the box ${Math.round(Math.abs(off))}u off the ${nearest.vertical ? "horizontal" : "vertical"} midpoint (tolerance ${Math.round(tol)}u), straddle the run centred or slide the label clear alongside it`);
      } else if (!overlaps || clearance > ALONGSIDE) {
        errors.push(`${where}: its own nearest run is ${Math.round(distToRun(centre, nearest))}u from the label centre, too far to ride or to sit alongside (maximum ${ALONGSIDE}u clear)`);
      }
    }
    if (lb.specimen) continue;
    aligned += 1;
    const wanted = crossing && !nearest.vertical ? "left" : "center";
    const align = lb.align ?? "center"; // the webapp's default when the style omits it
    if (align !== wanted) {
      errors.push(`${where}: align=${lb.align ?? "center (default, no token)"} with its own ${axis} run ${crossing ? "crossing it" : "alongside"}, the crossing axis wants align=${wanted}`);
    }
  }

  // Golden rule, ERROR tier: an edge label's first rendered line is the acting
  // party, bold and colon-terminated, and its body opens with a capital. A
  // legend caption on a specimen edge names a style, has no acting party, and
  // is exempt.
  let formatted = 0;
  for (const { cell, edge, specimen } of labelCells) {
    if (specimen) continue;
    formatted += 1;
    const lines = renderedLines(cell.attrs.value);
    if (lines.length === 0) continue;
    const whole = lines.map((l) => l.text).join(" ");
    if (CODE_LABEL.test(whole)) continue; // a call expression is code, not a description
    const body = lines.slice(1).map((l) => l.text).join(" ").trim();
    const faults = [];
    if (lines[0].bold !== lines[0].text) faults.push(`its first line "${lines[0].text}" is not fully bold`);
    if (!lines[0].text.endsWith(":")) faults.push(`its first line "${lines[0].text}" is not colon-terminated`);
    if (body === "") faults.push("it has no body under its first line");
    else if (!/^\p{Lu}/u.test(body)) faults.push(`its body "${body.slice(0, 24)}" does not start with a capital letter`);
    if (faults.length > 0) {
      errors.push(`label ${cell.id} ("${whole.slice(0, 30)}") on edge ${edge}: ${faults.join(", and ")}. An edge label reads as a bold colon-terminated actor over a capitalised body, and only a whole-text call expression (identifier immediately followed by parentheses) is exempt as a code label`);
    }
  }

  // The webapp writes theme and scrollbar CSS into a value edited in place.
  // A warning, not a note: it is textual, exact, and never a judgement call.
  let valued = 0;
  for (const c of cells.values()) {
    if (!c.attrs.value) continue;
    valued += 1;
    for (const token of editorJunk(c.attrs.value)) {
      warnings.push(`cell ${c.id}: editor-injected inline CSS in its value ("${token}"), strip it. The palette's Menlo code scaffold and the plain colour spans nested in it are the only sanctioned inline CSS`);
    }
  }

  // A check that inspected nothing is vacuous, not green: say so rather than
  // let an empty input set read as a pass. An all-specimen diagram exempts its
  // way to silence on alignment and format, which must read as coverage lost,
  // not as two rules held.
  const specimens = labelCells.filter((l) => l.specimen).length;
  const exempt = `${specimens} legend caption(s) on specimen edges exempt`;
  if (labelCells.length === 0) {
    notes.push("golden rules: this diagram carries 0 edge labels, so the run-through-centre, alignment and format checks inspected nothing (vacuous, not green)");
  } else {
    if (seated === 0) notes.push("golden rules: 0 edge labels resolved onto a run of their own edge, so the run-through-centre check inspected nothing (vacuous, not green)");
    if (aligned === 0) notes.push(`golden rules: 0 edge labels reached the alignment check (${exempt}), so it inspected nothing (vacuous, not green)`);
    if (formatted === 0) notes.push(`golden rules: 0 edge labels reached the format check (${exempt}), so it inspected nothing (vacuous, not green)`);
  }
  if (valued === 0) {
    notes.push("editor junk: this diagram carries 0 cell values, so the check inspected nothing (vacuous, not green)");
  }
  return { errors, warnings, notes };
}
