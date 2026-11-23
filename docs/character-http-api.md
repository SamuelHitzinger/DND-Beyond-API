# D&D Beyond Character API v1

A documented localhost HTTP API for any application on this Windows PC or Mac. The
extension owns D&D Beyond login and the remembered character choice. The helper
app only relays requests between local apps and the browser. No game or SDK
is required. See [installation](character-extension.md) and the complete
[OpenAPI 3.1 specification](character-http-api.openapi.json).

## Connect from any language

Read `%LOCALAPPDATA%/TabletopVR/character-bridge/v2/http.json` (Windows) or
`~/Library/Application Support/TabletopVR/character-bridge/v2/http.json` (macOS;
folder 0700, file 0600) for `url` and `token`.
Send `Authorization: Bearer <token>` on every request, including `/openapi.json`.
The URL uses `http://127.0.0.1:<dynamic port>`; reload the file after the browser
reconnects. The local bearer is not the D&D Beyond token. Keep it private.
The API is available while the browser and extension are running. It accepts
connections from this PC only; ordinary web pages are not granted CORS access.

```powershell
$api = Get-Content "$env:LOCALAPPDATA/TabletopVR/character-bridge/v2/http.json" -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($api.token)" }
$status = Invoke-RestMethod "$($api.url)/v1/status" -Headers $headers
$sheet = Invoke-RestMethod "$($api.url)/v1/character" -Headers $headers
```

The included CLI is `character-api.exe GET /v1/character/summary` on Windows and
`./character-api GET /v1/character/summary` on macOS (from the package folder). Exit0 means
success; exit1 means an HTTP/error/rejected/conflict result, exit4 means an unknown
outcome, and exit64 means usage error. The package
also includes dependency-free Python and PowerShell examples in `examples/`.

## Selection and common endpoints

| Method | Route | Result |
| --- | --- | --- |
| GET | `/v1/status` | `{browser:"connected", selected:{id,name} or null, characters:[id]}` |
| GET | `/v1/characters` | The authorized selected-ID array and `selected` metadata |
| GET | `/v1/account/characters` | Refresh account listing; `{characters:[{id,name,details}]}`; does not select a new character |
| GET | `/openapi.json` | Complete embedded API contract, available even before character selection |

The user chooses a character in the extension, not by enrolling each application.
This choice is remembered across browser restarts. All apps with the local bearer
may read and edit it without per-edit prompts. Access stays active automatically for the remembered character.
Refresh in the extension after switching DDB accounts; a refreshed different
account or an unavailable character clears the previous choice.

`/v1/character` and every `/v1/character/<suffix>` resolve the selection once per
request and include `characterId` in the response. Without a choice, they return
HTTP409 `no_character_selected`. For several related calls, pin `selected.id`
and use `/v1/characters/<id>/<suffix>`. Explicit IDs must still match the
selected character; switching selection revokes the old ID. Account discovery
returns active account characters; deleted and subscription-locked sheets are
excluded. The DDB account ID and login credential are never returned.

## Character routes

Prefix each suffix below with `/v1/character` or `/v1/characters/<id>`.

| Method | Suffix | JSON body / result |
| --- | --- | --- |
| GET | `/summary` | `{summary:{name,vitals:{current,maximum,temporary},observed_at_ms,capabilities,...}}` from fresh v5 + SCDS; unavailable/inconsistent HP is null |
| POST | `/hp/damage` | `{amount:6, expected?:{current,maximum,temporary}}`; temporary HP absorbs damage first, current HP clamps at zero |
| POST | `/hp/heal` | `{amount:4, expected?:{current,maximum,temporary}}`; clamps current HP at maximum, preserves temporary HP |
| POST | `/hp/temporary` | `{value:8, expected?:{current,maximum,temporary}}`; absolute temporary HP, including zero |
| GET | *(none)* | `{character: <fresh v5 character>}` |
| GET | `/inventory` | `inventory` and `customItems` |
| POST | `/inventory` | `entityId`, `entityTypeId`, `quantity` (default 1); optional `containerEntityId`, `containerEntityTypeId`; result includes `itemIds` |
| DELETE | `/inventory/<itemId>` | Remove item; `removeContainerContents` is false |
| PUT | `/inventory/<itemId>/quantity` | `{quantity: 2}` |
| PUT | `/inventory/<itemId>/equipped` | `{value: true}` |
| PUT | `/inventory/<itemId>/attuned` | `{value: true}` |
| PUT | `/inventory/<itemId>/container` | `{containerEntityId, containerEntityTypeId}` |
| GET / PUT | `/currency` | Read currencies / set any of `cp`, `sp`, `ep`, `gp`, `pp` to absolute nonnegative values |
| GET | `/spell-slots` | `spellSlots` and `pactMagic` |
| PUT | `/spell-slots/<level>` | `{used: 1}`; level 1â€“9; service validates the counter (raw v5 `available` is not computed capacity) |
| PUT | `/pact-slots/<level>` | `{used: 1}`; separate pact-magic counter, level 1â€“9 |
| PUT / DELETE | `/conditions/<conditionId>` | Apply/remove; exhaustion uses `{level: 1}` |
| GET / PUT | `/inspiration` | `{inspiration: true}` |
| GET / PUT | `/xp` | `{currentXp: 123}` |
| GET / PUT | `/death-saves` | `{failCount: 0, successCount: 0}` (0â€“3 each) |
| GET / PUT | `/notes` | Any of `allies`, `personalPossessions`, `otherHoldings`, `organizations`, `enemies`, `backstory`, `otherNotes`; strings, null normalized to empty string |
| GET / PUT | `/prepared-spells` | List class spells / `{id, characterClassId, prepared: true}` using mapping IDs from the read |
| GET / PUT | `/limited-use` | List actions with counters / `{id, entityTypeId, uses: 1}`; number or decimal-string action IDs accepted |
| GET / POST | `/custom-items` | List / create `{name, quantity: 1, description?, weight?, cost?, notes?}` |
| PUT / DELETE | `/custom-items/<id>` | Update supplied fields preserving others / remove |
| GET / POST | `/custom-actions` | List / create `{name, actionType: 3}` (weapon 1, spell 2, general 3) |
| PUT / DELETE | `/custom-actions/<id>` | Update action properties / remove; name updates live-verified, other properties follow the public bundle contract |
| POST | `/rests/short` | `{classHitDiceUsed?: {"<class mapping id>": used}, resetMaxHpModifier?: false}`; omitted counters preserved; no automatic hit-die healing |
| POST | `/rests/long` | `{resetMaxHpModifier?: false, adjustConditionLevel?: false}`; DDB resets resources and HP |
| GET / POST | `/rolls` | Read SCDS roll catalog / compute a local roll (below) |
| POST | `/request` | Generic authenticated character-service request (below) |

