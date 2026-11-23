# Install the Character API on Windows or macOS

This standalone package works with desktop Chrome and Brave on Windows x64 and
on macOS (Apple silicon or Intel). It contains the self-contained helper,
extension, optional CLI, API specification and examples. No Godot, Node, Python or separately installed .NET is needed to use
the API. Python is needed only for the optional Python example.

The extension works on both systems. Choosing a character and sharing it with
websites (such as an online tabletop) need no helper. The helper is only needed
for the local HTTP API used by other programs on the same computer.

Packages (version 1.2.1): `DDB-Character-API-1.2.1-Windows-x64.zip`,
`DDB-Character-API-1.2.1-macOS-AppleSilicon.zip` (M1, M2, M3, M4...) and
`DDB-Character-API-1.2.1-macOS-Intel.zip`. Each has the same extension folder
`extensions/dndbeyond`.

## Install once on Windows

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

## Install once on macOS

The helper needs macOS 15 (Sequoia) or newer. The extension itself only needs a
current desktop Chrome or Brave. The macOS packages were built and tested on
Windows and Linux (the helper's Unix code and the installer ran on Linux in WSL);
they are not yet tested on a real Mac. Please report problems.

1. Extract the ZIP that matches your Mac into a permanent folder (not Downloads
   if it may be cleaned up). Keep the whole folder together.
2. Open Terminal, type `bash` and a space, drag **Install.command** into the
   Terminal window and press Return. Double-clicking may be blocked by Gatekeeper
   because the package is not notarized by Apple.
3. Open `chrome://extensions` or `brave://extensions`, enable **Developer mode**,
   choose **Load unpacked** and select the package's **extensions/dndbeyond** folder.
4. Sign in to D&D Beyond and choose your character, as on Windows.

The installer works per user and needs no administrator rights. It:

- checks that the package matches your Mac's chip. The Apple silicon package is
  refused on an Intel Mac; the Intel package works on Apple silicon through
  Rosetta 2.
- removes the download quarantine from the two helper programs only
  (`CharacterBridge` and `character-api`) and makes sure they carry an ad hoc
  signature. The release is not signed or notarized by Apple: running the
  installer means you trust this release.
- checks that the helper starts.
- writes `com.tabletopvr.character_bridge.json` into
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (read by
  Chrome, and by Brave) and, when Brave is set up, also into
  `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`,
  so Brave finds it whichever folder its version reads. At least one of the two
  browsers must have been opened once on this Mac user account.

It refuses to overwrite a registration it did not create, or one that belongs to
another copy that still exists. If any check fails it changes nothing, and it
rolls back if a write fails. If you move the folder, run Install.command again
from the new place. Reload the extension afterwards.

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
(Windows) or `~/Library/Application Support/TabletopVR/character-bridge/v2/http.json`
(macOS; owner-only permissions) allows apps on this PC to control the selected character. Keep that file/token
private. It is separate from your D&D Beyond login.

## Sharing your character with a website

Some websites, such as a tabletop on your Tailscale network (`https://*.ts.net`)
or a page served from this PC (`http://localhost`, `http://127.0.0.1`), can ask
to use your selected character. Nothing is shared until you agree:

1. The website asks, and the extension opens a small **Share your character?**
   window showing the exact website address, your selected character and what the
   site may do:
   - **See who you are playing** (always): the character's ID, name and details
     line (for example `Level 5 - Elf - Wizard 5`), including later changes of
     your selection.
   - **Read the character sheet**: hit points, armor class, abilities, skills,
     attacks, spells, spell slots, conditions, death saves and the portrait.
     Read-only.
   - **See your dice rolls**: rolls you make on D&D Beyond with this character
     that everyone in the campaign or the DM can see. Rolls only you can see are
     never shared.
   - **Change this character on D&D Beyond**: hit points, temporary hit points,
     conditions and death saves. These changes are saved to your real character.

   Untick anything you do not want to share, then choose **Share**. Choose
   **Don't share** or close the window to refuse; the site must wait 15 seconds
   before it can ask again, and can open at most three requests a minute.
2. If a site you already share with asks for more, the window opens again as
   **Share more with this site?**; **Keep current** changes nothing.
3. Shared addresses are listed in the extension popup under **Shared with
   websites**, with **Sheet**, **Rolls** and **Changes** switches for each site.
   Switching one off takes effect immediately. **Stop sharing** ends access
   immediately and disconnects the site. If the change cannot be saved, the site
   stays stopped and is shown as **Stopped - not saved** with **Retry**; the
   extension also retries on its own.

Choosing a character in the popup and sharing it with websites both work without
the helper app (the helper is only needed by local applications on this computer);
the browser must be signed in to
D&D Beyond with the account that owns the selected character. Dice rolls are only
available for characters in a D&D Beyond campaign.

A shared website never receives your D&D Beyond login, account, other characters
or the local API bearer. Other websites cannot connect at all, and embedded
frames are refused. Reloading or updating the extension briefly disconnects shared
sites; they reconnect on their own. Developers: see
[character-share](character-share.md).

## Connection help

- **Helper app not running · only local apps need it:** this is normal if you only
  use the picker or website sharing. For local apps, run Install.cmd (Windows) or
  Install.command (macOS) from the extracted permanent package folder, check that
  the whole package is present, then open the extension.
- **Sign in required:** sign in to D&D Beyond in this same browser, then refresh.
  In Brave, if Shields blocks sign-in, allow D&D Beyond sign-in cookies for that site.
- **No active characters:** create or unlock a character on D&D Beyond and refresh.
- **Site access disabled:** restore the required D&D Beyond service access in the
  browser’s extension settings. No in-extension permission screen is used.
- **Another installation already owns this host:** uninstall the old registered
  package first; the installer refuses to take over another location silently.

The fixed extension ID is `abeakpcagojpphodembeeajfjgmcadnc`. On Windows the
installer writes only its own native-host registration in the current user's
Chrome registry location, which Brave also uses. On macOS it writes only its own
manifest file in the Chrome and Brave `NativeMessagingHosts` folders listed above. It does not install a service, autostart task,
change browser policies or open a port beyond IPv4 loopback.

## Update or remove

For an update, close the connected browser, replace the files in the same package
folder, run Install.cmd (Windows) or Install.command (macOS) and reload the extension
from its Extensions page.
Your DDB account stays in the browser and your selected character stays in
extension storage. Existing local authority/history files are not reset.
For this development installation, the source reload tool handles updates
through localhost; no repeated manual reload is required.

To remove it, close the connected browser, run **Uninstall.cmd** from the registered package,
and remove the extension from the browser. The uninstaller removes only owned
registration/generated manifest files and preserves user data and extracted files.

On macOS, run **Uninstall.command** the same way as the installer (`bash` and a
space, drag the file into Terminal, press Return). It removes only registrations
that point to that folder. Reload the extension afterwards.
