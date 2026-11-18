---
name: reference-replica
description: Reproduce a specific reference video as closely as possible, shot for shot, with the same timing, camera moves, eases, colour, typography and mechanics, changing only what the user asks. Use only when the user explicitly asks to copy, replicate or remake a given film exactly; "in the style of" is reference-to-video.
---

# Reference replica

The film is the reference again, measured and rebuilt to the frame, with only the content the user names swapped. Precision is the job: every shot, cut, move, ease, colour and type size comes from a measurement or a frame you opened, never from a feel. For a film that only borrows a reference's craft, use [reference to video](../reference-to-video/SKILL.md) instead; its rule that four of six axes must differ does **not** apply here.

Existing approval, budget and no-spend instructions take precedence. Measuring costs nothing.

## Loop

Run it as the film chain's `replica` route, so every approval point is the user's: `pnpm film:init --project <project> --type replica --product <film>`, then repeat `pnpm film:next --project <project>` and do what it says ([production chain](../../../docs/production-chain.md#the-replica-route)). Its steps are this loop: `rights`, `replica-reference`, `replica-spec`, `music`, `audio-map`, `material`, `build`, `sound`, `replica-compare`, `human`. A one-off fix to an existing replica is a quick edit outside the chain.

1. **Rights gate** (`rights`). Before anything else, ask the user who owns the reference and what the replica is for, and record their words with `pnpm film:rights --project <project> --status <owned|licensed|study-only> --answer "<their words>"`. Without a stated right to publish, the replica is a private study.
2. **Ingest and measure** (`replica-reference`). `pnpm ref:add --file <film> --id <ref> --rights <status> --rights-note "<user's words>"` (or `--url`), check `source.json` `crop` (rerun with `--crop W:H:X:Y` or `--crop none` if the picture box is wrong), then `pnpm ref:analyze --id <ref>` with every layer. The `reference-analyst` agent writes the judged layers, per [reference analysis](../reference-analysis/SKILL.md); `edit.json` `corrections` fix the detector's shot list.
3. **Replica spec** (`replica-spec`). One row per corrected reference shot: [replica spec](references/replica-spec.md). Swap only the content the user named. `pnpm ref:replica-check --project <project> --write-shots` until `passed`; it also writes `replica-shots.json`. The user approves the spec and every swap.
4. **Music, material, build and sound.** The user chooses the track (another owner's music and voice are replaced); the swaps' media are sourced at `material`. Library blocks first (`pnpm library:list`, [motion library](../motion-library/SKILL.md)); new code only for what no block can show, with each block's props set to the spec's numbers rather than its defaults, code in `src/projects/<project>/` ([compositions](../../../src/components/AGENTS.md)). The route has no strategy, ideas, concept, script, look, beat sheet or animatic.
5. **Measure and fix** (`replica-compare`, then the fixer), below, until within tolerance or out of rounds.
6. **Hand over** (`human`) to the user with the residual list. They judge sound and taste and approve.

## Rights gate

| The user says | `--rights` | What may ship |
|---|---|---|
| It is their own film | `owned` | Everything, after the content swap they asked for |
| They hold a licence to remake it | `licensed` | As the licence allows; quote it in `--rights-note` |
| Anything else, or no answer | `study-only` | Nothing: the replica stays private and is never published |

Whatever the status, the brand, logos, characters, mascots, copy, voice and music of **another owner** are never copied: they are replaced with the user's or with licensed material, and the replacement is a row in the spec. Music follows reference-to-video's route: `music --action from-reference --reference <ref>` is study-only, and only the user's own statement (`--rights owned|licensed --rights-note "<their words>"`) opens delivery. Product interfaces inside the replica are the user's real product, 90–100% identical, recorded or rebuilt per [real UI](../../../docs/real-ui.md); never a redraw of the reference's app. Record the rights answer in the spec's `rights` block as well as in `source.json`.

## Measure and fix

Each round (the chain's `replica-compare` runs the first command, after `film:render`):

```bash
pnpm ref:compare --id <ref> --render out/<project>/film.mp4 --render-shots public/projects/<project>/pipeline/replica-shots.json --tolerance replica --project <project>
pnpm motion:strip --input out/<project>/film.mp4 --output out/qa/<project>/r<N>-<shot>.png --start-sec <a> --end-sec <b> --step 1 --diff --vs design-reference/library/<ref> --vs-range <ra>:<rb>
```

- Pass the spec's own shot list as `--render-shots`, so pairing does not depend on the detector, and `--tolerance replica --project <project>`, so findings are at the [tolerances](references/replica-spec.md#tolerances), pair against the corrected shots and leave swapped shots' colour alone (`exempt`).
- Fix `compare.json` `findings[]` in severity order: every `major`, then `minor`, alignment and cuts before timing, timing before camera, camera before colour. A fix that moves a cut moves every later shot: re-measure before the next fix.
- Then read `summary.withinTolerance`: every `failed` is a finding above, and every `notMeasured` (camera without uv or a fitted move) is checked by strip instead. Without `--tolerance replica` the thresholds are for "in the style of" and far too loose here.
- Strip with `--vs` every shot that has a finding, every camera move, every transition and the climax, and look. Numbers point; the strip shows what is wrong.
- Findings are a fix list, not a score. No single number (`palette.meanDistance`, `look`, `motion.correlation` or any style distance) gates the replica, and none says it is good.
- Climax targets from `pnpm film:targets --reference <ref> --project <project>` and `film:measure`'s `climax-shape` leg are advisory: use them to find a flat build, never as a pass.
- Stop when no measure in `summary.withinTolerance` has `failed` and the strips agree, or after **5 rounds**. At the limit, report each residual with its shot, numbers and strip to the user and ask whether to continue.
- Record each round in the spec's `rounds[]`: what was fixed, the compare file, what remains.

## What agents cannot judge

Agents cannot hear: never claim the music, mix or sync sounds right; state the measured offsets and let the user listen to `compare/side-by-side.mp4` (reference left ear, replica right). Likeness of taste, feel and performance is the user's call. A replica within every tolerance is measured close, not approved.

## When a mechanism is out of reach

Mark the shot `unreachable` in the spec with the nearest equivalent and its measured residual, tell the user, and don't fake it. Routes beyond React: [engine selection](../engine-selection/SKILL.md), [Blender](../blender-3d/SKILL.md) (ask first), real footage, or generated material by estimate with consent.
