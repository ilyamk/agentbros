# Motion Library — Agent Rules

Last updated: 2026-11-21

Capture-based product demos use real before/after plates, camera stops and an optional carried control in landscape and portrait. The showcase can perform the captured ground-swap and caused-morph pair. The same frame plan schedules its local sound accents. [Reproducible example](../../../examples/workflows/product-ad/library-proof/README.md).

Reusable, parameterised motion-design blocks that agents choose by a catalogue line and a picture. To use blocks in a film, follow the [motion-library skill](../../../.agents/skills/motion-library/SKILL.md); this file is for changing the library itself. See [primitives](../AGENTS.md) and the [3D pilot and exhibition cut](../../../docs/drei-techniques.md).

```bash
pnpm -s library:catalogue                          # regenerate docs/library/catalogue.json after any change
pnpm -s library:list --query "glow"               # compact catalogue, read from catalogue.json
pnpm -s library:list --id film-finish              # usage, props schema, defaults, exports, preview compositions
pnpm -s library:preview --id film-finish           # docs/library/previews/film-finish.jpg
pnpm exec tsx --test tests/motion-library.test.ts  # contract checks for every item
```

| File | Role |
|------|------|
| `types.ts` | The contract: `LibraryItem`, `LibraryStyle`, `defineItem`, `FORMAT_SIZE`. |
| `registry.ts` | `libraryItems`, `libraryStyles`: concatenates every category's `items`. |
| `Root.tsx`, `index.tsx` | `makeLibraryRoot` gives each item and checked format a composition `Lib-<id>-<V\|S\|L>` at 30 fps. |
| `<category>/index.ts` | The category's `items`, each built with `defineItem`. |
| `<category>/preview.tsx` | Optional entry that bundles only this category; `library:preview` and `library:list --id` prefer it. |
| `styles/index.ts` | Complete looks: palette, fonts, motion personality, finish. `finish.preset` may name a finish preset; no style sets one yet, so every existing look renders as before. |
| `ui/ui-plan.ts` | Pure numbers of the interface-motion blocks (placeholder schedules, check fills, annotation build order, fan-out poses, chip-wall push, answer-pill and prompt-jump timings), tested in `tests/motion-blocks-gap-ui.test.ts`. Other blocks reuse `placeholder-resolve` through `resolvePlan`, `PlaceholderTile` and `PlaceholderRegions`; the API is in the header of `ui/PlaceholderResolve.tsx`. |
| `scenes/scene-plan.ts`, `data/ticker-plan.ts`, `camera/camera-plan.ts` | Pure numbers of the scene, data and camera gap blocks (quad-split cut planner, hero snap, aligned-burst focus, ticker swaps and pull-back, image card, video wall pose and tiles, defocus ramp), tested in `tests/motion-blocks-gap-scenes.test.ts`. `camera/VideoWall.tsx` holds the wall so `PopulatePullOut.tsx` stays importable in node tests. |
| `three/plate-plan.ts` | `plateSchema` and `plateSource` (block frame to plate file, hold-last): the optional `plate` prop of `shaded-orb`, `printing-slip`, `depth-card-flythrough` (fan) and `studio-product-stage` (array), played by `three/PlateLayer.tsx`. The plates come from `scripts/blender/` shots that keep the block's timing keys (`tests/blender-plates.test.ts`); defaults never name a plate, so previews need no render. |
| `finish/presets.ts` | `finishPresets` (`clean`, `filmic`, `tactile`) and `resolveFinish`: defaults, then the preset, then explicit props. `FilmFinish` takes `preset`; with neither preset nor props it is grain 0.04 only, as before. |

Node-side tooling (`scripts/library-*.ts`, the test) loads the registry through `src/lib/library/load.ts`, which resolves ESM-only render packages. Load it lazily, after argument parsing: the component graph takes seconds. That is why `library:list` reads `docs/library/catalogue.json`, written by `library:catalogue` (`src/lib/library/catalogue.ts`).

`data-unit-tray` uses a fixed grid and exact integer count for material-led evidence. The count and rendered objects share one frame function.

## Adding an item

