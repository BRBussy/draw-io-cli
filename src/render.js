import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { chromium } from "playwright";
import he from "he";
import { BOOTSTRAP_HTML, HOST_HTML, locateWebapp } from "./webapp.js";

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".txt": "text/plain",
  ".xml": "text/xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serves the host page, the bootstrap page, and the webapp's static files
 * on an ephemeral localhost port. Library image refs such as img/lib/...
 * resolve relative to the page URL rather than the base element, so the
 * webapp's img directory is also served at the root. Resolves to the
 * listening server.
 */
function serveWebapp(webappDir) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HOST_HTML);
      return;
    }
    if (path === "/app.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(BOOTSTRAP_HTML);
      return;
    }
    let filePath = null;
    if (path.startsWith("/webapp/")) filePath = join(webappDir, path.slice("/webapp/".length));
    else if (path.startsWith("/img/")) filePath = join(webappDir, "img", path.slice("/img/".length));
    if (filePath === null || !normalize(filePath).startsWith(webappDir)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Reduces an mxfile to the single diagram named or indexed by page, so the
 * webapp loads and exports exactly that page. A numeric page that matches
 * no diagram name selects by zero-based index.
 */
export function selectPage(xml, page) {
  const diagrams = [...xml.matchAll(/<diagram\b[^>]*(?:\/>|>[\s\S]*?<\/diagram>)/g)].map(
    (m) => m[0],
  );
  if (diagrams.length === 0) throw new Error("no diagram elements found in the mxfile");
  let chosen = diagrams.find((d) => {
    const name = d.match(/^<diagram\b[^>]*?\sname="([^"]*)"/);
    return name !== null && he.decode(name[1], { isAttributeValue: true }) === page;
  });
  if (chosen === undefined && /^\d+$/.test(page)) chosen = diagrams[Number(page)];
  if (chosen === undefined) {
    throw new Error(`page "${page}" not found (by name or zero-based index)`);
  }
  const open = xml.match(/<mxfile\b[^>]*>/);
  return `${open ? open[0] : "<mxfile>"}${chosen}</mxfile>`;
}

async function waitForState(page, state, timeoutMs) {
  await page.waitForFunction((expected) => window.__state === expected, state, {
    timeout: timeoutMs,
  });
}

function decodeDataUri(uri) {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma === -1) {
    throw new Error("export did not return a data URI");
  }
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  return meta.endsWith(";base64")
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
}

/**
 * Aborts every request the render does not address to its own local server,
 * naming each blocked URL on stderr. The rendered XML is untrusted: an
 * html=1 label carries arbitrary markup, so a hostile diagram can point the
 * browser at a remote host while it renders. The webapp's own offline=1 is
 * app-level configuration, not a browser restriction.
 */
async function blockEgress(context, origin) {
  await context.route("**/*", (route, request) => {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(request.url()).origin === origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) return route.continue();
    console.error(`render: blocked external request to ${request.url()}`);
    return route.abort();
  });
}

/**
 * Renders mxfile XML with the extension's bundled draw.io webapp under
 * headless Chromium and returns the requested exports. formats is an array
 * of "xmlpng" and "xmlsvg" entries. Resolves to a map from format to Buffer
 * (PNG bytes, or UTF-8 SVG bytes). Throws when the webapp is missing or
 * an export does not complete.
 */
export async function renderDiagram(xml, { formats, scale = 3, border = 10 }) {
  const webappDir = locateWebapp();
  if (webappDir === null) {
    throw new Error(
      "draw.io webapp not found: install the hediet.vscode-drawio VS Code extension",
    );
  }
  const server = await serveWebapp(webappDir);
  let browser = null;
  try {
    browser = await chromium.launch();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext();
    await blockEgress(context, origin);
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await waitForState(page, "init", 60_000);
    await page.evaluate((x) => window.loadXml(x), xml);
    await waitForState(page, "loaded", 60_000);
    const results = {};
    for (const format of formats) {
      await page.evaluate(
        ([f, s, b]) => window.exportAs(f, s, b),
        [format, scale, border],
      );
      await waitForState(page, "exported", 120_000);
      const dataUri = await page.evaluate(() => window.__export);
      results[format] = decodeDataUri(dataUri);
    }
    return results;
  } finally {
    if (browser !== null) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
