# draw-io-cli — agent rules

## NEVER BREAK: No machine-specific absolute paths, anywhere, ever.

- NEVER write a path that names a specific machine, user, or checkout location
  (`/Users/<name>/...`, `/home/<name>/...`, `C:\Users\...`, or any absolute
  path into someone's `Projects/` tree) into ANYTHING in this repository:
  source code, the skill under `skills/`, the README, tests, hooks, comments,
  package metadata, backlog notes — no exceptions, no "just this once".
- A committed absolute path is a lie on every machine but one, and this
  repository's files are read on other machines (the skill is symlinked and
  shared, the README is public documentation).
- Express locations by their relationship to the repository instead:
  - **Repo-root-relative prose**: "at the root of this checkout",
    "`skills/drawio-diagrams/` two levels below the repository root",
    "the repository's location on disc".
  - **Run-from-root commands**: instruct the reader to run from the checkout
    root and use `"$(pwd)"` (e.g. the README's symlink command).
  - **Placeholders with instructions**: where a literal is unavoidable (a JSON
    config snippet), write `<repo-root>` and tell the reader to substitute
    their checkout's absolute path.
  - **Self-locating code**: scripts and tests derive the repo root from their
    own location (`import.meta.url` + `dirname`), never from a hardcoded path.
- The ONLY sanctioned home for a real absolute path is a user's own machine
  configuration OUTSIDE this repository (e.g. `~/.claude/settings.json`
  registering the hook). Nothing inside the repository carries one.
- Before finishing any change, grep the repository for `/Users/`, `/home/`
  and the repository owner's name, and expect zero hits. Exclude
  `node_modules`, the gitignored `test/smoke-*` artifacts, and this file
  (whose pattern examples are the one sanctioned appearance of those strings).