- One component per file in `src/motion/library/<category>/`, exporting the component and its zod schema. `importPath` is that file without extension and must start with the category directory.
- `id` kebab-case and unique; `description` says what the viewer sees and when to use it, in one or two sentences; `tags` carry mood, motion verb and use case.
- `defaultProps` must parse with the schema and look good with no other input: it is the preview and the starting point for every agent.
- List in `formats` only what you have looked at. The first format is the preview sheet's.
- `inspiredBy` names every source (idea or ported code, with its licence as stated); ported code is restyled to the library and made frame-driven. Add `credits/<id>.json` and run `pnpm credits:write-doc`; a block from reference films adds itself to each film credit's `analysedFor` and follows its technique card ([edit-research](../../../.agents/skills/edit-research/SKILL.md)).
- If `component` is only a preview wrapper, set `usage` to the export or JSX a scene should use.
- Run `library:catalogue` and commit `docs/library/catalogue.json` with the change (`library:list` reads its JSON and warns when its `sourceHash`, a hash of the library's `.ts`/`.tsx` files and the builder, no longer matches the code on disk; docs, previews and this file do not count; `--live` bypasses it). `tests/motion-library.test.ts`, part of `test:fast`, rebuilds it in memory and fails naming the stale blocks. Render the sheet (`library:preview --id`), open it, then refresh the category overview (`--category`). Sheets live in `docs/library/previews/`, about 30 KB each. From a fork, leave the sheet out (intake refuses binaries): make the preview composition render from `defaultProps` and the maintainer renders the sheet after merge.
- Name the new block in the playbooks of the tasks it serves (`starter`, `library` or a Method line in `playbooks/<id>/`; `pnpm playbook --uses <category>` shows where its category is used), in the same commit ([playbooks](../../../playbooks/AGENTS.md)).

## Rules

- Deterministic only. Every value is a pure function of `useCurrentFrame()`; randomness through `random(seed)` or `noise2D`. `pnpm lint` checks all of `src/motion/**` for CSS animation and transitions, framer-motion, `requestAnimationFrame` and timers. GSAP blocks (category `kinetic`) import only from `src/motion/gsap.ts`, follow the rules in its header, derive `cues` from the same pure plan that places the timeline labels, and pass `tests/gsap-determinism.test.ts` before they ship.
- A GSAP block keeps its schema, plan and pure helpers in a gsap-free sibling (`kinetic/line-draw-math.ts`, `kinetic/morph-mark-math.ts`): node cannot import a module that imports `gsap.ts`, so tests import the sibling. GSAP transforms go on a wrapping `div`, never the root `<svg>`.
- Remotion media components only (`Img`, `@remotion/media`), never `<img>`/`<video>`.
- Extend through props with defaults that keep the existing look; never fork a block into a film.
- A changed look means a re-rendered preview sheet in the same change.
- A block that depicts a named platform (Telegram, WhatsApp, iOS) is a pixel-faithful replica of a dated reference screenshot, checked side by side at full size ([real-ui](../../../docs/real-ui.md)); record the reference date in its catalogue description. Generic `ui-*` blocks stay unbranded.
- Transition blocks take an optional `seamFrame`: frames from the block's start to the perceived cut (the cue frame itself, not the seam's first frame). `cues(props)` emits the `cut` cue there, and `sfx:cues` places it at the block's start plus `seamFrame`; without it the cue sits on the preview's centred seam (`demoCutCue`). `seamFrameOf(transitionStart, transitionFrames, PEAK)` in `transitions/demo.tsx` computes it for a TransitionSeries presentation.
- Blocks in `typography`, `data`, `ui` and `kinetic` can be laid over footage (`timeline:edit add-overlay`, [timeline edit](../../../docs/timeline-edit.md)): a block that paints a background gives it a transparent option (`ground: "transparent"`, `backdrop: "none"`).
- Measure text with the `src/motion` fitting helpers instead of fixed font sizes, so other formats and languages still fit.
- Text that crosses the stage or safe zone by design (a giant word overflowing, a punch-in crop) is declared by the block with `intendedOverflow(active, reason)` from `overflow.ts`, only on the frames it lasts; motion:check lists it under `intendedOverflow` instead of failing ([agent vision](../../../docs/agent-vision.md)). Defaults never rely on it to sit outside the safe zone at rest.

Icon block (2026-11-15): `icon-visual` uses returned local usage props and an explicit silent reveal cue. [Guide](../../../docs/icon-resources.md).

`three/RenderPlate.tsx` (2026-11-15): generic `render-plate` reuses `PlateLayer`, maps explicit source FPS to timeline frames and holds the final source frame. Its offline vector preview is not evidence of a Vork render.

Motion continuity (2026-11-19): `ui-state-morph` holds one action container through processing and result. `ui-swipe-deck` overlaps outgoing and incoming cards. `glass-lens` adds travelling local magnification, `page-turn` takes two supplied plates and a seam, and `caption-word-box` can use `active.boxMotion: "elastic"`.

Text entrances (2026-11-19) use `type-text-generate` for fixed word slots with focus, `type-blur-text` for short reading-order rises and `kinetic-binary-text` for one decoded status. Keep one principal gesture per beat and hold the readable result.

Production proof blocks (2026-11-19) link controls and accepted revisions to their visible result. Use the anchored evidence row, variation selection or device handoff when the edit follows the same subject. The landscape showcase assembles these with print registration, bars forming a number and waveform-timed text.
