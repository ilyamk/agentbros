# Agent vision

Commands that turn a composition or video into pictures, so an agent can judge its work. Each returns image paths in `outputs` of its one-line JSON result; paths are absolute.

**Viewing images.** Open each returned path with your harness's image tool: `Read` in Claude Code, `view_image` in Codex. A path in JSON is not a look at the image. Viewers shrink large images, so keep sheets near 2000 px on the long side (`metadata.width`, `metadata.height`) and narrow the window before raising `--width`.


## Source-bound review packs

Vision and QA commands now also return `metadata.reviewPack` (where the owning command has metadata) or a `manifest.json` in `outputs`. Existing first output paths and legacy measurements remain available. `critic:pack` puts review pages first in its reading order. Library previews retain their compact JPEGs and write detailed composition packages under `out/qa/library/`.

```bash
pnpm vision:pack --input out/demo/film.mp4 --output out/qa/demo/review-1 --profile typography
pnpm vision:pack --request request.json --output out/qa/demo/review-2
pnpm vision:inspect --manifest out/qa/demo/review-1/manifest.json --frame 30
```

Requests use version 1: `input`, `profile` (`overview`, `motion`, `typography`, `ui`, `captions`, `reference`), `events:[{frame,reasons,basis,clipId?,text?}]`, optional `measurements`, pixel `crops:[{frame,x,y,width,height}]`, `fields`, `count`, `maxFrames`, `startFrame`, `endFrame`, `step`, `phone`. The Zod contracts are in `src/types/vision-review.ts`. Paths resolve from the CLI working directory; MCP supplies its trusted root for nested input paths. No executable templates or network inputs are accepted.

Pages use up to 2000 px per side, with 300 px overview tiles, 600 px landscape detail tiles, 460 px portrait detail tiles or 390 px phone tiles. Pagination preserves tile size. Labels are browser-rendered UTF-8 using system fonts; original production glyph coverage is a separate measurement. Long labels show ellipses, full text stays in the manifest and HTML title. HTML links open originals and crops; PNGs are immediately viewable by agents. Chromium must already be prepared (`pnpm exec remotion browser ensure`); capture never silently downloads it.

The manifest pins source, full-resolution frames, crops and pages by SHA-256, with frame times and reasons, omissions, warnings and reading order. Inspection verifies bytes and source freshness before returning bounded data. CLI summaries flag truncated text/measurements and retain total counts; read the original manifest for complete records. `composition` packages describe a frozen set of stills and their declared identity, not a verified production video. Generic request measurements are caller-declared/unverified even if the caller labels them measured. Only the owning QA adapter attaches its actual diagnostic measurements, explicitly separate from final MP4 pixels. No missing measurement implies a pass.

Motion windows retain consecutive frames by default and add x4 difference maps with their actual previous selected frame and mean difference. A non-unit step or budget omissions leave coverage incomplete. Whole-window overviews include endpoints. Use `qa:screenshots --overview` for samples across the full duration; the interval mode warns when capped before the end.

Exact packages require zero-origin CFR media. VFR/nonzero-origin files are refused by `vision:pack`; compatible legacy tools retain their output with a detailed-review warning. Conform through the existing media workflow before asserting exact times. Inputs are restricted to self-contained local containers. No transcription, OCR preparation, generation or provider calls happen implicitly.

For evaluation, `pnpm vision:evaluate --action prepare --output out/qa/vision-fixtures` creates 24 frozen synthetic cases. `pnpm vision:evaluate --action run --cases out/qa/vision-fixtures/cases.json --output out/qa/vision-evaluation --harness both` uses existing configured Codex/Claude subscriptions, fresh sessions and a confined MCP image reader. Keys remain outside packets. Results retain actual image delivery, citations, failures and baseline/candidate metrics; subscription cost is not inferred. `--limit` is smoke-only and cannot establish acceptance.

## Which command when

