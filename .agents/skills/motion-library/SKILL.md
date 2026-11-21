---
name: motion-library
description: Pick and compose ready motion-design blocks (typography, finish, backgrounds, UI, transitions, camera, 3D, data, scenes) from the Agent Bros. Pictures motion library. Use before writing any new Remotion scene code, and when adding a block to the library.
---

The library in `src/motion/library/` holds reusable, parameterised, frame-driven blocks. Each one renders alone as a preview, has a zod props schema with good defaults and a picture of itself. Choose blocks by their catalogue line and their picture; never by reading their source.

## When to use

- Before writing a scene: something close probably exists. A block driven by props beats new code.
- When a scene needs a finish (grain, drift): `film-finish` wraps any shot.
- For burned captions over footage: `--category captions` (ten presets: outline pop, yellow italic shadow, key-word colour, sliding word box, line box, chunky stack, editorial mixed scale, clean sentence, single-word punch, typewriter); choosing one: [caption styles](../captions-and-localization/references/caption-styles.md).
- For metaphor B-roll in halftone paper collage (cut-outs assembling on a flat field): `paper-collage-assemble`, with craft, prompts and QA in [references/paper-collage.md](references/paper-collage.md).
- For any cut-out (a collage piece, `grade-step-flash` `matteSrc`, `parallax-rig` layers, a title behind a person with `subject-occlusion`): `pnpm matte`, free and local, on a still or a frame range ([matte](../../../docs/matte.md)). `rmbg` is paid and only on the user's approval, after `matte` has failed on the picture.
- When you have built something reusable that the next film will want: add it as a block (below).

Write bespoke code only for what no block or combination of blocks can show. Primitives in [src/motion/AGENTS.md](../../../src/motion/AGENTS.md) sit one level lower; blocks are built from them.

## Choosing

Full rules: [craft-rules.md](../../../design-reference/craft-rules.md) **Block choice**.

- `sparing` items (listed last, with why) never by default: only when the idea names what they do.
- Type is bimodal: a hero word or line at 50–95% width when type is the shot (`type-hero-word`, `type-word-pulse`, `type-sentence-build`), a ~10% caption over picture. Type builds: `--category kinetic`.
- Light grounds and `ground-swap-cut` as the cut device; `caused-morph` for a change in place; `speed-ramp-flurry` once.
- A product's interface is the real one, 90–100% identical ([real-ui](../../../docs/real-ui.md)): recorded with `capture:app` or computer use, or a pixel-faithful replica of a platform from a dated reference; generic `ui-*` only for interfaces of no named product. Read it with `ui-camera-read`. Hero product: `blender-plate`.
- `effects` only when the idea calls for that material or carry. Scenes and the film end hard on the music, not on a fade.
- Lock each block's `cues(props)` to the grid (`beatGridFromMap`, `src/motion/sync`) and play them with `<CueSounds>`.
- Audio-reactive, only where the music is the subject: `pnpm audio:curves --map <map.json> --input <audio> --fps 30 --output <curves.json>`, then `<AudioCurvesProvider src offsetFrames>` and a `react` prop on `type-hero-word` (kick), `kinetic-headline-build` (energy), `mesh-gradient` (bass) or `ui-camera-read` (downbeat). Off by default; see `audio-pulse-demo`.

## Workflow

For charts, node networks and diagrams, start with `pnpm viz:list`, then prepare a strict JSON request with `viz:prepare`. Do not write scene TSX for a supported recipe. Mount through revision-checked commands; bounded groups, ports, backend selection and source contracts are in [visualisations](../../../docs/visualisations.md).

1. **Search the catalogue.** One compact JSON line per call, read from `docs/library/catalogue.json` in under a second:

   ```bash
   pnpm library:list --query "chart glow"
   pnpm library:list --category typography --format vertical
   ```

   Each entry: `id`, `category`, `title`, `description`, `tags`, `formats`, `durationInFrames`, `importPath`, `usage` when set, `preview`. A `warning` field means the catalogue is missing or older than the library source: run `pnpm library:catalogue`, or add `--live` to read the registry directly (slow).

2. **Look at it.** Open `docs/library/previews/<id>.jpg`: early, mid and late frames of the default preview. `docs/library/previews/_<category>.jpg` shows a whole category at once. If `preview` is `null`, render it: `pnpm library:preview --id <id>` (one bundle per category; slow, so one item at a time).

