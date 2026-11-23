#!/bin/bash
# Exercises a real macOS package's installer on Linux (WSL), as far as that is possible without a Mac:
#   bash tests/macos_installer_test.sh <macOS package zip> <linux-x64 CharacterBridge> <linux-x64 character-api>
# The zip is extracted with its recorded Unix modes, then the macOS binaries are swapped for Linux builds of the
# same source so the installer's checks, ownership rules, transactions and the registered host can actually run.
# CHARACTER_API_INSTALL_TEST=1 skips only the macOS-only steps (platform check, quarantine, codesign).
# Not covered here: Gatekeeper, codesign, Chrome/Brave launching the host on a real Mac.
set -euo pipefail
zip="$1"; linux_helper="$2"; linux_cli="$3"
work="$(cd "$(mktemp -d)" && pwd -P)"; trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT
fail() { echo "FAIL $1" >&2; exit 1; }
pass() { echo "PASS $1"; }
# On a real Mac (CI) set CHARACTER_API_REAL_MAC=1: quarantine, codesign and the platform checks then run for real.
if [ -n "${CHARACTER_API_REAL_MAC:-}" ]; then unset CHARACTER_API_INSTALL_TEST || true; else export CHARACTER_API_INSTALL_TEST=1; fi
export HOME="$work/home"
unset XDG_DATA_HOME || true
mkdir -p "$HOME"
support="$HOME/Library/Application Support"
chrome="$support/Google/Chrome/NativeMessagingHosts/com.tabletopvr.character_bridge.json"
brave="$support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.tabletopvr.character_bridge.json"

extract() { # zip -> directory, applying the archive's Unix modes like Archive Utility / unzip
  python3 - "$1" "$2" <<'PY'
import sys, zipfile, os
with zipfile.ZipFile(sys.argv[1]) as z:
    for info in z.infolist():
        target = os.path.join(sys.argv[2], info.filename)
        if info.create_system != 3: raise SystemExit('entry not made on Unix: ' + info.filename)
        z.extract(info, sys.argv[2])
        os.chmod(target, (info.external_attr >> 16) & 0o777)
PY
}
pkg="$work/Character \"API\" package"   # spaces and a quote: the manifest path must be escaped JSON
mkdir -p "$pkg"; extract "$zip" "$pkg"
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }   # GNU (Linux) or BSD (macOS) stat
[ "$(mode "$pkg/CharacterBridge")" = 755 ] && [ "$(mode "$pkg/character-api")" = 755 ] \
  && [ "$(mode "$pkg/Install.command")" = 755 ] && [ "$(mode "$pkg/README.md")" = 644 ] || fail 'zip modes'
pass 'zip keeps Unix modes (programs and installers 0755, documents 0644)'
if [ -n "${CHARACTER_API_REAL_MAC:-}" ]; then
  # The way Finder (Archive Utility) and unzip unpack it on a Mac must give the same modes.
  ditto -x -k "$zip" "$work/ditto" && unzip -q "$zip" -d "$work/unzip" || fail 'ditto/unzip extraction'
  for x in ditto unzip; do
    [ "$(mode "$work/$x/CharacterBridge")" = 755 ] && [ "$(mode "$work/$x/Install.command")" = 755 ] && [ "$(mode "$work/$x/README.md")" = 644 ] || fail "$x modes"
  done
  pass 'macOS ditto (Archive Utility) and unzip extract the package with the same modes'
  # As if downloaded by a browser: quarantine every extracted file; the installer must clear it on the programs.
  find "$pkg" -type f -exec xattr -w com.apple.quarantine '0081;00000000;Chrome;' {} \;
else
  cp "$linux_helper" "$pkg/CharacterBridge"; cp "$linux_cli" "$pkg/character-api"
fi
copy2="$work/second copy"; cp -a "$pkg" "$copy2"

install() { bash "$1/Install.command" >"$work/out" 2>&1; }
uninstall() { bash "$1/Uninstall.command" >"$work/out" 2>&1; }
manifest_path() { python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); assert m["name"]=="com.tabletopvr.character_bridge" and m["type"]=="stdio" and m["allowed_origins"]==["chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/"]; print(m["path"])' "$1"; }

if install "$pkg"; then fail 'installed with no browser set up'; fi
[ ! -e "$support/Google" ] && [ ! -e "$support/BraveSoftware" ] || fail 'created browser folders'
grep -q 'neither Google Chrome nor Brave' "$work/out" || fail 'no-browser message'
pass 'no browser on the account: refused, nothing created'

mkdir -p "$support/BraveSoftware/Brave-Browser"
install "$pkg" || { cat "$work/out"; fail 'install with Brave only'; }
[ "$(manifest_path "$chrome")" = "$pkg/CharacterBridge" ] && [ "$(manifest_path "$brave")" = "$pkg/CharacterBridge" ] || fail 'Brave-only registration'
pass "Brave only: registered in Chrome's folder and Brave's folder"
mkdir -p "$support/Google/Chrome"
install "$pkg" || { cat "$work/out"; fail 'install'; }
[ "$(manifest_path "$chrome")" = "$pkg/CharacterBridge" ] && [ "$(manifest_path "$brave")" = "$pkg/CharacterBridge" ] || fail 'manifest path'
grep -q "Registered for Google Chrome's folder" "$work/out" && grep -q "Registered for Brave's folder" "$work/out" || fail 'report'
if [ -n "${CHARACTER_API_REAL_MAC:-}" ]; then
  ! xattr -p com.apple.quarantine "$pkg/CharacterBridge" 2>/dev/null && ! xattr -p com.apple.quarantine "$pkg/character-api" 2>/dev/null && xattr -p com.apple.quarantine "$pkg/README.md" >/dev/null || fail 'quarantine handling'
  codesign --verify "$pkg/CharacterBridge" && codesign --verify "$pkg/character-api" || fail 'signatures'
  pass 'quarantine removed from the two programs only; both pass codesign --verify'
