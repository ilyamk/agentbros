# Product HUD loop and camera story playbook

Last updated: 2026-11-25

Choose it for a dense sci-fi HUD canvas that shows how a product's system works, as a music loop and then as camera-flight stories. Real screens: [product-tutorial](../product-tutorial/AGENTS.md); an ad: [product-promo](../product-promo/AGENTS.md); an existing still: [animated-infographic](../animated-infographic/AGENTS.md); no product: [motion-design](../motion-design/AGENTS.md). Draft: one accepted project, built with a project kit rather than library blocks (Done when).

## Start

```bash
pnpm film:init --project <id> --type motion-graphics --playbook product-hud-story --title "<short name>" --product <path>
pnpm film:next --project <id>          # repeat: do what it says
```

`--product` is the product's own material: its docs, design tokens, logos. The canvas is an abstract visualisation of the product's processes, not its screens; any real screen or the real logo animation comes from the product itself ([real UI](../../docs/real-ui.md)).

## What good looks like

- Dense and readable: many moving parts (graphs, counters, terminals, micro charts), each standing for a real process of the product; nothing decorative. Every connector ends on a visible node, never in empty space.
- The loop is seamless (frame N equals frame 0) and the canvas breathes with the track: kicks, snares and bars drive pulses, not a timer.
- A story tells the system's work one block at a time: the camera arrives on a downbeat, the block builds as it arrives, a caption names the task, the camera leaves on a curved, eased flight; it ends on a pull-back to the whole canvas and black.
- A localised version reads natively, fits every box, and keeps code identifiers as code.
- A logo intro hands off with no visible seam: same mark size and place, same sound.

## Method

