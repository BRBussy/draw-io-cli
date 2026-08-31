export const PLAYWRIGHT_INSTALL_FIX = "run npm install in the drawio-cli checkout";

/**
 * Resolves to playwright's chromium driver, or null when the package is not
 * installed. The import is deferred to call time so every verb that never
 * renders runs on a checkout without playwright. A failure anywhere else in
 * playwright's module graph propagates.
 */
export async function loadChromium() {
  try {
    const playwright = await import("playwright");
    return playwright.chromium;
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}
