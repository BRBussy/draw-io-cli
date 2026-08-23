import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Render defaults from the nearest drawio.config.json, searched upward
 * from the input file's directory. Returns {scale, border, path} with
 * nulls for anything the file does not set, and all nulls when no file
 * is found. Throws on unreadable JSON or non-numeric values, a broken
 * config must never fall back silently.
 */
export function loadRenderConfig(inputPath) {
  let dir = dirname(resolve(inputPath));
  while (true) {
    const candidate = join(dir, "drawio.config.json");
    if (existsSync(candidate)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(candidate, "utf8"));
      } catch (error) {
        throw new Error(`${candidate} is not valid JSON: ${error.message}`);
      }
      const render = parsed.render ?? {};
      for (const key of ["scale", "border"]) {
        if (render[key] !== undefined && typeof render[key] !== "number") {
          throw new Error(`${candidate}: render.${key} must be a number`);
        }
      }
      return { scale: render.scale ?? null, border: render.border ?? null, path: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) return { scale: null, border: null, path: null };
    dir = parent;
  }
}
