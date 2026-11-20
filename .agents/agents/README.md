# Creative Studio Agents

Specialised leaf subagents, one definition per file in this directory; each file's front matter (`name`, `description`, `model`, `tools`) is the source of truth, and `tests/agents-readme.test.ts` keeps this page in step with it. Film agents are dispatched by the `/creative-studio` skill (`.agents/skills/creative-studio/SKILL.md`); `footage-editor` edits a user's own recording outside the chain ([footage editing](../../docs/footage-editing.md)); `campaign-producer` and the two Blender improvement agents are described at the end.

**Bespoke mode** follows the [production chain](../../docs/production-chain.md): `film:next` says who runs next and `film:brief` writes their prompt, which they read by path. Its agents: `brief-collector`, `concept-director`, `category-scout`, `reference-analyst`, `strategist`, `creative-director`, `sound-director`, `script-writer`, `design-director`, `narrator-director`, `asset-planner`, `motion-director`, `motion-engineer`, `creative-critic`, `fixer`, with `qa-reviewer` for technical checks.

**A `project.json` project** (a recipe draft, a campaign child, `project:new`, or an old template-mode project whose `pipeline/pipeline-state.json` is now ignored) is on the timeline route: `pnpm next` renders, checks and delivers it, with no stage agents. The 16-stage template pipeline and its stage-only agents were removed on 2026-11-17. `narrator-director`, `voice-producer` and `caption-editor` serve the chain's `narration` step.

---

## Agents

### Bespoke chain: brief, words, look, material, checks

#### brief-collector (sonnet)

Step `intake`: one message of questions that only someone who read the material could ask; writes `pipeline/brief.json` and `brief.md`. Never invents a detail.

#### script-writer (opus)

Step `script-variants`: one script variant (`--variant a|b|c`), every line tied to a section of the chosen track; a creative director picks the winner blind.

#### design-director (opus)

Step `look`: derives the look from the idea and the reference's measurements, proved by at least three styleframes rendered from real code, library blocks first.

#### asset-planner (sonnet)

Step `material`: `material.json`, shot by shot with provenance, licence and cost, before anything is fetched or generated.

### Generated voiceover

#### narrator-director (opus)

**Identity:** Performance director and voice coach; owns the film chain's `narration` step. Chooses the voice from the brief and script, directs each beat with audio tags, punctuation pauses (no SSML) and emphasis without altering copy, quotes the takes; after the user's yes makes them and runs `narration:check`.\
**Reads:** `pipeline/brief.json`, `pipeline/script.json`, `pipeline/script-music-map.json`, `pipeline/music-decision.json`, `pipeline/audio-map.json`.\
**Writes:** `pipeline/narrator-direction.json`, `pipeline/narration.md`, takes in `voiceover/`, `pipeline/narration.json` (by `narration:check`).\
**Gate:** user (the direction and its spend, then the takes by ear).\
**Dispatch when:** `film:next` names the narration step ([narration](../../docs/production-chain/narration.md)).

---

#### voice-producer (haiku)

**Identity:** Batch operator with no creative opinion. Remakes or resumes the takes of an approved `narrator-direction.json` (`generate:voiceover --directed`, or `voiceover:local` and `speech:local`), then `narration:check`.\
**Reads:** `pipeline/script.json`, `pipeline/narrator-direction.json`, `pipeline/narration.json`.\
**Writes:** `voiceover/{beatId}.mp3` with `.take.json` and `.words.json`, `pipeline/narration.json`.\
**Gate:** none; paid takes only on the user's approval of the current direction.\
**Dispatch when:** a retake or a resumed paid run is needed outside the narration step's owner.

---

#### caption-editor (sonnet)

Generated narration only. Subtitles or a transcript of a user's own recording go to `footage-editor`.

**Identity:** Caption editor with TikTok and YouTube Shorts sensibility. Reviews the caption words `narration:check` writes from the takes' word timings (filler removal, orphan merging, emphasis from the direction) against the script.\
**Reads:** `pipeline/script.json`, `pipeline/narrator-direction.json`, `pipeline/narration.json`, `voiceover/{beatId}.words.edited.json`.\
**Writes:** `pipeline/caption-review.md`.\
**Gate:** none.\
**Dispatch when:** captions of a narrated film need review before the build.

---

### Reference and checks

#### reference-analyst (opus)

Watches one reference film frame by frame and writes its judged layers (`story`, `visual`, `edit`, `techniques`, `blueprint`) and a Russian `breakdown.md`.

**Dispatch when:** `pnpm ref:analyze` has produced the measured layers and a film needs studying.

