import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const requiredWebappFiles = ["js/app.min.js", "js/PreConfig.js", "js/PostConfig.js", "js/extensions.min.js", "js/stencils.min.js", "js/shapes-14-6-5.min.js", "styles/grapheditor.css"];

export function createWebappFixture(path) {
  for (const file of requiredWebappFiles) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), 'App.main=function(){}; Menus.prototype={}; EditorUi.VERSION="26.0.2";');
  }
  return path;
}
