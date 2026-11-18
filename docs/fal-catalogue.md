# Discover provider endpoints offline
For production recommendations use `pnpm models:pick --task TASK` or a use case/slot from [the slot guide](model-slots-guide.md). The endpoint names below document provider contracts, prompting syntax and historical verification.


Last updated: 2026-11-15

Start with `pnpm fal:find --provider any --task "оживить фото 10 секунд 9:16 1080p" --min-tier verified --explain`. Russian and English concept token groups select categories and media hints regardless of word order; explicit flags override the derived values. `--category`, `--inputs` and `--outputs` take comma-separated lists. Aspect, resolution and `--max-usd` are filters. Duration is a filter for generated media; text-to-speech, speech-to-speech, audio-to-audio, speech-to-text, audio-to-text and audio-to-video instead warn that length follows the input and the script or source audio should be planned for the requested seconds. This applies to both parsed duration and explicit `--duration`, even when a duration schema field exists. Higgsfield source-video workflows report inherited aspect/duration for source preparation; schema-less opt-ins report unvalidated capabilities. Unsupported or unbounded constraints are rejected; `--explain` includes at most ten rejected rows.

1. Inspect the shortlist's reasons, warnings, estimate and next commands. Retiring, schema-less and training endpoints are excluded by default; training needs an explicit training task/category. `--include-retiring` and `--include-schemaless` are explicit opt-ins.
2. Inspect `pnpm fal:models --schema ENDPOINT`, then preview `pnpm fal:scaffold --endpoint ENDPOINT`. Missing strings appear as `<FILL: field>`; field hints include enums, bounds and defaults. Nothing is written without `--out`.
3. Fill fields with repeated `--set prompt="A quiet coast" --set duration=10`, or dotted object fields such as `--set image_size.width=1080`. Values parse as JSON when possible. Use `--out REQUEST.json` to write under the workspace or a temporary directory; overwriting requires `--force`. `valid: true` means the schema and operation guards passed with no placeholders. `SCHEMA_NOT_CACHED` supplies a sync `nextAction`; discovery never fetches it automatically.
4. Run `pnpm generate:model --request REQUEST.json --project PROJECT --output OUTPUT --dry-run`. Review the exact plan, media constraints, quote and durable budget before authorising generation. For variations, prepare a [batch spec](fal-integration.md#jobs-batches-and-result-handoff), then run `pnpm fal:batch --spec BATCH.json --project PROJECT --dry-run` and review its aggregate quote and budget verdict before authorising execution.

`fal:models --catalogue --list` lists the whole offline index. Category, tier, search and schema queries use the catalogue by default. `--local` retains the original exact family/operation/region/transport discovery; `--online` selects the existing Platform API behaviour. Search covers endpoint IDs, display names and tags. `--retiring` lists only entries with a retirement date.

Trust is evidence, separate from creative curation:

| Tier | Evidence |
|---|---|
| discovered | Pinned schema; price may be unknown |
| priced | Dated price record |
| verified | Guard, extraction and offline contract coverage |
| live | Accepted real-run receipt; no tracked entry claims this yet |

Ranking adds category (100), each required input (20), each constraint (10), bounded price (up to 10, cheaper first), trust (0/30/200/240), documented curation (5, or 25 for a matching role), and retirement (-100). Within dated Higgsfield families/roles, release recency adds up to 12; exclusive entries add 2 only for a curated role. fal release dates stay unknown; its `firstSeen` retains the existing fal-only tie-break. Provider plus endpoint makes the final deterministic key. Curation is sourced from the creative candidates guide, music allow-list and verified endpoint evidence below, never inferred quality rankings.

Estimates use the repository quote engine and endpoint price units. A bounded list-rate quote is a planning assumption, not an invoice. Token forecasts, missing quantities and unknown tariffs remain unbounded and warn `needs --max-cost-usd`; `--max-usd` excludes them. A higher trust tier does not guarantee a bounded price or live acceptance.

`--provider fal|higgsfield|any` selects the catalogue; the default is `any` when HIGGSFIELD_API_KEY is present, otherwise `fal`. Results carry provider, release date, labelled price and commands. Floors never admit `--max-usd`; unknown prices are not cheap. See [Higgsfield model choice](higgsfield.md#choosing-a-model) for cross-provider examples, provider-specific scaffolds and equivalents.

## Capabilities

One vocabulary, read from catalogue input fields of both providers ([capabilities.ts](../src/lib/models/capabilities.ts)), answers "which models can do this, within these limits, at what price" (2026-11-17). `pnpm models:capabilities --list` prints each capability with its proving fields and active-model counts per provider; `--endpoint ID [--provider fal|higgsfield]` prints one profile: capabilities with the field that proves each, duration, aspect, resolution and fps limits, maximum reference images, stated input audio/video seconds, input media, output kinds and the price for the scenario given (`--duration --resolution --aspect --audio on|off --chars`; `bounded`, `estimated` or `unknown`, with kind, label and source).

| Group | Capabilities |
|---|---|
| Inputs | `image-input`, `start-frame`, `end-frame`, `multi-reference`, `video-input`, `audio-input`, `mask`, `style-reference`, `character-reference`, `elements`, `keyframes` |
| Sound and speech | `generate-audio`, `audio-driven` (lip sync, avatars), `voice`, `voice-clone`, `lyrics`, `language` |
| Control | `seed`, `negative-prompt`, `camera-control`, `loop`, `multi-shot`, `style-preset`, `lora`, `fps`, `guidance`, `steps`, `prompt-expansion`, `safety-tolerance`, `web-search` |
| Output | `num-outputs`, `transparent-background`, `output-format`, `upscale-factor` |

Search: `--capability a,b` requires all, `--any-capability a,b` at least one, `--field REGEX` matches raw schema field names when the vocabulary lacks a word; they combine with `--category --inputs --outputs --duration --aspect --resolution --max-usd` and rank through the `fal:find` finder, which takes the same flags (as does `models:pick`). Rows list each matched capability with its field. `--input-audio-sec N` / `--input-video-sec N` reject a model whose schema states a lower maximum (Higgsfield field descriptions; fal `x-fal` bounds only when the local schema cache holds them) and warn when the limit is unknown, which is most fal entries.

```bash
pnpm models:capabilities --capability end-frame,generate-audio --duration 5 --max-usd 1
pnpm models:capabilities --capability multi-reference --category text-to-image --explain
pnpm models:capabilities --inputs video --input-video-sec 40 --provider higgsfield
pnpm models:capabilities --any-capability voice-clone,voice --category text-to-speech
pnpm models:capabilities --field "^camera_" --category image-to-video
```

MCP exposes local `avc_models_compare`, `avc_models_capabilities`, provider-aware `avc_fal_find`, `avc_fal_scaffold`, `avc_fal_quote` and read-only `avc_fal_doctor` (no catalogue path override). Scaffold's `set-json` accepts a JSON string array of assignments; `out` is scoped and cannot overwrite. `avc_models` supports category, tier, search and limit, returning 50 rows by default and at most 100.


## Task matching and no match

CLI and MCP `avc_fal_find` metadata always includes `match: { matched, via, concepts }`. `via` is `task-map`, `lexical`, `explicit` or `none`. Explicit non-empty `--category`, `--inputs` or `--outputs` take precedence. A recognised concept can have zero compatible endpoints after filtering: `matched: true` describes the task signal, not endpoint availability.

With no signal, discovery returns `ok: true`, `match: { matched: false, via: "none", concepts: [] }`, `candidates: []`, a short `message`, and three `suggestions` containing concept groups, categories and example commands. It does not rank the catalogue, even with `--explain`. Rephrase or use, for example, `pnpm fal:find --provider any --category image-to-image --inputs image --outputs image`. Never choose from an unmatched list.

Concepts use unordered `anyOf` token sets, `allOf` alternative groups and optional `noneOf` exclusions. Normalisation lowercases, folds ё to е, strips punctuation and applies a small deterministic Russian/English suffix stemmer; explicit `*` synonyms match prefixes. Technical directional labels such as text-to-speech stay atomic so their reverse has a different meaning. Concept `suppressedBy` exclusions first run once against all phrase matches: explicit upscale, denoise, cutout, background replacement, interpolation or video analysis suppress photo animation, so a source-photo mention cannot admit video generators. Remaining selection is deterministic in map order: if any specialist matches, all generic generation/editing concepts are suppressed; otherwise, another generic concept suppresses mere text-to-video. Music generation also uses `suppressedBy` for stem separation, denoise and voice change. Modifiers do not participate in suppression. Hero, fast-draft and budget modifiers boost curated roles without selecting categories or bypassing specialist hints.

If no category concept matches, lexical fallback checks endpoint ID, display name, tags and family title (3 points per overlapping token) and description (1 point). It needs at least 3 points and half of the informative query tokens; stopwords and generic media words do not contribute. Only meaningful hits in categories within 80% of the best score enter ranking. Each result warns that this is a lexical match. `match.via: "lexical"` and `matched: false` both include a ready `nextActions` command using `pnpm memory --add --type gap --agent orchestrator --evidence ...`; discovery never writes memory itself. The summary is bounded to memory's 160 characters and the evidence preserves the whole task.

Library callers can use `findFalEndpointResult(query, options?)` for this full result. The existing `findFalEndpoints` array API delegates to it; calls omitting `task` retain legacy catalogue browsing. CLI and MCP always use honest discovery, including when no task is supplied.

To add a concept, edit `src/lib/models/fal-task-map.ts`, inspect real catalogue terminology before choosing hints, and add Russian/English examples to `tests/fixtures/task-map/golden.json`. Run `tests/fal-task-coverage.test.ts`, `tests/fal-task-golden.test.ts` and `tests/fal-find-match.test.ts` alongside the existing fal/Higgsfield ranking tests. Coverage checks every schema category except `unknown`, every curation role, every raw tracked catalogue category except `unknown`, and a golden witness for each concept. A new category in a daily models-refresh PR fails this gate until a concept is added; unknown rows declare no capability to map.

For upscale, cutout, background replacement, denoise and interpolation, a named video (`video`, `видео`, `ролик`, `клип`, including inflections) requires video-to-video, video input and video output. A named image selects image-to-image; video takes precedence when both visual media are named. Denoise with an explicitly named audio/speech track retains audio-to-audio even when a containing video is mentioned. Directional labels such as video-to-video also identify the medium. Unqualified upscale/cutout/background replacement default to images, denoise to audio, and interpolation retains both image-pair and video routes. Image upscalers cannot satisfy a video request. Background replacement selects editors rather than removal-only endpoints. Ordinary text translation/rewriting excludes catalogue rows containing `lyrics`; explicit lyrics/song/песня requests allow them. Voice cloning, background replacement and 3D texturing require capability hints even when a broad curated role overlaps.

Lip-sync candidates align supplied speech; a translation-with-lip-sync request still needs separately translated audio. Recurring-character discovery shortlists character image/reference workflows; continuity across all scenes requires reusing the approved references.

### Concept inventory

| Concept | Categories | Roles |
|---|---|---|
| character-swap | video-to-video | motion-transfer, character-swap |
| character-in-video | video-to-video | motion-transfer, character-swap |
| restyle | video-to-video | restyle |
| object-swap | video-to-video | edit, reference |
| influencer | text-to-image | character |
| ad-image | text-to-image, image-to-image | ads |
| cinematic | text-to-video, image-to-video | cinematic |
| animate-photo | image-to-video | reference |
| inpaint | image-to-image | inpaint |
| outpaint | image-to-image | outpaint |
| denoise | audio-to-audio, video-to-video, image-to-image (medium selected) | — |
| stem-separation | audio-to-audio | analysis |
| voice-change | audio-to-audio, speech-to-speech | voice |
| voice-clone | audio-to-audio, text-to-speech | voice |
| character-consistency | text-to-image, image-to-image | character |
| avatar | audio-to-video, image-to-video, text-to-video | avatar |
| try-on | image-to-image | — |
| text-render | text-to-image, image-to-image | text-render |
| frame-interpolation | video-to-video, image-to-image | frame-interpolation |
| 3d-texture | 3d-to-3d | mesh |
| 3d-edit | 3d-to-3d | mesh |
| world | worlds | world |
| structured-data | text-to-json, image-to-json, json | analysis |
| text-json | text-to-json | analysis |
| image-json | image-to-json | analysis |
| rewrite | text-to-text, llm | analysis |
| transcript | speech-to-text, audio-to-text | transcript |
| cutout | image-to-image, video-to-video (medium selected) | cutout |
| background-replace | image-to-image, video-to-video (medium selected) | edit |
| upscale | image-to-image, video-to-video (medium selected; default image) | upscale |
| lipsync | audio-to-video, video-to-video | lipsync |
| music | text-to-audio | music |
| sfx | text-to-audio, video-to-audio | sfx, foley |
| describe-video | video-to-text, vision | analysis |
| vision | video-to-text, vision, image-to-text | analysis |
| llm | llm | analysis |
| training | training | training |
| workflow | workflow | — |
| image-edit | image-to-image | edit |
| video-edit | video-to-video | edit |
| voiceover | text-to-speech | voice |
| mesh | image-to-3d, text-to-3d | mesh |
| text-to-video | text-to-video | — |
| text-to-image | text-to-image | — |
| hero | Modifier only | hero |
| fast-draft | Modifier only | fast-draft |
| budget | Modifier only | budget |


## Verified endpoints

### Image and video

These image/video role additions have pinned schemas, offline request/result contracts and guards for description-only constraints. All are active with no recorded retirement date. The cache has no current price records for these additions; obtain a bounded quote or supply an authorised positive planning bound. This table makes no quality or live-acceptance claim.

| Endpoint | Category | Role | Selection evidence |
|---|---|---|---|
| `fal-ai/aura-sr` | image-to-image | upscale | Existing command default, retained. |
| `fal-ai/birefnet` | image-to-image | cutout | Existing command default, retained. |
| `fal-ai/birefnet/v2` | image-to-image | cutout | Newest numbered BiRefNet image version; Dynamic resolution guard. |
| `fal-ai/bytedance/omnihuman/v1.5` | image-to-video | avatar | Pinned portrait and speech audio inputs. Request and duration checks verified offline. |
| `fal-ai/image-apps-v2/outpaint` | image-to-image | outpaint | Newest numbered image-apps outpaint version; non-FLUX directional margins. |
| `fal-ai/latentsync` | video-to-video | lipsync | Existing command alternative, retained. |
| `fal-ai/qwen-image-edit/inpaint` | image-to-image | inpaint | Latest explicit inpaint route in this family; non-FLUX mask input. |
| `fal-ai/seedvr/upscale/image` | image-to-image | upscale | SeedVR2, dated later than Aura SR; latest standard family route. |
| `fal-ai/seedvr/upscale/video` | video-to-video | upscale | SeedVR2 standard video route with a complete scalar input schema. |
| `fal-ai/sync-lipsync` | video-to-video | lipsync | Existing command default, retained. |
| `fal-ai/sync-lipsync/v3` | video-to-video | lipsync | Newest numbered Sync version; speaker selection and option precedence guard. |
| `topaz/interpolate/video` | video-to-video | frame-interpolation | Dated 2026-08-11, later than cached FILM; bounded FPS/slowdown fields. |
| `veed/avatars/audio-to-video` | audio-to-video | avatar | Complete audio/avatar-ID schema; schema-less alternatives excluded. |

### Speech

These endpoints have pinned schemas, semantic guards, extraction and offline contract tests (2026-11-15). This is not live acceptance or a quality ranking. All currently lack a price record and require a positive `--max-cost-usd` planning bound for execution. Selection favours active, complete schemas and current vendor versions; no existing harness fal speech endpoint needed preserving.

| Endpoint | Category | Role and selection evidence |
|---|---|---|
| `fal-ai/elevenlabs/speech-to-text/scribe-v2` | speech-to-text | Latest queued Scribe variant in the index; native word times and speaker labels |
| `fal-ai/wizper` | speech-to-text | Whisper v3 with segment timestamps; word timing is explicitly estimated |
| `elevenlabs/tts/eleven-v4` | text-to-speech | Current full ElevenLabs version; optional timestamps, accepted for alignment only when explicitly labelled as words |
| `fal-ai/qwen-3-tts/text-to-speech/1.7b` | text-to-speech | Qwen3 1.7B variant; explicit language enum and audio-only output |
| `nvidia/nemotron-3-nano-omni/audio` | audio-to-text | Current Nano Omni audio variant; prose and usage, English prompts, WAV/MP3 up to 50 minutes; no timed transcript |
| `resemble-ai/chatterboxhd/speech-to-speech` | speech-to-speech | Active HD voice-conversion variant with target voice/reference override semantics |

Use `pnpm transcribe --provider fal --endpoint fal-ai/elevenlabs/speech-to-text/scribe-v2 --input talk.wav --output out/transcript.json --dry-run` to inspect the request and quote without spending. Execution also needs `--project` and budget admission. `--from-raw` replays the saved `.fal.json` or immutable `pipeline/model-results/<operationId>.json` without a provider call. Raw responses are retained; fal transcripts do not establish verbatim filler coverage. Wizper estimates words within segment spans and records `engine.timing: "estimated"`; missing timestamp bounds are never guessed. Scribe keyterms add the schema's 30% premium.

Use `pnpm generate:voiceover --project ID --provider fal --endpoint fal-ai/qwen-3-tts/text-to-speech/1.7b --voice Ryan --language ru --dry-run` for per-scene planning. Language defaults to the brief, then the script; ISO codes are mapped to Qwen's language names and unsupported enum values fail before submission. The same command without dry-run produces `voiceover/<scene>.mp3`. Explicit provider word timing produces `<scene>.words.json` without invented loss/confidence. Character-only or missing timing produces no words file and reports `alignment: "needed"`, with `pnpm align:captions --project ID` as the next action. This alignment command remains template-mode voiceover only. ElevenLabs remains the default provider of both speech commands.

Speech-to-speech endpoints are usable through `generate:model` only. The verified audio-to-text endpoint also uses `generate:model`: its prose output has no timestamp evidence and cannot be normalised into a timed recording transcript. Both follow the endpoint-form request, dry-run quote and durable budget path above.

### 3D and worlds

These rows record offline schema, guard and extraction contracts checked on 2026-11-15, not quality judgements or live-run acceptance. Selection preserves existing harness routes first, then prefers active non-retiring endpoints, the latest version within a family, a priced unit and schemas with no unsupported keywords. No existing specialised harness 3D command or dated price record applies to these selections; unknown prices still need an authorised positive `--max-cost-usd`.

| Endpoint | Category | Role | Selection evidence and constraints |
|---|---|---|---|
| `meshy/v7.1/image-to-3d` | image-to-3d | Mesh from a supplied image | Latest numbered Meshy standard generation version, active and non-retiring; v7 retires. Animation requires rigging; action IDs 0–696; N1 texture restrictions guarded. |
| `meshy/v7.1/text-to-3d` | text-to-3d | Mesh from a description | Latest numbered Meshy standard generation version, active and non-retiring; v7 retires. Same animation and N1 restrictions; full and preview modes covered. |
| `meshy/rigging` | 3d-to-3d | Humanoid rigging and optional animation | Current standalone Meshy route, active and non-retiring; GLB input, action IDs 0–696 when enabled. Humanoid anatomy and skeleton/finger compatibility still need inspection/provider validation. |
| `fal-ai/hunyuan-3d/v3.1/smart-topology` | 3d-to-3d | Retopology | Latest numbered Hunyuan smart-topology family, active and non-retiring; GLB/OBJ input, described 200MB limit guarded against measured bytes (conservative decimal MB). The schema's `model_glb` example is actually OBJ: inspect MIME/extension and select the GLB in `model_urls` when needed. |
| `meshy/n1/retexture` | 3d-to-3d | Reference-image texturing | Current named N1 family, active and non-retiring; distinct from numbered standard texturing. Exactly one single image or 1–4 reference views, enforced by the guard. |

All five input/output schemas have empty `unsupportedKeywords`. Their output `File` objects describe `url` and nullable `content_type`; only `url` is required. Result hosts cannot be established offline: these partners may return non-fal hosts, and execution refuses untrusted hosts by design. Pins, byte-identical schema fixtures and contract tests back each row.

GLB output convention: **`public/projects/<id>/assets/3d/<name>.glb`**. `generate:model` accepts endpoint-form requests; AssetSpec uses `kind: "ai-3d"`, `source: "fal-model"`, `targetPath: "assets/3d/<name>.glb"` and `metadata.operationRequest`. `executeFalOperation` inspects and publishes the GLB as a `model3d` asset. Offline tests exercise both direct publication and the asset-plan → `generate:model` path with a fake queue and a locally built valid GLB. Non-GLB model files remain file publications.

Photo/image hints in 3D tasks (for example `сделать 3d модель из фото` or `3d model from photo`) require an image input. Text-to-3D is offered only when no image candidate passes the filters; explicit `--inputs image` retains that hard requirement without fallback.

## Generated 3D in a film

Use a generated mesh for an invented prop or an approximate shape from a supplied image when no approved model or library block fits. It can save manual modelling, but still needs geometry, UV, material, scale and licence inspection. Use existing phone/laptop GLBs for devices, Blender for exact modelling, simulation or photoreal lighting, and real capture for visual evidence. A generated mesh supplies an asset; three.js or Blender still renders the shot.

The existing `studio-product-stage` block loads shared phone/laptop GLBs with `useGLTF(staticFile(...))` inside `<ThreeCanvas>`. **Gap:** its `shape` prop is limited to `phone`, `laptop` or `card`, with no arbitrary project GLB path. No new library block is added. A bespoke scene can follow the same loader/canvas path:

```tsx
import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { ThreeCanvas } from '@remotion/three';
import { staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

function ProjectMesh() {
  const { scene } = useGLTF(staticFile('projects/ID/assets/3d/prop.glb'));
  const object = useMemo(() => clone(scene), [scene]);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <group rotation={[0, (frame / fps) * 0.35, 0]}><primitive object={object} /></group>;
}

export function GeneratedPropShot() {
  const { width, height } = useVideoConfig();
  return (
    <ThreeCanvas width={width} height={height} camera={{ position: [0, 0, 4] }}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 4, 5]} intensity={2} />
      <ProjectMesh />
    </ThreeCanvas>
  );
}
```

Adjust the static origin, camera and scale after inspecting the mesh. Suspense loading is held by `ThreeCanvas`; rotation depends only on the frame. No `useFrame`, wall-clock animation or automatic clip playback. For rigged models this example renders the rest pose; seek a mixer explicitly to `frame / fps` for each rendered frame, or bake the animation through Blender. Clone skinned scenes with `SkeletonUtils` so instances do not share skeleton state.

For Blender, read [the shot rules](../scripts/blender/AGENTS.md) and the `blender-3d` skill. The existing `scripts/blender/studio_kit.py` helper `import_device(kind_or_path)` calls `bpy.ops.import_scene.gltf` and accepts a GLB path. The shot templates accept that path in their `device` field. Save project shot JSON as `public/projects/ID/assets/blender/prop.json`:

```json
{"device":"public/projects/ID/assets/3d/prop.glb","frames":60,"look":"dark"}
```

```bash
pnpm blender:run --script scripts/blender/hero_turntable.py --output out/ID/prop --frames 1-60 --samples 24 --resolution 1920x1080 --script-args '["public/projects/ID/assets/blender/prop.json"]'
```

The kit expects normalised device geometry (metres, Z up and a `screen` mesh for overlays). It imports and groups an arbitrary GLB without normalising it; generated props may need scale, orientation and material repair in a project scene script. Use a custom script for rigs, clip selection or non-device framing. Inspect look frames before rendering a sequence, then use `blender-plate` for the rendered plate.

## Worlds

The current cached schemas describe a WebRTC/WMA session offer, not a generated mesh or a video-file result:

| Endpoint | Schema input/output | Usable in this harness? |
|---|---|---|
| `alibaba/abot-world-0` | Required `sdp`; `type` is `offer`; optional session/ICE/credential-age fields. `AbotWorld0StartSessionOutput` is `{}`. | No world capture/playback adapter or declared result artefact; retained as discovered. Offline fixture checked. |
| `robbyant/lingbot-world-2` | Same session-offer fields; `LingbotWorld2StartSessionOutput` is `{}`. | Same gap; retained as discovered. Offline fixture checked. |
| `vast/eden-live-14b-game` | Same session-offer fields; `EdenLive14bGameStartSessionOutput` is `{}`. | Same gap; retained as discovered. Offline fixture checked. |
| `vast/eden-live-5b-game` | Same session-offer fields; `EdenLive5bGameStartSessionOutput` is `{}` in the current cache. | Same gap; retained as discovered. |
| `minimax/h3-max/director`, `minimax/h3-max/reference-director` | No cached schema; return shape unknown. | Cannot validate or execute through schema-backed generation. |

An empty output schema permits arbitrary JSON and establishes no specific returned fields, files or model format. The index's `json` kind and `queue` transport for these session offers do not establish a working interactive-world integration. None is promoted to verified: a defined output contract and a dedicated session/capture route are missing. No network or paid calls were used to inspect them.

### Analysis and training

These entries have pinned schemas, offline request/result contracts and semantic guards where the schema descriptions need them. They are active and not retiring in the 2026-11-15 local index. No row claims creative quality or live provider acceptance; none has a bounded catalogue price.

| Endpoint | Category | Role | Selection evidence |
|---|---|---|---|
| `fal-ai/florence-2-large/caption` | vision | Image caption observation | Complete image URL schema; latest indexed Florence caption family. |
| `fal-ai/bytedance/seed/v2/mini` | llm | Multimodal observation | Latest indexed Seed version; image/video URLs; complete schema and explicit input-count limits. |
| `bria/ad-delayer` | image-to-json | Layer description | Public image URL to open JSON; complete schema; no indexed versioned successor. |
| `bria/fibo-lite/generate/structured_prompt` | text-to-json | Structured prompt | Text or image URL to typed JSON; complete schema; indexed Fibo variants have no newer numbered version. |
| `nvidia/nemotron-3-5-super/video` | video-to-text | Video observation | Latest indexed Nemotron version; complete video URL/text schema; guarded duration and pixel limits. |
| `nvidia/nemotron-3-5-super/vision` | image-to-text | Image observation | Latest indexed Nemotron version; complete image URL/text schema; JPEG/PNG format guard. |
| `blackforestlabs/flux-3/klein/base/trainer` | training | LoRA training | Latest indexed FLUX trainer family; complete weights/config schema; unknown training price requires a bound. |

Read generated analysis evidence using `pnpm model:result --project ID --operation-id OPERATION` (`avc_model_result` in MCP). Its summary includes data keys, a text excerpt of at most 2000 characters, files and untrusted URLs, without downloads or spending. QA/reference agents must check the frames themselves; see [model analysis evidence](../.agents/skills/qa-and-delivery/references/model-analysis.md).

The fixture manifest's additive `verifiedSnapshots` map pins current schemas when an endpoint already has an older fixture in `endpoints`; the original mappings remain unchanged for earlier contracts.

### Sound

Offline contracts checked on 2026-11-15, using byte-pinned cached schemas and synthetic results. These rows do not claim live acceptance or audio quality. All selected endpoints are active and non-retiring in the recorded index, with no unsupported input/output schema keywords. Quotes still decide whether a published price is bounded; otherwise an authorised positive `--max-cost-usd` is required.

| Endpoint | Category | Role | Selection evidence |
|---|---|---|---|
| `elevenlabs/sound-effects/v3` | text-to-audio | SFX | Non-retiring v3 successor to retiring ElevenLabs SFX v2; complete schema. |
| `fal-ai/stable-audio-3/small/sfx/text-to-audio` | text-to-audio | SFX | SFX-specific post-trained Stable Audio 3 route, newer than 2.5; complete schema. |
| `mirelo-ai/sfx2.0/video-to-audio` | video-to-audio | Foley | SFX2.0 speech-aware route with explicit duration/sample count; complete schema. |
| `fal-ai/demucs` | audio-to-audio | Stems | Retains the Demucs family used by local `audio:stems`; complete fal schema. |
| `fal-ai/deepfilternet3` | audio-to-audio | Denoise | Latest indexed DeepFilterNet family version, 3; complete schema. |
| `fal-ai/elevenlabs/voice-changer` | audio-to-audio | Voice change | Selectable multilingual/English v2 speech-to-speech models; complete schema. |

SFX endpoints are separate from the music allow-list in `src/lib/providers/fal-music.ts`. Endpoint-form requests through `generate:model` now run that allow-list's prompt-length, duration, seed and negative-prompt guards too. Existing `generate:music --provider fal` inputs and outputs remain unchanged. Lyria 2 and MiniMax 2.6 accept no duration; ElevenLabs Music needs an explicit length or composition plan to bound its quote; MiniMax Music 3 retains the allow-list's instrumental-only route and explicit upper-bound duration.

### Audio-to-audio recipes

Write an endpoint-form request with the following `input`, then run `pnpm generate:model --project ID --request REQUEST.json --output public/projects/ID/assets/audio/take.wav --dry-run`. Review the quote and budget before execution; keep the same operation ID to resume. Use an uploaded HTTPS URL or an imported `asset://sha256/HASH` reference, with measured `context.media` keyed by the actual URL when available. Preserve source rights and reference provenance; voice changes require permission to use the source recording and target voice. Keep original and processed takes separate, and perform these steps before the mix.

| Recipe | Endpoint | Example input |
|---|---|---|
| Extract stems | `fal-ai/demucs` | `{"audio_url":"asset://sha256/HASH","model":"htdemucs_6s","stems":["drums","bass","vocals","other"],"output_format":"wav"}` |
| Denoise speech | `fal-ai/deepfilternet3` | `{"audio_url":"asset://sha256/HASH","audio_format":"wav"}` |
| Change voice | `fal-ai/elevenlabs/voice-changer` | `{"audio_url":"asset://sha256/HASH","voice":"Rachel","model_id":"eleven_multilingual_sts_v2"}` |

Demucs guitar/piano requests require `htdemucs_6s`; results expose named stem fields, published as separate assets (the output path and numbered siblings). Preserve the result's field-to-file mapping when assigning mixer tracks. English-only voice change refuses a non-English `context.speechLanguage`; the provider checks the multilingual model's 29-language coverage. Voice change defaults to MP3, so use a matching output extension. Local `audio:stems` remains available for offline Demucs. `HASH` is the imported asset's full 64-character SHA-256, not a literal placeholder to send.

## Keeping models and prices fresh

Refresh weekly and after provider model/tariff announcements: inspect `pnpm models:refresh --dry-run`, then run `pnpm models:refresh --resume` in a network-authorised maintenance session. `--provider fal|higgsfield|all` selects sources. Catalogue/schema reads are anonymous; fal pricing needs FAL_KEY and Higgsfield pricing needs HIGGSFIELD_API_KEY. Pricing steps skip visibly when credentials are absent. No generation is submitted. On GitHub, `.github/workflows/models-refresh.yml` runs it daily with keys from the `models` environment and opens or updates the `bot/models-refresh` PR for review ([GitHub administration](github.md)).

The umbrella refreshes the fal catalogue plus verified schemas and both tracked price sources with pricing resume. Each step is reported independently; partial failure returns `ok: false` without losing successful updates. `out/qa/model-refresh/model-refresh.md` and JSON metadata include new/released, retiring/gone, >1% price changes, evidenced discounts/expiry and exact savings from `pnpm models:compare --resolution 720p --duration 5`. Floors and unknown prices are excluded from savings. fal's tracked price records have no discount/expiry fields, so no sale is inferred. Full flags, sample-media limitations and provider choice are in [the Higgsfield guide](higgsfield.md#keeping-models-and-prices-fresh). Maintenance stays CLI-only; comparison is local MCP.

Daily model refresh proposes slot successors and flags stale/retiring entries for owner review; see [Freshness](model-slots-guide.md#freshness).

`pnpm fal:pricing --historical --slots --resume` refreshes free historical averages per API call; the [price matrix](model-slots-guide.md#price-comparison-matrix) keeps them separate from duration/character scenario totals.