#### qa-reviewer (opus)

Technical QA of a bespoke film only (no taste; taste belongs to `creative-critic`): measured checks with times, `skipped` never a pass, and the delivery verdict left to the user.

#### colourist (opus)

Measures and grades a clip, generated shot or edit with the local colour commands (`colour:scopes`, `colour:compare`, `colour:match`, `colour:grade`, `colour:shots`, `colour:track`): measure, look, propose, apply, re-measure, compare, report evidence. Never judges taste ([colour grading](../../docs/colour-grading.md)).

**Dispatch when:** a grade drifts from its source, shots do not match, skin or white balance is off, or a look or LUT is wanted.

#### fixer (sonnet)

One round of a critic's or `film:measure`'s ranked list, in order, without grading the result; also a campaign repair brief (`CampaignRepairSchema`).

---

### Bespoke chain: ideas, music, motion and critique

Dispatched through `pnpm film:brief --project <id> --step <step>`; each definition is the source of its rules.

#### concept-director (opus)
Steps `truth` and `ideas`: sorts the product's claims by its own statuses; as one concept team with one stance (`--team`), writes four to six raw ideas that differ in the picture, apart from the other teams.

#### category-scout (sonnet)
Step `discovery`: scans 10–15 short ads in the product's category from text and page descriptions only, with category terms only, never the product's name or private details; writes `category-scan.json` with concrete visual clichés, white space and methods to learn, so the concept teams can ban the obvious.

#### strategist (opus)
Step `strategy`: audience and their moment, platform and sound, one proposition, the 2-second hook mechanic, tone, mandatories, forbidden, success criteria and the film type, before any idea.

#### creative-director (opus)
Steps `idea-review` and `script-review` (`--role critic`): scores an anonymised pool blind on the project's frozen rubric (v2, or v1 for benchmarks) and judges the best pairwise in both orders; code ranks. New every round; never resumed. Step `concept`: presents the top three with boards from library blocks.

#### sound-director (opus)
Steps `music` and `sound`: puts the music route to the user, builds a fitted shortlist, and after picture lock designs and mixes the sound.

#### motion-director (opus)
Beat-sheet step: writes the film on paper from its music, shot by shot (`motion-plan.json`, cue sheet), until `plan:check` passes.

#### motion-engineer (opus)
Animatic and build steps: builds the film from the motion plan, scene by scene, through stills, frame strips and `motion:check`.

#### creative-critic (opus)
Steps `critic` and `look`: harsh, independent judge of a render or styleframe sheet. New every round; never resumed.

### Footage editing

#### footage-editor (sonnet)
A user's own recording: transcript (`speech:local` free, `transcribe` paid only on approval), `footage:shots`, `recut:plan`, caption style, shorts, `multicam:sync`/`multicam:angles` and `reframe:track`. Proposes plans with hashes; the user approves before anything is created.

**Dispatch when:** the user asks to cut, subtitle, shorten, reframe or sync their own footage.

---

## Model rationale

| Model | Agents | Reason |
|-------|--------|--------|
| **Opus** | script-writer, design-director, narrator-director, reference-analyst, qa-reviewer, colourist, concept-director, strategist, creative-director, sound-director, motion-director, motion-engineer, creative-critic, campaign-producer | Creative and architectural decisions where wrong choices compound downstream; narrator-director requires performance judgement that maps emotional arc to delivery cues |
| **Sonnet** | brief-collector, category-scout, asset-planner, caption-editor, fixer, footage-editor | Structured generation with clear contracts; deterministic mapping from inputs to outputs; caption-editor is a pure-function transform |
| **Haiku** | voice-producer | IO-heavy batch execution with no judgement; fast and inexpensive |
| **Inherit** | blender-critic, blender-advisor | `blender:improve` runs them as fresh Codex sessions with the model it pins itself; under Claude Code they take the session's model |

---

## Dispatch protocol

Claude compatibility paths in `.claude/agents` and `.claude/skills` resolve to these canonical definitions. Codex reads `.agents/skills`; `pnpm harness:setup` generates `.codex/agents/*.toml` (and Copilot and OpenCode files) from these definitions, and `avc_guide kind=agent` serves them to any MCP harness ([harnesses](../../docs/harnesses.md)). Use the configured harness model: Claude frontmatter labels are not Codex model IDs.

The Claude orchestrator invokes each agent via:

```ts
Agent({ subagent_type: "<name>", prompt: "...inputs..." })
```

Agents are leaf agents (depth 1) — they **must not** spawn sub-agents.

---

## State

