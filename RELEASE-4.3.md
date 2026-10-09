# Battle Balls 4.3 — the Halloween Pass to level 100, Grey's 14 Inches fixed

Packages:
- `battle-balls-server-4.3.zip` — the Worker + Durable Objects (no `node_modules`, no `.wrangler`)
- `battleballs-site-4.3.zip` — `index.html`, `privacy.html`, `rap_trailer.mp4`, `rap_trailer.jpg`

**Nothing here has been deployed to production.**

## What changed

| Area | Client (`site/index.html`) | Server (`server/`) |
|---|---|---|
| Halloween Pass | 100 levels. 1–50 cost 100 XP each (unchanged); from 51 a level costs 150 XP, +4 each level (346 at 100). Buying a level past 50 costs 350 yen. Every yen reward is 100 at most. Ends the last second of Oct 31, Pacific. | Level costs come from `CAT.pass.xpAt` (total XP per level) and `yenPer2`; `passbuy` gives exactly one level and keeps progress into the next; pass tiers can give an emote. |
| New pass items | The Monster + Tesla Coil (60), Werewolf + Silver Moon (70), Mummy + Bone Saw (80), The Count + The Wick (90); emotes BOO! (55), BRAINS... (75), TOIL & TROUBLE (85), WITCHING HOUR (100) | Catalog regenerated: the new items are pass-only (never in chests, the Limited stall, or for sale) |
| Grey's 14 Inches | Anyone in the wave's lane is carried ~9 units and popped up (it used to be undone by the next frame's steering). New curling-wave mesh. No ability casts during the countdown. | The sim (rebuilt) grants the carried player movement grace, so the server never corrects them |

## Setup / migration

1. **Server first:** unzip over your server folder, then `npm install`, `npx wrangler deploy`. No new bindings, no new migration.
2. **Then the site:** upload `battleballs-site-4.3.zip`'s files to Cloudflare Pages as before.

Saves are preserved. A save at level 50 stays at level 50 (the first fifty levels cost exactly what they did) and carries on from there. Rewards already paid are never paid again or taken back.

To move the end date: `PASS.end` in `site/index.html`, then `npm run build` in `server/` and redeploy both.

## Tests run (all local)

- `npm test` in `server/`: all suites pass, including the new `pass 51-100` tests. These check level costs, old level-50 saves, buying one level with progress kept, 200 vs 350 yen, every new item and emote granted, nothing past 100, no XP past the top, and no pass item in chests or for sale.
- Grey's wave on the server sim: a player carried by the wave gets no movement corrections.
- Headless browser: a match plays with no errors, the wave carries a bot about 7–17 units, the pass screen and inventory render, and buying a level past 50 costs 350 yen and grants the BOO! emote.

## Not verified here

- Real devices and real accounts (all tests used local mocks and SwiftShader).
- Frame rate of the Witching Hour emote on low-end iPads. It scales its bats and lanterns down on Low and Medium quality.
