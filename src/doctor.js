import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { locateWebapp } from "./webapp.js";

/**
 * Reports whether a full render path works on this machine: the extension
 * webapp and the playwright Chromium build. Returns 0 when both are found,
 * 1 otherwise, naming each missing piece and its fix.
 */
export function doctor() {
  let ok = true;

  const webapp = locateWebapp();
  if (webapp === null) {
    ok = false;
    console.error(
      "extension webapp: NOT FOUND under ~/.vscode/extensions or ~/.cursor/extensions",
    );
    console.error("  fix: install the hediet.vscode-drawio extension in VS Code or Cursor");
  } else {
    console.log(`extension webapp: ${webapp}`);
  }

  let executable = null;
  try {
    executable = chromium.executablePath();
  } catch {
    executable = null;
  }
  if (executable === null || executable === "" || !existsSync(executable)) {
    ok = false;
    console.error("playwright chromium: NOT FOUND");
    console.error("  fix: run npx playwright install chromium");
  } else {
    console.log(`playwright chromium: ${executable}`);
  }

  return ok ? 0 : 1;
}