1. **Concepts.** Read the product's material and propose three canvases, each telling one story of the system (identity, search, agents). Each block names the process it shows. List the logos needed and fetch them with `pnpm resources:logos --project <id> --action acquire --id <source:id> --variant=dark` (`--variant=x`, not `--variant x`). Only names and partners the user cleared appear (intake).
2. **Music and grid.** The user's track, mapped with `pnpm audio:map`; cut a loop window of whole bars and, for stories, a separate window (`music:backtime` for the end). Keep two beat maps (loop, story) and switch the active one per composition before children render, so the canvas follows whichever track plays.
3. **Loop build.** A project kit (panels, sparks, meters, terminals, tickers, comets, glow) on the library's ui and data blocks (`pnpm library:list --category ui|data`). Periodic by construction: noise sampled on a circle, wrapped event time, rotations in whole turns per loop, oscillators instead of growing counters, terminal lines duplicated one loop earlier. Thousands of points or strands go into batched SVG paths. A seam composition of N+1 frames proves frame N equals frame 0. `pnpm lint --project <id>` after every edit (determinism).
4. **Approve loops, then deliver.** HQ and social for each (step 9). Archive the approved state (step 10) before touching the code again.
5. **Story on paper.** Before any code, a storyboard table in `pipeline/` (shot, bars, block, caption label and line, transition) and the user's choices of language and length. Then a shot table in code: `id`, arrival frame on a downbeat, departure, canvas point (or a function of the frame to follow a moving packet), zoom in and out, drift, caption anchor, label and line, flight side. Flights are quadratic Bézier arcs bowed sideways from the chord, eased in-out, with a 15% zoom dip and about 2° roll; holds push slowly; the end is a spiral pull-back to the full canvas on the drop, then a radial close to black. Motion blur from the camera's screen speed sits on an outer layer, never on the transformed one (it softens zoomed text).
6. **Build states.** Each block reads a build value 0..1 from a context whose default is 1, so approved loops render unchanged; the story sets build windows that finish as the camera lands. Unbuilt blocks are dark skeletons; a build types the title, then reveals the body behind a scan line. After the edit, render the loop again and prove it identical to the approved one: `cmp` on stills, or ffmpeg PSNR / difference YMAX; when a render differs (draw order changed), restore the order rather than accept it.
7. **Captions and sound.** A caption is a pair: a short mono label (`01 · IMPORT`) and one line, words appearing on half-beats, a leader line to the block, a dark plate under it; checked at phone size with `motion:strip --phone`. SFX from `pnpm sfx:synth` (whooshes in three seeds, tick, pop, hit, sub-drop, riser of the flight's length): a whoosh peaking mid-flight with volume growing with distance, a tick under each label, a riser and hit into the pull-back. Keep them under the music ([sound design](../../.agents/skills/sound-design-and-mix/SKILL.md)).
8. **Draft before HQ.** One half-scale render (`pnpm film:render --project <id> --entry src/projects/<id>/index.tsx --composition <c> --embedded-audio --draft --output <file>`), then a contact sheet every 45 frames and `motion:strip`; parallel stills are far slower than one draft render. Send the user the draft or HQ only when the frame check is clean.
9. **Render and master.** The full render is `film:render` without `--draft` (the film's own build composition to `out/<id>/film.mp4` is what `delivery` binds). A 2x HQ master currently needs a plain Remotion render with `--scale=2` (film:render has no scale flag); audio mastered -1.5 dB through a limiter, social 1080x1350 from the HQ (lanczos, CRF 19, faststart). Checks on every file: `pnpm flash:check --render <mp4>`, ebur128 true peak at most -0.5 dBFS, first and last frames black for stories. Then `pnpm delivery` (snapshot, check).
10. **Archive per approval.** Proactively, at each approval: a dated folder with a MANIFEST (compositions, file names, the user's approving words, checksums), a tarball of the project's source and public assets, and a rebuild script that renders, masters, scales and checks one composition. Record each verdict with `pnpm memory --add --type decision --project <id> --summary "..." --quote "<user's words>"` and each delivery as `--type episode`.
11. **Localise after the English is approved.** One dictionary per video, applied at render time through a translate helper on every text path (components, SVG `<text>`, strings computed at module level). Exact matches first, then a longest-first phrase pass with identifier-safe boundaries; identity entries pin code identifiers (`search_people`, `person`) so they stay code; numbers use the locale's separators. Offer two or three native options for every headline term before rendering; literal translations get replaced. Check every box for overflow on stills and shorten the words, never the type ([captions and localisation](../../.agents/skills/captions-and-localization/SKILL.md)).
12. **Logo intro.** The brand's own launch animation, captured deterministically: try `pnpm capture:html` (seek per frame) first; a WebGL engine that keeps state needs a project script that loads the engine paused, seeks it per frame, reads the canvas back and composites the transparent frames over black. It replaces the opening close-up in place: same length, same soundtrack, the camera holds still while the mark forms, then the canvas opens around it. Size and place the intro so its final mark matches the canvas mark by bounding box (measure both), then cross-fade on the first flight. Approve on one video, then apply to the rest.

## Tools

- `film:init`, `film:next`, `next`; `library:list` before new code; `resources:logos` for source and partner logos.
- Music and sound: `audio:map`, `music:backtime`, `sfx:synth`, `sfx:cues`.
- Proof: `lint`, `motion:still`, `motion:strip`, `motion:check`, `film:measure`, `flash:check`; render with `film:render`; ship with `delivery`.
- `capture:html` for a third-party seekable animation ([html capture](../../docs/html-capture.md)); `memory` at every verdict.
- Skills: `motion-library`, `motion-and-typography`, `sound-design-and-mix`, `captions-and-localization`, `engine-selection`, `qa-and-delivery`.

## Anti-patterns

- Decoration that stands for nothing; lines that run into empty space.
- Changing an approved composition's code without proving its render unchanged.
- Writing story code before the storyboard table is agreed.
- A logo intro as a pre-roll with its own sound effects: it replaces the opening shot and keeps the film's sound.
- Splicing on a text search that matches twice (a comment repeated across files): anchor on a unique line and re-read before rendering.
- Batch loops in zsh: `set -- $pair` does not split words, names come out empty and nothing renders. Run batch renders with bash.
- Treating transparent canvas frames as finished: composite over black before encoding.
- Translating code identifiers or keeping the English thousands separator in a localised version.
- Vendoring a third-party animation engine's source when its licence allows only use in the end product.

## References

- Example loops from the accepted project (README GIFs): [loop A](../../docs/readme/example-hud-loop-a.gif), [loop B](../../docs/readme/example-hud-loop-b.gif), [loop C](../../docs/readme/example-hud-loop-c.gif).
- [Motion grammar](../../.agents/skills/motion-and-typography/references/motion-grammar.md) for easing and holds; [real UI](../../docs/real-ui.md) for product screens; [delivery](../../docs/delivery.md).
- Loudness and peaks: ITU-R BS.1770 true peak, measured with ffmpeg `ebur128=peak=true`; -0.5 dBFS ceiling is a house rule.
- Flashes: [WCAG 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html), checked by `flash:check`.

## Done when

Draft until:

- A second project passes this method through `film:next` end to end. The evidence project was built in a bespoke kit and its film chain stayed at intake, so the gates of the chain are untested here.
- The camera engine (shot table, Bézier flights, build windows, caption pairs, cues per flight) becomes a library block, and the build-state context a library helper.
- A harness tool captures a stateful WebGL animation (paused engine, seek, readback, composite) instead of a project script, or `capture:html` is shown to handle it.
- `film:render` takes a scale for a 2x HQ master; the archive per approval (MANIFEST, source tarball, rebuild script) is a command; a benchmark task exists.
