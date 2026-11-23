# character-share v2: share the selected character with a website

A web page can ask the extension for the D&D Beyond character the player has
selected in the picker. Access is consent-gated per exact website origin and
split into four scopes. Website sharing is separate from the local HTTP API: a
page never receives the local bearer, D&D Beyond credentials or tokens, the
account ID or the account's other characters.

| Scope | What the site gets | Default in the approval window |
| --- | --- | --- |
| `identity` | `{id, name, details}` of the selected character (always, once approved) | always on |
| `sheet` | A read-only sheet projection and a small portrait | on |
| `rolls` | Dice rolls the player makes on D&D Beyond with the selected character that are public or sent to the DM. Rolls only the player can see are never relayed | on |
| `write` | The site may change the selected character's HP, temporary HP, conditions and death saves | on, separately explained |

Scopes belong to the origin. Data always comes from the currently selected
character and follows the selection when it changes.

Sheets, rolls and writes for websites use the extension's own D&D Beyond reader.
They do not need the Windows helper (`helper` is informational only) but do need
the extension's D&D Beyond host access and a browser signed in to the same D&D
Beyond account that owns the selected character (otherwise nothing is read or
written).

## Who can connect

The manifest's `externally_connectable` lets only these pages open a port:

```json
{ "matches": ["https://*.ts.net/*", "http://127.0.0.1/*", "http://localhost/*"] }
```

`localhost` and `127.0.0.1` match every port. Reachability is not consent. The
worker additionally refuses (disconnects) a port unless:

- the port name is exactly `character-share`;
- the sender is a top-level page in a tab (`frameId` 0; iframes are refused);
- `sender.origin` equals the origin of `sender.url`;
- the origin is `https:`, or `http:` on `127.0.0.1`/`localhost`.

The user approves exact origins (`scheme://host[:port]`). Approvals are stored in
extension storage: `sharedOrigins` (the approved origins, unchanged from v1) and
`sharedScopes` (`{origin: {sheet, rolls, write}}`). An approved origin without a
`sharedScopes` entry, such as every v1 approval, is identity-only. The popup lists
approved sites under **Shared with websites**, each with **Sheet**, **Rolls** and
**Changes** toggles and **Stop sharing**.

## Messages

Connect with the fixed extension ID:

```js
const port = chrome.runtime.connect('abeakpcagojpphodembeeajfjgmcadnc', { name: 'character-share' });
```

### Extension to page

#### `state`

```json
{ "type": "state", "version": 2, "approved": true,
  "scopes": { "identity": true, "sheet": true, "rolls": true, "write": false },
  "selected": { "id": "123456789", "name": "Mira", "details": "Level 5 · Elf · Wizard 5" },
  "helper": "ready", "revision": 2, "relay": { "state": "listening" } }
```

| Field | Meaning |
| --- | --- |
| `approved` | `true` once the user chose **Share** for this exact origin |
| `scopes` | What the origin may currently do; all `false` until approved |
| `selected` | `null` until approved and while no character is selected; otherwise exactly `{id, name, details}` |
| `selected.id` | Canonical decimal D&D Beyond character ID (string) |
| `selected.name` | Character name, at most 256 characters; display it as text, never as HTML |
| `selected.details` | For example `Level 5 · Elf · Wizard 5`, or `""`; at most 256 characters |
| `helper` | Windows helper state: `ready`, `connecting` or `unavailable` (informational; sharing does not need it) |
| `revision` | Starts at 1 for each connection and increases whenever `selected` changes |
| `relay` | `{state, detail?}` of the roll relay: `off` (no `rolls` scope or no character), `listening`, `no_campaign` (the character is not in a D&D Beyond campaign), `unavailable` (for example `detail: "connecting"`, `"reauth_required"`, `"permission_required"`, `"account_mismatch"`) or `error` (for example `detail: "closed_1006"`). `detail` is a short code for display and diagnostics |
| `retry_after_ms` | Optional. Present only on a state sent in reply to a `request_access` that was not prompted (cooldown or prompt limit); milliseconds until asking again can open a window |

Pages must ignore fields they do not know, and must accept a state that carries
`retry_after_ms` as an ordinary state.