A bespoke film's state is derived from its files and hashes (`src/lib/film/state.ts`); there is no stage state file. `pipeline/pipeline-state.json` belonged to the removed 16-stage template pipeline: `pnpm next` ignores it, and only an old film's `approve` entries in it still count, when no newer than the artefact (`legacyApproved`).

---

## Adding a new agent

1. Create `.agents/agents/<name>.md` with `name`, `description`, `model`, and `tools` frontmatter.
2. Wire its dispatch: a chain step in `film:brief` (`src/lib/film/chain.ts`).
3. Update this README with a block in the appropriate section above.

---

## Naming and tone

- British English throughout (colour, optimise, behaviour)
- No emojis
- Agents speak as their role: a script-writer "writes scripts", not "I will produce scripts"

---

## Scripts catalogue

All production scripts live in `scripts/`. Every script follows the same JSON output contract: stdout is one line `{ ok: bool, outputs?, metadata?, elapsedMs, error?, message?, retryAfterMs? }`, stderr is human progress, exit 0 on success.

| Script | Owner agent | Purpose |
|---|---|---|
| `generate-model.ts` | asset-fetch dispatch | Exact modern fal operations (image, video, presenter) through durable jobs and the budget layer |
| `generate-voiceover.ts` | narrator-director, voice-producer | Narrator takes per script beat from narrator-direction.json (`--directed`) |
| `narration-check.ts` | narrator-director, voice-producer, caption-editor | Film narration: takes measured, receipts and words checked, caption words written |
| `generate-music.ts` | asset-fetch dispatch | Background music via ElevenLabs Music API |
| `asset-fetch.ts` | fixer (single asset re-run) | Single-asset fetch dispatcher; reads asset-plan.json spec and calls correct backend |
| `asset-fetch-all.ts` | orchestrator (material fetch) | Batch dispatcher for the full asset stage; iterates asset-plan.json |
| `validate-render.ts` | qa-reviewer, fixer | Render QA bundle: ffprobe metadata + ffmpeg frame extraction + health findings |
| `pipeline-check.ts` | fixer, qa-reviewer | Stateless findings probe: artefact schemas, file references, charts, creative and film findings |
| `align-captions.ts` | fixer | ElevenLabs forced alignment → per-scene .words.json |
| `edit-captions.ts` | manual | Generated-voiceover captions: filler removal + emphasis marking + .words.edited.json output (not for user footage) |
| `measure-audio-durations.ts` | manual | ffprobe-backed duration map for all scene MP3s |
| `transcribe.ts` | qa-reviewer (optional) | Audio/video → `TranscriptSchema` transcript via ElevenLabs Scribe (v3 default) |
| `rmbg.ts` | asset-fetch dispatch | Background removal via fal.ai birefnet |
| `upscale.ts` | asset-fetch dispatch | 4× image upscale via fal.ai aura-sr |
| `fetch-sound-effects.ts` | asset-fetch dispatch | Freesound CC0 SFX search and download |
| `fetch-lottie.ts` | asset-fetch dispatch | LottieFiles animation search and download |
| `resources.ts` | asset-fetch dispatch, asset-planner | Ranked stock search (Unsplash, Pexels, Pixabay, Openverse, Wikimedia, NASA) and rights-checked acquisition |
| `slice-talking-head.ts` | manual talking-head workflow | ffmpeg-based per-scene clip extraction from full presenter take |
| `render-project.ts` | orchestrator (render step) | Remotion render via CLI; resolves composition id from prefix map |

---

## See also

- `src/types/pipeline.ts` — Zod schemas the agents must produce
- `src/types/video.ts` — `LeftPanelSchema` discriminated union
- `src/lib/film/state.ts` — the bespoke chain's derived step states
- `src/lib/design-tokens.ts` — canonical design system (typography, gradients, animation presets)
- `.agents/skills/creative-studio/SKILL.md` — orchestrator skill
- `AGENTS.md` — canonical project conventions (typography, animation rules, media rules)

## Blender improvement agents

`blender-critic` judges one blind packet per fresh round/order, with cited frames and JSON scores. `blender-advisor` reads critiques, gaps and arsenal/history snapshots and proposes at most three testable system changes. Both are leaf agents; the orchestrator implements, tests and logs through `blender:improve`. See [self-improvement](../skills/blender-3d/references/self-improvement.md).

## Campaign production

`campaign-producer` authors an exact variant/campaign request, source bindings, reuse and model needs. campaign:brief scopes one task; existing specialists and fresh creative critics execute child work. User approvals remain exact package decisions. See [campaign production](../../docs/campaign-production.md).
