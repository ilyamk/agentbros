# sound-director: worked examples and notes

Moved out of `.agents/agents/sound-director.md`. Adapted from lemo-opuscar DIRECTOR.md §6 and TECHNIQUE.md §6 (MIT, © 2026 LemoLab), motion-video-kit audio.md (MIT, © 2026 echris6), brag audio.md (MIT, © 2026 Shunit Haviv Hakimi) and video-use SKILL.md (MIT, © 2026 Browser Use).

## Before searching (music step)

Write down: what the track must do (where the film rests, turns, ends); the dynamics wanted (tempo band, loudness range, energy rise, clean final hit); what rules a track out (vocals under on-screen text, a long intro on a hard opening, a corporate ukulele, a decay that dies before the end card).

## Music step: full commands

- free stock: two or three searches from different angles, `pnpm music --action search --project <id> --route free-stock --query "<sound words>" --mood "<words>" --min-duration <s> --commercial`; with a tempo or shape in the brief add `--bpm <n> --duration <s> --drop-at <s> --intro quiet --ending hard --analyse` and report each `fit` (measured BPM, start offset, level before and after the drop, cut on a downbeat). A loop shorter than the cue can become one with `--action stitch` (marked stitched; `--start` sets where the loop begins in the source). Then `pnpm music --action shortlist --project <id> --from <a.json,b.json> --top 3 --brief "<sentence>"`.
- generated: run only when the brief holds the user's words choosing it **and** accepting your estimate (takes × `--max-cost-usd`). Otherwise write the plan, report the estimate, stop. Then `pnpm generate:music --composition-plan <plan.json> --output <dir>/music/take-1.mp3 --project <id> --operation-id <stable-id> --max-cost-usd <agreed>`; resume ambiguous failures with the same id. On HTTP 402 from ElevenLabs Music, run the same plan through fal: add `--provider fal --model fal-ai/elevenlabs/music`, `--dry-run` first for the quote.

## Step sound: commands and levels

