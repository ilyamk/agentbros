# References for agentic video creation and editing

Date checked: 11 October 2026. The aim is to strengthen Agent Bros. Pictures with a shared timeline, a template catalogue, media management and quality checks. First adapt these capabilities to Remotion; assess a second engine as a separate pilot.

## Depth of review

For Hyperframes, selected sources for the registry, media management, composition checks and the audio mixer types were reviewed. For Claude Motion, the sources for the timeline, graphic primitives, contact sheets, sound synthesis and mastering, beat analysis and frame-by-frame capture of simulations were reviewed. Then selected sources of the other systems in the table, OpenCut Classic and the small Freesound MCP were reviewed. This is a selective audit, without installing dependencies or running third-party renders. The pinned commits are listed in [CREDITS.md](../CREDITS.md).

| Reference | Review | Application |
|---|---|---|
| [Hyperframes](https://github.com/heygen-com/hyperframes) | Selected sources, README, LICENSE | Block catalogue, media, checks, optional HTML renderer |
| [Claude Motion](https://github.com/whaleyxbt/claude-motion) | Selected sources, README, LICENSE | Shared timeline, review, procedural SFX, beat map |
| [Remotion Skills](https://github.com/remotion-dev/skills) | Sources for router, captions, text measurement, parameters, sync script | API knowledge and separate workflows |
| [Prompt to Motion Graphics](https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas) | Sources for route, skills, compiler, auto-correction | Guidance/examples, targeted edits, a bounded repair loop |
| [DaVinci Resolve MCP](https://github.com/samuelgursky/davinci-resolve-mcp) | Sources for Cut-IR, edit plans, readback, mix, mode probes | Edit proposals, actual verification of the result, finishing bridge |
| [MoviePy MCP](https://github.com/vive1101011/moviepy-mcp) | Sources for registry/tools/export and selected tests | Clip operations without changing the source, metadata, duration invariants |
| [VideoAgent](https://github.com/HKUDS/VideoAgent) | Sources for planner, preloader/searcher/editor, rhythm | Search for B-roll and meaningful intervals; timing/JSON need adapting |
| [OpenCut](https://github.com/OpenCut-app/OpenCut) | Rewrite skeleton + Classic commands, split, timeline, exporter | Undo/redo, exact timing, review UI; rewrite API/MCP/headless still future |
| [Freesound MCP](https://github.com/johnkimdw/freesound-mcp-server) | Source of a small search server | Discovery with metadata/preview; CC0 filtering and originals to be implemented separately |

Carrying code over requires a licence and compatibility check. For Remotion Skills and the Prompt-to-motion template, no root LICENSE was found in the snapshots examined; MoviePy MCP declares MIT in metadata without a separate LICENSE. Declared capabilities and sources read do not mean the integration has been verified in our environment. Sources and pinned commits are in [CREDITS.md](../CREDITS.md).

## Hyperframes

Snapshot reviewed: `9e9b613ccf867f98838617f7424967e056e63de2`.

### Registry of components and ready-made scenes

[registry/types.ts](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/packages/core/src/registry/types.ts) separates examples, blocks and components. [data-chart](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/registry/blocks/data-chart/registry-item.json) stores dimensions, duration, tags, parameters and links to the video/poster. [wordmark-tiles](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/registry/components/wordmark-tiles/registry-item.json) adds variable roles, constraints and sync points.

The proposal is to create our own registry with a Zod schema: ID, version, component, category, tags, formats, props schema, duration, syncPoints, safe zones, preview, provenance and licence. The storyboarder chooses a checked template, the composer fills in the data. Initial candidates: chart callout, product showcase, chat reveal, testimonial, kinetic title, subtitle highlight.

Port the HTML/GSAP implementation of a visual block to React and the Remotion APIs. Keep the existing components and design-tokens as the foundation.

### Media management

[manifest.mjs](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/packages/cli/src/media-use/lib/manifest.mjs) contains append-only records, provenance, search by normalised prompt and entity, a lock on ID allocation, file reservation and cleanup of a failed result. [manifest.test.mjs](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/packages/cli/src/media-use/lib/manifest.test.mjs) gives examples of testing this contract.

The proposal is to extend `src/lib/asset-dispatcher.ts` with an asset library: ID, version, character/location/product ID, references, model/endpoint, parameters, prompt, hash, approval, provenance, licence, provider request ID. First local SQLite and files, then object storage.

Search by normalised prompt is useful for suggesting reuse, but is not enough for a generation cache key. The key must include the model, parameters, dimensions, seed and reference hashes. Reserving a file is not the same as reserving funds: implement budget reservation separately.

### Composition checks

[check.ts](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/packages/cli/src/commands/check.ts) and [checkPipeline.ts](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/packages/cli/src/utils/checkPipeline.ts) combine lint and in-browser checks, have a JSON report, a choice of time points, transition boundaries and a strict mode. The [caption rules](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/packages/lint/src/rules/captions.ts) check, among other things, the risks of overflow and clipping of enlarged words.

Adaptation: extend `pipeline-check`, `validate-render` and `qa-screenshots` with checks for safe zones, text fit, missing media, contrast and frames around transitions. Errors block release; warnings are kept separate. Do not carry HTML-specific regexes or the Hyperframes editor's requirements over into Remotion.

### Sound and workflows

[audioMixer.types.ts](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/packages/engine/src/services/audioMixer.types.ts) describes source and edit times, volume keyframes, fades, FX tails, groups and structured errors. It is a data-model reference; this audit did not check the mixing implementation in full.

The proposal is to introduce separate presenter, voiceover, music and SFX tracks, their envelopes and groups. Shared presenter/audio lives outside the left-panel transitions. `audio-mix.json` must describe executable mix settings.

Of the Hyperframes workflows, the useful ones are product launch, faceless explainer, talking-head recut, captions-only, music-to-video and a short motion graphic. Our router must choose the stages needed, not run all 16 for every task.

### Integration boundary

Hyperframes uses HTML and seekable adapters for GSAP/CSS/other runtimes; that is a different determinism contract. Inside our Remotion compositions the AGENTS.md prohibitions remain. A second-engine pilot must produce a separate MP4 or a compatible transparent overlay that is imported as an asset; do not mix engine clocks in one composition.

The current README requires Node 22+, our project declares Node 20+. The pilot checks the environment separately. The [LICENSE](https://github.com/heygen-com/hyperframes/blob/9e9b613ccf867f98838617f7424967e056e63de2/LICENSE) is Apache-2.0; when carrying code over, keep the licence, the required notices and change markings. Check the licences of third-party assets separately.

## Claude Motion

Snapshot reviewed: `e627941543d9988b155dc610bb9cc0115a5e365e`.

### Shared event map

[timeline.json](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/timeline.json) contains named events. [src/lib.ts](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/src/lib.ts), the sound cues and the contact sheets use this map.

For our system a generated `timeline.json` is proposed: scenes, clips, speech, captions, visualEvents, audioCues, transitions and reviewPoints. It is compiled from storyboard/rhythm/caption-edit/audio-mix; the agent does not maintain several independent clocks by hand. Distinguish source time from output time, compute transitions once and check clip boundaries.

Criterion: moving one event updates the linked visual accent, SFX and review frame; continuous speech does not shift because of a panel change.

### Contact sheets

[sheet.mjs](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/scripts/sheet.mjs) extracts frames by event or interval, labels the time and assembles them into a grid. For transitions a denser interval can be set.

Adaptation: cheap draft → contact sheet of key events and transitions → visual check → fix → re-check → final render. Our version must follow the single JSON CLI contract and write its output to the specific project's directory. Supplement the contact sheet with short video/audio fragments: still frames do not check lip-sync or speech quality.

### Procedural sound

[synth.py](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/sfx/synth.py) generates clicks, typing, pops, chimes, whooshes, risers, impacts and pads. [mix.py](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/sfx/mix.py) places sound in time and uses a seed, pan and mastering; [loudness.py](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/sfx/loudness.py) calculates loudness for stereo 48 kHz and an approximate true peak.

The proposal is a `procedural-sfx` source: generate simple UI sounds and transitions locally, cache by parameters, keep provenance. Leave realistic sounds and music to the existing providers. First presets: click, pop, whoosh, riser, impact.

Check mastering against FFmpeg and measure the final AAC after the mux. The Python model holds sample arrays and makes several passes; a long video needs a memory and time estimate. The loudness target must be set by the output profile, not be one global number.

### Beat map and simulations

[beats.py](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/sims/beats.py) estimates tempo, beats, downbeats, kicks, energy and the drop. The algorithm has tempo preferences and assumes grouping in fours; its result should be treated as a hint, with manual overrides and checks for silence and short files.

[capture.mjs](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/sims/capture.mjs) calls `window.SIM.render(t)`, captures Chromium frames and passes them to FFmpeg. It is a reference for a separate source of 3D/simulation video. The pilot must check for an identical result with sequential and random seek, asset readiness and FFmpeg exit codes.

### Graphic primitives and limits

[primitives.tsx](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/src/components/primitives.tsx) contains masked reveal, rolling values, grain and line boil. Grain and line boil can be adapted to our tokens and frame/fps; the source's fixed frame step does not guarantee the same effect rate at 30 and 60 fps.

Masked reveal and rolling text use translateY; this is acceptable as long as the value remains a pure function of the frame. Adapt to our tokens. Do not carry over the built-in colours, sizes, watermark and 60 fps as global defaults.

The [LICENSE](https://github.com/whaleyxbt/claude-motion/blob/e627941543d9988b155dc610bb9cc0115a5e365e/LICENSE) is MIT. Carrying over substantial parts of the code requires keeping the copyright and the licence text; Remotion and third-party dependencies have separate terms.

## Adaptation tasks

| Order | Task | Place in our system | Readiness check |
|---|---|---|---|
| 1 | Compiled shared timeline | pipeline types, rhythm, composer, compositions | Fade/cut/custom durations do not wrongly change duration or speech continuity |
| 2 | Draft and per-event contact sheets | render-project, qa-screenshots, validate-render | Every event and transition has labelled frames in all formats |
| 3 | Registry of the first six templates | templates, Zod schemas, storyboarder | Previews, props, constraints, provenance and valid examples |
| 4 | Media manifest and entity library | asset-dispatcher, shared assets | Reuse, reference version, no collisions between parallel writes |
| 5 | Preflight and blocking QA | pipeline-check, validate-render | A safe zone/missing media/invalid timing error blocks release |
| 6 | Five procedural SFX | audio, dispatcher, pricing | Reproducible WAV, provenance record, valid JSON CLI |
| 7 | Beat map and mix automation | rhythm, audio-mix | Overrides, correct behaviour on silence and a short track, loudness after AAC |
| 8 | Workflow router | creative-studio, pipeline state | captions-only/recut do not run unnecessary generation |
| 9 | Optional HTML or simulation renderer | separate asset provider | Comparison with Remotion on quality, seek, time, memory and maintenance |

These tasks complement the basic fixes to the budget, CLI contracts and state machine. New tools must call the shared business logic, keep project-scoped outputs and not bypass spending checks.
