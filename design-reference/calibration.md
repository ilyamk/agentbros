# Sensor calibration

Last updated: 2026-11-15

How far the film:measure legs can be trusted as gates, measured on the professional reference corpus (20 analysed references, one of them private and counted only in totals). Method and commands are in [reference analysis](../docs/reference-analysis.md#calibration); the signatures themselves are in the [slop catalogue](slop-catalogue.md). Rerun this when the corpus grows by a third or a leg changes.

Two questions, two rules:

- **False positives.** Every blocking leg fails at most 10% of professional references, each measured against corpus targets built without itself (leave-one-out).
- **Detection.** A sensor earns a gate on a degradation kind at accuracy 0.85 or more on 6 pairs or more (`judge:calibrate`, `eligibleGates`). A sensor eligible for none of the kinds it is meant to catch only warns, unless its kind does not exercise what it reads (said below).

## Corpus distributions used

A dated snapshot: judged cuts (`edit.json` corrections), `pnpm ref:corpus` on main at 2026-11-15, 20 references (19 with loudness):

| Metric | p10 | p25 | median | p75 | p90 |
|---|---|---|---|---|---|
| Median shot, s | 0.13 | 0.67 | 0.98 | 1.78 | 2.47 |
| Cuts a minute | 20.0 | 23.8 | 40.6 | 63.2 | 93.1 |
| Shot length variety (p90/p10) | 3.0 | 3.3 | 5.8 | 17.2 | 30 |
| Integrated loudness, LUFS | -16.8 | -15.4 | -14.1 | -13.0 | -12.2 |
| Cuts on beat, lift over chance | 0.40 | 0.71 | 1.0 | 1.38 | 1.48 |
| Cuts on downbeat within a frame, lift | 0 | 0 | 0.23 | 1.35 | 2.0 |

Read by film:measure on each reference's own media (cue cuts plus detector boundaries for the pixel legs):

| Reading | min | p10 | p25 | median | p75 | p90 | max |
|---|---|---|---|---|---|---|---|
| `motion-spread` share | 0.03 | 0.05 | 0.09 | 0.19 | 0.25 | 0.29 | 0.34 (0.39 on detector cuts only) |
| `fast-motion-sharp` share | 0 | 0 | 0 | 0.49 | 0.82 | 1.0 | 1.0 |
| True peak, dBTP | -6.0 | -3.2 | -1.8 | -0.2 | 0.25 | 0.42 | 0.8 |

Professionals mostly do not cut on the beat: a lift of 1.0 is what random cuts score.

## False positives

Fails out of 20 references (warns after the slash). "Judged" measures with the analyst's cuts, as a film with a cue sheet is measured; "detector" with the detector's cuts alone, as a film without one is. Legs never failing or warning on any reference are left out. The "before" columns were read on a library in which two references' `edit.json` did not yet parse (their judged cuts fell back to `shots.json`); the "after" columns on the corrected library.

| Leg | Detector, before | Judged, before | Detector, after | Judged, after |
|---|---|---|---|---|
| `shot-length-median` | 9 (45%) | 10 (50%) | 2 (10%) | 2 (10%) |
| `cuts-per-minute` | 10 (50%) | 11 (55%) | 3 (15%) | 2 (10%) |
| `shot-length-variety` | 2 (10%) | 3 (15%) | 0 | 1 (5%) |
| `loudness-integrated` | 3 (15%) | 3 (15%) | 2 (10%) | 2 (10%) |
| `motion-spread` | 1 (5%) | 0 | 0 | 0 |
| `fast-motion-sharp` | 8 (40%) | 5 (25%) | 0 / 9 warn | 0 / 5 warn |
| `cuts-on-audio` | 0 / 9 warn | 0 / 7 warn | 0 / 1 warn | 0 / 1 warn |
| `cut-to-beat-offset` | 0 / 7 warn | 0 / 6 warn | 0 / 1 warn | 0 / 1 warn |
| `audio-not-silent-throughout` | 1 (5%) | 1 (5%) | 1 (5%) | 1 (5%) |
| `true-peak` | 13 (65%) | 13 (65%) | 13 (65%) | 13 (65%) |
| `flash-risk` | 15 (75%) | 15 (75%) | 15 (75%) | 15 (75%) |

Why, and what changed:

- **Pace (median shot, cuts a minute).** The corpus targets were the middle half, p25 to p75, which fails half the references by construction. They are now a gate, p10 / 1.5 to p90 × 1.5 (`CORPUS_PACE_SLACK`), with the median shot's low side never above 0.1 s (`CORPUS_FASTEST_MEDIAN_SEC`: three professional films hold a judged median of three or four frames). The p25 and p75 stay in `measuredFrom` as the aim. The remaining fails are the two slowest films (paper-style, postiz: 4.3 and 3.7 s median shots, 10 and 13.5 cuts a minute, each outside a band drawn without itself). On detector cuts alone two more films fall under the cuts floor because the detector misses most of their cuts: pass a cue sheet.
- **Variety.** At least 0.75 of the p10 (between 1.5 and 3). One professional film is genuinely uniform (1.4) and still fails.
- **Loudness.** The p10 less 2 LU to the p90 plus 2, never narrower than -17 to -11 LUFS. Fails: one film mastered at -21 LUFS, one at -10.6 against a leave-one-out ceiling of -10.7.
- **motion-spread.** Ceiling 0.4: the p90 (0.29) plus the 0.1 slack a reference earns, clearing the busiest reference (0.39). Warns until eligible.
- **fast-motion-sharp.** The p90 is 1.0: no ceiling separates professional films, much professional motion design is rendered without blur. Now warns only.
- **Beat sync.** With a median lift of 1.0, corpus targets never ask for a lift; `cuts-on-audio` now passes off the grid instead of warning "these cuts ignore the music", and `cut-to-beat-offset` is read only when the targets or the film cut on the beat (lift 1.5 or more). Beat sync gates only when the chosen targets cut on their grid: a single reference whose own lift reaches 1.5.
- **Exempt, unchanged.** `true-peak` (-1 dBTP) is a delivery spec, and the references are platform re-encodes whose lossy audio raises inter-sample peaks; a render is a master. `flash-risk` is WCAG 2.3.1 and fails whatever professionals do; its reported stretches were read from the sensor's ranges, not checked frame by frame: one is a near-full-frame alternation 12 times in 2 s, several sit just over the area limit (0.12 to 0.21 of the frame against 0.111). 75% of professional films failing suggests the sensor may over-count on hard cuts between light and dark shots; worth a frame-level check, which would not change the gate. `audio-not-silent-throughout` fails a reference with no sound, as it should.

## True positives

The weak film the user judged (3.9 s median shot, no sound) is no longer on disk, so synthetic stand-ins were measured against full-corpus targets (git-ignored, `out/qa/calibration/true-positive/`):

| Film | Fails |
|---|---|
| Template slideshow: five 4 s holds of reference stills, 0.5 s linear crossfades, a centred title block, no audio | `audio-present`, `shot-length-median` (4 s), `shot-length-variety` (1.07), `cuts-per-minute` (11.7) |
| Sharp whole-frame drift: the same stills panned fast with no blur, five 4 s shots, no audio | `audio-present`, `shot-length-median`, `shot-length-variety` (1.0), `cuts-per-minute`, `motion-spread` (0.79), `flash-risk`; `fast-motion-sharp` warns (0.8) |
| motion:check slop fixtures (`SlopEntry`, `SlopCentred`, `SlopPalette`, `Strobe`), 1 s at 320×180 | `audio-present`, `cuts-per-minute` (one shot); `Strobe` also `flash-risk` and `motion-spread` (0.44) |

The slideshow's 11.7 cuts a minute sit just under the floor (13.3): the slowest professional films cut nearly as rarely, so its uniform lengths, long median and silence are what catch it surely. The slop fixtures' own signatures (simultaneous entry, centred text, palette) are motion:check's to catch on the composition, not film:measure's on pixels.

## Degradation accuracy

`ref:degrade --auto 3` on gojiberry, flex, postiz, muse, palmier and nexaa (18 segments of 3 s; palmier and nexaa cut on the beat), then `judge:calibrate`. Sharpness was resampled with the new step (below).

| Sensor | Kind | Pairs | Accuracy | Eligible |
|---|---|---|---|---|
| `shot-length-variety` | uniform-cuts | 14 | 1.0 | yes |
| `motion-spread` | stutter | 18 | 0.11 | no |
| `fast-motion-sharp` | stutter | 18 | 0.22 (on the first four references' 12 pairs: 0 before the step change, 0.25 after) | no |
| `cut-sound-coverage` | desync | 36 | 0.31 | no |
| `cut-sound-coverage` | soft-transients | 18 | 0.44 | no |
| `cuts-on-beat` (sync reading) | desync | 36 | 0.28 | no |
| `cuts-on-beat` | uniform-cuts | 18 | 0.39 | no |
| `cut-to-beat-offset` | desync | 36 | 0.47 | no |
| `motion-energy-contrast` (candidate) | linear-motion | 17 | 0.71 | no |
| `colour-saturation` (candidate) | flat-grade | 18 | 0.78 | no |

No segment had stems, so `no-sfx` was skipped and `soft-transients` stood in. Packets written without `--batches` leak the original (one critic sees it in several pairs, and both orders of a pair as byte-identical swaps): repack with `--batches N`, one fresh critic per batch, before any critic result counts ([reference analysis](../docs/reference-analysis.md)).

### Critic (blind, both orders)

The same 126 pairs, packed with `--critic-pack --batches 14` (seed `calibration-v2`): 18 questions per batch, one fresh creative-critic per batch, no original seen twice by one critic, the two orders of a pair with different critics. 2026-11-15.

| Kind | Pairs | Accuracy | Eligible |
|---|---|---|---|
| soft-transients | 18 | 1.0 | yes |
| stutter | 18 | 0.944 | yes |
| linear-motion | 18 | 0.889 | yes |
| flat-grade | 18 | 0.889 | yes |
| uniform-cuts | 18 | 0.778 | no |
| desync (±4 frames) | 36 | 0.5 | no (chance) |

Overall 0.786; both orders agreed on 106 of 126 pairs. A first, leaky packing (one critic per quarter, originals repeated, byte-identical order swaps) read 0.889 overall and is discarded. So in a tournament the critic's pairwise verdict is evidence for motion curves, stutter, grade and transient punch; it cannot tell a cut 4 frames off the sound or uniform cutting, which `shot-length-variety` and the cue sheet carry instead.

What follows:

- **Eligible gate:** `shot-length-variety` on uniform cuts. It stays blocking.
- **fast-motion-sharp:** advisory (above). Its pair sampling stepped 6 frames at 30 fps, the period of a hold on threes, so a stutter always read as still; `sharpnessStep` now never steps by a multiple of 2 or 3 (5 at 30 fps), and kept evidence with the old step is measured again. That raised its stutter accuracy from 0 to 0.25 on the same 12 pairs (0.22 on all 18), short of a gate.
- **cut-sound-coverage:** advisory. Music onsets sit within 2 frames of most cuts whatever the edit does, so desync and blunted transients barely move it. It returns to blocking when it passes on pairs with the sound effects actually removed (stems, or our own renders).
- **Only eligible legs gate.** A leg that `judge:calibrate` has not found eligible warns, whatever its other evidence. `motion-spread` has 0 of 20 false positives and measured true positives; `cut-sound-coverage` has neither (no cue sheet on a reference, and its proper kind, `no-sfx`, needs stems no reference had). Both warn.
- **motion-spread:** warns, not eligible. Stutter does not change how much of the frame moves, and the 10 Hz pass samples frames 0, 3, 6, the frames a hold on threes keeps, so the kind cannot exercise this leg. Its evidence is the false-positive table (0 of 20) and the true positives (0.79 and 0.44 against professionals' 0.34 at most). It needs a degradation that moves the whole frame (a synthetic drift) before it can be called eligible.
- **Sync readings:** not eligible, even on the two references that cut on the beat: a 3 s segment holds one to four cuts, too few for a hit ratio. `cuts-on-audio` still gates when the targets ask for sync, `cut-to-beat-offset` warns; whole-film desync pairs are what would settle them.

## Not calibrated here

plan:check (`curve-linear`, `text-hold-long`, `entry-hierarchy`) and motion:check (`SIMULTANEOUS_ENTRY`, `TEXT_CENTRED_ALWAYS`, `SLOP_PALETTE`) read plans and compositions, which references do not have, so their thresholds stay provisional. The corpus's OCR `centredTextShare` (p90 0.47 of text appearances) sits far under `TEXT_CENTRED_ALWAYS`'s 85% of frames, a different unit but the same direction.
