import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const emptyHome = mkdtempSync(join(tmpdir(), "drawio-empty-home-"));
process.on("exit", () => rmSync(emptyHome, { recursive: true, force: true }));
const source = `export const homedir = () => ${JSON.stringify(emptyHome)};`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:os" && context.parentURL?.endsWith("/src/webapp.js")) {
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
