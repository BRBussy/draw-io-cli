import { parseCells } from "./lint.js";

function absOrigin(cells, id) {
  let x = 0, y = 0, cur = cells.get(id);
  while (cur) {
    if (cur.geo && cur.attrs.vertex === "1") { x += Number(cur.geo.x ?? 0); y += Number(cur.geo.y ?? 0); }
    cur = cells.get(cur.attrs.parent);
  }
  return { x, y };
}

function label(value) {
  return (value ?? "")
    .replace(/&lt;[^&]*?&gt;|<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Renders the diagram model as a readable table: one line per cell with its
 * kind, absolute geometry, label, and for edges the endpoints, pinned
 * anchors and waypoints. Embedded images are elided to their byte size.
 */
export function cellsReport(xml) {
  const cells = parseCells(xml);
  const lines = [];
  for (const c of cells.values()) {
    if (c.id === "0" || c.id === "1" || !c.attrs.id) continue;
    const st = c.attrs.style ?? "";
    if (c.attrs.edge === "1") {
      const anchors = ["exitX", "exitY", "exitDx", "exitDy", "entryX", "entryY", "entryDx", "entryDy"]
        .filter((k) => c.style[k] !== undefined).map((k) => `${k}=${c.style[k]}`).join(",");
      const wp = c.points.map((p) => `(${p.x},${p.y})`).join(" ");
      const colour = c.style.strokeColor ?? "default";
      lines.push(`EDGE  ${c.id}  ${c.attrs.source ?? "?"} -> ${c.attrs.target ?? "?"}  colour=${colour}  ${anchors}${wp ? "  wp: " + wp : ""}`);
    } else if (c.attrs.vertex === "1" && c.geo) {
      const o = absOrigin(cells, c.attrs.parent);
      const x = o.x + Number(c.geo.x ?? 0), y = o.y + Number(c.geo.y ?? 0);
      const kind = st.includes("swimlane") ? "LANE " : st.includes("image=data:") ? "ICON " : st.includes("image") ? "ICON " : st.includes("edgeLabel") ? "ELBL " : "SHAPE";
      const styleShort = st.replace(/image=data:[^;]+/, (m) => `image=[${Math.round(m.length / 1024)}KB]`).slice(0, 90);
      lines.push(`${kind} ${c.id}  @(${x},${y}) ${c.geo.width ?? "?"}x${c.geo.height ?? "?"}  parent=${c.attrs.parent}  "${label(c.attrs.value)}"  ${styleShort}`);
    }
  }
  return lines.join("\n");
}

/**
 * Digests a palette file into a named style catalogue: each labelled cell's
 * copyable style string, with embedded image data elided.
 */
export function stylesReport(xml) {
  const cells = parseCells(xml);
  const lines = [];
  for (const c of cells.values()) {
    if (!c.attrs.style || (!c.attrs.value && c.attrs.edge !== "1")) continue;
    const name = label(c.attrs.value) || c.id;
    const st = c.attrs.style.replace(/image=data:[^;]+/, "image=<embedded, copy the cell from the palette>");
    lines.push(`${c.attrs.edge === "1" ? "edge " : "shape"}  ${name}\n    ${st}`);
  }
  return lines.join("\n");
}