A state is sent immediately after the worker has checked the origin's approval,
after every access decision (even when the state is unchanged), and whenever the
visible data changes: approval, scopes, the selected character, its
name/details, the helper state or the relay state. Otherwise identical
consecutive states are not repeated. Nothing about the character is sent before
approval.

#### `sheet` (`sheet` scope)

```json
{ "type": "sheet", "character_id": "123456789", "revision": 2, "sheet": { "...": "see Sheet" },
  "portrait": "data:image/webp;base64,..." }
```

- Sent after connecting, every 20 seconds while at least one port of an origin
  with the `sheet` scope is open, after every `apply`, and after `refresh`. There
  is one shared poll per selected character, fanned out to all eligible ports.
- Identical consecutive sheets (ignoring `fetched_at`) are not repeated to a port.
- `revision` is the port's state `revision` when the sheet was sent, so a sheet
  can be matched to the `selected` character it belongs to. A state with that
  revision is always sent first.
- `portrait` is included in the first sheet a port receives for a character and
  whenever it changes; otherwise it is `null`. It is a WebP (or JPEG, if WebP
  encoding is unavailable) data URL of at most 128 px and under 90 KB, produced by
  the extension, or `null` when the character has no usable portrait.

#### `roll` (`rolls` scope)

```json
{ "type": "roll", "character_id": "123456789",
  "roll": { "roll_id": "c3c1…", "label": "Longsword", "to": "everyone", "advantage": null, "initiative": false,
    "at_ms": 1763900000000,
    "rolls": [{ "type": "to hit", "kind": "", "notation": "1d20+6",
      "dice": [{ "sides": 20, "values": [14], "keep": "all" }], "constant": 6, "total": 20 }] } }
```

| Field | Meaning |
| --- | --- |
| `roll_id` | D&D Beyond's roll ID. Dedupe by it: the same roll may be sent more than once |
| `label` | The action, for example `Longsword`; ability checks/saves (`str`…`cha`) become `Strength`…`Charisma`. Plain text |
| `to` | `everyone` (rolled to the campaign) or `dm` (rolled to the DM). Rolls to self are never relayed |
| `advantage` | `advantage`, `disadvantage` or `null`, from the first d20 roll |
| `initiative` | `true` when the label is `Initiative` |
| `at_ms` | Time of the roll (from D&D Beyond when available), ms since the epoch |
| `rolls[].type` | `to hit`, `damage`, `check`, `save`, `heal` or `roll` (other D&D Beyond types such as `spell` or `recharge` become `roll`; damage-type names become `damage`) |
| `rolls[].kind` | `""`, `advantage`, `disadvantage` or `critical hit` |
| `rolls[].notation` | Dice sets joined with `+` plus the constant, for example `2d20+3`; keep-highest/lowest is in `dice[].keep`, not in the notation |
| `rolls[].dice[]` | `{sides, values, keep}`; `keep` is `all`, `highest` or `lowest` |
| `rolls[].constant`, `total` | Integers; `total` is D&D Beyond's result |

The last 30 seconds of relayed rolls are kept in `chrome.storage.session` and
re-sent to ports that (re)connect, so a page or worker restart does not lose them.

#### `applied`

`{"type": "applied", "op_id": "...", "state": "verified"|"rejected"|"conflict"|"unknown", "reason": string|null}`
is the reply to `apply`:

| `state` | Meaning |
| --- | --- |
| `verified` | The change was made and read back from D&D Beyond, or the character was already in the requested state |
| `conflict` | `expected` HP did not match the current HP (`reason: "expected_hp_changed"`); nothing was written |
| `rejected` | Nothing was changed. `reason` includes `scope` (no `write` scope), `character` (not the selected character), `rate`, `invalid`, `hp_unavailable`, `account_mismatch`, `permission_required`, `reauth_required`, `read_failed`, `storage_unavailable`, or `dndbeyond_rejected` (D&D Beyond refused the write) |
| `unknown` | A write was sent but could not be confirmed (`reason` such as `readback_mismatch`, `network`, `timeout`, or `interrupted` when the worker restarted during the write). Read the next sheet before deciding anything else |

