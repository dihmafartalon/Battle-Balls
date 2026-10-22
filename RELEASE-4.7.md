# Battle Balls 4.7: Ricky joins the Jbob & Jdog Pack (still unreleased)

Packages:
- `battle-balls-server-4.7.zip`: the Worker and Durable Objects (no `node_modules`, no `.wrangler`).
- `battleballs-site-4.7.zip`: `index.html`, `privacy.html`, and the existing `rap_trailer.*` and `afterhours_trailer.*`.

Ricky's own trailer is a separate file for you only, and is **not** in either package.

## What changed

The pack now has 13 items. It is still switched off (`PACKS.jays.off`), and every item is still UNRELEASED: no stand, no popup, no sale, and the only way to get them is an admin gift.

| Item | What it is |
|---|---|
| Ricky (skin) | Tight dark curls falling over the forehead, a small closed smile, and a black polo with the collar out and buttoned up. |
| The Hog (Ricky's blade) | A big octopus tentacle, made as a chain of 11 joints with suckers down the inside. At rest it sways and curls. In a swing it lags behind the hand and cracks through like a whip, with a wet slap, an ink splat on the floor and spray. One motion, one step. |
| Cammy (emote, 4.2 s) | A little black car pops up around you, and you sit in it with your hands on the wheel. You look round, the headlights come on, and you spin it in a donut with tyre smoke and skid marks, then it's gone. It's a pose only: the fighter never moves. The weapon hides while both hands are on the wheel, and the speech bubble is tucked away during the spin so it doesn't read backwards. |

No damage, hitbox, parry window or balance number changed; every effect is cosmetic. `VERSION` stays `4.4`.

## Releasing it later

Same steps as in RELEASE-4.6.md:

1. Remove `off:true` from `PACKS.jays`.
2. Change the 13 items from `secret` to `mythic`.
3. Add `event:"pack"` and the `yen` values.
4. Rebuild, run the tests, and bump `VERSION`.

## Setup / migration

Server first: unzip, run `npm install`, then `npx wrangler deploy`. Then upload the site zip's files. There are no new bindings, no migration and no save changes.

## Tests run (all local)

- `npm test` in `server/`: all suites pass. The pack test now covers every skin and blade, including Ricky and The Hog, plus both emotes:
  - Never sold while off.
  - Unreleased and worth 0.
  - Never in chests.
  - Can't be sold when gifted.
- Headless browser: renders of Ricky, The Hog and Cammy, with no page errors. After the emote ends, the car is removed and the weapon is visible again.
- Mesh counts for Ricky holding The Hog (Low/Medium/High): 181/181/211. The Headless Horseman is 180/185/203, so High is slightly heavier because of the tentacle's joints.

## Not verified here

- Real phones and iPads (frame rate is not measured).
- Online play between two real clients.
