---
name: sound-design-and-mix
description: Plan dialogue-first audio, semantic SFX cues, musical rhythm and measured local mixes for agent video projects.
---

# Sound design and mix

Read the approved script, exact timeline and delivery target before choosing sound. Preserve dialogue and meaning. Embedded presenter audio has one owner; do not layer TTS over it. Keep source files immutable.

## Design thinking first

Sound is half the film. Choose it before script and cuts when you can, and treat a film without it as unfinished. The bespoke chain's steps `music` and `sound` belong to [sound-director](../../agents/sound-director.md), which has the full method; this is how to think.

- **Three layers.** Ambience says where we are. Foley says what happened and what it's made of. Music carries shape. Ask of each moment which of the three is speaking; usually one.
- **Every visible action has a sound of the right material.** Fewer sounds than events: choose. When everything clicks, nothing is heard, and a whoosh on every cut is a template.
- **Silence is an event.** Plan at least two before the turn or the peak, then design the first sound after each one first.
- **Every event is decided: a sound or a deliberate silence.** Each cut, transition and hero moment in the cue sheet carries `sfx` (a sound kind chosen for this moment) or `silent: {reason}`; undecided blocks `plan:check` (`cut-sound-decided`) and `sfx:cues --motion-plan --cue-sheet`. A whoosh on every cut is a template, not a decision. A hero moment may layer (`layers`: a tick transient, a whoosh body, a sub-drop tail), within the riser and impact budget. `film:measure`'s `cut-sound-coverage` warns on a decided sound that is not heard on the render (advisory until calibrated, design-reference/calibration.md); treat it as a fix to make.
- **Sound carries cuts.** At least twice let a sound cross a boundary: the next scene heard early (J-cut), the last one heard late (L-cut). The picture changes while the world goes on.
- **One family, consistent levels.** Replace a sound that feels wrong; don't delete it. The hero moment must be heard over the music on a laptop, so duck for it.
- **Small speakers.** Synthetic scores turn bass-heavy: keep 20–120 Hz about 3 dB under the rest, no pad notes below MIDI 48, and give the bass 2nd and 3rd harmonics so it speaks on a phone. Compress TTS before balancing it: its peak-to-average ratio is high, so match levels by RMS, not peak (lemo-opuscar TECHNIQUE.md §4–5, MIT).
- **You cannot hear.** Read the map and the meters, report them, and say what you did not judge. Passing numbers do not mean it sounds good. The user's ear decides.

## Commands for a bespoke film

| Need | Command |
|---|---|
| Put the route to the user, then record their words | `pnpm music --action options --project ID`, `pnpm music --action record --project ID --route ROUTE --answer "THEIR WORDS" --reason "WHY"` |
| Search, chart, shortlist, fetch, check rights | `pnpm music --action search --project ID --route free-stock --query "Q"`, `--action trending`, `--action shortlist --from A.json --top 3`, `--action acquire --candidate ID`, `--action check` |
| A map of the track: sections, events, grid trust | `pnpm audio:map --input TRACK --output MAP.json --image MAP.png` |
| Land the track's ending on the end card | `pnpm music:backtime --map MAP.json --film-sec S --end-card-frame F --fps N` |
| Find a sound by material; synthesise air | `pnpm sfx:library --action find --query "soft paper scrape" --duration 0.4`, `--action synth --kind whoosh` |
| Seeded SFX in the film's key: sub-drop, layered hit, frame-exact riser, whoosh, click, tick, pop, glass, chime | `pnpm sfx:synth --project ID --key A` (`--kind riser --length-frames 45`); default pack in `public/shared/sfx/synth/` |
| Choose a sound by measured shape and text, not by name | `pnpm sfx:find --text "short airy whoosh, peak at 60%, soft tail" --duration 0.5 --kind whoosh`; the collection is `public/shared/sfx/<kind>/`, git-ignored and rebuilt by `pnpm sfx:fetch` from committed manifests (licence, recipe, sha256), measured by `pnpm sfx:index` (`--clap` for tags). A film keeps its own copies: `sfx:cues --project <id>` |
| Hear by proxy: mood, genre and tags of any audio | `pnpm audio:describe --input music.mp3 --labels "warm hopeful piano,cold industrial drone"`; similarity scores, not a verdict |
| Sounds on block cues, with gain hierarchy and budget | `pnpm sfx:cues --placements P.json --output CUES.json --plan-output PLAN.json`; play in a scene with `<CueSounds>` (`src/motion/sync`) |
| Will each SFX be heard? | `pnpm audio:masking --music MUSIC --cues CUES.json [--vo VO.mp3]`: margin per cue in dB, masked and colliding sounds, a fix each; `sfx:cues --fix-masking --music MUSIC` applies the safe ones (gain, short music duck) |
| See picture against sound | `pnpm audio:syncmap --render FILM.mp4 --map MAP.json --cues CUES.json --output SYNC.png`: cuts against beats in frames (red off), SFX (orange masked); the critic pack draws it too |
| The music's form and an edit skeleton on it | `map.structure` (sections, phrases, fills, risers, breaks, ending); `pnpm edit:plan --map MAP.json --style punchy`: riser SFX ends on the drop, impact on the drop, whoosh on section transitions, tick in fills |
| Snap picture to music with per-kind lead | `pnpm edit:snap` (cut 1 frame early, sfx on the frame); in a scene `snap(beatGridFromMap(map, {fps}), frame, "cut")` |
| Generate music, only with a stated estimate and the user's consent to it | `pnpm generate:music --composition-plan PLAN.json --output TAKE.mp3 --project ID --max-cost-usd BOUND`; if the selected provider refuses payment, stop and select an approved alternative with `pnpm models:pick --use-case music-bed`, then scaffold/quote its exact endpoint |
| Mix and measure | `pnpm audio:mix --plan PLAN.json --output MASTER.wav [--preset social] [--duck-db -9]`, `pnpm audio:analyze --input MASTER.wav` |

