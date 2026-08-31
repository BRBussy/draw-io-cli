import { cellSlice } from "./cells.js";
import { parseCells } from "./lint.js";

/**
 * In-place editing verbs. Every edit is string surgery on the file's OWN
 * bytes: the cell's element is located byte-exactly, the smallest possible
 * span inside it is replaced, and everything else in the file stays
 * byte-for-byte, so a committed file's serialisation (attribute order,
 * self-closing spellings, indentation) survives an edit. Values written are
 * canonical draw.io spellings; only the touched span changes.
 */

/** The cell's own mxGeometry element within its slice, or null. */
function geometrySpan(slice) {
  const open = slice.indexOf("<mxGeometry");
  if (open === -1) return null;
  const headEnd = slice.indexOf(">", open);
  if (headEnd === -1) throw new Error("unterminated mxGeometry start tag");
  const selfClosing = slice[headEnd - 1] === "/";
  const end = selfClosing ? headEnd + 1 : slice.indexOf("</mxGeometry>", headEnd) + "</mxGeometry>".length;
  if (end < headEnd) throw new Error("unclosed mxGeometry element");
  return { open, headEnd, selfClosing, end };
}

/** Sets or inserts one attribute inside a start tag's text. */
function withAttr(tag, name, value) {
  const re = new RegExp(`(\\s${name}=")[^"]*(")`);
  if (re.test(tag)) return tag.replace(re, `$1${value}$2`);
  // Insert before as="geometry" when present (the conventional last slot),
  // otherwise before the tag's closer.
  const asAt = tag.search(/\sas="/);
  if (asAt !== -1) return `${tag.slice(0, asAt)} ${name}="${value}"${tag.slice(asAt)}`;
  const close = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
  return `${tag.slice(0, close).replace(/\s+$/, "")} ${name}="${value}"${tag.slice(close)}`;
}

/** Splices `replacement` over [open, end) of `xml`. */
function splice(xml, open, end, replacement) {
  return xml.slice(0, open) + replacement + xml.slice(end);
}

/**
 * Sets any of x, y, width, height on a cell's geometry, leaving the rest of
 * the file untouched.
 *
 * @param xml - The .drawio file's text.
 * @param id - The cell to edit.
 * @param geo - The values to set; absent keys stay as they are.
 * @returns The edited file text.
 * @throws When the cell or its geometry is missing.
 */
export function setGeometry(xml, id, geo) {
  const { open, end } = cellSlice(xml, id);
  const slice = xml.slice(open, end);
  const g = geometrySpan(slice);
  if (!g) throw new Error(`cell ${id} has no mxGeometry element to edit`);
  let head = slice.slice(g.open, g.headEnd + 1);
  for (const key of ["x", "y", "width", "height"]) {
    if (geo[key] !== undefined) head = withAttr(head, key, geo[key]);
  }
  return splice(xml, open, end, splice(slice, g.open, g.headEnd + 1, head));
}

/** Opens a self-closing geometry into `<mxGeometry ...></mxGeometry>` form. */
function openedGeometry(slice, g) {
  if (!g.selfClosing) return { slice, g };
  const head = slice.slice(g.open, g.headEnd + 1).replace(/\s*\/>$/, ">");
  const replaced = splice(slice, g.open, g.headEnd + 1, `${head}</mxGeometry>`);
  return { slice: replaced, g: geometrySpan(replaced) };
}

/**
 * Refuses an edit that would leave two of an element inside one geometry. The
 * replace patterns below are spelling-exact, so an element written any other
 * way survives them and the canonical one joins it instead of replacing it.
 * The duplicate can read back as the intended value, so only a count of the
 * edited body catches it.
 */
function refuseDuplicate(body, re, id, canonical) {
  if ((body.match(re)?.length ?? 0) > 1) {
    throw new Error(
      `cell ${id} already holds a ${canonical} spelled differently, so this edit would leave two of them: ` +
        "correct that element's spelling in the source (or delete it), then run the command again",
    );
  }
}

/**
 * Replaces a cell's waypoints with the given points, or removes them all when
 * the list is empty. The points land as a canonical `<Array as="points">`
 * inside the geometry, existing serialisation elsewhere untouched.
 *
 * @param xml - The .drawio file's text.
 * @param id - The edge to edit.
 * @param points - Array of {x, y}.
 * @returns The edited file text.
 */
export function setWaypoints(xml, id, points) {
  const { open, end } = cellSlice(xml, id);
  let slice = xml.slice(open, end);
  let g = geometrySpan(slice);
  if (!g) throw new Error(`cell ${id} has no mxGeometry element to edit`);
  const arrayRe = /\s*<Array as="points">[\s\S]*?<\/Array>/;
  const body = () => slice.slice(g.headEnd + 1, g.end - "</mxGeometry>".length);
  if (points.length === 0) {
    if (g.selfClosing || !arrayRe.test(body())) return xml; // nothing to remove
    const cleaned = body().replace(arrayRe, "");
    slice = splice(slice, g.headEnd + 1, g.end - "</mxGeometry>".length, cleaned);
    return splice(xml, open, end, slice);
  }
  ({ slice, g } = openedGeometry(slice, g));
  const array = `<Array as="points">${points.map((p) => `<mxPoint x="${p.x}" y="${p.y}" />`).join("")}</Array>`;
  const inner = body();
  const replaced = arrayRe.test(inner) ? inner.replace(arrayRe, array) : array + inner;
  refuseDuplicate(replaced, /<Array\b[^>]*\bas="points"/g, id, '<Array as="points">');
  slice = splice(slice, g.headEnd + 1, g.end - "</mxGeometry>".length, replaced);
  return splice(xml, open, end, slice);
}

/**
 * Sets (or inserts) an edge label's offset point, the `<mxPoint as="offset">`
 * inside its relative geometry.
 *
 * @param xml - The .drawio file's text.
 * @param id - The label cell to edit.
 * @param dx - Offset x in model units.
 * @param dy - Offset y in model units.
 * @returns The edited file text.
 */
export function setLabelOffset(xml, id, dx, dy) {
  const { open, end } = cellSlice(xml, id);
  let slice = xml.slice(open, end);
  let g = geometrySpan(slice);
  if (!g) throw new Error(`cell ${id} has no mxGeometry element to edit`);
  ({ slice, g } = openedGeometry(slice, g));
  const offsetRe = /<mxPoint\b[^>]*as="offset"[^>]*\/>/;
  const point = `<mxPoint x="${dx}" y="${dy}" as="offset" />`;
  const inner = slice.slice(g.headEnd + 1, g.end - "</mxGeometry>".length);
  const replaced = offsetRe.test(inner) ? inner.replace(offsetRe, point) : inner + point;
  refuseDuplicate(replaced, /<mxPoint\b[^>]*\bas="offset"/g, id, '<mxPoint as="offset" />');
  slice = splice(slice, g.headEnd + 1, g.end - "</mxGeometry>".length, replaced);
  return splice(xml, open, end, slice);
}

/**
 * Asserts the edited text parses and the cell now carries the expected
 * values, so a surgery slip fails the command instead of landing on disk.
 */
export function verifyEdit(xml, id, expect) {
  const c = parseCells(xml).get(id);
  if (!c) throw new Error(`verification failed: cell ${id} no longer parses`);
  for (const [key, want] of Object.entries(expect.geo ?? {})) {
    const got = Number(c.geo?.[key === "width" ? "width" : key === "height" ? "height" : key]);
    if (got !== Number(want)) throw new Error(`verification failed: ${id} ${key}=${got}, expected ${want}`);
  }
  if (expect.points) {
    const got = c.points.map((p) => `${p.x},${p.y}`).join(" ");
    const want = expect.points.map((p) => `${p.x},${p.y}`).join(" ");
    if (got !== want) throw new Error(`verification failed: ${id} waypoints "${got}", expected "${want}"`);
  }
  if (expect.offset) {
    const got = c.offset ? `${c.offset.x},${c.offset.y}` : "none";
    const want = `${expect.offset.x},${expect.offset.y}`;
    if (got !== want) throw new Error(`verification failed: ${id} offset ${got}, expected ${want}`);
  }
}
