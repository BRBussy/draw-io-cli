import { readFile, writeFile, mkdir, mkdtemp, rename, rm, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWebapp } from "./webapp.js";

export const ASSET_RELEASE = Object.freeze({
  extensionVersion: "1.9.0",
  drawioVersion: "26.0.2",
  url: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/hediet/vsextensions/vscode-drawio/1.9.0/vspackage",
  sha256: "822dfe98c25c52791bd0515bea09b1f5e23c0512d7df3fe44ebed193486e74fe",
});

export async function installAssets({ archive, directory = fileURLToPath(new URL("../.drawio-assets", import.meta.url)), url = ASSET_RELEASE.url } = {}) {
  let bytes;
  if (archive !== undefined) {
    bytes = await readFile(archive);
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`asset download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== ASSET_RELEASE.sha256) throw new Error(`asset SHA-256 mismatch: expected ${ASSET_RELEASE.sha256}, received ${digest}`);
  const prerequisite = spawnSync("unzip", ["-v"], { encoding: "utf8" });
  if (prerequisite.error || prerequisite.status !== 0) throw new Error("unzip is required: ask your administrator to provision it");
  const destination = resolve(directory);
  await mkdir(dirname(destination), { recursive: true });
  const lock = `${destination}.lock`;
  await mkdir(lock);
  let staging;
  try {
    staging = await mkdtemp(join(dirname(destination), ".drawio-stage-"));
    const zip = join(staging, "assets.vsix");
    const payload = join(staging, "payload");
    await writeFile(zip, bytes);
    const extracted = spawnSync("unzip", ["-q", zip, "-d", payload], { encoding: "utf8" });
    if (extracted.error || extracted.status !== 0) throw new Error(`asset extraction failed: ${extracted.error?.message ?? extracted.stderr}`);
    validateWebapp(join(payload, "extension/drawio/src/main/webapp"));
    const version = (await readFile(join(payload, "extension/drawio/VERSION"), "utf8")).trim();
    if (version !== ASSET_RELEASE.drawioVersion) throw new Error(`incompatible draw.io version: ${version}`);
    for (const licence of ["extension/LICENSE.md", "extension/drawio/LICENSE", "extension/drawio/src/main/webapp/img/LICENSE", "extension/drawio/src/main/webapp/templates/LICENSE"]) {
      if (!(await readFile(join(payload, licence))).length) throw new Error(`empty licence: ${licence}`);
    }
    await writeFile(join(payload, "installation.json"), `${JSON.stringify(ASSET_RELEASE, null, 2)}\n`);
    let present = false;
    try { await access(destination); present = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    const backup = join(staging, "previous");
    if (present) {
      const previous = JSON.parse(await readFile(join(destination, "installation.json"), "utf8"));
      if (previous.sha256 !== ASSET_RELEASE.sha256) throw new Error("refusing to replace an unrecognised asset installation");
      await rename(destination, backup);
    }
    try {
      await rename(payload, destination);
    } catch (error) {
      if (present) await rename(backup, destination);
      throw error;
    }
    console.log(`standalone draw.io ${version}: ${join(destination, "extension/drawio/src/main/webapp")}`);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
