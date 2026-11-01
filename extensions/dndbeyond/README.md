# D&D Beyond Character API extension

The standalone Windows package contains the Chrome/Brave extension, a native
HTTP helper, installer, documented API and examples. No game is required.

- [Install and choose a character](../../docs/character-extension.md)
- [HTTP API reference](../../docs/character-http-api.md)
- [OpenAPI specification](../../docs/character-http-api.openapi.json)

The toolbar is a character picker for the signed-in D&D Beyond account. Its
selection is remembered. Browser login credentials stay in memory inside the
worker. Any local application with the local API bearer can read and edit the
selected character without additional approval prompts. Required D&D Beyond service access is
part of installation; there are no in-extension Allow, Pause or Stop sharing controls.

`background.js` starts the worker; `local-api.js` owns the native connection and
selection; `http-read.js` authenticates browser service calls; `account-characters.js`
projects the account listing; `script-api.js`, `sheet-api.js`, `character-summary.js`
and `script-rolls.js` implement the API. `ui/` contains only the picker and setup.
There are no content scripts, sheet-tab automation, pairing, enrollment, scoped
grants, recorder, developer validation pages or production npm dependencies.

Run `node tools/build-extension.js --check` to check identity and runtime files.
Run `npm run test:bridge -- --workers=2` for the current isolated browser/API tests.
Build/package with `tools/build-character-api.ps1` and
`tools/package-character-api.ps1`. The standalone helper is independent of the
repository's game-side integration and older game export tools.