## Local rolls

`GET .../rolls` returns fresh SCDS abilities, skills, attacks and initiative bonus.
`POST .../rolls` accepts `kind`: `ability`, `save`, `skill`, `attack`, `damage`,
`initiative`, or `dice`. Select a catalog entry by `name` (case-insensitive, unique)
or zero-based `index`; abilities also accept their short labels such as `DEX`.

```json
{"kind":"skill","name":"Stealth","advantage":"advantage","bonus":2}
```

`advantage` is `auto` (default), `normal`, `advantage` or `disadvantage`.
Auto uses SCDS skill flags; opposing flags cancel. Other situational advantages,
bonus dice, effects and feature choices must be supplied by the caller. The
optional integer `bonus` adjusts the modifier. Damage uses the selected attack's
SCDS dice; `critical:true` doubles dice, preserving the fixed modifier. Unsupported
formulas return an error instead of a guessed result. Explicit dice use, e.g.,
`{"kind":"dice","expression":"2d6+3-1d4"}` (addition/subtraction, max 100 dice).

Results contain individual dice, modifier, total, source and fetch time. Randomness
uses browser crypto. Rolls do not consume slots, apply damage, determine hits or
post to a game log (`posted:false`). SCDS can be unresolved; that returns an error.

## Generic request

```json
{"method":"PUT","path":"/character/v5/inventory/item/quantity","body":{"id":123,"quantity":2}}
```

The worker supplies its browser-only bearer credential and defaults `characterId`
in object mutation bodies. A path may be relative to character-service or an
absolute HTTPS URL on `character-service.dndbeyond.com` or
`character-service-scds.dndbeyond.com`. Caller headers, cookies and redirects are
not supported. The response includes the upstream HTTP `status` and parsed `data`.
Character source responses are private; store and log them accordingly.


## Results and errors

HTTP200 alone is not a successful mutation. Inspect `state`:

| State | Meaning |
| --- | --- |
| `verified` | Typed operation matched a fresh read-back; HP routes also check SCDS consistency |
| `acknowledged` | Generic service write returned success; no verification claim |
| `rejected` | Service refused the request, or HP was unavailable/inconsistent |
| `conflict` | Optional expected HP did not match the fresh pre-read; nothing was written |
| `unknown` | A write may have happened, but its outcome/read-back could not be established |

Never automatically retry or invert an unknown write. Read fresh state and decide
whether a new action is appropriate. Calls are serialized per character. Writes
are not durable receipts and are not replayed after browser/native disconnects.
HP no-ops return the already fresh verified summary without a redundant write.

Errors use `{error:"code"}`: HTTP400 for invalid input, 401 for the local bearer,
403 `character_not_allowed`, 404 `route_not_found`, 409 `no_character_selected`,
422 for unsupported/unavailable roll modifiers, 502 for service/read failures,
and 503 when the browser is unavailable. Possible writes interrupted by the
local transport return `{state:"unknown",reason:"browser_unavailable"}`. DDB
sign-in failures require sign-in in the browser; no terminal login is supported.

Inventory item IDs are mapping IDs, distinct from catalog definition IDs. The
character's container entity type is `1581111423`. Standard mutation objects in
`/request` default `characterId`; callers remain responsible for other or nested
identifiers. Both allowed HTTPS service hosts are listed in OpenAPI.

Rest `verifiedFields` lists the returned HP, slots, conditions, classes and action
counters compared with fresh v5; it does not certify every D&D rest rule.
Meaningful warlock pact consumption and broad custom-action properties have not
been live-verified. Rolls are local and never post to the DDB game log.

## Source development

The independent source projects are `backend/character-api` and
`backend/character-api-cli`. Use `tools/build-character-api.ps1`,
`tools/check-character-api.ps1` and `tools/package-character-api.ps1`; development
needs Windows x64, which also builds the macOS packages with
`-Runtime osx-arm64` or `-Runtime osx-x64`.
`tools/build-character-api.ps1 -ReloadExtension` stages the new helper, pauses
the existing native connection, copies only after it exits and reconnects.
`tools/reload-extension.ps1` sends the local development endpoint
`POST /dev/reload-extension` exactly once; it never retries a character write.
This development endpoint is not part of the public v1 integration contract.

Upstream request shapes were checked against the publicly served
[character app](https://media.dndbeyond.com/character-app/static/js/main.4ccf1602.js)
and its [source map](https://media.dndbeyond.com/character-app/static/js/main.4ccf1602.js.map).
DDB controls these private upstream services; a service change can require an
extension update. No public DDB API guarantee is implied.
