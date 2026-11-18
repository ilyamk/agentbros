# Locations: plates and light

Tiers and dates: [legend](../SKILL.md#references). Profile limits: `pnpm refs:profiles --action show --family F`.

## Prepare

- A wide plate of the place (`plate-wide`), plus a reverse angle (`plate-reverse`) when the shot list cuts both ways and a medium plate when framing is tighter.
- One plate per lighting state: day and night, dusk and interior lamp light are separate plates (`lighting:<state>` or `plate:<state>` views, or a forked card). Light and time of day bake into the result.
- Empty plates unless people are part of the place: background people in a plate leak into the shot as extras.
- A role sentence that limits the plate: "take only the place and the light", never "this scene".
- A video reference of the place is restricted to camera or action in its role sentence, or the motion reference rewrites the setting.
- For true multi-angle consistency across many shots, a 3D proxy (see [previs-3d](previs-3d.md)) holds geometry better than more 2D plates.

## Specs and sources

- Give the setting its own reference and its own role sentence; restrict a video reference to camera or action, or it rewrites the setting — [O] [Dreamina reference inputs FAQ](https://dreamina.capcut.com/ai-video/ai-video-reference-inputs-faq), checked 2026-11-17.
- References taken from the same scene entangle identity with lighting and background — [P] [Phantom-Data, arXiv 2506.18851](https://arxiv.org/html/2506.18851v1), checked 2026-11-17.
- Location slots per profile (which families take a location image or video, and how many): `pnpm refs:profiles --action show --family F`; never assume a model takes a location reference because a sibling does.

## In our system

| Need | Card view role | Requirement role | Derivative |
|---|---|---|---|
| The place | `plate-wide`, `plate-medium`, `plate-reverse`, `plate:<id>` | `location` | `scale` or `crop` to the slot's edge and aspect limits |
| A light state | `lighting:<id>` | `lighting` | none; a new plate per state |
| The place in motion | a video asset | `location` on a video slot, or `camera` | `trim`, `strip-audio` |

- Declare `facts`: `containsOtherPeople`, `lighting`. Coverage warns on `noUnintendedPeople` and `onePlatePerLighting` (`src/lib/references/coverage.json`).
- `refs:plan` draft takes the first of `plate-wide`, `plate-medium`, `plate-reverse` (else a `plate:*` view) with the role sentence "the place and light of NAME, without its people".

## Failure modes

- A populated plate: extras appear, or the hero is replaced by someone in the plate.
- One plate for day and night: the light of the plate wins over the prompt.
- An establishing video as a location reference with no role limit: its camera move and action are copied.
- Copy-paste: the plate's exact framing reappears in every shot. Fix: ask for the shot's framing in the action and camera sentences, and attach the plate as place only.
