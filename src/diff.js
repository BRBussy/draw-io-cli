import { parseCells } from "./lint.js";

const ANCHOR_KEYS = new Set(["exitX", "exitY", "exitDx", "exitDy", "entryX", "entryY", "entryDx", "entryDy"]);

/**
 * Cell-level comparison of two models: ids present on one side only, and for
 * shared ids the value and style differences, geometry excluded on purpose
 * (a flow diagram may re-seat inherited cells freely). A style difference
 * confined to connection-anchor tokens is named as a re-anchoring, since that
 * is the silent way an inherited edge's route breaks byte-identity.
 *
 * @param xmlA - First model's XML (for a flow diagram, the flow).
 * @param xmlB - Second model's XML (the actor map it inherits from).
 * @returns Report lines; empty when the shared cells match exactly.
 */
export function diffCells(xmlA, xmlB) {
  const a = parseCells(xmlA);
  const b = parseCells(xmlB);
  const lines = [];
  const onlyA = [...a.keys()].filter((id) => !b.has(id) && id !== "0" && id !== "1");
  const onlyB = [...b.keys()].filter((id) => !a.has(id) && id !== "0" && id !== "1");
  if (onlyA.length > 0) lines.push(`only in A (${onlyA.length}): ${onlyA.join(", ")}`);
  if (onlyB.length > 0) lines.push(`only in B (${onlyB.length}): ${onlyB.join(", ")}`);
  for (const [id, ca] of a) {
    const cb = b.get(id);
    if (!cb || id === "0" || id === "1") continue;
    if ((ca.attrs.value ?? "") !== (cb.attrs.value ?? "")) {
      lines.push(`cell ${id}: value differs ("${(ca.attrs.value ?? "").slice(0, 40)}" vs "${(cb.attrs.value ?? "").slice(0, 40)}")`);
    }
    if ((ca.attrs.style ?? "") !== (cb.attrs.style ?? "")) {
      const keys = new Set([...Object.keys(ca.style), ...Object.keys(cb.style)]);
      const changed = [...keys].filter((k) => (ca.style[k] ?? null) !== (cb.style[k] ?? null));
      if (changed.length > 0 && changed.every((k) => ANCHOR_KEYS.has(k))) {
        const detail = changed.map((k) => `${k}=${ca.style[k] ?? "unset"} vs ${cb.style[k] ?? "unset"}`).join(", ");
        lines.push(`cell ${id}: edge re-anchored (${detail}), the rest of the style is identical`);
      } else {
        lines.push(`cell ${id}: style differs (${changed.slice(0, 6).join(", ") || "token order or spelling"})`);
      }
    }
  }
  return lines;
}