### Page to extension

Exactly these shapes are accepted. Any other shape (and therefore any message
over 1 KB) or more than 10 messages in one second disconnects the port before it
is processed further.

- `{ "type": "request_access" }`
- `{ "type": "refresh" }` — asks for a fresh sheet; at most once per 5 seconds per
  origin, otherwise (and without the `sheet` scope) ignored.
- `{ "type": "apply", "op_id": "<1-40 of A-Z a-z 0-9 _ ->", "character_id": "<id>", "op": "damage" | "heal" | "temp", "amount": <int 0..1000000>, "expected": {"current", "maximum", "temporary"} | null }`
  (`expected` may be omitted; `temp` sets temporary HP to `amount`; `damage`/`heal` need `amount` ≥ 1)
- `{ "type": "apply", "op_id": "...", "character_id": "<id>", "op": "condition", "condition": 1..15, "on": true|false, "level": 1..6 | null }`
  (when turning a condition on, `level` is required for exhaustion, condition 4, and must be `null` for the others, else `rejected`/`invalid`; it is ignored when turning a condition off and may be omitted when `null`)
- `{ "type": "apply", "op_id": "...", "character_id": "<id>", "op": "death_saves", "success": 0..3, "fail": 0..3 }`

#### `request_access`

- Approved with every scope: ignored (the current state already says so).
- Not approved, or approved but missing a scope: the extension opens, or focuses,
  one approval window per origin. It shows the exact origin, the selected
  character and a checkbox per scope (identity is always included; sheet, rolls
  and changes start ticked). For an approved origin it is an upgrade: it lists
  what is already shared and marks the new scopes, with **Update sharing** and
  **Keep current**. The chosen scopes replace the origin's scopes. The decision is
  delivered to every open port of that origin.
- After **Don't share** / **Keep current**, or after the window is closed without a
  decision, further `request_access` messages from those ports are ignored, and
  the origin has a 15 second cooldown that also applies to new ports. A new port
  that asks during the cooldown gets the current state with `retry_after_ms` and
  no window. The refusal is not remembered after the cooldown.
- At most 3 approval windows are opened per origin per minute, and at most 3
  approval windows are open at once across all origins. Requests over these
  limits get the current state with `retry_after_ms`. Repeated requests while a
  window is open refocus it at most every 2 seconds.
- A decision counts only when it comes from the approval page inside the popup
  window the extension created for that origin.

#### `apply`

- Requires the `write` scope (else `rejected`, `scope`) and `character_id` equal to
  the selected character (else `rejected`, `character`).
- Idempotent per `op_id`: the outcomes of the last 200 operations are kept in
  `chrome.storage.session` and a repeated `op_id` returns the stored outcome
  without applying again. Operation IDs are scoped to the origin. Rejections
  that happen before anything is sent to D&D Beyond (`scope`, `character`,
  `rate`, `invalid`, failed reads) are not stored, so the same `op_id` can be
  retried. An operation interrupted by a worker restart reports `unknown`
  (`interrupted`) and is never applied again.
- At most 20 applies per origin per minute (`rejected`, `rate`).
- HP operations use the same verified read-back as the local API (`/hp/damage`,
  `/hp/heal`, `/hp/temporary`): temporary HP absorbs damage first, healing stops at
  the maximum, and `expected` guards against concurrent changes (`conflict`).
  Conditions and death saves read the current value first and report `verified`
  without a write when the character is already in the requested state; otherwise
  they write and verify the field in a fresh read.
- Writes are never retried automatically.

## Sheet

Every key is always present. Numbers are integers; unknown values are `null`;
every string is plain text (HTML tags removed). The whole sheet JSON stays under
90 KB (the longest lists are shortened if needed).