| Question | Command |
|---|---|
| Does this exact frame of the composition look right? | `pnpm motion:still` |
| How does this move, cut or transition play? | `pnpm motion:strip` with a short window and `--diff` |
| What are the shots of this video? | `pnpm motion:strip --by-shots` |
| Does this moment play like the reference's? | `pnpm motion:strip --vs <reference dir> --vs-range a:b` |
| Does the whole piece hold together, and do cuts land on the sound? | `pnpm review:sheet` |
| I need a video of the composition or a part of it | `pnpm motion:render` |
| Is anything measurably broken? Run this first | `pnpm motion:check` |
| Can this text be read on a phone? | `pnpm review:sheet --phone` or `pnpm motion:strip --phone` |

```bash
pnpm motion:still --composition MyComp --frames 0,30,90 --output out/qa/me/stills
pnpm motion:strip --input out/me/v.mp4 --output out/qa/me/cut.png --start-frame 80 --end-frame 103 --step 2 --diff
pnpm motion:strip --input out/me/v.mp4 --output out/qa/me/shots.png --by-shots shots.json
pnpm review:sheet --project me --output out/qa/me/sheet.png --count 12
pnpm motion:render --composition MyComp --output out/me/motion.mp4 --frames 0-119 --project me --import --clip hook
```

`--help` on any script lists every flag.

## Reading the images

- **Stills** are `frame-NNNNNN.png`, rendered by Remotion at full size. `--entry` selects another entry point and `--props` a JSON file. `--gl` defaults to `angle` for 3D. Stills and the new review pages need Chromium; legacy raster sheets do not.
- **Strips** show consecutive frames labelled `F<frame> <mm:ss.cc>`. Frame windows include both ends; second windows exclude the end. A sheet holds 120 tiles at most, and a longer request fails with the `--step` it needs.
- **`--diff`** puts an amplified difference map (x4) under each tile, against the previous tile, so with `--step 2` it spans two source frames. White areas changed; black held still. `metadata.frames[].diffMean` is the unamplified mean difference (0-255). Use it to find motion peaks and dead air, then strip those windows at `--step 1`. A sudden spike at one tile is a cut or a flash.
- **`--by-shots`** reads `{shots:[{startSec,endSec}]}`, the shape of a reference `shots.json`, and labels tiles `<shot><F|M|L> <mm:ss.cc>`.
- **Review sheets** put frames over a waveform. Red lines are cut marks, blue ticks show the sampled frames. `--marks` takes a JSON array of seconds or a shots file. `--captions` takes strings per frame or `[{startSec,endSec,text}]`. `--project` supplies the newest `out/<id>/*.mp4` and takes clip boundaries and labels from the timeline. Compare the marks with the waveform: a hit that misses its cut shows here.

Legacy raster sheets use a built-in Latin and Cyrillic bitmap font, drawn in capitals, because many ffmpeg builds have no `drawtext`. Other scripts appear as hollow boxes; the full text stays in `metadata`.

## Binding a render to a timeline

With `--project ID --import`, `motion-render` imports the output as an immutable asset and returns `metadata.asset` (`id`, `path`, `sha256`). `metadata.timeline.commands` holds the exact next `timeline:edit` calls, as dry runs. Nothing edits the timeline by itself.

Name the clips with `--clip a,b` (and `--track` if there are several visual tracks) to resolve the command fully; otherwise it contains `<trackId>` or `<clipId>`, `metadata.timeline.resolved` is false and `metadata.timeline.visualClips` lists the choices. A whole-composition render keeps each clip's existing source span; a `--frames` render uses the new file from its first frame. `metadata.timeline.durationChanges` lists clips the command would lengthen or shorten: a replace can pass validation yet leave a gap on the track. Review the dry run, then repeat the command without `--dry-run`.

## Sensors first, then look

`scripts/motion-check.ts` opens the composition in headless Chromium and counts what the eye misses. Run it after every build, before looking at anything. It does not judge taste.

