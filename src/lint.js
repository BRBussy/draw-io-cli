/**
 * Static geometry lint over an uncompressed mxfile. Works entirely from the
 * XML: it requires edges to pin their connection points (exitX/exitY and
 * entryX/entryY) and declare jogs as explicit waypoints, which makes every
 * route a literal polyline the checks below can verify exactly.
 */

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

function attrs(chunk) {
  const out = {};
  for (const m of chunk.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function styleMap(style) {
  const out = {};
  for (const part of (style ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) { if (part) out[part] = ""; }
    else out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** Parses the flat cell list of the FIRST diagram in the mxfile. */
export function parseCells(xml) {
  const cells = new Map();
  const chunks = xml.split(/<mxCell\b/).slice(1);
  for (const chunk of chunks) {
    const head = chunk.slice(0, chunk.search(/\/?>/));
    const a = attrs(head);
    const body = chunk.slice(0, (() => { const i = chunk.indexOf("<mxCell"); return i === -1 ? chunk.length : i; })());
    const geoM = body.match(/<mxGeometry\b([^>]*)>?/);
    const geo = geoM ? attrs(geoM[1]) : null;
    const points = [];
    const arr = body.match(/<Array as="points">([\s\S]*?)<\/Array>/);
    if (arr) for (const p of arr[1].matchAll(/<mxPoint\b([^>]*)\/>/g)) {
      const pa = attrs(p[1]);
      points.push({ x: Number(pa.x ?? 0), y: Number(pa.y ?? 0) });
    }
    const offM = body.match(/<mxPoint\b([^>]*)as="offset"[^>]*\/>/);
    const offset = offM ? (() => { const oa = attrs(offM[1] + 'as="offset"'); return { x: Number(oa.x ?? 0), y: Number(oa.y ?? 0) }; })() : null;
    cells.set(a.id, { id: a.id, attrs: a, style: styleMap(a.style), geo, points, offset });
  }
  return cells;
}

function absOrigin(cells, id) {
  let x = 0, y = 0, cur = cells.get(id);
  while (cur) {
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

const NAMED_ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", amp: "&" };

/**
 * Decodes a cell value's XML entities to a fixpoint. A value round-tripped
 * through the webapp's editor is often doubly encoded (`&amp;lt;b&amp;gt;`),
 * so a single pass leaves markup still spelled as text.
 */
export function decodeEntities(value) {
  let text = value ?? "";
  for (let pass = 0; pass < 8; pass += 1) {
    const next = text
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&(lt|gt|quot|apos|nbsp|amp);/g, (_, n) => NAMED_ENTITIES[n]);
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
 * Estimates a label's rendered box from its character counts: width from the
 * longest line's advance, height from the line count. An estimate, never
 * exact: callers must treat it as advisory.
 */
export function estimateLabelBox(value) {
  const lines = renderedLines(value);
  const chars = Math.max(...lines.map((l) => l.text.length), 1);
  const perChar = /font-family:\s*Menlo/.test(decodeEntities(value)) ? 7.3 : 6.5;
  return {
    w: chars * perChar + 4,
    h: Math.max(lines.length, 1) * 16,
    text: lines.map((l) => l.text).join(" ").slice(0, 30),
  };
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

  for (const c of cells.values()) {
    if (POISON_IDS.has(c.id)) errors.push(`cell id "${c.id}" collides with a webapp builtin and kills rendering`);
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
      warnings.push(`edge ${e.id}: floating connection (pin exitX/exitY and entryX/entryY to make the route verifiable)`);
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
      stackNotes.push(
        `edges ${a.edge} and ${b.edge}: stacked ${axis} runs ${gap} units out of column, align them, separate them, or confirm the offset is anchor-caused`,
      );
    }
  }

  // Advisory only: a monospace code cell much wider than its text suggests the box
  // is not hugging its content. Char-count estimate, so these never fail a run.
  const notes = [...stackNotes];
  for (const c of cells.values()) {
    if (c.attrs.vertex !== "1" || !c.geo) continue;
    const value = c.attrs.value ?? "";
    if (!/font-family:\s*Menlo/.test(value)) continue;
    const text = value.replace(/&lt;[^&]*?&gt;|<[^>]*>/g, "").replace(/&[a-z]+;|&#\d+;/g, "x");
    const est = text.length * 7.3 + 8;
    const width = Number(c.geo.width ?? 0);
    if (width > est + 40) {
      notes.push(`cell ${c.id}: box ${width}u wide for ~${Math.round(est)}u of text, likely not hugging its content`);
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
    labelCells.push({ cell: c, edge: parentEdge.id });
    const pts = polylines.get(parentEdge.id);
    if (!pts) continue;
    const anchor = labelAnchor(pts, c.geo.x, c.offset);
    if (!anchor) continue;
    const est = estimateLabelBox(c.attrs.value);
    labelBoxes.push({ id: c.id, edge: parentEdge.id, x: anchor.x - est.w / 2, y: anchor.y - est.h / 2,
      w: est.w, h: est.h, text: est.text, align: c.style.align });
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
  for (let i = 0; i < labelBoxes.length; i += 1) for (let j = i + 1; j < labelBoxes.length; j += 1) {
    const a = labelBoxes[i], b = labelBoxes[j];
    if (a.x + PEN < b.x + b.w && b.x + PEN < a.x + a.w && a.y + PEN < b.y + b.h && b.y + PEN < a.y + a.h) {
      notes.push(`labels ${a.id} ("${a.text}") and ${b.id} ("${b.text}"): estimated boxes overlap, likely colliding text`);
    }
  }
  // Golden rule, advisory: a riding label either straddles its own edge's
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
  let seated = 0;
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
    if (centred) {
      // seated correctly
    } else if (nearest.vertical && off > 0 && Math.abs(off) >= half) {
      notes.push(`${where}: its own vertical run sits ${clearance}u clear on the label's RIGHT, a run alongside may only sit on the label's left`);
    } else if (overlaps && Math.abs(off) < half) {
      crossing = true;
      notes.push(`${where}: its own ${axis} run cuts the box ${Math.round(Math.abs(off))}u off the ${nearest.vertical ? "horizontal" : "vertical"} midpoint (tolerance ${Math.round(tol)}u), straddle the run centred or slide the label clear alongside it`);
    } else if (!overlaps || clearance > ALONGSIDE) {
      notes.push(`${where}: its own nearest run is ${Math.round(distToRun(centre, nearest))}u from the label centre, too far to ride or to sit alongside (maximum ${ALONGSIDE}u clear)`);
    }
    const wanted = crossing && !nearest.vertical ? "left" : "center";
    const align = lb.align ?? "center"; // the webapp's default when the style omits it
    if (align !== wanted) {
      notes.push(`${where}: align=${lb.align ?? "center (default, no token)"} with its own ${axis} run ${crossing ? "crossing it" : "alongside"}, the crossing axis wants align=${wanted}`);
    }
  }

  // Golden rule, advisory: an edge label's first rendered line is the acting
  // party, bold and colon-terminated, and its body opens with a capital.
  for (const { cell, edge } of labelCells) {
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
      notes.push(`label ${cell.id} ("${whole.slice(0, 30)}") on edge ${edge}: ${faults.join(", and ")}. An edge label reads as a bold colon-terminated actor over a capitalised body, and only a whole-text call expression (identifier immediately followed by parentheses) is exempt as a code label`);
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
  // let an empty input set read as a pass.
  if (labelCells.length === 0) {
    notes.push("golden rules: this diagram carries 0 edge labels, so the format check inspected nothing (vacuous, not green)");
  }
  if (seated === 0) {
    notes.push("golden rules: 0 edge labels resolved onto a run of their own edge, so the run-through-centre and alignment checks inspected nothing (vacuous, not green)");
  }
  if (valued === 0) {
    notes.push("editor junk: this diagram carries 0 cell values, so the check inspected nothing (vacuous, not green)");
  }
  return { errors, warnings, notes };
}
