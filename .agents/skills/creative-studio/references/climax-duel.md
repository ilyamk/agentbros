# Climax duel

Last updated: 2026-11-13

The film's climax against the reference's, frame by frame, before anything else is judged. A climax is most of what a viewer remembers, so it is checked first and in the most detail. Method after ReelMimic's critic and director prompts (MIT, © 2026 ReelMimic contributors; see `CREDITS.md`).

**Advisory.** The duel informs the look and the `referenceMatch` score. It is not a floor or a gate, and it does not block approval by itself. `film:measure`'s `climax-shape` leg measures the same thing and only warns. Without a reference there is no duel.

## Where the climax is

Both sides are measured by the same tension curve (`src/lib/film/tension.ts`, [reference analysis](../../../../docs/reference-analysis.md#climax-shape)). The climax is the peak in `tension.peaks[]` with the largest `prominence × height`. Each peak has `timeSec`, `breathSec` and `breathDepth` (the dip before the hit), `riseFrames`, `holdSec`, `decaySec` and `beatOffsetFrames` (negative means before the beat).

- **Reference, for the design director**: `film-targets.json` `measuredFrom.climaxTimeSec`, `climaxBreathSec`, `climaxHoldSec`, `climaxRiseFrames`, `climaxBeatOffsetFrames`, and the `climax` ranges a render should meet.
- **Both sides, for the critic**: `evidence.json` in your own two packs, `<pack-dir>/evidence.json` for the film and `<pack-dir>-reference/evidence.json` for the reference. Both come from one instrument, so you need no sensor report.

The duel window on each side runs from 2 s before the breath (`timeSec − breathSec − 2`) to 1 s after the hold (`timeSec + holdSec + 1`).

## Design director: the signature frame against the reference's hit

1. Find the reference's hit frame at `measuredFrom.climaxTimeSec`. Take it from the picture analysis reads: if `source.json` has a `crop`, use `media/analysis-*.mp4`, otherwise use `media/source.*`. Extract it with `ffmpeg -ss <climaxTimeSec> -i <media> -frames:v 1`.
2. Render the signature frame at finished quality, with the real material, light and type. Place it beside the reference frame at the same height (`hstack`) as `pipeline/look/climax-vs-ref.png`. Open the result.
3. Compare subject size, frame density, light, colour impact and what the eye lands on. **If ours is clearly weaker, keep working**: enlarge the subject, add density or light, recompose. Do not hand over a signature frame that loses.
4. Write one line in the signature frame's `frames[].climaxNote`: what already wins and what still loses.
5. Plan the hit on the beat when the reference's is on the beat (`climax.beatOffsetFrames`). Plan a breath when the reference has one (`climax.breathDepth`), and a hold at least as long as `climax.holdSec` asks.

## Critic: the duel strip

1. Read the film's climax and the reference's climax from the two packs' `evidence.json`.
2. Build the strip with the reference above and ours below. Pass the reference directory so the cropped picture is used:
   `pnpm motion:strip --input <render> --output <pack-dir>/climax-vs-ref.jpg --start-sec <ours from> --end-sec <ours to> --vs <reference dir> --vs-range <ref from>:<ref to> --diff`
3. Open it and compare row against row:
   - **Build**: how tension is stacked in picture, camera and sound.
   - **Breath**: whether the film holds still or quiet before the hit, and for how long.
   - **The hit frame**: composition, subject size, density, colour.
   - **Hold and exit**: how long the hit is held and how it is left.
   - **Sound landing**: the loudness lift around each `timeSec`, from each pack's evidence.

   You cannot hear, so judge sound only from these numbers.
4. Give a verdict of `ours-better`, `equal` or `ref-better`, with a concrete reason. Record it in two places:
   - a `framesReviewed` entry for the strip, with `timeSec` set to our hit;
   - the `referenceMatch` note, beginning `climax duel: <verdict>`.
5. On `ref-better`, add an action that names what to add for the film to win. Be concrete about the technique, the frames and the size, for example: `frames 212–228: hit lands with no breath -> fix: 10 frames of hold at 0.4 opacity before 228, subject from 35% to 70% of frame height`. Even on `ours-better`, every weakness your reason names (subject too small, breath too long, nothing to look at after the hit) becomes an action. All of these count within the cap of seven ranked actions.

The duel adds no cap of its own. It shows in the score only through `referenceMatch`, which uses the scale the critic already applies.
