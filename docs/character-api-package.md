# D&D Beyond Character API for Windows and macOS

Choose a D&D Beyond character in Chrome or Brave, then control it from any local
application through a documented HTTP API. The choice is remembered. No game,
per-application enrollment or approval for each edit is required.

## Start here

1. Extract this ZIP into a permanent folder.
2. Windows: run **Install.cmd** (normal user, no administrator rights).
   macOS: open Terminal, type `bash` and a space, drag **Install.command** into
   the window and press Return.
3. Load **extensions/dndbeyond** from `chrome://extensions` or
   `brave://extensions` using Developer mode → Load unpacked.
4. Sign in to D&D Beyond, open the extension and choose a character by name.
5. Run `character-api.exe GET /v1/character/summary` (Windows) or
   `./character-api GET /v1/character/summary` (macOS), or connect your own
   software.

See the [installation guide](docs/character-extension.md),
[API reference](docs/character-http-api.md), and
[OpenAPI specification](docs/character-http-api.openapi.json). A website you
approve can learn which character is selected (name and details only); see
[website sharing](docs/character-share.md). Runnable
PowerShell and Python clients are in **examples/**. The live specification is
also available at authenticated **GET /openapi.json**.

## What's included

- Self-contained native helper and optional command-line client for this
  package's system: Windows x64, macOS Apple silicon or macOS Intel
  (`CharacterBridge`/`character-api` on macOS, `.exe` files on Windows).
- The same Manifest V3 extension for desktop Chrome and Brave.
- Per-user install/uninstall scripts (`Install.cmd`/`Uninstall.cmd` on Windows,
  `Install.command`/`Uninstall.command`/`setup.sh` on macOS), API docs, OpenAPI
  and examples.
- Required .NET runtime notices under **licenses/**.

DDB login credentials remain in the browser. Local apps use a separate bearer
and the current URL from `%LOCALAPPDATA%/TabletopVR/character-bridge/v2/http.json`
on Windows or `~/Library/Application Support/TabletopVR/character-bridge/v2/http.json`
on macOS.
The API listens only on this PC and is available while the connected browser is
running. Use one Chrome/Brave profile at a time. Unknown write outcomes are never
retried automatically: read the current character state before deciding what to do.

No Godot files, old pairing/enrollment/grant/recorder flows, developer captures,
account data or credentials are included. This is an unpacked extension
package; it has not been submitted to a browser store.
