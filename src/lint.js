/**
 * Static geometry lint over an uncompressed mxfile. Works entirely from the
 * XML: it requires edges to pin their connection points (exitX/exitY and
 * entryX/entryY) and declare jogs as explicit waypoints, which makes every
 * route a literal polyline the checks below can verify exactly.
 */

const MICRO = 15; // units: a nonzero run shorter than this is a stutter, not a jog
const NEAR = 15; // units: parallel runs closer than this must be exactly aligned
const POISON_IDS = new Set(["map", "filter", "target", "constructor", "proto", "__proto__"]);

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
    cells.set(a.id, { id: a.id, attrs: a, style: styleMap(a.style), geo, points });
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

  const runs = []; // {edge, vertical, coord, lo, hi}
  for (const e of edges) {
    const s = e.attrs.source, t = e.attrs.target;
    if (!s || !t) { errors.push(`edge ${e.id}: unattached (missing ${!s ? "source" : "target"})`); continue; }
    const sw = Number(e.style.strokeWidth ?? 1);
    if (sw < 2) warnings.push(`edge ${e.id}: strokeWidth=${sw}, edges must be thicker than lane borders (>=2)`);
    const sb = bbox(cells, s), tb = bbox(cells, t);
    if (!sb || !tb) { warnings.push(`edge ${e.id}: terminal without geometry, cannot verify route`); continue; }
    const pinnedExit = e.style.exitX !== undefined && e.style.exitY !== undefined;
    const pinnedEntry = e.style.entryX !== undefined && e.style.entryY !== undefined;
    if (!pinnedExit || !pinnedEntry) {
      warnings.push(`edge ${e.id}: floating connection (pin exitX/exitY and entryX/entryY to make the route verifiable)`);
      continue;
    }
    const eo = absOrigin(cells, e.attrs.parent);
    const pts = [
      pinnedPoint(sb, e.style.exitX, e.style.exitY, e.style.exitDx, e.style.exitDy),
      ...e.points.map((p) => ({ x: p.x + eo.x, y: p.y + eo.y })),
      pinnedPoint(tb, e.style.entryX, e.style.entryY, e.style.entryDx, e.style.entryDy),
    ];
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
        runs.push(dx < 0.01
          ? { edge: e.id, vertical: true, coord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) }
          : { edge: e.id, vertical: false, coord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
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

  for (let i = 0; i < runs.length; i += 1) for (let j = i + 1; j < runs.length; j += 1) {
    const a = runs[i], b = runs[j];
    if (a.vertical !== b.vertical || a.edge === b.edge) continue;
    const gap = Math.abs(a.coord - b.coord);
    if (gap > 0.01 && gap < NEAR && a.lo < b.hi && b.lo < a.hi) {
      errors.push(
        `edges ${a.edge} and ${b.edge}: parallel ${a.vertical ? "vertical" : "horizontal"} runs ${gap} units apart, align them exactly or separate them`,
      );
    }
  }

  return { errors, warnings };
}
