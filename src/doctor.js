import { existsSync } from "node:fs";
import { locateWebapp } from "./webapp.js";
import { chromiumLaunchOptions, loadChromium, PLAYWRIGHT_INSTALL_FIX } from "./playwright.js";

/**
 * Checks asset structure and executable presence. A real render is required
 * to establish that the browser launches and the webapp exports a model.
 */
export async function doctor(options = {}) {
  let ok = true;

  const webapp = locateWebapp(options);
  if (webapp === null) {
    ok = false;
    console.error(
      "webapp assets: NOT FOUND in the checkout or installed extensions",
    );
    console.error("  fix: run drawio-cli install-assets or install the hediet.vscode-drawio extension");
  } else {
    console.log(`webapp assets: ${webapp}`);
  }

  const chromium = await loadChromium();
  if (chromium === null) {
    ok = false;
    console.error("playwright package: NOT INSTALLED");
    console.error(`  fix: ${PLAYWRIGHT_INSTALL_FIX}`);
  } else {
    console.log("playwright package: installed");
    const launchOptions = chromiumLaunchOptions();
    let executable = null;
    try {
      executable = launchOptions.executablePath ?? chromium.executablePath();
    } catch {
      executable = null;
    }
    if (executable === null || executable === "" || !existsSync(executable)) {
      ok = false;
      console.error("playwright chromium: NOT FOUND");
      if (launchOptions.executablePath !== undefined) {
        console.error(`  DRAWIO_CHROMIUM_EXECUTABLE_PATH: ${executable}`);
        console.error("  fix: point DRAWIO_CHROMIUM_EXECUTABLE_PATH at a Playwright-compatible Chromium executable");
      } else {
        console.error("  fix: ask your administrator to provision the matching Playwright Chromium and OS libraries");
      }
    } else {
      console.log(`playwright chromium: ${executable}`);
    }
  }

  return ok ? 0 : 1;
}
