# Battle Balls 4.4: After Hours Pack, The Architect, signature swings for the pass blades

Packages:
- `battle-balls-server-4.4.zip`: the Worker and Durable Objects (no `node_modules`, no `.wrangler`).
- `battleballs-site-4.4.zip`: `index.html`, `privacy.html`, `rap_trailer.mp4/.jpg`, `afterhours_trailer.mp4/.jpg`.

**Nothing has been deployed or merged.**

## What changed

| Area | Client (`site/index.html`) | Server (`server/`) |
|---|---|---|
| After Hours Pack | `PACKS.afterhours`: 1,800 yen, Oct 15 00:00 to Oct 22 00:00 Pacific (it opens the moment the Rap Pack closes). Dreddy and Fluffles (mythic skins), the Nightshift Axe (mythic blade) and System Failure (emote). The stand takes its look from a per-pack theme table (`PACK_LOOK`). | Catalog regenerated. Purchase is the existing server-authoritative `pack` act: window checked, no double purchase, all-or-nothing. |
| Trailer popup | Packs marked `teaser` take the popup first, so the After Hours trailer replaces the Rap Pack's now. The Rap Pack's trailer is still on its stand's WATCH THE TRAILER button. The popup also re-checks ownership before it shows. | None. |
| Dreddy / Fluffles | Built over the standard body, so every run, swing, parry and emote pose still drives them. Each has a head pivot, a jaw, and individually curling fingers. Fluffles' ears are three-section spring chains: they bounce on the stride, swing out on turns, flop forward on hard stops and twitch independently at idle. Idle actions are scheduled at random and fade out whenever the fighter moves, swings or emotes. | Sim rebuilt. |
| Nightshift Axe | Held in both hands at rest (`HOLD.axe2`, with the left hand on the shaft). Two-handed `axefire` swing with fire, sparks, smoke and a scorched floor mark. Small spark burst on a successful parry (`SWORD_PARRY_FX`, cosmetic only). | None. |
| Inspect | New bind INSPECT WEAPON (V): lift the blade and look it over. The axe's edge flares. It travels as a taunt, so everyone in the room sees it. | Taunts already pass through without an ownership check, so no change. |
| System Failure | 5.6 s: freeze, head snap and arm twitches, collapse, spasms on the floor, snap upright, final twitch. Static, clicks and glitch sparks, and the animatronics' eyes flicker. The pose only: position, collision and hitbox are untouched. Walking off cancels it, as with every emote. | None. |
| Pass blades | Signature swings: Tesla Coil (`teslarc`, chain lightning), Silver Moon (`moonfall`, rising moon, claw marks), Bone Saw (`sawrip`, cursed eye), The Wick (`wickfire`, ring of fire, fire jet). | None. |
| DEV skin | Rebuilt as The Architect: a monitor head with a live face, floating brackets, a wireframe core, orbiting code panels, a cape of falling code and voxel boots. | None. |

No damage, hitbox, parry window, swing timing or balance number changed. Every effect is cosmetic.

## Setup / migration

1. Server first: unzip, run `npm install`, then `npx wrangler deploy`. There are no new bindings and no migration.
2. Then upload the site zip's files to Pages, including the two new `afterhours_trailer.*` files.

Saves are preserved: the only new save key is the `inspect` bind, and only if someone rebinds it.

## Tests run (all local)

- `npm test` in `server/`: all 17 suites pass. New `after hours pack` tests check:
  - The pack can't be bought before Oct 15 07:00 UTC or after Oct 22 07:00 UTC.
  - It costs 1,800 yen, grants all four items, and can only be bought once.
  - The items stay owned after the pack closes.
  - With too little yen, nothing is taken and nothing is given.
  - The Rap Pack is unaffected.
  - None of the items drop from chests.
  - The emote is not a default emote.
- Headless browser (SwiftShader):
  - The popup today plays the After Hours trailer ("opens in 5 days").
  - On Oct 17 the stand sells After Hours, buying grants all four items, and the buy button disappears afterwards.
  - On Oct 23 there is no stand and no popup.
  - Desktop (1280×800) and phone (390×844) layouts.
  - The inventory shows the new skins, axe and emote.
  - System Failure cancels cleanly when you walk off, and the fighter never moves during it.
  - A normal match runs with no errors.
- Mesh counts per fighter: Dreddy and Fluffles have 193 meshes on Low (claws, wires, ribs and springs dropped), against 181 for the Headless Horseman. They have 227 on Medium and 245 on High.

## Not verified here

- Real iPads and phones (frame rate is not measured, only mesh counts).
- Online play between two real clients (the network path is the existing taunt and swing messages).
- Heat distortion on the axe was not done: it would need a post-processing pass the renderer does not have. The heat is suggested with embers and smoke instead.
- Inspect has no touch button yet (keyboard only).
