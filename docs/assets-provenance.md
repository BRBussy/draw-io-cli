# Standalone webapp provenance

The standalone installer downloads the unmodified hediet.vscode-drawio 1.9.0
VSIX from the [Visual Studio Marketplace version endpoint](https://marketplace.visualstudio.com/_apis/public/gallery/publishers/hediet/vsextensions/vscode-drawio/1.9.0/vspackage).
It extracts the archive locally. It does not register or execute an editor extension.
The publisher's package metadata identifies the source repository as
[hediet/vscode-drawio](https://github.com/hediet/vscode-drawio).

The downloaded archive's SHA-256 is
`822dfe98c25c52791bd0515bea09b1f5e23c0512d7df3fe44ebed193486e74fe`.
This digest was computed from the actual downloaded, HTTP-decoded VSIX bytes.
It is a locally verified content pin, not a publisher signature or an independently
published checksum. Node fetch decodes HTTP content encoding before hashing.
An offline archive must contain those same ZIP bytes, not a gzip transport wrapper.

The archive's `extension/package.json` reports version 1.9.0 and its
`extension/drawio/VERSION` reports draw.io 26.0.2. Compatibility was exercised
by launching managed Chromium through Playwright and exporting real diagrams
to PNG and SVG, then extracting their embedded models. Filenames alone do not
establish compatibility.

The installer keeps the complete extracted payload and its notices, including:

| Archive path | Licence text |
| --- | --- |
| `extension/LICENSE.md` | GNU GPL version 3 |
| `extension/drawio/LICENSE` | Apache License version 2.0 |
| `extension/drawio/src/main/webapp/img/LICENSE` | Creative Commons Attribution 4.0 |
| `extension/drawio/src/main/webapp/templates/LICENSE` | Creative Commons Attribution 4.0 |

Other bundled notices remain in their original directories. These are the
upstream licence texts, not a replacement licence for all bundled content.
The archive and extracted third-party assets are excluded from this repository.

`src/install-assets.js` holds the version and digest pin. Installation verifies
the archive before extraction, checks required scripts and bootstrap APIs,
checks the draw.io version and the licence files above, and records the pin in
`installation.json`. A staged replacement preserves the preceding installation
when download, integrity, prerequisites or extraction fail. An installation lock
serialises replacement. After an interrupted process, the operator must confirm
that no installer is active before removing a stale sibling `.lock` directory.

Explicit webapp paths and discovered editor installations receive structural
bootstrap checks. They are not asserted to match this pinned archive's digest.
The tested editor assets on the Linux server are not evidence of an interactive
laptop or editor session.
