# motion-engineer: worked examples

Moved out of `.agents/agents/motion-engineer.md`.

## Strip notes

Bad: "Transition looks smooth, type reads well." It could be written without opening the file.

Our own film, `src/motion/showcase`, F389–F402, as it should have been read: "F389–F395: `DIFF 0` on all seven, the label is frozen 0.23 s before the cut with no sound event. F396: `DIFF 114.59`, the whole frame swaps to orange, nothing kept from the label: a slide change at the film's turn. F397–F399: the word rises from a mask, the same entrance as every other word. F400–F402: diff decays 13.03, 6.78, 3.45, then stands still. Against the plan: nothing carries, and the entrance is the one the plan meant to avoid." Every `motion:check` counter was zero on that film.

Good, on an invented burst: "F384–F389: full-frame diff each frame, stroke moves right, cut at F384 on the cue. Stroke height 540 in F388, 548 in F389: fine at this speed. F389–F396: stroke left, edge stops dead at F395, diff ~0 on F396. Cue `stop-grinding` is F396. The stop is one frame early: moving the stroke's end to F396."

## Bad and good motion

| Bad | Why | Good |
|---|---|---|
| Interpolating `translateY` with a hand-typed bezier | A second curve library | `track` with `curves` from `src/motion`, or a library block |
| A blur to soften a cut that does not carry | Polish hiding a boundary defect | Fix the handover, then `Shutter` only if speed calls for it |
| One entrance function for all words | Reads as a template | Each word's treatment from the plan's `entrance` |
| A scene that eases to a stop and waits | A dead hold | Landing, small settle, accelerating exit on its cue |
| "Motion good" from a 12-tile sheet | Hides everything | One strip per boundary, with what moved written down |

## Command detail

```bash
pnpm motion:render --entry src/projects/ID/index.tsx --composition Id --frames 212-224 --output out/qa/ID/s07-s08.mp4
pnpm motion:strip --input out/qa/ID/s07-s08.mp4 --output public/projects/ID/pipeline/strips/s07-s08.jpg --diff --columns 7 --width 240
pnpm film:render --composition Id --entry src/projects/ID/index.tsx --draft --embedded-audio --output out/qa/ID/draft.mp4 --targets public/projects/ID/pipeline/film-targets.json --audio-map public/projects/ID/pipeline/audio-map.json --cue-sheet public/projects/ID/pipeline/cue-sheet.json
pnpm hyperframes:render --project-dir PROJECT --output public/projects/ID/assets/hyperframes/shot.mp4 --block BLOCK --licence SPDX --source PINNED_URL
pnpm asset:import --project ID --input public/projects/ID/assets/hyperframes/shot.mp4 --metadata public/projects/ID/assets/hyperframes/shot.mp4.provenance.json
pnpm blender:run --script public/projects/ID/assets/blender/shot.py --output out/qa/ID/shot --frames 40-40 --samples 24 --resolution 960x540
```

The animatic command in the brief carries `--project`, which needs `--import`: leave both off unless the animatic should be kept as an asset. Keep drafts out of project paths: with `--project`, `film:render` writes `film-measure.json` and the measure receipt.

Sources: motion-video-kit business-motion-film (MIT, echris6); lemo-opuscar TECHNIQUE.md §3, §8 (MIT, LemoLab).
