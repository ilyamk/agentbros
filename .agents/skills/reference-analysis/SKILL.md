---
name: reference-analysis
description: Break one reference video into measured and judged layers and a content-free blueprint another agent can rebuild its method from. Use when a film is given as a reference or a blueprint is needed.
---

# Reference analysis

Turns a film into JSON and pictures. Scripts measure; an agent judges, by looking. The goal is the method: a breakdown is good when a colleague who never saw the film could rebuild how it works with a different product. Existing approval and no-spend instructions take precedence. None of this costs money.

Reach for the [`reference-analyst`](../../agents/reference-analyst.md) agent to write the judged layers of a whole film. Use this skill directly to read an existing breakdown, check one move, or run the measuring commands.

## Commands

```bash
pnpm ref:add --file /abs/path/film.mp4 --id ID --rights study-only
pnpm ref:add --url https://example.com/watch/abc --id ID --rights unknown --rights-note "Given by the user"
pnpm ref:add --file /abs/path/client.mp4 --id ID --private                  # a film you may not name: local corpus only
pnpm ref:analyze --id ID
pnpm ref:analyze --id ID --layers speech-text --language en
pnpm ref:validate --id ID
pnpm ref:contribute --id ID                                                # before a pull request
pnpm ref:add --id ID --crop none --crop-note "Watermark read as a band"   # fix a crop, then rerun ref:analyze
pnpm ref:analyze --id ID --layers colour                                # re-measure shot colour only
pnpm ref:compare --id ID --render out/ID/landscape.mp4
pnpm motion:strip --input design-reference/library/ID/media/source.mp4 --output design-reference/library/ID/visuals/a1/NAME.jpg --start-sec 12.4 --end-sec 13.2 --step 1 --diff
```

Run one analysis at a time. `--library-root` chooses another library, such as `public/projects/ID/pipeline/reference`. If a download fails or a site wants a login, ask the user for the file. [Reference analysis](../../../docs/reference-analysis.md) explains every layer and its limits; [agent vision](../../../docs/agent-vision.md) explains how to read strips.

