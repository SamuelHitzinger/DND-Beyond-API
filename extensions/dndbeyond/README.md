# D&D Beyond Character API extension

The standalone Windows and macOS packages contain the Chrome/Brave extension, a
native HTTP helper, installer, documented API and examples. No game is required.
The extension works the same on both systems.

- [Install and choose a character](../../docs/character-extension.md)
- [HTTP API reference](../../docs/character-http-api.md)
- [OpenAPI specification](../../docs/character-http-api.openapi.json)
- [Sharing with a website (character-share v2)](../../docs/character-share.md)

The toolbar is a character picker for the signed-in D&D Beyond account. Its
selection is remembered. Browser login credentials stay in memory inside the
worker. Any local application with the local API bearer can read and edit the
selected character without additional approval prompts. Required D&D Beyond service access is
part of installation; there are no in-extension Allow or Pause controls for it.

Websites are separate: a top-level page on `https://*.ts.net`, `http://localhost`
or `http://127.0.0.1` may connect through `externally_connectable`, but learns the
selected character's `{id, name, details}` only after the user approves that exact
origin in `ui/share.html`, and the read-only sheet, dice rolls or HP/condition/
death-save changes only with the scopes ticked there. The popup lists approved
sites with per-scope toggles and **Stop sharing**.

`background.js` starts the worker; `local-api.js` owns the native connection and
selection; `web-share.js` owns website ports, approvals, scopes and revocation,
with its own D&D Beyond reader (independent of the helper app);
`share-sheet.js` builds the sheet projection, portrait and shared poll;
`share-relay.js` relays game-log dice rolls; `share-apply.js` validates and
deduplicates website writes;
`http-read.js` authenticates browser service calls; `account-characters.js`
projects the account listing; `script-api.js`, `sheet-api.js`, `character-summary.js`
and `script-rolls.js` implement the API. `ui/` contains the picker (with its
shared-sites list), setup and the website approval window (`share.html`).
There are no content scripts, sheet-tab automation, pairing, enrollment, per-app
scoped grants, recorder, developer validation pages or production npm dependencies.

Run `node tools/build-extension.js --check` to check identity and runtime files.
Run `npm run test:bridge -- --workers=2` for the current isolated browser/API tests.
Build/package with `tools/build-character-api.ps1` and
`tools/package-character-api.ps1` (Windows x64 development machine; add
`-Runtime osx-arm64` or `-Runtime osx-x64` for the macOS packages). The standalone helper is independent of the
repository's game-side integration and older game export tools.
