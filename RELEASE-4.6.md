# Battle Balls 4.6: three more for the Jbob & Jdog Pack (still unreleased)

Packages:
- `battle-balls-server-4.6.zip`: the Worker and Durable Objects (no `node_modules`, no `.wrangler`).
- `battleballs-site-4.6.zip`: `index.html`, `privacy.html`, and the existing `rap_trailer.*` and `afterhours_trailer.*`.

The recut trailer (cut to "About The Money") is a separate file for you only, and is **not** in either package.

## What changed

The pack from 4.5 now has five people in it. It is still switched off (`PACKS.jays.off`), and every item is still UNRELEASED: no stand, no popup, no sale, and the only way to get the items is an admin gift.

| Item | What it is |
|---|---|
| Zandeezy (skin) | A big messy mop of golden blonde swept up and over, darker at the roots, and a big grin. A black tee with white type down the chest. |
| Big Onion 1 (skin) | Tight brown curls with the ears out, and braces in the grin. The head is lifted onto a long neck. A black tee. |
| Smg (skin) | Thick dark curls piled high, heavy brows, the widest grin, and a cream tee. |
| Demon Yart (Zandeezy's) | A giant crimson-and-gold pen with horns on the cap and a glowing nib. One diagonal stroke writes a red line through the air, and a demon's face looms out of it over a red sigil on the floor. |
| Dutro Cannon (Big Onion 1's) | A big pink hand cannon held at the hip. Each swing kicks back and fires a pink ball that goes off in a white blast. A parry also blows up white right on the ball (`SWORD_PARRY_FX`, cosmetic). |
| Ramp Tesla Cam (Smg's) | A little white electric car held by the bumper. It is swung overhead and grows the whole way down, landing the size of a real car with glass, sparks, dust and a horn. It shrinks back after, and is put back to toy size if a swing is cut short. |

Other changes:
- Jbob and Jdog got the same face clean-up: skin under the eyes, and shirt shoulders that cover the base collar.
- Every swing is one motion with one step.
- No damage, hitbox, parry window or balance number changed; every effect is cosmetic.
- `VERSION` stays `4.4`, so there is no What's New screen.

## Releasing it later

1. Remove `off:true` from `PACKS.jays` and set `from`/`to` if the week changes.
2. On the eleven items, change `rarity:"secret"` to `"mythic"`.
3. Add `event:"pack"` to the ten skins and blades.
4. Give the skins `yen:330` and the blades `yen:345`, like the other packs.
5. Run `npm run build` and `npm test` in `server/`, then bump `VERSION`.

With eleven items you may want a new price: it is still 1,800 yen.

## Setup / migration

Server first: unzip, run `npm install`, then `npx wrangler deploy`. Then upload the site zip's files to Pages. There are no new bindings, no migration and no save changes.

## Tests run (all local)

- `npm test` in `server/`: all suites pass. The pack test now covers all ten skins and blades plus the emote:
  - Never sold while off.
  - Unreleased and worth 0.
  - Never in chests.
  - Can't be sold when gifted.
- Headless browser: renders of each character and each swing, with no page errors.
- Mesh counts per fighter (Low/Medium/High):

  | Fighter | Low | Medium | High |
  |---|---|---|---|
  | Zandeezy | 116 | 118 | 136 |
  | Big Onion 1 | 136 | 137 | 165 |
  | Smg | 132 | 132 | 162 |
  | Headless Horseman (for comparison) | 180 | 185 | 203 |

## Not verified here

- Real phones and iPads (frame rate is not measured).
- Online play between two real clients.
- The Ramp Tesla Cam reaches about 9 units long at the hit. It is cosmetic and changes nothing about the parry, but on a small map it can clip through walls for a moment.