Choose by dynamics: a riser is a swell whose peak sits on the hit, so its length is the run-up; a whoosh is a sweep whose peak goes on the transition's peak; an impact's tail must end before the next event or it smears it. The index measures these (`peakSec`, `tailSec`, `dynamics`, `centroidTrajectory`), and `sfx:cues` uses them.

Sync numbers: sound may trail its picture slightly but must never lead it (sound early is noticed at ~45 ms, late only at ~125 ms). So the SFX transient sits on frame 0 of its event, a cut lands 0–2 frames before the beat, a visual hit up to 3 frames before a music hit. Hero sounds 0.25–0.35, support 0.08–0.2; one riser ending exactly on its hit and one impact per ~15 s.

Lessons from measured, rejected mixes (onetake, `design-reference/sources/onetake.md`):

- One material set in one shared room (a single reverb, sent 15–70 % by distance), fewer sounds than beats; of two within 40 ms keep one. A different synth tone per event, flat levels and no silences was rejected as cheap within a minute.
- Sounds inaudible under music: measure SFX against music in each event window and in 800–4500 Hz, not only overall loudness. 27–35 dB below the music read as no SFX at all; renormalising the whole mix did not fix it.
- Mud: band shares per 0.5 s window find the cause; a pitched run starting at F3 with long tails filled 95 % low-mid in one window. Keep pitched runs at F4 and above and cut their tails.
- Loudness by beat: the landing must measure louder (K-weighted, per beat) than the move into it.
- Dense contacts in lockstep (many lines landing on the same beats) sum to a pulse train heard as a tone or a croak. Break the alignment: vary every hit, keep only the followable contacts countable, turn the rest into grains whose level follows how many land together.
- A vibraphone chord with a shimmer is the stock ending users recognise; end on the music's own cadence or a hit that belongs to the film.

In a local mix plan, `duckMusic` reacts only to speech tracks. Dips under foley, planned silences and J/L overlaps are music `keyframes` and track `startSec` values. A preview is for choosing and rhythm only. A `native-on-platform` track never enters the delivered master.

Before mixing, see [stems, denoise and provenance](references/audio-preparation.md).

## Timeline projects

For a trusted native Hyperframes capture with AAC or embedded video audio, read the [explicit preparation contract](../../../docs/html-capture.md). The opt-in macOS normalization validates original decoded clocks and derives checked PCM; embedded speech follows its original video descriptor's trim/rate/gain/mute with one audio owner. Do not add another voice track for that derivative. Offsets/gaps/unequal audio-video extents refuse; an ordinal video proxy does not establish an audio clock. Preserve receipts and measure the encoded result; short synthetic AAC agreement does not prove intelligibility or human approval.

