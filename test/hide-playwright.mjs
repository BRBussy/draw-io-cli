import { register } from "node:module";

// node --import ./test/hide-playwright.mjs src/cli.js <verb> runs the CLI as
// if playwright had never been installed, without touching node_modules.
register("./hide-playwright-hooks.mjs", import.meta.url);
