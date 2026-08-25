import { decodePng } from "./png.js";
import { parseCells, pinnedPolyline, labelAnchor, estimateLabelBox } from "./lint.js";

function absOrigin(cells, id) {
  let x = 0, y = 0, cur = cells.get(id);
  while (cur) {
    if (cur.geo && cur.attrs.vertex === "1") { x += Number(cur.geo.x ?? 0); y += Number(cur.geo.y ?? 0); }
    cur = cells.get(cur.attrs.parent);
  }
  return { x, y };
}

function bbox(cells, c) {
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
 */
function modelBounds(cells) {
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
      const b = bbox(cells, c);
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

const INK = ([r, g, b, a]) => a > 16 && (r < 245 || g < 245 || b < 245);

/**
 * Measures cells of a rendered .drawio.png against its embedded model.
 * Calibration maps model units to pixels from the model bounds plus the
 * render config's scale and border; the report opens with the calibration
 * residual so measurements carry their own error bar.
 */
export function measure(pngBuffer, xml, { cellIds, scale, border }) {
  const img = decodePng(pngBuffer);
  const cells = parseCells(xml);
  const b = modelBounds(cells);
  const predictedW = Math.round((b.maxX - b.minX + 2 * border) * scale);
  const predictedH = Math.round((b.maxY - b.minY + 2 * border) * scale);
  const residualW = img.width - predictedW;
  const residualH = img.height - predictedH;
  const lines = [];
  lines.push(
    `calibration: scale=${scale} border=${border} model=(${b.minX},${b.minY})..(${b.maxX},${b.maxY}) ` +
      `png=${img.width}x${img.height} predicted=${predictedW}x${predictedH} residual=${residualW},${residualH}px`,
  );
  if (Math.abs(residualW) > 2 * scale || Math.abs(residualH) > 2 * scale) {
    // Edge labels have no committed geometry, so they never count toward the
    // model bounds, and a label hanging past the outermost shape is the usual
    // cause of a large residual. Estimate each label's box and name the
    // overhangers.
    const overhangs = [];
    for (const c of cells.values()) {
      if (c.attrs.vertex !== "1" || !c.geo) continue;
      const parentEdge = cells.get(c.attrs.parent);
      if (parentEdge?.attrs.edge !== "1") continue;
      const res = pinnedPolyline(cells, parentEdge);
      if (!res.pts) continue;
      const anchor = labelAnchor(res.pts, c.geo.x, c.offset);
      if (!anchor) continue;
      const est = estimateLabelBox(c.attrs.value);
      const over = Math.max(
        b.minX - (anchor.x - est.w / 2), (anchor.x + est.w / 2) - b.maxX,
        b.minY - (anchor.y - est.h / 2), (anchor.y + est.h / 2) - b.maxY,
      );
      if (over > 2) overhangs.push(`${c.id} (~${Math.round(over)}u past the bounds)`);
    }
    const suspects = overhangs.length > 0
      ? `Estimated edge-label overhangs: ${overhangs.join(", ")}`
      : `Bounds are set by left=${b.setBy.minX} top=${b.setBy.minY} right=${b.setBy.maxX} ` +
        `bottom=${b.setBy.maxY}: check those cells for overhanging strokes or labels`;
    lines.push(
      `calibration: WARNING residual exceeds ${2 * scale}px, strokes or labels extend past ` +
        `the geometry bounds; per-cell numbers below may be off by up to residual/scale units. ` +
        suspects,
    );
  }
  const toPx = (mx, my) => ({
    x: Math.round((mx - b.minX + border) * scale) + Math.trunc(residualW / 2),
    y: Math.round((my - b.minY + border) * scale) + Math.trunc(residualH / 2),
  });
  const u = (px) => Math.round((px / scale) * 10) / 10;
  // Scans ink inside a model-space box, inset by insetU units per side so a
  // border stroke never counts as ink. Returns null when no ink is found.
  const inkIn = (box, insetU) => {
    const tl = toPx(box.x, box.y);
    const br = toPx(box.x + box.w, box.y + box.h);
    const inset = Math.ceil(insetU * scale);
    let inkL = Infinity, inkT = Infinity, inkR = -Infinity, inkB = -Infinity;
    for (let y = Math.max(0, tl.y + inset); y < Math.min(img.height, br.y - inset); y += 1) {
      for (let x = Math.max(0, tl.x + inset); x < Math.min(img.width, br.x - inset); x += 1) {
        if (INK(img.at(x, y))) {
          inkL = Math.min(inkL, x); inkT = Math.min(inkT, y);
          inkR = Math.max(inkR, x); inkB = Math.max(inkB, y);
        }
      }
    }
    if (!Number.isFinite(inkL)) return null;
    return {
      w: u(inkR - inkL + 1), h: u(inkB - inkT + 1),
      padL: u(inkL - tl.x), padT: u(inkT - tl.y), padR: u(br.x - 1 - inkR), padB: u(br.y - 1 - inkB),
    };
  };
  const boxLine = (prefix, box, insetU) => {
    const ink = inkIn(box, insetU);
    if (!ink) {
      return `${prefix}: box ${box.w}x${box.h}u at (${box.x},${box.y}), no ink found inside (past the ${insetU}u border inset)`;
    }
    return `${prefix}: box ${box.w}x${box.h}u at (${box.x},${box.y}), ink ${ink.w}x${ink.h}u, ` +
      `padding L=${ink.padL} T=${ink.padT} R=${ink.padR} B=${ink.padB}u ` +
      `(ink beyond the ${insetU}u border inset)`;
  };
  for (const id of cellIds) {
    const c = cells.get(id);
    if (!c || c.attrs.vertex !== "1" || !c.geo) {
      lines.push(`cell ${id}: not a vertex with geometry`);
      continue;
    }
    const parentEdge = cells.get(c.attrs.parent);
    if (parentEdge?.attrs.edge === "1") {
      // An edge label's geometry is relative: resolve its anchor from the
      // parent edge's pinned polyline, then measure ink in its estimated box.
      const res = pinnedPolyline(cells, parentEdge);
      if (!res.pts) {
        lines.push(`cell ${id}: label of edge ${parentEdge.id}, which has no pinned polyline to anchor on`);
        continue;
      }
      const anchor = labelAnchor(res.pts, c.geo.x, c.offset);
      if (!anchor) {
        lines.push(`cell ${id}: label of edge ${parentEdge.id}, whose polyline has no length`);
        continue;
      }
      const est = estimateLabelBox(c.attrs.value);
      const box = {
        x: Math.round((anchor.x - est.w / 2 - 4) * 10) / 10,
        y: Math.round((anchor.y - est.h / 2 - 4) * 10) / 10,
        w: Math.round((est.w + 8) * 10) / 10,
        h: Math.round((est.h + 8) * 10) / 10,
      };
      const off = c.offset ? ` offset (${c.offset.x},${c.offset.y})` : " no offset";
      lines.push(
        boxLine(`label ${id} on edge ${parentEdge.id}`, box, 0) +
          ` [anchor (${Math.round(anchor.x)},${Math.round(anchor.y)}) pos=${c.geo.x ?? 0}${off}; ` +
          `box is the char-count estimate, and ink includes anything else inside it, the edge's own stroke included]`,
      );
      continue;
    }
    const box = bbox(cells, c);
    lines.push(boxLine(`cell ${id}`, box, 2));
    // A container or group: measure each vertex child too, so box-hug
    // questions (is the text padded inside its box) are answerable directly.
    const children = [...cells.values()].filter(
      (k) => k.attrs.parent === id && k.attrs.vertex === "1" && k.geo,
    );
    for (const child of children) {
      lines.push("  " + boxLine(`child ${child.id}`, bbox(cells, child), 2));
    }
  }
  return lines.join("\n");
}