```json
{ "summary": "Level 5 · Human · Paladin 5", "level": 5, "ac": 18, "initiative": 1, "proficiency": 3, "speed": "30 ft.",
  "inspiration": false, "hp": { "current": 38, "max": 45, "temp": 4 },
  "passives": { "perception": 13, "investigation": 10, "insight": 13 },
  "abilities": [{ "key": "str", "score": 16, "modifier": 3, "save": 3, "save_proficient": false }],
  "skills": [{ "name": "Perception", "ability": "wis", "modifier": 3, "proficient": true, "advantage": false, "disadvantage": false }],
  "attacks": [{ "name": "Longsword", "to_hit": 6, "damage": "1d8+3", "damage_type": "Slashing", "range": "Reach 5 ft.", "notes": null }],
  "spells": [{ "name": "Command", "level": 1, "to_hit": null, "save_dc": 14, "save_ability": "wis", "damage": null, "prepared": true,
    "school": "Enchantment", "casting_time": "1 action", "range": "60 ft." }],
  "spell_slots": [{ "level": 1, "used": 1, "max": 4, "pact": false }],
  "conditions": [{ "id": 4, "level": 2 }], "death_saves": { "success": 0, "fail": 0 }, "fetched_at": 1763900000000 }
```

Limits: abilities 6, skills 40, attacks 60, spells 300, spell slots 10,
conditions 15.

Sources. The sheet is built from the v5 character
(`GET character-service.dndbeyond.com/character/v5/character/<id>`) and the
computed sheet (`POST character-service-scds.dndbeyond.com/v2/characters`).

