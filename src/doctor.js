import { existsSync } from "node:fs";
import { locateWebapp } from "./webapp.js";
import { loadChromium, PLAYWRIGHT_INSTALL_FIX } from "./playwright.js";

/**
 * Reports whether a full render path works on this machine: the extension
 * webapp, the playwright package and its Chromium build. Resolves to 0 when
 * all are found, 1 otherwise, naming each missing piece and its fix.
 */
export async function doctor() {
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

  const chromium = await loadChromium();
  if (chromium === null) {
    ok = false;
    console.error("playwright package: NOT INSTALLED");
    console.error(`  fix: ${PLAYWRIGHT_INSTALL_FIX}`);
  } else {
    console.log("playwright package: installed");
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
  }

  return ok ? 0 : 1;
}