- Cue sounds first: list the placed library blocks (`{fps, durationInFrames, blocks:[{id, startFrame, props}]}` from the motion plan) and run `pnpm sfx:cues --placements P.json --pack public/projects/<id>/assets/sfx/synth --output pipeline/sound-cues.json --plan-output pipeline/sfx-plan.json` (render that pack first, below). Each block's `cues(props)` gives the frames; sound lands on the picture frame (whoosh peak and riser end included). Gains: hero 0.25–0.35, support 0.08–0.2. Budget: one riser and one sub-drop or impact per ~15 s; read `dropped` and keep what the idea needs. Continuous motion stays silent. The scene plays the same events with `<CueSounds events>` from `src/motion/sync`.
- Hero sounds by comparison, before `sfx:cues`: with `earshot-bank` prepared, render a seeded take or two per hero kind (`sfx:synth --engine earshot --kind <kind> --seed <n>`), then `pnpm sfx:audition --project <id> [--earshot-takes <receipts>]` ranks each hero cue's candidates (takes, library, pack) by fit and Earshot's advisory audit into sfx-selection.json; pass it to `sfx:cues --cue-sheet … --selection`. Quote each `reason` as measurement, not hearing. A reference's sfx-map.json (`sfx:map`) gives its sounds per minute by family: a starting density, not a target.
- Tonal sounds in the film's key: `pnpm sfx:synth --project <id> --key <root>` (all kinds: a project pack without a kind drops its cues); a riser ending on frame F of a cue at least L frames in: `--kind riser --length-frames L`. Sounds by shape and description: `pnpm sfx:find --text "<what it sounds like>" --kind <kind> --duration <s>` ranks the measured collection (`public/shared/sfx/<kind>/`) by CLAP similarity and measured fit; `sfx:cues` already picks from it by fit to each cue; add `--project <id>` so the chosen sounds are copied into the project with their provenance (credit CC BY ones); pass `--no-library` when tonal kinds (chime, glass, riser, sub-drop) must stay in the film's key from the project's synth pack. Material sounds: `pnpm sfx:library --action find --query "<material, weight>" --duration <s> --limit 5`; import each with `asset:import`, keep licences. `pnpm audio:describe --input <file>` gives CLAP moods and tags as a proxy, never as a verdict. Paid SFX needs the same consent.
- Back-time the ending with `pnpm music:backtime` (brief's command); prefer moving a cut to chopping music; if the offset changes from the cue sheet's, stop and report.
- Mix: `mix-plan.json` strictly follows `LocalAudioMixSchema` (src/types/audio-master.ts), `version: 1`; `targetLufs` from film-targets within -24..-9, `truePeakDb` ≤ -1.5 for review; social delivery is `--preset social` (−14 LUFS / −1.5 dBTP). Music ducks under speech no deeper than `duckDb` (default −9; −6 gentle, −12 for dense VO); ducking for foley and silences via music `keyframes` (50–200 ms ramps). Merge the cue sounds with `sfx:cues --merge mix-plan.json --plan-output mix-plan.json`.
- `audio:mix` and `audio:analyze` take the paths only; never pass `--project` too. Social delivery is `--preset social` (−14 LUFS / −1.5 dBTP). `metadata.duck` reports the median dip and the bed under the voice.

## The excerpt the user chose

The shortlist fit proposes a 30 s excerpt starting at 9.25 s of a 4-minute track, ending on a downbeat. Record with `--start 9.25 --duration 30`: the decision's `cut` names `music/cue.wav`, and the audio map, the script's sections and the review all read that 30 s cut. Recording only the candidate leaves later steps fitting words to the whole track.

## Reading a candidate's audio map

| Read | Compare with | Tells you |
|---|---|---|
| `tempo.bpm`, `gridTrust` | Reference tempo, median shot | Cuts on the grid, or pacing by phrases (`weak`/`none`) |
| `sections[].level`, `feel` | The idea's rest and turn | Whether the track has a shape |
| `keyMoments`, `silences` | Planned turn and ending | A real stop or surge to cut to |
| `energyCurve` | Loudness range target | Flat = wall of sound; early decay = empty end card |
| Ending | End card | A clean final hit can be back-timed; a fade cannot |

## Candidate description (three lines, user's language)

> Track B, 2:14, CC BY. The map shows a quiet first 40 s, one strong surge at 0:41 and a hard stop at 1:58, with weak grid trust. If we start at 0:30, the surge lands on the turn at 0:11 of the film and the ending has to be back-timed. I cannot tell whether it sounds cheap or whether the melody annoys you: listen at 0:35 to 0:50.

## Generated-music plan

One section per part of the film, durations summing to its length; starts on the first beat; a resolved final chord at the start of the last section, then rings out. Describe measured grammar (tempo, kick pattern, density, ending), never brands or artists. Reject takes with a near-silent intro or early decay.

## Sound table example

| Section, times | Ambience | Foley (action, material) | Music | Silence or transition |
|---|---|---|---|---|
| 0.0–2.1 office at dawn | Fridge hum, faint street | Sticker slipping: paper scrape. Hit on desk: dull wood | Out | J-cut: warehouse air from 1.6 |
| 2.1–2.6 the turn | None | None | Out | Planned silence, 0.5 s |
| 2.6–6.0 warehouse | Large room, forklift far off | Bag drop: soft crunch, grains after | In on the first sound after the silence | L-cut: grains over the cut |

Bad designs: a click on every interface change; a whoosh on every cut; one sting at the end; music at one level with effects on top.

## Mix mapping (`LocalAudioMixSchema`, src/types/audio-master.ts)

| Idea | In the plan |
|---|---|
| Foley on a frame | `startSec` from frame and fps; one track per placement, `role: "sfx"` |
| Ambience | `role: "sfx"`, `loop: true` if needed, low `volume`, `keyframes` for fades |
| J-cut | next ambience starts 0.3–0.8 s before the cut, keyframe ramp up |
| L-cut | last source runs past the cut via `sourceEndSec`, ramping down |
| Duck under speech | `duckMusic: true` (reacts only to `role: "speech"`) |
| Duck under foley, planned silence | `keyframes` on music, film seconds, 50–200 ms ramps |
| Loudness | `targetLufs` from film-targets within -24..-9, `truePeakDb` ≤ -1.5 |

## Closing note to the user (example)

> Measured: -14.2 LUFS, range 4.8 LU, peak -1.6 dBTP. Silences at 2.1–2.6 and 18.0–18.4 measure below -50 LUFS. I placed 14 sounds on 31 events. I cannot hear, so these are unjudged: whether the paper scrape at 0:01 sounds like paper, whether the room at 0:03 feels real, and the balance at the turn. Listen to 0:00–0:05 and 0:17–0:20 first.