3. **Read its props.**

   ```bash
   pnpm library:list --id <id>
   ```

   Returns `usage` (the export or JSX a scene should use, when `component` is only a preview wrapper), the props JSON schema (`propsSchema`), `defaultProps`, the file's `exports`, `inspiredBy`, and `preview.entry` plus `preview.compositions` (`Lib-<id>-<V|S|L>`).

4. **Import it into the scene** from `importPath` (relative to your file), following `usage` when present, and pass only the props you change; start from `defaultProps`. Keep the item's checked `formats` in mind: another aspect ratio is unverified until you look at it.

5. **Compose with a style.** `pnpm library:list --styles` lists looks (palette, fonts, motion personality, finish). Feed one style's values into every block's colour, font and spring props, so a film keeps one voice. Colour grades of footage are separate: the [Looks & colour](../../../docs/library/looks.md) page (mood, palette, finish per look) and the [colour-grading skill](../colour-grading/SKILL.md).

6. **Wrap in `FilmFinish`** (`src/motion/library/finish/FilmFinish`) at the shot level. Keep `Audio` and video layers outside it when `aberration` is above 0, because it renders its children twice.

7. **Check it.** Stills at the reveal, the reading hold and the exit, then motion from a strip of a rendered clip:

   ```bash
   pnpm motion:still --entry src/motion/library/index.tsx --composition Lib-<id>-L --frames 0,60,110 --output out/qa/lib/<id>
   pnpm motion:render --entry src/your-film/index.tsx --composition Scene --output out/qa/lib/scene.mp4
   pnpm motion:strip --input out/qa/lib/scene.mp4 --output out/qa/lib/strip.jpg --start-sec 0 --end-sec 2 --diff
   ```

## Rules

- Prefer blocks over custom code. Combine and parameterise before writing new motion.
- Never copy-paste a block's source into a film. If a block lacks something, extend it through a new prop with a default that keeps the current look, then re-render its preview.
- Blocks are deterministic: every value comes from the current frame; randomness only through `random(seed)` or `noise2D`. No CSS animation or transitions, free-running GSAP (only a paused timeline seeked to the frame, as `kinetic` blocks do), framer-motion, `requestAnimationFrame` or timers; `pnpm lint` enforces this under `src/motion/`.
- Do not trust a block in a format it was not checked in. Look at frames first.
- The catalogue line is the contract with other agents. Keep it accurate when behaviour changes.
- Anything taken from an outside repo, film or asset source gets a row in [CREDITS.md](../../../CREDITS.md) and, for library blocks, an `inspiredBy` entry.

## Adding a block

1. **Place it.** `src/motion/library/<category>/<Name>.tsx` exports the component and its zod schema (`<name>Schema`). Build from `src/motion` primitives where they fit.
2. **Register it** in the category's `index.ts` with `defineItem({...})` (contract: `src/motion/library/types.ts`):
   - `id`: kebab-case and unique; `category` matches the directory; `importPath` is the file without extension.
   - `description`: one or two sentences of what the viewer sees and when to use it. Agents choose by this line.
   - `tags`: mood, motion verb, use case. `formats`: only those you have looked at; the first is the preview default.
   - `defaultProps`: must parse with the schema and make a good-looking preview with no input.
   - `inspiredBy`: every source, idea or ported code (frame-driven, restyled); plus a CREDITS.md row.
3. **Preview gate.** Look at stills of `Lib-<id>-<V|S|L>` in every listed format (step 7 above, or `pnpm studio`). Fix what you see before going further.
4. **Catalogue and preview sheet.** After adding or changing a block, run `pnpm library:catalogue` (rewrites `docs/library/catalogue.json`), then `pnpm library:preview --id <id>`, which writes `docs/library/previews/<id>.jpg`; open it and confirm it reads at a glance. Run `--category <category>` to refresh the overview sheet.
5. **Playbooks.** Add the block to the playbooks of the tasks it serves (`playbooks/<id>/playbook.json` `library` or `starter`, and a Method line when it changes how that kind of video is made); `pnpm playbook --uses <category>` lists them.
6. **Test.** `tests/motion-library.test.ts` (run with `tsx --test`) checks ids, schema defaults, formats, durations and import paths for every item. Then `pnpm lint`.

Developer notes for the library code: [src/motion/library/AGENTS.md](../../../src/motion/library/AGENTS.md). Overview for humans: [docs/motion-library.md](../../../docs/motion-library.md).

## Icons and logos

Use `icon-visual` for a local mark with a label. Its usage props come from the export command; a path copied from search is not an acquired asset. [Icon resources](../../../docs/icon-resources.md) explains style profiles and placement references.
