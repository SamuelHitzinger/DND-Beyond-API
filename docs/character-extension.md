# Install the Character API on a Windows PC

This standalone package works with desktop Chrome and Brave on Windows x64.
It contains the self-contained helper, extension, optional CLI, API specification
and examples. No Godot, Node, Python or separately installed .NET is needed to use
the API. Python is needed only for the optional Python example.

## Install once

1. Extract the entire ZIP into a permanent, writable folder, such as
   `C:\Users\you\Apps\CharacterAPI`. Keep the whole folder together.
2. Run **Install.cmd** as your normal Windows user. It registers the included
   helper for Chrome and Brave. No administrator rights are required.
3. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
4. Enable **Developer mode**, choose **Load unpacked**, and select the package's
   **extensions/dndbeyond** folder. Pin the extension if desired.
5. Sign in to [D&D Beyond](https://www.dndbeyond.com/characters) in that browser.
6. Open the extension and choose your character by name. The choice is remembered, and applications can
   immediately read and edit it through the [documented API](character-http-api.md).

D&D Beyond service access is included in the extension's required installation
permissions. There is no separate Allow/Connect screen or per-edit approval.
Chrome/Brave may display its own permission notice on installation or update.
Credentials stay in browser memory; you never paste or export cookies or DDB
tokens. No character sheet tab needs to remain open.

## Everyday use

Open the extension to switch characters. Switching replaces
access to the previous character for all local apps. Refresh after creating,
unlocking, deleting or renaming a character, or after switching accounts. The
list excludes deleted and subscription-locked sheets. A refreshed different
account or missing chosen character clears the remembered choice.

Keep one Chrome/Brave profile connected at a time: both use the same user-local
API discovery file. Close the other browser, or disable the extension in that
profile, before switching. Access stays active automatically for the remembered
character. Closing the popup keeps the API running. Closing the browser ends it;
applications read the updated dynamic URL after reconnect.

The local bearer in `%LOCALAPPDATA%/TabletopVR/character-bridge/v2/http.json`
allows apps on this PC to control the selected character. Keep that file/token
private. It is separate from your D&D Beyond login.

## Connection help

- **Windows helper unavailable:** run Install.cmd from the extracted permanent
  package folder, check that the whole package is present, then open the extension.
- **Sign in required:** sign in to D&D Beyond in this same browser, then refresh.
  In Brave, if Shields blocks sign-in, allow D&D Beyond sign-in cookies for that site.
- **No active characters:** create or unlock a character on D&D Beyond and refresh.
- **Site access disabled:** restore the required D&D Beyond service access in the
  browser’s extension settings. No in-extension permission screen is used.
- **Another installation already owns this host:** uninstall the old registered
  package first; the installer refuses to take over another location silently.

The fixed extension ID is `abeakpcagojpphodembeeajfjgmcadnc`. The installer writes
only its own native-host registration in the current user's Chrome registry
location, which Brave also uses. It does not install a service, autostart task,
change browser policies or open a port beyond IPv4 loopback.

## Update or remove

For an update, close the connected browser, replace the files in the same package
folder, run Install.cmd and reload the extension from its Extensions page.
Your DDB account stays in the browser and your selected character stays in
extension storage. Existing local authority/history files are not reset.
For this development installation, the source reload tool handles updates
through localhost; no repeated manual reload is required.

To remove it, close the connected browser, run **Uninstall.cmd** from the registered package,
and remove the extension from the browser. The uninstaller removes only owned
registration/generated manifest files and preserves user data and extracted files.
