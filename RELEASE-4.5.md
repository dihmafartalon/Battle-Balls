# Battle Balls 4.5: the Jbob & Jdog Pack (unreleased)

Packages:
- `battle-balls-server-4.5.zip`: the Worker and Durable Objects (no `node_modules`, no `.wrangler`).
- `battleballs-site-4.5.zip`: `index.html`, `privacy.html`, and the two existing trailers (`rap_trailer.*`, `afterhours_trailer.*`).

The trailer cut to "About The Money" is a separate file for you only. It is **not** in either package, because the song is not ours to ship.

## What changed

Next week's pack is fully built, but switched off. Players can't see it, buy it or roll it. The only way anyone gets the items is an admin gift.

| Area | Client (`site/index.html`) | Server (`server/`) |
|---|---|---|
| The pack | `PACKS.jays`: 1,800 yen, slotted for Oct 22–29 Pacific, the week after After Hours. `off:true` hides the stand and the trailer popup. The stand look (`PACK_LOOK.jays`) is ready. | `CAT.packs.jays.off` is set, and the `pack` act refuses a pack that is off. |
| Rarity | Every item is `rarity:"secret"`, so it shows as UNRELEASED: hidden in the inventory until owned, worth 0, never in chests or bot loadouts. | Already excluded from chests, the Limited stall, selling, trading and save imports. |
| Jbob | Skin: dark hair swept across, chunky black glasses, a grey henley. | Catalog regenerated. |
| Jdog | Skin: a shaggy mop, thin silver glasses, a toothy grin, a black 73 tee. | |
| Blue Blaze | Jbob's weapon: a blue fireball in each fist (`hold:"orbs"`). Each swing throws from the other hand. The alternation rides the existing Dev2 BOTH sync (`phStep`/`phTake`, the `pa` field), so everyone in the room sees the same hand. Each throw launches a cosmetic fireball that bursts at the end of its run. | Sim rebuilt. |
| The Moak Slayer | Jdog's weapon: a massive pink greatsword. It has a heart pommel, winged guard, and a glowing fuller with MOAK SLAYER cut into it. At rest it sits up over the shoulder. The swing is one motion: up and straight down, with a cracked heart on the floor, two shockwaves, a pink pillar and hearts rising. | None. |
| Power Surge | Emote, 4.4 s. Fists clenched, charge up: a gold aura, rubble lifting, lightning. The hair goes gold at 2.55 s and it all goes off at 2.85 s. On Jbob his own hair swaps for the gold and his eyes turn teal. Anyone can use it. | Taunts already pass through. |

Every swing is a single motion with one step. No damage, hitbox, parry window or balance number changed; every effect is cosmetic.

`VERSION` stays `4.4`, so nobody gets a What's New screen about a pack they can't see.

## Releasing it later

1. Remove `off:true` from `PACKS.jays` and set `from`/`to` if the week changes.
2. On the five items, change `rarity:"secret"` to `"mythic"`, add `event:"pack"` to the four skins/blades, and give the skins and blades `yen:330` / `yen:345` like the other packs.
3. Run `npm run build` and `npm test` in `server/`, then bump `VERSION`.

## Setup / migration

1. Server first: unzip, run `npm install`, then `npx wrangler deploy`. There are no new bindings and no migration.
2. Then upload the site zip's files to Pages.

No save format changes. Accounts and saves are untouched.

## Tests run (all local)

- `npm test` in `server/`: all suites pass. The new `jbob & jdog pack` tests check:
  - The pack is never sold while off, before, during or after its week, and nothing is taken.
  - The items are UNRELEASED and worth 0.
  - They never drop from chests.
  - A gifted one can't be sold.
  - The emote isn't a default emote.
  - The After Hours Pack is unaffected.
- Headless browser (SwiftShader):
  - Today, the popup and the stand are still After Hours.
  - On Oct 25 there is no stand and no popup.
  - Unowned, the items are hidden in the inventory. Once gifted, they show with the UNRELEASED tag and their icons.
  - No page errors.
- Mesh counts per fighter (Low/Medium/High), measured during the emote:
  - Jbob: 145/146/164.
  - Jdog: 181/186/204.
  - For comparison, the Headless Horseman is 207/212/230.

## Not verified here

- Real phones and iPads (frame rate is not measured).
- Online play between two real clients. The alternating hands use the same network field as Dev2 BOTH, which is already shipped.
