import assert from "node:assert/strict";
import { lint } from "../src/lint.js";

// Every check is proven by a planted violation seen firing, with a clean
// control beside it where absence is the assertion. Pure lint, no rendering.

function wrap(cells) {
  return `<mxfile><diagram name="t" id="t1"><mxGraphModel><root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    ${cells}
  </root></mxGraphModel></diagram></mxfile>`;
}

const box = (id, x, y, w = 120, h = 40, value = "", style = "rounded=0;whiteSpace=wrap;html=1;") =>
  `<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" /></mxCell>`;

const edge = (id, source, target, style, waypoints = "", label = "") =>
  `<mxCell id="${id}" style="${style}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry">${waypoints}</mxGeometry></mxCell>${label}`;

const PIN_LR = "html=1;strokeWidth=2;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;";

const ridingLabel = (id, on, value, style = "edgeLabel;html=1;align=left;verticalAlign=middle;", pos = 0, offset = "") =>
  `<mxCell id="${id}" value="${value}" style="${style}" vertex="1" connectable="0" parent="${on}"><mxGeometry x="${pos}" relative="1" as="geometry">${offset}</mxGeometry></mxCell>`;

const has = (list, needle) => list.some((m) => m.includes(needle));
const lacks = (list, needle) => !has(list, needle);

// A long horizontal edge between two boxes, the base most fixtures ride on.
const BASE = box("a", 0, 300) + box("b", 900, 300);

{ // Format check fires on an unprefixed label, and the good control passes.
  const bad = lint(wrap(BASE + edge("e", "a", "b", PIN_LR, "", ridingLabel("el", "e", "just some words"))));
  assert.ok(has(bad.errors, "not fully bold"), "format violation must fire");
  const good = lint(wrap(BASE + edge("e", "a", "b", PIN_LR, "",
    ridingLabel("el", "e", "&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Reads the request"))));
  assert.ok(lacks(good.errors, "not fully bold"), "clean format must pass");
}

{ // Alignment check fires on align=center across a horizontal run.
  const bad = lint(wrap(BASE + edge("e", "a", "b", PIN_LR, "",
    ridingLabel("el", "e", "&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Reads it", "edgeLabel;html=1;align=center;verticalAlign=middle;"))));
  assert.ok(has(bad.errors, "the crossing axis wants align=left"), "alignment violation must fire");
}

{ // Seating: a label slid far off its run fires, one riding it passes.
  const off = '<mxPoint x="0" y="-200" as="offset" />';
  const bad = lint(wrap(BASE + edge("e", "a", "b", PIN_LR, "",
    ridingLabel("el", "e", "&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Reads it", "edgeLabel;html=1;align=left;verticalAlign=middle;", 0, off))));
  assert.ok(has(bad.errors, "too far to ride"), "off-run label must fire");
  const good = lint(wrap(BASE + edge("e", "a", "b", PIN_LR, "",
    ridingLabel("el", "e", "&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Reads it"))));
  assert.ok(lacks(good.errors, "too far to ride"), "riding label must pass");
}

{ // Seating: a vertical run on the label's RIGHT fires.
  const tall = box("c", 300, 0, 4, 4) + box("d", 300, 600, 4, 4);
  const vpin = "html=1;strokeWidth=2;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;";
  const off = '<mxPoint x="-160" y="0" as="offset" />';
  // Both endpoints degenerate would exempt it as a specimen, so give one girth.
  const result = lint(wrap(box("c", 300, 0, 40, 40) + box("d", 300, 600, 40, 40) +
    edge("e", "c", "d", vpin, "",
      ridingLabel("el", "e", "&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Reads it", "edgeLabel;html=1;align=center;verticalAlign=middle;", 0, off))));
  assert.ok(has(result.errors, "RIGHT"), "vertical run on the label's right must fire");
}

{ // Remote image is an error; an embedded payload is not.
  const bad = lint(wrap(box("i", 0, 0, 40, 40, "", "shape=image;image=https://example.com/x.png;")));
  assert.ok(has(bad.errors, "remote image"), "remote image must fire");
  const good = lint(wrap(box("i", 0, 0, 40, 40, "", "shape=image;image=data:image/png,AAAA;")));
  assert.ok(lacks(good.errors, "remote image"), "embedded image must pass");
}

{ // Editor junk: a <font color> wrapper fires the warning.
  const bad = lint(wrap(box("t", 0, 0, 120, 40, "hi&lt;font color=&quot;#000000&quot;&gt;&lt;br&gt;&lt;/font&gt;")));
  assert.ok(has(bad.warnings, "font color"), "font-colour junk must fire");
}

