# Battle Balls 4.8: the Jbob & Jdog Pack is out

Packages:
- `battle-balls-server-4.8.zip`: the Worker and Durable Objects (no `node_modules`, no `.wrangler`).
- `battleballs-site-4.8.zip`: `index.html`, `privacy.html`, `rap_trailer.*`, `afterhours_trailer.*`, and the new `jays_trailer.mp4/.jpg`.

## What changed

| Area | Client (`site/index.html`) | Server (`server/`) |
|---|---|---|
| The pack | `PACKS.jays` is on: 1,800 yen, Oct 22 00:00 to Oct 29 00:00 Pacific, starting the moment After Hours closes. The stand sells it, and its trailer takes over the popup. | Catalog regenerated. `off` is gone, so the existing `pack` act sells it: window checked, no double purchase, all-or-nothing. |
| Items | The 6 skins, 6 blades and 2 emotes are now mythic pack items, priced like the other packs (`yen:330` skins, `yen:345` blades). Each description ends "From the Jbob & Jdog Pack." | Pack items stay out of chests, the Limited stall and selling. |
| Trailer | `jays_trailer.mp4` (1:18, 720p, 13 MB) and `jays_trailer.jpg`. Same picture as your cut, with an **original** beat at the same tempo so every hit still lands. The cards now read "out now". | None. |
| What's New | `VERSION` is `4.8`. The update screen leads with the pack. | None. |

The `off` switch is still supported (`curPackKey`, the trailer popup and the server all honour it) for building the next pack.

## Music

The in-game trailer does not use "About The Money"; that song stays in your own copies only. The popup's track is synthesized: A minor, Am F C G, and an original bell hook. Its drops, quiet section and build-up land on the same beats as the picture.

## Setup / migration

1. Server first: unzip, run `npm install`, then `npx wrangler deploy`. There are no new bindings and no migration.
2. Then upload the site zip's files to Pages, **including the two new `jays_trailer.*` files**.

Saves are untouched. Anyone who was gifted items while they were unreleased keeps them, and the stand shows those as owned.

## Tests run (all local)

- `npm test` in `server/`: all suites pass. The `jbob & jdog pack` test now checks:
  - The window is Oct 22 07:00 to Oct 29 07:00 UTC, and the pack is not on sale before or after it.
  - It costs 1,800 yen, gives all 14 items, and can't be bought twice.
  - With too little yen, nothing is taken and nothing is given.
  - All 12 skins and blades are mythic and never drop from chests.
  - The emotes are not default emotes.
  - After Hours is closed by then.
- Headless browser:
  - On Oct 24, desktop (1280×800) and phone (390×844):
    - The popup plays `jays_trailer.mp4`.
    - The stand sells the pack.
    - Buying takes 1,800 yen and grants all 14.
    - The buy button becomes "You own all of it".
  - On Oct 30 there is no stand and no popup.
  - No page errors.

## Not verified here

- Real phones and iPads (frame rate is not measured).
- Online play between two real clients.
- How the new music sounds: its levels were checked by measurement only.
