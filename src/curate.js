import { cellSlice } from "./cells.js";
import { parseCells } from "./lint.js";

/**
 * The curation marker: an inert mxCell (no vertex, no edge, no geometry) that
 * rides inside the model, survives editor and render round-trips, and tells
 * every reader the layout is hand-tidied. Agents on a curated diagram change
 * only the cells their task names; everything else is the curator's decision.
 */

/** The marker cell's reserved id. */
export const CURATED_ID = "curated";

/** The policy text the marker carries, shown to whoever opens the model. */
export const CURATED_VALUE =
  "CURATED: hand-tidied layout. Change only the cells the task names. " +
  "Geometry, routing, label seats and spacing you were not asked to touch " +
  "are the curator's decisions, never defects to fix.";

/** Whether the model carries the curation marker. */
export function isCurated(xml) {
  return parseCells(xml).has(CURATED_ID);
}

/** The banner cells and lint print for a curated model, or null. */
export function curatedBanner(xml) {
  return isCurated(xml) ? `CURATED diagram: ${CURATED_VALUE}` : null;
}

/**
 * Adds or removes the curation marker, splicing the file's own bytes so the
 * rest of its serialisation survives untouched. Adding is idempotent: a model
 * already carrying the marker comes back byte-identical.
 *
 * @param xml - The .drawio file's text.
 * @param on - true to mark, false to unmark.
 * @returns The edited file text (the input text when nothing changes).
 * @throws When marking a model with no root cell id="1" to anchor on.
 */
export function setCurated(xml, on) {
  const has = isCurated(xml);
  if (on === has) return xml;
  if (!on) {
    const { open, end } = cellSlice(xml, CURATED_ID);
    // Take the preceding line break and indentation with the element.
    const lineStart = xml.lastIndexOf("\n", open);
    const before = lineStart !== -1 && xml.slice(lineStart + 1, open).trim() === "" ? lineStart : open;
    return xml.slice(0, before) + xml.slice(end);
  }
  const { open, end } = cellSlice(xml, "1");
  const lineStart = xml.lastIndexOf("\n", open);
  const indent = lineStart !== -1 ? xml.slice(lineStart + 1, open) : "";
  const marker = `\n${/^\s*$/.test(indent) ? indent : ""}<mxCell id="${CURATED_ID}" value="${CURATED_VALUE}" parent="1" />`;
  return xml.slice(0, end) + marker + xml.slice(end);
}

const round = (n) => Math.round(Number(n ?? 0) * 1000) / 1000;
const geoKey = (c) =>
  c.geo ? ["x", "y", "width", "height", "relative"].map((k) => round(c.geo[k])).join(",") : "none";
const pointsKey = (c) => (c.points ?? []).map((p) => `${round(p.x)},${round(p.y)}`).join(" ") || "none";
const offsetKey = (c) => (c.offset ? `${round(c.offset.x)},${round(c.offset.y)}` : "none");

/**
 * Compares two models cell-for-cell and reports every id whose value, style,
 * parent, geometry, waypoints or label offset differ, plus ids present in only
 * one model. Ids in `allowed` may change freely; anything else that changed is
 * a violation. This is the mechanical mandate check for curated diagrams: the
 * baseline is the file before an edit, the allow-list is what the task named.
 *
 * @param baselineXml - The model before the edit.
 * @param editedXml - The model after the edit.
 * @param allowed - Cell ids permitted to change (appear, disappear, or differ).
 * @returns lines - The per-id report, and violations - the count outside the allow-list.
 */
export function guardDiff(baselineXml, editedXml, allowed) {
  const a = parseCells(baselineXml);
  const b = parseCells(editedXml);
  const allow = new Set(allowed);
  const lines = [];
  let violations = 0;
  let allowedChanges = 0;
  const report = (id, what) => {
    const ok = allow.has(id);
    if (ok) allowedChanges += 1;
    else violations += 1;
    lines.push(`${ok ? "allowed" : "VIOLATION"} ${id}: ${what}`);
  };
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const ca = a.get(id);
    const cb = b.get(id);
    if (!ca) { report(id, "added"); continue; }
    if (!cb) { report(id, "removed"); continue; }
    const deltas = [];
    if ((ca.attrs.value ?? "") !== (cb.attrs.value ?? "")) deltas.push("value");
    if ((ca.attrs.style ?? "") !== (cb.attrs.style ?? "")) deltas.push("style");
    if ((ca.attrs.parent ?? "") !== (cb.attrs.parent ?? "")) deltas.push("parent");
    if (geoKey(ca) !== geoKey(cb)) deltas.push(`geometry ${geoKey(ca)} -> ${geoKey(cb)}`);
    if (pointsKey(ca) !== pointsKey(cb)) deltas.push("waypoints");
    if (offsetKey(ca) !== offsetKey(cb)) deltas.push("label offset");
    if (deltas.length > 0) report(id, deltas.join(", "));
  }
  const unusedAllows = [...allow].filter(
    (id) => !lines.some((l) => l.startsWith(`allowed ${id}:`)),
  );
  for (const id of unusedAllows) lines.push(`note ${id}: allowed but unchanged`);
  lines.push(
    `guard-diff: ${allowedChanges} allowed change(s), ${violations} violation(s)` +
      (allow.size === 0 ? " (strict: no ids allowed to change)" : ""),
  );
  return { lines, violations };
}