{ // Cell-count guard: a model whose cells mostly fail to parse errors out.
  const idless = Array.from({ length: 12 }, () => `<mxCell vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry" /></mxCell>`).join("");
  const bad = lint(wrap(idless));
  assert.ok(has(bad.errors, "the model is malformed"), "cell-count guard must fire");
}

{ // Duplicate ids: two cells sharing one id error, unique ids stay quiet.
  const bad = lint(wrap(box("a", 0, 0) + box("a", 300, 0)));
  assert.ok(has(bad.errors, 'cell id "a" is carried by 2 elements'), "duplicate id must fire");
  const good = lint(wrap(box("a", 0, 0) + box("b", 300, 0)));
  assert.ok(lacks(good.errors, "duplicate ids"), "unique ids must stay quiet");
}

{ // A duplicate whose second holder is an <object> wrapper fires too: the
  // wrapper carries the id and the mxCell inside it carries none.
  const wrapped = `<object id="a" label="x"><mxCell style="html=1;" vertex="1" parent="1"><mxGeometry x="300" y="0" width="120" height="40" as="geometry" /></mxCell></object>`;
  const bad = lint(wrap(box("a", 0, 0) + wrapped));
  assert.ok(has(bad.errors, 'cell id "a" is carried by 2 elements'), "wrapped duplicate must fire");
}

{ // Token overflow: an unbreakable token wider than its box notes, and an
  // icon whose caption renders outside its box stays quiet.
  const bad = lint(wrap(box("t", 0, 0, 40, 28, "completeWithdrawTransaction(...)")));
  assert.ok(has(bad.notes, "likely overflowing"), "token overflow must fire");
  const icon = lint(wrap(box("i", 0, 0, 28, 28, "Midnight wallet",
    "shape=image;verticalLabelPosition=top;verticalAlign=bottom;image=data:image/png,AAAA;")));
  assert.ok(lacks(icon.notes, "likely overflowing"), "icon caption must not fire");
}

{ // Overlap: two labels on one seat error; the same labels far apart pass.
  const l1 = ridingLabel("l1", "e", "&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Reads the recorded thing", "edgeLabel;html=1;align=left;verticalAlign=middle;", 0);
  const l2 = ridingLabel("l2", "e", "&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Posts the recorded thing", "edgeLabel;html=1;align=left;verticalAlign=middle;", 0.02);
  const bad = lint(wrap(BASE + edge("e", "a", "b", PIN_LR, "", l1 + l2)));
  assert.ok(has(bad.errors, "overlap well beyond"), "certain overlap must fire as an error");
  const l2far = ridingLabel("l2", "e", "&lt;b&gt;MPC:&lt;/b&gt;&lt;br&gt;Posts the recorded thing", "edgeLabel;html=1;align=left;verticalAlign=middle;", 0.9);
  const good = lint(wrap(BASE + edge("e", "a", "b", PIN_LR, "", l1 + l2far)));
  assert.ok(lacks(good.errors, "overlap well beyond"), "separated labels must pass");
}

{ // Floating connection: a specimen edge is exempt, a real one still warns.
  const spec = box("p1", 0, 0, 1, 1) + box("p2", 200, 0, 1, 1) +
    edge("es", "p1", "p2", "html=1;strokeWidth=2;");
  const specimen = lint(wrap(spec));
  assert.ok(lacks(specimen.warnings, "floating connection"), "specimen float must be exempt");
  const real = lint(wrap(BASE + edge("e", "a", "b", "html=1;strokeWidth=2;")));
  assert.ok(has(real.warnings, "floating connection"), "real float must still warn");
}

{ // Clearance: a run passing 10u from an unrelated shape notes; same-colour
  // furniture (a step circle hugging its own step's edge) stays quiet.
  const near = box("n", 400, 330, 60, 60, "5.", "ellipse;html=1;strokeColor=#7F3C8D;");
  const bad = lint(wrap(BASE + near + edge("e", "a", "b", PIN_LR + "strokeColor=#11A579;")));
  assert.ok(has(bad.notes, "minimum clearance"), "clearance note must fire");
  const own = box("n", 400, 330, 60, 60, "5.", "ellipse;html=1;strokeColor=#11A579;");
  const good = lint(wrap(BASE + own + edge("e", "a", "b", PIN_LR + "strokeColor=#11A579;")));
  assert.ok(lacks(good.notes, "minimum clearance"), "same-colour furniture must not fire");
}

{ // Vacuity: a label-free diagram says its label checks inspected nothing.
  const result = lint(wrap(BASE + edge("e", "a", "b", PIN_LR)));
  assert.ok(has(result.notes, "vacuous, not green"), "vacuity note must appear");
}

console.log("lint-violations: all planted violations fired, all controls stayed quiet");
