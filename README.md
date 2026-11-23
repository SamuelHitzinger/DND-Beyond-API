# D&D Beyond Character API

Choose a D&D Beyond character in desktop Chrome or Brave, then read and control
it from any local application through HTTP. The choice is remembered and access
stays active automatically. D&D Beyond credentials stay inside the browser.

[Download a package](https://github.com/SamuelHitzinger/DND-Beyond-API/releases/latest)
for your computer (version 1.2.1):

- `DDB-Character-API-1.2.1-Windows-x64.zip`
- `DDB-Character-API-1.2.1-macOS-AppleSilicon.zip` (Apple silicon: M1, M2, M3, M4...)
- `DDB-Character-API-1.2.1-macOS-Intel.zip`

The helper and CLI are self-contained: no .NET, Node or game installation is
required to use the package. The macOS packages are not yet tested on a real Mac;
please report problems.

## Install

Windows:

1. Extract the release ZIP into a permanent folder.
2. Run **Install.cmd** as your normal Windows user.
3. Open `chrome://extensions` or `brave://extensions`, enable Developer mode,
   choose Load unpacked, and select **extensions/dndbeyond** from the package.
4. Sign in to D&D Beyond and choose a character in the extension.
5. Run `character-api.exe GET /v1/character/summary` or connect your own software.

macOS (macOS 15 or newer for the helper):

1. Extract the release ZIP for your chip into a permanent folder.
2. Open Terminal, type `bash` and a space, drag **Install.command** into the
   Terminal window and press Return. It works per user and needs no admin rights.
   (Double-clicking may be blocked because the package is not notarized by Apple.)
3. Load **extensions/dndbeyond** in `chrome://extensions` or
   `brave://extensions` as in steps 3 and 4 above.
4. Run `./character-api GET /v1/character/summary` from the package folder or
   connect your own software.

Choosing a character and sharing it with websites work without the helper on both
systems; the helper is only needed for the local HTTP API. See
[installation and connection help](docs/character-extension.md) for details.

There is one browser-owned API per computer user. All local applications use the
same URL and bearer from
`%LOCALAPPDATA%/TabletopVR/character-bridge/v2/http.json` on Windows or
`~/Library/Application Support/TabletopVR/character-bridge/v2/http.json` on macOS.
Use one connected browser profile at a time. No per-application enrollment or per-edit approval is needed.

## Documentation

- [Installation and connection help](docs/character-extension.md)
- [HTTP API reference](docs/character-http-api.md)
- [OpenAPI 3.1 specification](docs/character-http-api.openapi.json)
- [Sharing your character with a website](docs/character-share.md)
- [Python example](examples/character-api/character_api.py)
- [PowerShell example](examples/character-api/character-api.ps1)

The specification is also served at authenticated `GET /openapi.json`.
Character endpoints cover HP, inventory, currencies, conditions, spell counters,
notes, custom items/actions, rests and local rolls. A restricted authenticated
request route covers upstream character-service operations without typed wrappers.
Unknown write outcomes are never automatically retried: read the current state
before deciding on another action. The listener accepts IPv4 loopback only.

Web pages get no HTTP access. A page on `https://*.ts.net`, `http://localhost` or
`http://127.0.0.1` may ask, through the extension, to use the selected character.
The user approves each exact site and chooses what it may do: always the
character's ID, name and level/species/class line, and optionally a read-only
sheet with portrait, dice rolls made on D&D Beyond (public and to-DM only), and
HP/condition/death-save changes. Scopes can be switched off or sharing stopped in
the popup. See [character-share v2](docs/character-share.md).

## Build and test

Development requires Windows x64 and Node24; the macOS packages are also built
there. Setup downloads the pinned .NET SDK
from Microsoft and verifies its checksum. Runtime users do not need these tools.

```powershell
.\tools\setup-character-api.ps1
.\tools\build-character-api.ps1
.\tools\check-character-api.ps1
npm ci
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.tools/playwright'
npx playwright install chromium
npm run test:bridge -- --workers=2
.\tools\package-character-api.ps1
```

For macOS, build and package with `-Runtime osx-arm64` or `-Runtime osx-x64`:
`tools/build-character-api.ps1 -Runtime osx-arm64` and
`tools/package-character-api.ps1 -Runtime osx-arm64`.

Generated binaries/packages stay under **dist/**. Tests use isolated native
processes, HTTP fixtures and invented account responses. They never install a
second API, use a personal browser profile or mutate a real character.

After editing an installed development extension, use
`tools/reload-extension.ps1`. Helper updates use
`tools/build-character-api.ps1 -ReloadExtension`, which discovers and updates the
existing registered installation instead of creating another host.

The extension is distributed unpacked and has not been submitted to a browser
store. D&D Beyond controls the upstream services; this is not an official DDB API.
See [third-party notices](THIRD_PARTY_NOTICES.md) for runtime/development dependencies.
