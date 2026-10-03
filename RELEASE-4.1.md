# Battle Balls 4.1 — setup, migration, tests and limitations

Packages:
- `battle-balls-server-4.1.zip` — the Worker + Durable Objects (no `node_modules`, no `.wrangler`)
- `battleballs-site-4.1.zip` — `index.html`, `privacy.html`, `rap_trailer.mp4`, `rap_trailer.jpg`

**Nothing here has been deployed to production.**

## What changed

| Area | Client (`site/index.html`) | Server (`server/`) |
|---|---|---|
| Ranked & match rewards | Solo ranked runs in a private server room when signed in; results show "pending" until the server confirms them, and stay pending (never a loss) across reloads | Room writes one settlement record per player per match id; the Vault settles each match id exactly once; retried by alarm (2s→10min backoff, 7 days); a client "match" claim pays nothing |
| Movement | Applies the server's `corr` correction | Host-side check against time, speed, jump height, bounds, ability grace; NaN dropped; one spike is free, only a sustained run is flagged (never banned) |
| Popups | Block move/jump/parry/ability/emote under any screen or popup; held input is cleared on open/close; online menus never pause the match | — |
| Lobby performance | Static decorations welded by material; Low drops beams/webs/rings and fog; distant effects animate at a lower rate | — |
| Boss Rally | New mode (Casual card, or a room's mode), practice offline | Server runs it in the room sim; pays per damage milestone + victory (no RP, daily cap) |
| Social | FRIENDS panel, top-right notifications, phone MENU | New `Hub` (per account) and `Party` Durable Objects, tags in `Directory`, seat reservations in `Room` |
| Tutorial | One minute, skippable, replayable from How to Play; no rewards | — |

## Setup / migration (in this order)

1. **Server first.** Unzip `battle-balls-server-4.1.zip` over your server folder (or replace it), then:

       npm install
       npm test          # optional: the whole suite, ~90s
       npx wrangler deploy

   `wrangler.toml` adds two bindings (`HUB`, `PARTY`) and migration **`v4`**
   (`new_sqlite_classes = ["Hub", "Party"]`). Wrangler applies it on deploy. It only
   *adds* classes: Room, Vault and Directory data — accounts, inventories, coins,
   yen, RP, cosmetics, settings — are untouched.

2. **Then the site.** Upload `battleballs-site-4.1.zip`'s files to Cloudflare Pages
   as before. Deploying the site before the server works too: the FRIENDS panel just
   says it is connecting, and Boss Rally practice still runs offline, until the
   server is up.

3. Check `https://<your-worker>/health` prints `ok 2026-10-03a`.

Saves are preserved: nothing in a save is renamed or removed. New save keys are
`tutDone`, `tutAsked` and `bossAbil` (Boss Rally's replacement ability); the
ids of matches still waiting on the server are kept with the cloud sign-in. Device-imported RP is no longer accepted by the server
(RP only comes from server-settled matches); existing server RP is kept.

Config lives in code constants if you want to tune it:
- Boss: `BOSS_CFG` in `site/index.html` (health `[6,8,10,12]`, guard 5, attack timing) and `BOSS` in `server/src/econ.js` (450 coins per 25% milestone, 1500 victory, 12 000/day cap). Rebuild the sim after editing the site (`npm run build` in `server/`).
- Social limits: `SOC` in `server/src/social.js` (message length 280, rate limits, invite TTL 2 min, seat hold 60 s, party size 6, Boss Rally 4).
- Movement: `MV` in `site/index.html`.

## Tests run (all local)

Server suite (`npm test` in `server/`), all passing:
- `test-econ` — settlement semantics, GOD rule, duplicates, mismatched modes, fast wins, coin caps, boss milestones, no reset farming, daily cap.
- `test-settle` — Room→Vault through in-memory Durable Objects: clean settle, failed writes kept and retried, lost answer never pays twice, restart delivery, forged claims pay nothing, `settle` unreachable from `/cloud`.
- `test-move` — on the real game sim: sprinting untouched, lag spike allowed, double jump fine, flying/teleport cut back, NaN dropped, arena edge, Dash grace, one flag only for a sustained run.
- `test-dir` — directory/lobby list.
- `test-social` — tags (unique, stable on rename), requests/decline/cancel/mutual/remove, presence only to friends with grace on reconnect and one "online" toast per real arrival, heartbeat timeout, DMs (friends only, control chars stripped, length cap, rate limit, paging, no access to others' threads, previews off), blocks enforced server-side, lobby invites authorised by the room with held seats counting toward 6, closed lobby / cancel / expiry / in-a-match, parties (6 max, Boss Rally max 4, ready, kick, leader transfer, idle drop, disband, invite expiry).
- `test-boss` — on the real game sim: health 6/8/10/12, ability swap rules, a full solo fight to victory (guard counts only player parries 1–5, three breaks, curves only from phase 2, attacks only in phase 3, never inside a recoil, ≥1.65 s warning, the dodging player never caught, ball speed never drops: 1.00→2.03), KO resets the guard and the next break revives the downed player, a full wipe loses.

Browser checks (headless Chromium + SwiftShader, local `wrangler dev`, a test-only dev login instead of Google):
- Two players: tag search → request accepted from the toast → host a room → INVITE TO LOBBY → JOIN puts the friend in that room; DMs both ways (markup shown as text); party invite/accept; Boss Rally started for the room and run by the server; presence reads "IN MATCH".
- Solo ranked on the server: match id issued, menu open does not pause (`paused=false`, clock ran 1.3 s), result shows "CONFIRMED BY THE SERVER" after settlement.
- Tutorial: block → miss → ability → done, 0 coins, no match counted.
- Popups: held W released when the shop opens, no movement/jump/block/ability under it, typing in a field doesn't move you, controls return when it closes, a popup over a match blocks the Block key.
- Layout screenshots: 390×844 and 844×390 phones, 1024×768 and 768×1024 iPad.

Lobby draw calls (`renderer.info.render.calls`, four fixed camera views, SwiftShader):

| Quality | Before | After |
|---|---|---|
| Low | 427 / 708 / 487 / 444 | 200 / 352 / 179 / 171 |
| Medium | 729 / 1008 / 784 / 733 | 333 / 490 / 317 / 308 |
| High | 789 / 1077 / 855 / 800 | 408 / 565 / 388 / 384 |

Boss Rally arena on Medium: ~135 calls.

## Not verified here — please check on real devices/accounts

- **Real Google sign-in.** All online tests used a test-only dev login against a local server. The social socket and settlement use the same session token path as before, but have not been exercised with real Google accounts.
- **Live latency.** Tests ran on one machine (~0–170 ms local). Parry timing, movement correction thresholds and Boss Rally attack warnings have not been tried over real school Wi-Fi.
- **Physical iPads / phones.** Draw-call counts are measured; real FPS is not. Layouts were checked by viewport size only.
- **Production Durable Objects behaviour** (hibernation, alarms at scale) is simulated with in-memory mocks and `wrangler dev`.

## Known limitations

- The boss is built from primitives (no concept image was attached); armour damage, recoil and debris are stylised.
- Boss returns don't add speed; only player parries climb the speed (the normal per-hit step). Nothing ever resets it inside a fight.
- Abilities that sit Boss Rally out: Blood Rift, Jordan, Switch, Ramen's Hair, Gravity Well, Doppelganger, Drone Strike, Guardian, Lightskin Aura, Grey's 14 Inches, Divine Judgment, Blade Toss, Pull, Cursed Aura. Other room members with one of these get a pick button in the room; if they don't pick, the server uses Dash for them.
- Friend search is by exact tag only (no name search, by design).
- Message history keeps the newest 400 per conversation per account.
- Party "bring to lobby" uses the leader's current room; there is no matchmaking queue for parties beyond that.
- If an invited friend is mid-match, the invite waits in their panel; it still expires after 2 minutes.