1. Plan speech, music, SFX and ambience with exact source/output intervals. A J/L cut moves a visual boundary while speech continues on its independent track; do not ripple speech merely to match a visual cut.
2. Use `pnpm audio:editorial --action rhythm --input MUSIC --output REPORT.json` for local onset/energy evidence. Confidence is a heuristic for regular amplitude onsets, not genre, metre or speech recognition. Use reviewed beat overrides or speech/story rhythm when confidence is low. Never force a cut on every beat.
3. Use `--action sfx --input SPEC.json --output TAKE.wav` for deterministic click/pop/whoosh/impact/chime; retain seed and measured peak. Import originals with `asset:import`, then `--action cues --project ID --input CUES.json --output COMMAND.json` to anchor effects to timeline events. Inspect the command with `timeline:edit --dry-run`, apply at the stated revision, and retain undo.
4. `audio:mix` uses the real edited timeline, source trims, speech ducking and chosen LUFS/true peak targets. Mount its checksummed master explicitly at render. Measure the final encoded output with `validate:render`/`audio:analyze`; local WAV measurements do not prove encoded AAC acceptance.
5. Before a generated replacement, `--action forecast` reads actual jobs/reservations and planned quote bounds. Unknown cost is blocking; estimates are not invoices. Do not regenerate ambiguous jobs.

Use music/SFX-only `audio-gain` and `audio-loop` through the [timeline contract](../../../docs/timeline-edit.md) when revising an existing clip. Gain is an attenuation multiplier0..1 over base volume and absolute keyframes; gain:null restores original values. Physical imported originals establish loop bounds via finite local ffprobe; never supply a guessed registry duration to make an edit pass. New loops require source start0; disabling a loop beyond the physical end needs a reviewed explicit trim+off batch. Dry-run, explicit Apply/CAS, readback and undo preserve speech/caption ownership. Remix after audio edits and mount that newly measured master explicitly: an old master or exported preview does not inherit gain/loop changes. Direct timeline playback does not reproduce bus automation or ducking. Missing ffprobe requires installed local ffmpeg, never a paid fallback. New project-generated masters carry checked input pins: same-duration audio edits, automation or changed originals require a fresh explicit remix. Visual/caption-only changes and undo to identical audio remain valid. Keep the binding; removing it loses project consistency checks. Legacy/manual masters retain their measured-file contract and require your explicit comparison with current audio inputs. Read the [master contract](../../../docs/local-audio-qa.md) before choosing a sidecar.

Output `pipeline/craft/sound-design-and-mix.json`: revision, dialogue ownership, cue IDs and anchors, sources/licences, rhythm evidence/confidence, intended loudness, measured final report, alternatives and remaining review.

For exact music/SFX placement or an inward trim, use the [position/trim review controls](../../../docs/local-review-ui.md) and inspect the prepared existing move/trim/batch command before Apply. A start trim preserves the old output end by moving the output start at the current rate; an end trim preserves the output start. Keep rational frames, source pins, gain and automation. Changed inputs, Refresh or Escape cancel the draft; stale revisions require a new decision. Physical source bounds and zero-origin loop checks can refuse an edit: choose a separate reviewed trim+loop-off batch when appropriate, never silently switch looping off or retime speech. Remix a mounted master explicitly and measure the encoded result. Short PCM/UI/AAC evidence demonstrates local timing and Undo; it does not establish human listening approval.

Worked decision 1: an educational caveat spans a diagram change. Keep the complete speech clip, cut the visual track independently, and place a quiet chime after the clause ends. Review captions and source wording; an attractive cut never removes “not guaranteed”.

Worked decision 2: product demo UI click lands at frame 75. Import a seeded click, anchor its cue to the reveal's start+75 frames, inspect before applying, and mix below dialogue. Alternative: omit the click if the UI action is already audible.

Failure: a loud whoosh masks the price disclaimer and music onsets trigger five needless cuts. Lower/remove the cue, hold the explanatory shot, remix, and compare measured plus listened evidence. A passing peak measurement alone cannot prove intelligibility.

Review: no double voice; intended silence retained; speech context intact; cues tied to current revision; effect tails fit delivery; music rights cover placement; encoded loudness measured; human review records creative and intelligibility decisions.

## Optional audio integrations

For selected needs, read [audio integrations](../../../docs/audio-integrations.md). The prepared Earshot bank can supply a measured seeded take; pass its receipt to `sfx:cues --earshot-takes` so the existing planner owns budgets, layers, intentional silence and placement. In the film chain, `sfx:audition` compares each hero cue's candidates (Earshot takes, measured library, synth pack) by fit and Earshot's model-free audit into sfx-selection.json, and `sfx:cues --selection` places the choices; a reference's sfx-map.json (`sfx:map`) gives its sound density by family. Use `sfx:find-segment` for source-bound candidate ranges and `audio:review` for advisory SFX artifact evidence. Neither semantic score nor audit is listening or creative acceptance. Preparation is explicit; never auto-download during production. Keep current library/native synth as the default.

Dialogue, isolation, voice conversion and dubbing use budgeted commands. Preserve originals and align the actual selected take. For a reviewed line edit, use `speech:replace` and rebuild any project audio master.
