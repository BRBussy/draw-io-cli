import { parseCells } from "./lint.js";
import { elideImagePayloads } from "./extract.js";

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

function label(value) {
  return (value ?? "")
    .replace(/&lt;[^&]*?&gt;|<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Renders the diagram model as a readable table: one line per cell with its
 * kind, absolute geometry, label, and for edges the endpoints, pinned
 * anchors and waypoints. An edge label's line carries its relative position
 * and offset point instead of a meaningless absolute origin. Embedded images
 * are elided to their byte size, and styles are truncated unless `full` is
 * set.
 *
 * @param xml - Uncompressed mxfile XML.
 * @param full - When true, print untruncated style strings (image payloads
 *   stay elided).
 */
export function cellsReport(xml, { full = false } = {}) {
  const cells = parseCells(xml);
  const lines = [];
  const styleOf = (st) => {
    const elided = st.replace(/image=data:[^;]+/, (m) => `image=[${Math.round(m.length / 1024)}KB]`);
    return full ? elided : elided.slice(0, 90);
  };
  for (const c of cells.values()) {
    if (c.id === "0" || c.id === "1" || !c.attrs.id) continue;
    const st = c.attrs.style ?? "";
    if (c.attrs.edge === "1") {
      const anchors = ["exitX", "exitY", "exitDx", "exitDy", "entryX", "entryY", "entryDx", "entryDy"]
        .filter((k) => c.style[k] !== undefined).map((k) => `${k}=${c.style[k]}`).join(",");
      const wp = c.points.map((p) => `(${p.x},${p.y})`).join(" ");
      const colour = c.style.strokeColor ?? "default";
      lines.push(`EDGE  ${c.id}  ${c.attrs.source ?? "?"} -> ${c.attrs.target ?? "?"}  colour=${colour}  ${anchors}${wp ? "  wp: " + wp : ""}${full && st ? "  " + styleOf(st) : ""}`);
    } else if (c.attrs.vertex === "1" && c.geo) {
      const parentEdge = cells.get(c.attrs.parent);
      if (parentEdge?.attrs.edge === "1") {
        const off = c.offset ? `(${c.offset.x},${c.offset.y})` : "none";
        lines.push(`ELBL  ${c.id}  on=${parentEdge.id} pos=${c.geo.x ?? 0} offset=${off}  "${label(c.attrs.value)}"  ${styleOf(st)}`);
        continue;
      }
      const o = absOrigin(cells, c.attrs.parent);
      const x = o.x + Number(c.geo.x ?? 0), y = o.y + Number(c.geo.y ?? 0);
      const kind = st.includes("swimlane") ? "LANE " : st.includes("image=data:") ? "ICON " : st.includes("image") ? "ICON " : st.includes("edgeLabel") ? "ELBL " : "SHAPE";
      lines.push(`${kind} ${c.id}  @(${x},${y}) ${c.geo.width ?? "?"}x${c.geo.height ?? "?"}  parent=${c.attrs.parent}  "${label(c.attrs.value)}"  ${styleOf(st)}`);
    }
  }
  return lines.join("\n");
}

// The elements that can carry a cell id. A cell wrapped for custom attributes
// holds its id on the wrapper, with the mxCell inside carrying none.
const ID_BEARING = ["mxCell", "object", "UserObject"];

/**
 * Walks a start tag from its `<`, returning where it ends and whether it
 * closes itself. Quoted attribute values are skipped whole, so a `>` inside
 * one never ends the tag early.
 */
function startTagEnd(xml, open) {
  let quote = null;
  for (let i = open + 1; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") return { end: i, selfClosing: xml[i - 1] === "/" };
  }
  throw new Error(`unterminated start tag at byte ${open}`);
}

/** The byte after an element that starts at `open`, nesting of its own tag counted. */
function elementEnd(xml, open, name) {
  const head = startTagEnd(xml, open);
  if (head.selfClosing) return head.end + 1;
  const close = `</${name}>`;
  let depth = 1, at = head.end + 1;
  while (depth > 0) {
    const nextClose = xml.indexOf(close, at);
    if (nextClose === -1) throw new Error(`unclosed <${name}> element at byte ${open}`);
    const nextOpen = xml.indexOf(`<${name}`, at);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      at = startTagEnd(xml, nextOpen).end + 1;
      continue;
    }
    depth -= 1;
    at = nextClose + close.length;
  }
  return at;
}

/**
 * Slices one cell's element out of the file's own text: the `<mxCell ...>`
 * start tag through its close, child `<mxGeometry>`/`<Array>` included, byte
 * for byte with no re-serialisation. This is the form to copy from when
 * patching the file by string surgery, which the {@link cellsReport} and
 * `extract` renderings are not: both print the webapp's spelling of the model
 * rather than the file's. An id held by an `<object>`/`<UserObject>` wrapper
 * slices the wrapper, so the returned text is always a whole element.
 *
 * @param xml - The file's text exactly as stored (for a rendered pair, the
 *   embedded model's own bytes).
 * @param id - The id of the cell to slice.
 * @param elideImages - When true, embedded image payloads are replaced with
 *   the size markers `extract --elide-images` uses. This is the one deliberate
 *   departure from verbatim, and it exists so a cell carrying a 32KB base64
 *   style stays readable.
 * @returns The element's source text.
 * @throws When no element carries the id, or when more than one does.
 */
export function cellXml(xml, id, { elideImages = false } = {}) {
  const { open, end } = cellSlice(xml, id);
  const slice = xml.slice(open, end);
  return elideImages ? elideImagePayloads(slice) : slice;
}

/**
 * Locates the single id-bearing element carrying `id` in the file's own text,
 * returning its byte range {open, end, name}. The locating half of
 * {@link cellXml}, exported so in-place surgery can splice the same bytes.
 *
 * @throws When no element carries the id, or when more than one does.
 */
export function cellSlice(xml, id) {
  const lineOf = (index) => xml.slice(0, index).split("\n").length;
  const hits = [];
  for (const name of ID_BEARING) {
    for (const m of xml.matchAll(new RegExp(`<${name}(?=[\\s/>])`, "g"))) {
      const open = m.index;
      const head = xml.slice(open, startTagEnd(xml, open).end + 1);
      const idAttr = head.match(/\sid="([^"]*)"/);
      if (idAttr?.[1] === id) hits.push({ open, name });
    }
  }
  if (hits.length === 0) {
    throw new Error(`no element carries id="${id}": run "drawio-cli cells <input>" to list the ids`);
  }
  if (hits.length > 1) {
    const where = hits.map((h) => `<${h.name}> at line ${lineOf(h.open)}`).join(", ");
    throw new Error(
      `${hits.length} elements carry id="${id}" (${where}): there is no single slice to print, ` +
        `and duplicate ids break the webapp's model. Fix the source first.`,
    );
  }
  const hit = hits[0];
  return { open: hit.open, end: elementEnd(xml, hit.open, hit.name), name: hit.name };
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