fi
first="$(cat "$chrome")"; install "$pkg" || fail 'reinstall'; [ "$(cat "$chrome")" = "$first" ] || fail 'idempotent'
pass 'install registers Chrome and Brave with valid JSON (escaped path with spaces and quotes); rerun is idempotent'
lock="${TMPDIR:-/tmp}/com.tabletopvr.character_bridge.$(id -u).lock"; mkdir "$lock"
if install "$pkg"; then rmdir "$lock"; fail 'ran while another installer held the lock'; fi
rmdir "$lock"; grep -q 'another Character API installer is running' "$work/out" || fail 'lock message'
install "$pkg" || fail 'install after lock released'
pass 'one installer at a time (per-user lock); the lock is released after each run'

# Launch the registered host exactly as Chrome does on macOS: manifest path, origin as the only argument.
config_dir="$HOME/.local/share/TabletopVR/character-bridge/v2"; [ -z "${CHARACTER_API_REAL_MAC:-}" ] || config_dir="$support/TabletopVR/character-bridge/v2"
python3 - "$(manifest_path "$chrome")" "$config_dir" <<'PY'
import json, os, struct, subprocess, sys, stat
p = subprocess.Popen([sys.argv[1], 'chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
def read():
    n = struct.unpack('<I', p.stdout.read(4))[0]; return json.loads(p.stdout.read(n))
def write(m):
    b = json.dumps(m).encode(); p.stdin.write(struct.pack('<I', len(b)) + b); p.stdin.flush()
assert read() == {'type': 'ready'}
write({'type': 'ping'}); assert read() == {'type': 'pong'}
config = os.path.join(sys.argv[2], 'http.json')
assert stat.S_IMODE(os.stat(config).st_mode) == 0o600 and stat.S_IMODE(os.stat(sys.argv[2]).st_mode) == 0o700
p.stdin.close(); assert p.wait(10) == 0 and p.stderr.read() == b''
PY
pass 'registered host starts from the manifest with the origin argument, frames ready/pong, owner-only http.json, clean exit on EOF'

if install "$copy2"; then fail 'second copy replaced a registration whose folder still exists'; fi
[ "$(manifest_path "$chrome")" = "$pkg/CharacterBridge" ] || fail 'second copy changed chrome'
uninstall "$copy2" || fail 'uninstall from other copy'
[ -f "$chrome" ] && [ -f "$brave" ] && grep -q 'registered to another copy' "$work/out" || fail 'other copy removed registrations'
pass 'a second copy cannot take over or remove the registrations of an existing installation'

rm "$chrome"; printf '{"name":"com.tabletopvr.character_bridge","path":"/somewhere/else"}\n' > "$brave"
if install "$pkg"; then fail 'overwrote a foreign manifest'; fi
[ ! -e "$chrome" ] && grep -q 'did not create' "$work/out" || fail 'partial write before refusing'
uninstall "$pkg" || fail 'uninstall with foreign'; [ -f "$brave" ] || fail 'removed foreign manifest'
rm "$brave"
pass 'a foreign registration in one browser blocks the whole install (no partial write) and survives uninstall'

if [ "$(id -u)" != 0 ]; then
  chmod 555 "$(dirname "$brave")" 2>/dev/null || mkdir -p "$(dirname "$brave")"
  chmod 555 "$(dirname "$brave")"
  if install "$pkg"; then fail 'install succeeded into a read-only folder'; fi
  [ ! -e "$chrome" ] && grep -q 'restored' "$work/out" || fail 'no rollback of chrome'
  chmod 755 "$(dirname "$brave")"
  pass 'a failed write rolls back the browsers already registered'
fi

install "$pkg" || fail 'reinstall original'
cp /usr/bin/false "$copy2/CharacterBridge"   # Linux: an ELF that exits 1; macOS: not a Mach-O for this package
rm -rf "$pkg"   # the original folder is gone: another copy may take over
if install "$copy2"; then fail 'installed a helper that cannot run'; fi
[ "$(manifest_path "$chrome")" = "$pkg/CharacterBridge" ] && grep -Eq 'could not run|not a recognised' "$work/out" || fail 'probe'
pass 'a helper that cannot start on this machine is refused before anything is changed'

cp "$linux_helper" "$copy2/CharacterBridge"
install "$copy2" || { cat "$work/out"; fail 'install moved copy'; }
[ "$(manifest_path "$chrome")" = "$copy2/CharacterBridge" ] || fail 'moved copy path'
uninstall "$copy2" || fail 'uninstall'
[ ! -e "$chrome" ] && [ ! -e "$brave" ] || fail 'uninstall left registrations'
pass 'after the folder moves, reinstalling from the new place takes over; uninstall removes its registrations'
echo "PASS macOS installer ($([ -n "${CHARACTER_API_REAL_MAC:-}" ] && echo 'real macOS' || echo 'on Linux')): modes, registration, ownership, transactions, host launch"
