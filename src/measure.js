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

// units: the uniform text padding a box is sized to, left/right and top/bottom.
const FIT_PAD_X = 8;
const FIT_PAD_Y = 6;

/** Renders `mx - origin` readably, so a negative origin reads as an addition. */
function shifted(variable, origin) {
  return origin < 0 ? `(${variable} + ${-origin})` : `(${variable} - ${origin})`;
}

/** Renders `+ origin` readably, so a negative origin reads as a subtraction. */
function added(origin) {
  return origin < 0 ? `- ${-origin}` : `+ ${origin}`;
}

/**
 * Measures cells of a rendered .drawio.png against its embedded model.
 * Calibration maps model units to pixels from the model bounds plus the
 * render config's scale and border; the report opens with the calibration
 * residual so measurements carry their own error bar.
 *
 * @param pngBuffer - The rendered PNG's bytes.
 * @param xml - The model embedded in that PNG.
 * @param cellIds - Ids to measure, in report order.
 * @param fitIds - Ids that additionally report the box their measured text ink
 *   implies under the uniform padding rule. Every fit id is measured, so the
 *   caller need not repeat it in `cellIds`.
 * @param affine - When true, print the model-unit to pixel mapping per axis in
 *   both directions, taken from this same calibration.
 * @param scale - Render scale the PNG was exported at.
 * @param border - Render border, in model units, the PNG was exported with.
 * @param quietCalibration - When true, drop the calibration line and a demoted
 *   residual note. A residual too large or too vague to attribute still warns:
 *   it is the error bar on every number below it.
 * @returns The report, one cell per line.
 */
export function measure(pngBuffer, xml, { cellIds, fitIds = [], affine = false, scale, border, quietCalibration = false }) {
  const img = decodePng(pngBuffer);
  const cells = parseCells(xml);
  const b = modelBounds(cells);
  const predictedW = Math.round((b.maxX - b.minX + 2 * border) * scale);
  const predictedH = Math.round((b.maxY - b.minY + 2 * border) * scale);
  const residualW = img.width - predictedW;
  const residualH = img.height - predictedH;
  const lines = [];
  if (!quietCalibration) {
    lines.push(
      `calibration: scale=${scale} border=${border} model=(${b.minX},${b.minY})..(${b.maxX},${b.maxY}) ` +
        `png=${img.width}x${img.height} predicted=${predictedW}x${predictedH} residual=${residualW},${residualH}px`,
    );
  }
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
    // The export already leaves `border` units of slack on every side, so a
    // residual no wider than that border in pixels cannot be pushing anything
    // out of frame. Named suspects (the label overhangs above, never the
    // fallback list of bound-setting cells, which is a guess) turn it from a
    // mismatch into a known one, and known and harmless is a note, not a
    // warning repeated on every invocation.
    const explained = overhangs.length > 0;
    const small = Math.max(Math.abs(residualW), Math.abs(residualH)) <= border * scale;
    if (explained && small) {
      if (!quietCalibration) {
        lines.push(
          `calibration: note residual ${residualW},${residualH}px is within the render border ` +
            `(${border}u = ${border * scale}px) and attributed. ${suspects}`,
        );
      }
    } else {
      lines.push(
        `calibration: WARNING residual exceeds ${2 * scale}px, strokes or labels extend past ` +
          `the geometry bounds; per-cell numbers below may be off by up to residual/scale units. ` +
          suspects,
      );
    }
  }
  const shiftX = Math.trunc(residualW / 2);
  const shiftY = Math.trunc(residualH / 2);
  const toPx = (mx, my) => ({
    x: Math.round((mx - b.minX + border) * scale) + shiftX,
    y: Math.round((my - b.minY + border) * scale) + shiftY,
  });
  const u = (px) => Math.round((px / scale) * 10) / 10;
  if (affine) {
    // The same numbers toPx runs on, written out so a crop of a model region
    // is one substitution rather than a transcription of the calibration line.
    const offsetX = border * scale + shiftX;
    const offsetY = border * scale + shiftY;
    lines.push(
      `affine: offset = border ${border}u * scale ${scale} + residual shift ${shiftX},${shiftY}px ` +
        `(= ${offsetX},${offsetY}px); px rounds to the nearest integer`,
      `affine x: px = ${shifted("mx", b.minX)} * ${scale} + ${offsetX}`,
      `affine x: mx = (px - ${offsetX}) / ${scale} ${added(b.minX)}`,
      `affine y: py = ${shifted("my", b.minY)} * ${scale} + ${offsetY}`,
      `affine y: my = (py - ${offsetY}) / ${scale} ${added(b.minY)}`,
    );
  }
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
  // Returns the report line for a box plus the ink it found, so a caller that
  // sizes the box from that ink measures the pixels once.
  const boxLine = (prefix, box, insetU) => {
    const ink = inkIn(box, insetU);
    if (!ink) {
      return {
        ink,
        text: `${prefix}: box ${box.w}x${box.h}u at (${box.x},${box.y}), no ink found inside (past the ${insetU}u border inset)`,
      };
    }
    return {
      ink,
      text: `${prefix}: box ${box.w}x${box.h}u at (${box.x},${box.y}), ink ${ink.w}x${ink.h}u, ` +
        `padding L=${ink.padL} T=${ink.padT} R=${ink.padR} B=${ink.padB}u ` +
        `(ink beyond the ${insetU}u border inset)`,
    };
  };
  const round1 = (n) => Math.round(n * 10) / 10;
  const signed = (n) => (n > 0 ? `+${round1(n)}` : `${round1(n)}`);
  // The box the uniform padding rule implies for the ink just measured, and how
  // far the declared box is from it: the answer a resize is looking for, without
  // a second render to check it.
  const fitLine = (id, box, ink) => {
    if (!ink) return `  fit ${id}: no ink found, nothing to size the box to`;
    const impliedW = round1(ink.w + 2 * FIT_PAD_X);
    const impliedH = round1(ink.h + 2 * FIT_PAD_Y);
    return `  fit ${id}: ink ${ink.w}x${ink.h}u + padding ${FIT_PAD_X}u L/R ${FIT_PAD_Y}u T/B ` +
      `-> implied box ${impliedW}x${impliedH}u, declared ${box.w}x${box.h}u, ` +
      `delta ${signed(impliedW - box.w)}x${signed(impliedH - box.h)}u`;
  };
  const fits = new Set(fitIds);
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
        boxLine(`label ${id} on edge ${parentEdge.id}`, box, 0).text +
          ` [anchor (${Math.round(anchor.x)},${Math.round(anchor.y)}) pos=${c.geo.x ?? 0}${off}; ` +
          `box is the char-count estimate, and ink includes anything else inside it, the edge's own stroke included]`,
      );
      if (fits.has(id)) {
        lines.push(
          `  fit ${id}: an edge label declares no box (it rides its edge and sizes itself), ` +
            `so there is nothing to fit`,
        );
      }
      continue;
    }
    const box = bbox(cells, c);
    const measured = boxLine(`cell ${id}`, box, 2);
    lines.push(measured.text);
    if (fits.has(id)) lines.push(fitLine(id, box, measured.ink));
    // A container or group: measure each vertex child too, so box-hug
    // questions (is the text padded inside its box) are answerable directly.
    const children = [...cells.values()].filter(
      (k) => k.attrs.parent === id && k.attrs.vertex === "1" && k.geo,
    );
    for (const child of children) {
      // A fit on a child needs no handling here: every --fit id is measured in
      // its own right by the loop above, where the fit line follows it.
      lines.push("  " + boxLine(`child ${child.id}`, bbox(cells, child), 2).text);
    }
  }
  return lines.join("\n");
}