```bash
pnpm motion:check --composition MyComp --safe-zone vertical
pnpm motion:check --composition MyLoop --loop-frames 120
pnpm motion:check --composition MyComp --frames 80-103 --render out/me/v.mp4
```

| Counter | Reads non-zero when |
|---|---|
| `runtimeErrors`, `consoleErrors` | A checked frame throws, fails to settle or logs `console.error` |
| `textOffStage` | Visible text rests or drifts across the composition edge. Text wholly beyond the stage, hidden by a smaller mask or passing the edge at speed (over 1% of the long side per frame, such as a whip) does not count |
| `textOutsideRegion` | Text leaves the nearest ancestor with a `data-region` attribute |
| `textOutsideSafeZone` | With `--safe-zone`, on-stage text crosses the profile's margins from `design-tokens` |
| `textOverlap` | Two unrelated text nodes, both at opacity 0.6 or more, overlap. Crossfades and same-text stacks do not count |
| `fallbackFonts` | Chromium drew text with a font other than the first requested family, such as Cyrillic in a Latin-only font. Generic stacks and emoji are ignored |
| `nonDeterministic` | A frame opened directly visibly differs (any channel by more than 4) from the same frame reached after others. Checks three frames at most. A first mismatch is captured once more on both sides (a fresh direct open, a fresh seek from the previous checked frame) and counts only if it persists; every retry is listed in `metadata.determinismRetried` with `cleared` and both comparisons, so a flaky capture under load stays visible |
| `loopSeam` | With `--loop-frames N`, frames 0 and N are not pixel-identical. Frame N must exist |
| `fadedFinal` | The last frame is much darker than the frame 15 before it |
| `deadFrames` | Any frame is entirely black; or the first or last frame is a single colour; or a single-colour run lasts 6 frames or more. A shorter flat-colour beat inside a transition does not count |
| `flashRisk` | More than three general or saturated-red flashes in any one second over more than 11.1% of the frame ([WCAG 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html): a 10% swing in relative luminance with the darker side below 0.80, or a change to or from saturated red). Each finding names its time range and frames. Needs every frame: the `--render` file, else a consecutive `--frames a-b`; skipped on a sampled walk. `film:measure` runs the same sensor as its `flash-risk` leg, and `pnpm flash:check --render <file>` on any video (`src/lib/sensors/flash.ts`) |
| `simultaneousEntry`, `textCentredAlways`, `emojiText`, `slopPalette` | Slop signatures: three or more text blocks entering on one frame the same way; every text block on the centre line in over 85% of text frames; emoji in visible text; a purple-blue gradient or a frosted-glass backdrop. Thresholds and fixes: [slop catalogue](../design-reference/slop-catalogue.md) |
| `renderFile` | With `--render`, the file's pixel aspect ratio, size, codec (`--codec`, default h264), frame count or frame rate is wrong |

`--frames` takes a range (`a-b`, `a-b:step`) or a sample step; the default is every 5th frame plus the first and last. A range that omits the last frame cannot check `fadedFinal`; only a consecutive range (or `--render`) checks `flashRisk`.

The result is one JSON line with `metadata.counters`, `metadata.findings[]` and `metadata.frames`, plus a table on stderr. Any non-zero counter exits non-zero with error code `VALIDATION`. Each finding has `code`, `frame`, `lastFrame`, `occurrences`, `message` and `fix`; repeats of one problem across frames merge into one finding, and counters count every occurrence. A counter reads `null` when its check did not run, and `metadata.skipped` says why: `null` is not a pass. `metadata.textNodes` of 0 means the text counters had nothing to measure.

An intended exception goes in `--allow`, as inline JSON or a file, with a reason. `text` matches a substring; `element` matches an `id`, `data-element` or `data-region` on the text or its ancestors. `metadata.unusedAllow` lists rules that matched nothing, so remove those.

