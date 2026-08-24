import { decodePng } from "./png.js";
import { parseCells } from "./lint.js";

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

/** Model-space bounds over every vertex box and edge waypoint. */
function modelBounds(cells) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cells.values()) {
    if (c.attrs.vertex === "1" && c.geo && !(cells.get(c.attrs.parent)?.attrs.edge === "1")) {
      const b = bbox(cells, c);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    if (c.attrs.edge === "1") {
      const eo = absOrigin(cells, c.attrs.parent);
      for (const p of c.points) {
        minX = Math.min(minX, p.x + eo.x); minY = Math.min(minY, p.y + eo.y);
        maxX = Math.max(maxX, p.x + eo.x); maxY = Math.max(maxY, p.y + eo.y);
      }
    }
  }
  if (!Number.isFinite(minX)) throw new Error("no geometry found to calibrate against");
  return { minX, minY, maxX, maxY };
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
    lines.push(
      `calibration: WARNING residual exceeds ${2 * scale}px, strokes or labels extend past ` +
        `the geometry bounds; per-cell numbers below may be off by up to residual/scale units`,
    );
  }
  const toPx = (mx, my) => ({
    x: Math.round((mx - b.minX + border) * scale) + Math.trunc(residualW / 2),
    y: Math.round((my - b.minY + border) * scale) + Math.trunc(residualH / 2),
  });
  for (const id of cellIds) {
    const c = cells.get(id);
    if (!c || c.attrs.vertex !== "1" || !c.geo) {
      lines.push(`cell ${id}: not a vertex with geometry`);
      continue;
    }
    const box = bbox(cells, c);
    const tl = toPx(box.x, box.y);
    const br = toPx(box.x + box.w, box.y + box.h);
    // Inset past the border stroke so the box's own outline never counts as ink.
    const inset = Math.ceil(2 * scale);
    let inkL = Infinity, inkT = Infinity, inkR = -Infinity, inkB = -Infinity;
    for (let y = Math.max(0, tl.y + inset); y < Math.min(img.height, br.y - inset); y += 1) {
      for (let x = Math.max(0, tl.x + inset); x < Math.min(img.width, br.x - inset); x += 1) {
        if (INK(img.at(x, y))) {
          inkL = Math.min(inkL, x); inkT = Math.min(inkT, y);
          inkR = Math.max(inkR, x); inkB = Math.max(inkB, y);
        }
      }
    }
    if (!Number.isFinite(inkL)) {
      lines.push(`cell ${id}: box ${box.w}x${box.h}u at (${box.x},${box.y}), no ink found inside (past the ${Math.round(inset / scale)}u border inset)`);
      continue;
    }
    const u = (px) => Math.round((px / scale) * 10) / 10;
    lines.push(
      `cell ${id}: box ${box.w}x${box.h}u at (${box.x},${box.y}), ink ${u(inkR - inkL + 1)}x${u(inkB - inkT + 1)}u, ` +
        `padding L=${u(inkL - tl.x)} T=${u(inkT - tl.y)} R=${u(br.x - 1 - inkR)} B=${u(br.y - 1 - inkB)}u ` +
        `(ink beyond the ${Math.round(inset / scale)}u border inset)`,
    );
  }
  return lines.join("\n");
}