`ref:validate` returning `ok: true` only means the script ran. Read `passed`, `missingJudged` and `warnings` (corrections that do nothing, tempo readings that disagree, a beat grid slipping, the film's words left in the blueprint).

When `ref:analyze` returns a review manifest, inspect it with `pnpm vision:inspect --manifest PATH`, open its pages and follow exact frame IDs to originals/crops. Detector labels remain measured candidates; expected copy and inferred motion remain distinct. Missing data, skipped events and sparse motion coverage require more evidence, not a positive verdict.

## Layers

| File | Written by | Holds |
|---|---|---|
| `source.json`, `shots.json`, `speech-text.json`, `audio.json`, `motion.json`, `sync.json` | `ref:add`, `ref:analyze` | What can be measured. Never edit these |
| `story.json` | Analyst | Idea, audience, hook, beats, payoff, call to action, why it works |
| `visual.json` | Analyst | Palette, type by role, composition, materials, light |
| `edit.json` | Analyst | Rhythm, purpose of each shot, signature moves, `corrections` to the detector |
| `techniques.json` | Analyst | Each reusable move with a route and its primitives, plus typed `function`, `timing`, `ease`, `sound`, `typography`, `layers`, `fromShot`/`toShot` filled from strips, `motion.json` eases and `sync.json` |
| `blueprint.json` | Analyst | The film with its content removed: slots covering its full length |
| `breakdown.md` | Analyst | One page in Russian for the user |

Only `.json` and `.md` are tracked; `media/`, `visuals/` and the film's words are not. `speech-text.json` is structure only (spans, counts, boxes, case, `textId`); the words are in `media/speech-text.full.json` for the leak checks ([contributing references](../../../docs/contributing-references.md)).

## Decision and output

Decide what a film can teach before reusing it, in this order:

1. **Look.** Open the edit map, contact sheets and boundary sheets, then strip every move at `--step 1 --diff`. A path in JSON is not a look.
2. **Correct.** Detected boundaries are candidates. Record faults in `edit.json` under `corrections`: `merge`, `reject`, `split` (`timeSec`, `shotIds` = the shot it falls in), `retype`, and `move` (`shotId`, `toSec`) for a real cut the detector placed a few frames off. Count cuts one way: a grade, polarity or colour step on the same plate stays inside the shot; a new plate or a swap of a flat ground is a cut; a text swap on a held ground is a `split` with `transition: "cut"` and "text swap" in its note.
3. **Mark each claim.** `observed` for frames you opened, `measured` for numbers in a layer or computed from the media, `inferred` for reasoning and every guess at how something was made. Add a confidence and the evidence.
4. **Reason about sound honestly.** You cannot hear. Compare each ratio in `sync.json` with its chance value. Dense onsets make high ratios meaningless, so also test a window and look at loudness peaks.
5. **Route.** Choose from `remotion`, `hyperframes`, `blender`, `generated`, `footage`, `unreachable` with skills `engine-selection` and `blender-3d`. Name existing exports from `src/motion/AGENTS.md` and mark the rest `missing:name`.
6. **Remove the content.** The blueprint holds roles, recipes and timing. `ref:validate` rejects slots that leave gaps or overlaps above 0.1 s or do not span the film.

**Typed techniques.** Fill each technique's typed facts from evidence, so `ref:corpus` indexes it by function and numbers; leave out what you did not establish:
- `function`: `hook`, `reveal`, `proof`, `transition`, `emphasis`, `cta` or `breath`.
- `timing`: `durationSec` and `startOffsetFromCutSec` counted on the move's `motion:strip --step 1 --diff` frames; `onBeat` only from `sync.json` or `audio.json` beats.
- `ease`: a shot's fitted `motion.json` `camera.ease` (`source: "motion.json"`, its GSAP or CSS name and `cubicBezier`), else read off the strip (`"strip"`), else `"inferred"`. Skip fits with `suspect: true`. Name eases from the corpus vocabulary (`power2.out`, `expo.inOut`, `none`, `steps(3)`, `spring(…)`, `cubic-bezier(…)`); `ref:corpus` groups them by family (`linear`, `in`, `out`, `inOut`, `spring`, `steps`). A two-phase move takes `phases` (`exit`, `entry`, …) each with its own curve; a fit a cut cuts off is `truncated`.
- Several occurrences: `occurrences` (`span`, `fromShot`/`toShot` or `shots`, `timing`); a move across shots: `shots` (ids after corrections); a recurring signature move: `spans`.
- `sound`: `kind` `sfx`, `music-hit`, `music-bed`, `dip`, `voice`, `silence`, or `unknown` when nothing is established; an onset at the move is `timingBasis: "measured"`, what made it `sourceBasis: "inferred"`.
- `typography`, one object or a list per role (`role`, `entry`, `alignment` `left`/`centre`/`right`/`free`/`split-edges` checked against the OCR box, `size` as a share of frame height), `layers`, and a transition's `fromShot`/`toShot` (0-based, after corrections).
- `requiredPrimitives`: `remotion:<Api>`, `block:<id>`, a plain repository export, or `missing:<name>, what it must do` (the only kind counted as a gap).
- `timing`, `sound` and `typography` carry `basis`, `evidence` (strip paths and frames) and, if useful, `confidence` (0-1). Transitions may also be `iris`, `morph` or `bleach`. Each `edit.json` signature move gets a kebab-case `name` (`whip-to-ui`), the same name for the same move in any film.

To choose from many films, run `pnpm ref:corpus [--playbook ID]` and read `design-reference/library/_corpus.json`: pace and sync as distributions, techniques grouped by function, recurring gaps ([corpus](../../../docs/reference-analysis.md#corpus)). `pnpm film:targets --corpus` turns its p10 to p90, widened, into gates and keeps the middle half as the aim. To use a breakdown, read `blueprint.json` and `techniques.json` first and go to `edit.json` for the detail of a move. Express what you take in the owning brief, script, design or storyboard artefact before generating anything. After a recreation, `ref:compare` shows where to look; its numbers do not say the work is good.

## Worked decisions

- `polymarket` plays 130 BPM and its detector metric says cuts hit beats 54.5% of the time against 34.6% by chance. With text swaps counted, after the music rises only 9 of 21 cuts land on a beat, at chance. 19 of 21 land on onsets, against 70% by chance. The transferable rule is "cut on transients", and even that is weak.
- `ugc-app` has a tempo of low confidence and onsets too dense to read. Loudness peaks show an uneven figure repeating about every 3.7 s, and four of the five picture changes I picked land on it. I picked them after seeing the peaks, so this suggests a method and does not prove one. The onset numbers alone showed nothing.
- `paper-style` reads as 9 shots and 7 whips, but its panels share one sheet and the moves are a single camera. Recording that changes the route: one stage with `RegionCamera`, not `whipPan` between scenes, and only that gives the final pull-back.

Failure to avoid: "dynamic editing with bold typography". It fits any film and teaches nothing. Write the frames, sizes and reason instead.

Failure to avoid: copying a creator's graphics, brand, copy or music while calling it research. References are study-only unless the rights field says otherwise. Recreations made to learn are not published. In every tracked file, quote at most four of the film's words; describe longer copy (role, word count, case, size, timing) and cite screen text by index and time. Never name a private reference outside its own directory.

## Alternatives and review

If a move cannot be reached, say so and name the nearest equivalent we can build. Use your own frames and licensed footage to demonstrate a principle.

A vision or video-to-text model's output (`pnpm model:result`) is an observation to check against the frames, never a verdict on taste ([model analysis evidence](../qa-and-delivery/references/model-analysis.md)).

Review: Could another agent rebuild the method from these files alone? Does every move have a frame-accurate strip behind it? Do shot ids match the frames cited, and does each sound claim give its basis? Does the blueprint still hold brand names, numbers or copy? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.


With `earshot-find` prepared, `pnpm sfx:map --input <reference video> --output <library>/<id>/sfx-map.json` records the reference's candidate sound events by family (density, longest gaps) for the sound step and the critic: a count of candidates, not a judged layer. For uncertain reference SFX events, optional prepared `pnpm sfx:find-segment` proposes source-clock ranges. Preserve the source hash, inspect surrounding context and verify timing against measured audio/frames; a semantic score is not a judged cut. Read [Earshot contracts](../../../docs/audio-integrations.md#optional-earshot-engine) before use. No installation or paid work follows from analysis.