A library block whose documented move takes text past the stage or safe zone declares it itself: on exactly the frames the overflow lasts, it marks the layer with `data-overflow="<block>: <reason>"` (`intendedOverflow(active, reason)` from `src/motion/library/overflow.ts`). `textOffStage` and `textOutsideSafeZone` then skip that text on those frames and list it in `metadata.intendedOverflow` (`code`, `reason`, `text`, `frame`, `lastFrame`); the same text resting there on an undeclared frame still counts, and `textOutsideRegion` is never excused. Today: giant-word-pull-out (until the word settles), ui-punch-reframe (while punched in), accelerate-into-cut (from the approach until the new shot rests). A film's own scene code uses `--allow`, never the attribute.

```json
[{ "code": "FADED_FINAL", "reason": "End card fades out by design" },
 { "code": "TEXT_OVERLAP", "element": "stacked-title", "frames": "30-60", "reason": "Deliberate type collision" }]
```

Clean counters do not prove a frame is right. The check reads boxes rather than pixels, so text hidden behind another layer still counts as visible and a line running through a label goes unseen. Look afterwards.

`--phone` draws review tiles 390 px wide, about the size a phone shows them, whatever the video's orientation. If you cannot read the text in a tile, neither can a viewer. Keep the sheet near 2000 px on the long side, or the viewer shrinks it and the test means nothing; `metadata.warnings` says when it does not fit.

## Goals and stop rules

An unattended repair loop needs a goal a machine can check, a rule for giving up and a limit:

```text
motion:check reads zero. Fix the worst failure each round.
Abort if a round fixes nothing. Stop after 5 rounds.
```

Fix runtime errors first, because the other counters cannot see a frame that does not render. Count progress from the counters: a round that leaves them unchanged has failed, so stop and report rather than try variations. Adding an `--allow` rule to reach zero is not a fix unless the exception really is intended.

Taste is not a loop goal. "Looks premium" has no stop condition, so a loop chasing it churns until the limit and reports success on the last attempt. Use loops for what can be counted, and leave judgement to a reviewer looking at the images, whose notes become specific requests.

When the same problem happens twice, stop fixing the output. Change the rule in the guide or skill that allowed it, or add a sensor that catches it, so that it becomes unlikely or impossible next time.

## Review loop

0. **Sensors.** Run `motion-check` and get it to zero before spending attention on images.
1. **Styleframes.** Before animating, render stills of the key frames and look at each: hierarchy, safe zones, legibility.
2. **Motion.** Strip every transition and motion peak with `--diff`, at `--step 1` or `2`. Look for frames a viewer would notice: flashes, overlaps, dead holds, illegible text mid-move.
3. **Whole.** Make a review sheet of the finished render with its cut marks. Check story order, repetition and how cuts sit against the sound.
4. **Phone.** Look at a `--phone` sheet of the render and read every line of text.
5. Fix, re-render, run the sensors and look again at what changed.

## Writing a review receipt

After looking, write `public/projects/<id>/pipeline/reviews/<step>.json` matching `VisualReviewSchema` in `src/types/creative.ts`. It records what was looked at, not that it is good. Get the hash from `shasum -a 256 <render>` or `hashRenderFile` in `src/lib/vision/reviews.ts`.

```json
{
  "schemaVersion": 1,
  "step": "motion",
  "renderSha256": "<64 hex digits of the render>",
  "reviewer": "motion-engineer",
  "frames": [
    { "path": "out/qa/me/cut.png", "timeSec": 3, "note": "Example: headline fades out before the cards settle." }
  ],
  "issues": ["Example: caption overlaps the card at frame 92."]
}
```

`checkVisualReviews(projectDir, renderSha256)` in the same file reports:

- `VISUAL_REVIEW_MISSING`: no receipts exist, or a receipt does not match the schema and so does not count.
- `REVIEW_STALE`: a step has receipts, but none covers the current render.

Findings are errors while no receipt covers the current render, and warnings once one does.
