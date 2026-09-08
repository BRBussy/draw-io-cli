# First-run readiness

The Node.js CLI in `src/cli.js` loads the repository's declared packages and
provides diagram extraction, rendering, inspection and editing commands.
Rendering uses the draw.io webapp bundled with `hediet.vscode-drawio`, discovered
through the account's VS Code or Cursor extension directories. The webapp assets
are a separate dependency from the CLI and its Node.js packages.

Playwright supplies the Chromium driver. Its matching headless browser runs the
webapp for PNG and SVG export. The provisioned worker uses extension assets
labelled 1.9.0 and Chromium 151.0.7922.34, revision 1234, with the browser location
inherited through `PLAYWRIGHT_BROWSERS_PATH`. Shared assets are provisioned
centrally through Ansible. The CLI's `doctor` command checks discovery and
executable presence, so actual launch and rendering need separate verification.

Run the verification from the checkout root:

```sh
npm run test
```

Observed result in the provisioned worker: exit status 0, with all test suites
passing. The smoke test rendered PNG and SVG exports and verified their embedded
diagram models, extraction and external-request blocking.

This readiness rehearsal is limited to the provisioned worker environment.
Standalone installation and Codex integration are outside its scope.
