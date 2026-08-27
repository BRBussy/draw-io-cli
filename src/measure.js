import { decodePng } from "./png.js";
import {
  parseCells, pinnedPolyline, labelAnchor, estimateLabelBox, labelBoxFor, modelBounds, isSpecimenEdge,
} from "./lint.js";

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

function bbox(cells, c) {
  const o = absOrigin(cells, c.attrs.parent);
  return {
    x: o.x + Number(c.geo.x ?? 0),
    y: o.y + Number(c.geo.y ?? 0),
    w: Number(c.geo.width ?? 0),
    h: Number(c.geo.height ?? 0),
  };
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

/** Resolves every edge label's estimated box in absolute model space. */
function estimatedLabelBoxes(cells) {
  const out = [];
  for (const c of cells.values()) {
    if (c.attrs.vertex !== "1" || !c.geo) continue;
    const parentEdge = cells.get(c.attrs.parent);
    if (parentEdge?.attrs.edge !== "1") continue;
    const res = pinnedPolyline(cells, parentEdge);
    if (!res.pts) continue;
    const anchor = labelAnchor(res.pts, c.geo.x, c.offset);
    if (!anchor) continue;
    const est = estimateLabelBox(c.attrs.value);
    const raw = labelBoxFor(anchor, est, c.style);
    const box = {
      x: Math.round(raw.x * 10) / 10, y: Math.round(raw.y * 10) / 10,
      w: Math.round(raw.w * 10) / 10, h: Math.round(raw.h * 10) / 10,
    };
    out.push({ cell: c, edge: parentEdge, anchor, est, box });
  }
  return out;
}

/** Parses a style stroke colour to [r,g,b]; the webapp default is black. */
function strokeRgb(style) {
  const hex = style.strokeColor;
  if (hex === undefined || hex === "default") return [0, 0, 0];
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Measures cells of a rendered .drawio.png against its embedded model.
 * Calibration maps model units to pixels from the FULL content bounds
 * (geometry plus estimated edge-label boxes, labels being the usual reason
 * the export outgrows the geometry) plus the render config's scale and
 * border; the report opens with the calibration residual so measurements
 * carry their own error bar.
 *
 * @param pngBuffer - The rendered PNG's bytes.
 * @param xml - The model embedded in that PNG.
 * @param cellIds - Ids to measure, in report order.
 * @param fitIds - Ids that additionally report the box their measured text ink
 *   implies under the uniform padding rule. Every fit id is measured, so the
 *   caller need not repeat it in `cellIds`.
 * @param gapIds - Container ids whose children's clearances and largest empty
 *   rectangle are reported.
 * @param affine - When true, print the model-unit to pixel mapping per axis in
 *   both directions, taken from this same calibration. Refused while a live
 *   calibration WARNING stands: numbers with an unexplained shift mislead.
 * @param scale - Render scale the PNG was exported at.
 * @param border - Render border, in model units, the PNG was exported with.
 * @param quietCalibration - When true, drop the calibration line and a demoted
 *   residual note. A residual too large or too vague to attribute still warns:
 *   it is the error bar on every number below it.
 * @returns The report, one cell per line.
 * @throws When the PNG's size is so far off the prediction that it must have
 *   been rendered at a different scale: numbers would be nonsense.
 */
export function measure(pngBuffer, xml, { cellIds, fitIds = [], gapIds = [], affine = false, scale, border, quietCalibration = false }) {
  const img = decodePng(pngBuffer);
  const cells = parseCells(xml);
  const b = modelBounds(cells);
  const labels = estimatedLabelBoxes(cells);
  // Labels have no committed geometry yet extend the export bounds, so the
  // calibration includes their estimated boxes: that is what makes the offset
  // true when a label hangs past the outermost shape.
  let fullMinX = b.minX, fullMinY = b.minY, fullMaxX = b.maxX, fullMaxY = b.maxY;
  const overhangs = [];
  for (const l of labels) {
    const over = Math.max(
      b.minX - l.box.x, (l.box.x + l.box.w) - b.maxX,
      b.minY - l.box.y, (l.box.y + l.box.h) - b.maxY,
    );
    if (over > 2) overhangs.push(`${l.cell.id} (~${Math.round(over)}u past the geometry bounds)`);
    fullMinX = Math.min(fullMinX, l.box.x);
    fullMinY = Math.min(fullMinY, l.box.y);
    fullMaxX = Math.max(fullMaxX, l.box.x + l.box.w);
    fullMaxY = Math.max(fullMaxY, l.box.y + l.box.h);
  }
  const predictedW = Math.round((fullMaxX - fullMinX + 2 * border) * scale);
  const predictedH = Math.round((fullMaxY - fullMinY + 2 * border) * scale);
  const residualW = img.width - predictedW;
  const residualH = img.height - predictedH;
  // A wrong SCALE multiplies both dimensions by one factor, so two axis
  // ratios that agree and sit far from 1 mean the PNG is a different render:
  // publishing numbers against it would mislead. A one-axis or additive
  // mismatch (a misstated border, overhanging strokes) is a residual for the
  // warning path below, not a scale error.
  const ratioW = img.width / predictedW;
  const ratioH = img.height / predictedH;
  if (Math.abs(ratioW - ratioH) < 0.05 * Math.max(ratioW, ratioH) && (ratioW > 1.2 || ratioW < 0.8)) {
    const impliedScale = (scale * (ratioW + ratioH)) / 2;
    throw new Error(
      `PNG is ${img.width}x${img.height} but scale=${scale} border=${border} predicts ` +
        `${predictedW}x${predictedH}: the PNG appears rendered at scale ~${Math.round(impliedScale * 100) / 100}. ` +
        `Pass the scale it was actually rendered at (--scale), or re-render with the config.`,
    );
  }
  const lines = [];
  if (!quietCalibration) {
    const labelNote = overhangs.length > 0 ? ` (label boxes extend the geometry: ${overhangs.join(", ")})` : "";
    lines.push(
      `calibration: scale=${scale} border=${border} content=(${Math.round(fullMinX)},${Math.round(fullMinY)})..(${Math.round(fullMaxX)},${Math.round(fullMaxY)})${labelNote} ` +
        `png=${img.width}x${img.height} predicted=${predictedW}x${predictedH} residual=${residualW},${residualH}px`,
    );
  }
  let warningLive = false;
  if (Math.abs(residualW) > 2 * scale || Math.abs(residualH) > 2 * scale) {
    const suspects = `Bounds are set by left=${b.setBy.minX} top=${b.setBy.minY} right=${b.setBy.maxX} ` +
      `bottom=${b.setBy.maxY}: check those cells for overhanging strokes`;
    // The export leaves `border` units of slack per side, so a residual within
    // it pushes nothing out of frame. When the bound-setting cells on the
    // offending axes are EDGES, the webapp's habit of padding an edge's
    // bounds beyond its declared polyline explains the residual: known and
    // harmless is a note, not a warning repeated on every invocation.
    const small = Math.max(Math.abs(residualW), Math.abs(residualH)) <= border * scale;
    const isEdge = (id) => cells.get(id)?.attrs.edge === "1";
    const edgesExplain =
      (Math.abs(residualW) <= 2 * scale || isEdge(b.setBy.minX) || isEdge(b.setBy.maxX)) &&
      (Math.abs(residualH) <= 2 * scale || isEdge(b.setBy.minY) || isEdge(b.setBy.maxY));
    if (small && edgesExplain) {
      if (!quietCalibration) {
        lines.push(
          `calibration: note residual ${residualW},${residualH}px is within the render border ` +
            `(${border}u = ${border * scale}px) and attributed to bound-setting edges ` +
            `(the webapp pads an edge's bounds beyond its declared polyline). ${suspects}`,
        );
      }
    } else {
      warningLive = true;
      lines.push(
        `calibration: WARNING residual exceeds ${2 * scale}px, strokes extend past the estimated ` +
          `content bounds; per-cell numbers below may be off by up to residual/scale units. ${suspects}`,
      );
    }
  }
  const shiftX = Math.trunc(residualW / 2);
  const shiftY = Math.trunc(residualH / 2);
  const toPx = (mx, my) => ({
    x: Math.round((mx - fullMinX + border) * scale) + shiftX,
    y: Math.round((my - fullMinY + border) * scale) + shiftY,
  });
  const u = (px) => Math.round((px / scale) * 10) / 10;
  if (affine) {
    if (warningLive) {
      lines.push(
        "affine: refused while a live calibration WARNING stands, its unexplained shift would be " +
          "baked into the offset. Attribute or fix the residual first.",
      );
    } else {
      // The same numbers toPx runs on, written out so a crop of a model region
      // is one substitution rather than a transcription of the calibration line.
      const offsetX = border * scale + shiftX;
      const offsetY = border * scale + shiftY;
      lines.push(
        `affine: offset = border ${border}u * scale ${scale} + residual shift ${shiftX},${shiftY}px ` +
          `(= ${offsetX},${offsetY}px); px rounds to the nearest integer`,
        `affine x: px = ${shifted("mx", fullMinX)} * ${scale} + ${offsetX}`,
        `affine x: mx = (px - ${offsetX}) / ${scale} ${added(fullMinX)}`,
        `affine y: py = ${shifted("my", fullMinY)} * ${scale} + ${offsetY}`,
        `affine y: my = (py - ${offsetY}) / ${scale} ${added(fullMinY)}`,
      );
    }
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
      pxL: inkL, pxT: inkT, pxR: inkR, pxB: inkB,
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
  // a second render to check it. A stroked shape's border counts as ink at the
  // plain inset, so the fit peels the inset until the ink pulls clear of the
  // scan window on every side, leaving the text alone.
  const fitLine = (id, c, box) => {
    let inset = 2, ink = null;
    for (; inset <= 12; inset += 1) {
      ink = inkIn(box, inset);
      if (!ink) break;
      const clear = Math.min(ink.padL, ink.padT, ink.padR, ink.padB);
      if (clear > 0.4) break; // ink no longer touches the window: the border is peeled off
    }
    if (!ink) return `  fit ${id}: no text ink found inside the border, nothing to size the box to`;
    const impliedW = round1(ink.w + 2 * FIT_PAD_X);
    const impliedH = round1(ink.h + 2 * FIT_PAD_Y);
    const peeled = inset > 2 ? ` (border peeled at a ${inset}u inset)` : "";
    const sp = c.style;
    const spacing = ["spacing", "spacingLeft", "spacingRight", "spacingTop", "spacingBottom"]
      .filter((k) => Number(sp[k] ?? 0) !== 0).map((k) => `${k}=${sp[k]}`).join(" ");
    const spacingNote = spacing ? ` [declared ${spacing} already insets the ink: the delta partly restates it]` : "";
    return `  fit ${id}: ink ${ink.w}x${ink.h}u + padding ${FIT_PAD_X}u L/R ${FIT_PAD_Y}u T/B ` +
      `-> implied box ${impliedW}x${impliedH}u, declared ${box.w}x${box.h}u, ` +
      `delta ${signed(impliedW - box.w)}x${signed(impliedH - box.h)}u${peeled}${spacingNote}`;
  };
  // Walks an axis-aligned run in pixels and reports how much of it stays
  // visible on each side of the label's knockout. The stroke is matched by
  // colour with a tight tolerance: antialiased glyph edges match anything
  // looser and fabricate phantom breaks.
  const TOL = 40;
  const visibleRun = (run, labelBox, rgb) => {
    const strokePx = Math.max(2, Math.ceil(2 * scale));
    const matches = (x, y) => {
      for (let d = -strokePx; d <= strokePx; d += 1) {
        const [r, g, bl, a] = run.vertical
          ? (x + d >= 0 && x + d < img.width ? img.at(x + d, y) : [255, 255, 255, 0])
          : (y + d >= 0 && y + d < img.height ? img.at(x, y + d) : [255, 255, 255, 0]);
        if (a > 16 && Math.abs(r - rgb[0]) <= TOL && Math.abs(g - rgb[1]) <= TOL && Math.abs(bl - rgb[2]) <= TOL) return true;
      }
      return false;
    };
    const a = toPx(run.vertical ? run.coord : run.lo, run.vertical ? run.lo : run.coord);
    const bpx = toPx(run.vertical ? run.coord : run.hi, run.vertical ? run.hi : run.coord);
    const lo = run.vertical ? a.y : a.x, hi = run.vertical ? bpx.y : bpx.x;
    const fixed = run.vertical ? a.x : a.y;
    const labelLo = toPx(labelBox.x, labelBox.y);
    const labelHi = toPx(labelBox.x + labelBox.w, labelBox.y + labelBox.h);
    const gapLo = run.vertical ? labelLo.y : labelLo.x;
    const gapHi = run.vertical ? labelHi.y : labelHi.x;
    let beforeVisible = 0, afterVisible = 0;
    for (let p = Math.max(0, lo); p <= hi; p += 1) {
      const visible = run.vertical ? matches(fixed, p) : matches(p, fixed);
      if (!visible) continue;
      if (p < gapLo) beforeVisible += 1;
      else if (p > gapHi) afterVisible += 1;
    }
    return { before: u(beforeVisible), after: u(afterVisible) };
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
      // parent edge's pinned polyline, then measure ink in its estimated box,
      // the TEXT box tight around the estimate and a padded halo separately,
      // so the edge's own stroke reads as foreign ink rather than as zero
      // padding on the text.
      const entry = labels.find((l) => l.cell.id === id);
      if (!entry) {
        lines.push(`cell ${id}: label of edge ${parentEdge.id}, which has no pinned polyline to anchor on`);
        continue;
      }
      const text = boxLine(`label ${id} on edge ${parentEdge.id} (text box)`, entry.box, 0);
      const halo = { x: entry.box.x - 4, y: entry.box.y - 4, w: entry.box.w + 8, h: entry.box.h + 8 };
      const haloInk = inkIn(halo, 0);
      let foreign = "no foreign ink in the 4u halo";
      if (haloInk && text.ink) {
        const grew = Math.max(
          text.ink.pxL - haloInk.pxL, haloInk.pxR - text.ink.pxR,
          text.ink.pxT - haloInk.pxT, haloInk.pxB - text.ink.pxB,
        );
        if (grew > scale) foreign = `foreign ink inside the 4u halo (${u(grew)}u beyond the text ink: the edge's own stroke or a neighbour)`;
      } else if (haloInk && !text.ink) {
        foreign = "only foreign ink: nothing inside the text box itself";
      }
      const off = c.offset ? ` offset (${c.offset.x},${c.offset.y})` : " no offset";
      lines.push(
        text.text +
          ` [anchor (${Math.round(entry.anchor.x)},${Math.round(entry.anchor.y)}) pos=${c.geo.x ?? 0}${off}; ` +
          `${foreign}; box is the char-count estimate, align-aware]`,
      );
      // The knockout must leave visible run on both sides of the text: an
      // arrowhead-only stub is the orphaned-run defect the guide names.
      if (!isSpecimenEdge(cells, parentEdge)) {
        const res = pinnedPolyline(cells, parentEdge);
        if (res.pts) {
          const runs = [];
          for (let i = 0; i + 1 < res.pts.length; i += 1) {
            const p = res.pts[i], q = res.pts[i + 1];
            if (Math.abs(p.x - q.x) < 0.01 && Math.abs(p.y - q.y) > 0.01) {
              runs.push({ vertical: true, coord: p.x, lo: Math.min(p.y, q.y), hi: Math.max(p.y, q.y) });
            } else if (Math.abs(p.y - q.y) < 0.01 && Math.abs(p.x - q.x) > 0.01) {
              runs.push({ vertical: false, coord: p.y, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x) });
            }
          }
          const centre = { x: entry.box.x + entry.box.w / 2, y: entry.box.y + entry.box.h / 2 };
          const dist = (r) => Math.abs((r.vertical ? centre.x : centre.y) - r.coord);
          const near = runs.filter((r) => {
            const along = r.vertical ? centre.y : centre.x;
            return along >= r.lo - 8 && along <= r.hi + 8;
          }).sort((p, q) => dist(p) - dist(q))[0];
          const rgb = strokeRgb(parentEdge.style);
          if (near && rgb) {
            const vis = visibleRun(near, entry.box, rgb);
            const short = Math.min(vis.before, vis.after) < 20 ? " (a side under 20u reads as an orphaned stub)" : "";
            lines.push(`  visible run ${id}: ${vis.before}u before the knockout, ${vis.after}u after${short}`);
          }
        }
      }
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
    if (fits.has(id)) lines.push(fitLine(id, c, box));
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
  // Dead-space questions: each child's clearance to the container's sides, and
  // the largest empty rectangle inside the container. Candidate rectangle
  // edges come from the child boxes themselves, which is where an axis-aligned
  // maximal rectangle must end.
  for (const id of gapIds) {
    const c = cells.get(id);
    if (!c || c.attrs.vertex !== "1" || !c.geo) {
      lines.push(`gaps ${id}: not a vertex with geometry`);
      continue;
    }
    const outer = bbox(cells, c);
    const kids = [...cells.values()]
      .filter((k) => k.attrs.parent === id && k.attrs.vertex === "1" && k.geo)
      .map((k) => ({ id: k.id, b: bbox(cells, k) }));
    lines.push(`gaps ${id}: box ${outer.w}x${outer.h}u at (${outer.x},${outer.y}), ${kids.length} child(ren)`);
    for (const k of kids) {
      lines.push(
        `  child ${k.id}: clearance L=${round1(k.b.x - outer.x)} T=${round1(k.b.y - outer.y)} ` +
          `R=${round1(outer.x + outer.w - (k.b.x + k.b.w))} B=${round1(outer.y + outer.h - (k.b.y + k.b.h))}u`,
      );
    }
    const xs = [...new Set([outer.x, outer.x + outer.w, ...kids.flatMap((k) => [k.b.x, k.b.x + k.b.w])])].sort((p, q) => p - q);
    const ys = [...new Set([outer.y, outer.y + outer.h, ...kids.flatMap((k) => [k.b.y, k.b.y + k.b.h])])].sort((p, q) => p - q);
    let best = null;
    for (let i = 0; i < xs.length; i += 1) for (let j = i + 1; j < xs.length; j += 1) {
      for (let k = 0; k < ys.length; k += 1) for (let l = k + 1; l < ys.length; l += 1) {
        const r = { x: xs[i], y: ys[k], w: xs[j] - xs[i], h: ys[l] - ys[k] };
        if (r.x < outer.x || r.y < outer.y || r.x + r.w > outer.x + outer.w || r.y + r.h > outer.y + outer.h) continue;
        const blocked = kids.some(
          (kid) => kid.b.x < r.x + r.w && r.x < kid.b.x + kid.b.w && kid.b.y < r.y + r.h && r.y < kid.b.y + kid.b.h,
        );
        if (!blocked && (best === null || r.w * r.h > best.w * best.h)) best = r;
      }
    }
    if (best) {
      lines.push(
        `  largest empty rectangle: ${round1(best.w)}x${round1(best.h)}u at (${round1(best.x)},${round1(best.y)})`,
      );
    }
  }
  return lines.join("\n");
}