| Field | Source |
| --- | --- |
| `hp` | Computed `hitPointInfo`, only when it agrees with the v5 `removedHitPoints`/`temporaryHitPoints` (the same rule as the local API's verified HP); otherwise `null` |
| `ac`, `initiative`, `proficiency`, `level`, `passives` | Computed `armorClass`, `initiativeBonus`, `proficiencyBonus`, `level`, `passivePerception`/`passiveInvestigation`/`passiveInsight` |
| `speed` | Computed `speeds[]` entry named Walking (or the only entry) |
| `abilities` | Computed `abilities[]` (`score`, `modifier`, `save`); `save_proficient` from v5 race/class/background/feat proficiency modifiers (`<ability>-saving-throws`) |
| `skills` | Computed `skills[]`; `proficient` is proficiency or expertise; `ability` from the standard skill list |
| `attacks` | Computed `attacks[]`; `damage` only when it matches `\d+d\d+([+-]\d+)*` or `\d+`; `notes` is the save DC and ability when present |
| `spells` | v5 `classSpells` and `spells.{class,race,background,feat,item}`; to-hit and save DC from the computed `castingInfo` of the spell's class; granted (non-class) spells and cantrips count as prepared |
| `spell_slots` | v5 `spellSlots`/`pactMagic` for `used`; `max` from the class spell-slot tables (multiclass: caster level and the standard table), `null` when it cannot be determined |
| `conditions`, `death_saves`, `inspiration`, `summary` | v5 `conditions`, `deathSaves`, `inspiration`, race and classes |

The computed-sheet field names beyond HP come from open-source D&D Beyond
parsers, not from a published contract; any missing or differently shaped field
becomes `null`. If the computed sheet is unavailable, its fields are `null` and
`hp` is `null`.

The portrait comes from the v5 `decorations.avatarUrl` on `www.dndbeyond.com` or
`media.dndbeyond.com` only. It is fetched without cookies, at most 3 MB, raster
images only (never SVG), decoded and re-encoded by the extension, and cached per
URL. `fetch` cannot inspect intermediate redirects, so the extension checks the
starting and final URL against the allowlist.

## Roll relay

With the `rolls` scope and at least one such port open, the worker connects to
D&D Beyond's game log as the signed-in player:
`wss://game-log-api-live.dndbeyond.com/v1?gameId=<campaign>&userId=<user>&stt=<token>`,
where the campaign is the selected character's v5 `campaign.id` and the token is
a freshly minted D&D Beyond cobalt token. It sends only `{"data":"ping"}` every
20 seconds (which also keeps the worker alive), reconnects with backoff of up to
30 seconds, and closes the socket when the last port with the `rolls` scope
closes. It relays only `dice/roll/fulfilled` events whose entity is the selected
character, and only rolls sent to the campaign or to another user (the DM).

This relay uses an undocumented D&D Beyond service and has not been verified
against it from an extension worker (the service may, for example, refuse the
extension's origin). Failures are reported in `relay.state`/`relay.detail`; they
never affect the other scopes.

## Revocation, reloads and restarts

**Stop sharing** immediately stops publishing to the origin, sends
`approved:false` to its open ports and disconnects them, then saves the removal.
A later connection from that origin starts unapproved again.

Turning a scope off in the popup takes effect immediately and is then saved. If
it cannot be saved, sharing with the site stops completely, as with Stop
sharing, rather than keeping the old scopes. Turning a scope on that cannot be
saved changes nothing; if even restoring the previous value fails (so storage may
hold the new scope), sharing with the site stops in the same way. Stop sharing
also closes an approval window still open for that site, and scope changes in
the popup update an open window's "Currently shared" line.

If a removal cannot be saved, the site stays stopped and stays listed in the
popup as **Stopped — not saved** with **Retry** and an error. The extension
retries every 15 seconds. A pending-revocation marker is written first to
`chrome.storage.session`, so a service-worker restart keeps the site stopped and
retries the removal. Approvals, scope changes and revocations are written one at
a time from the last saved state; a failed write is rolled back and never left in
storage. If a rollback also fails, the site is treated as stopped and unsaved in
the same way. If extension storage cannot be read, nothing is shared and nothing
is written.

Limitation: session storage is cleared when the browser fully restarts or the
extension is reloaded or updated. If saving keeps failing until then, a site the
user stopped could be listed as shared again afterwards. The same applies to the
stored `apply` outcomes and the roll buffer.

Reloading or updating the extension disconnects every port. Chrome may also
stop the MV3 service worker when it is idle, which disconnects ports as well.
Pages should reconnect with backoff; approvals and the selection are stored, so
the first state after reconnecting is already current. If `chrome.runtime` is
missing, or the port disconnects at once with "Receiving end does not exist",
the extension is not installed or is disabled, or the page's origin is not in
the list above (desktop Chrome or Brave is required).

## Minimal page

```html
<p id="who">Looking for the D&amp;D Beyond extension…</p>
<button id="ask" hidden>Share my character with this site</button>
<pre id="hp"></pre>
<script>
const EXTENSION = 'abeakpcagojpphodembeeajfjgmcadnc';
let port = null, delay = 1000;
const seen = new Set();
function connect() {
  if (!globalThis.chrome?.runtime?.connect) { who.textContent = 'Install the extension in desktop Chrome or Brave.'; return; }
  try { port = chrome.runtime.connect(EXTENSION, { name: 'character-share' }); } catch { return retry(); }
  port.onMessage.addListener(m => {
    if (m?.type === 'state' && m.version === 2) {
      delay = 1000;
      ask.hidden = m.approved && m.scopes.sheet && m.scopes.rolls && m.scopes.write;
      who.textContent = !m.approved ? 'Not shared with this site.'
        : m.selected ? `${m.selected.name} ${m.selected.details}` : 'Choose a character in the extension.';
    } else if (m?.type === 'sheet' && m.sheet.hp) {
      hp.textContent = `HP ${m.sheet.hp.current}/${m.sheet.hp.max}`;
    } else if (m?.type === 'roll' && !seen.has(m.roll.roll_id)) {
      seen.add(m.roll.roll_id); console.log(m.roll.label, m.roll.rolls.map(r => r.total));
    }
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; who.textContent = 'Extension disconnected; reconnecting…'; retry(); });
}
function retry() { setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); }
ask.onclick = () => port?.postMessage({ type: 'request_access' });
connect();
</script>
```

The identity is self-reported by the player's browser. A site that needs
stronger guarantees must not treat it as authentication.

## Changes from v1

- `state` now has `version: 2`, `scopes` and `relay`; pages written for v1 that
  require `version === 1` must be updated.
- New `sheet`, `roll` and `applied` messages and the `refresh` and `apply`
  requests.
- The approval window has scope checkboxes and an upgrade mode; v1 approvals keep
  working as identity-only.
- The popup lists each site's scopes with toggles.
- Extension version 1.2.0 adds host access to `www.dndbeyond.com/avatars/*` and
  `media.dndbeyond.com` for portraits.
