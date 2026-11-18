# RFC 0003: Reference packs: preparing, binding and checking model reference inputs

Status: implemented on feat/reference-packs (2026-11-17); see [reference packs](../reference-packs.md) for current behaviour. Where the implementation changed a contract, the text below is corrected and the change is listed in §15.
Date: 2026-11-17
Owner: the maintainer (`@ilyamk`)
Builds on: [entity cards](../entity-workflow.md), [prepared Genjutsu inputs](../higgsfield-prompting.md#prepared-genjutsu-workflow), [production model routing](../production-model-routing.md), [production chain](../production-chain.md)

## Summary

Current image and video models take more than a prompt. They take **reference inputs** of several kinds:

- character, object, location and style images;
- first and last frames;
- motion, performance and camera videos;
- control signals: depth, pose and masks;
- voice and sound clips.

The prompt then refers to each input by a model-specific marker such as `@Image1`, `@Video1`, `@Audio1`, `@Element1`, "image 2" or plain prose. Output quality depends on three things:

1. **Which** inputs a shot needs.
2. **How** each input is prepared: angle, background, light, length, framing, resolution, temporal consistency.
3. **How** the inputs are bound to the request fields and named in the prompt.

The harness already solves all three for one family, Higgsfield Genjutsu (`model:prepare`), and it has a versioned entity bible (`entity:card`). Everywhere else, references are passed by hand: URL lists in `generate:video`, raw `image_urls` in `generate:model` requests, and prose in the `ai-film` playbook. Nothing tells an agent what a shot needs before generation. Nothing checks that every marker matches an attachment. Nothing produces control signals or 3D previs passes.

This RFC proposes one general layer, the **reference pack**. It has four parts:

- **Model reference profiles**: what each model family accepts, its limits, and how its prompt names inputs.
- **Reference requirements**: per shot, what has to exist before generation (`refs:plan`).
- **Reference derivatives**: reproducible local preparations: trim, crop, last frame, depth, pose, mask, Blender passes, cleaned voice (`refs:derive`).
- **Reference packs**: immutable, hash-pinned bundles of ordered attachments and a compiled prompt, with a review board, approval and result review (`refs:pack`). This generalises `model:prepare`; Genjutsu becomes one profile.

It also adds:

- coverage rules for entity cards;
- a new skill, `reference-preparation`, holding the craft knowledge from §3;
- changes to `asset-planner`, the film chain, the playbooks and the QA dimensions;
- a work-package plan (§13) sized for parallel subagents in a separate worktree, each package with tests and acceptance criteria.

---

## 1. Current state (2026-11-17, verified in code)

### 1.1 What exists

| Layer | Where | State |
|---|---|---|
| Entity bible: character, object, location, style and scene cards with immutable revisions, user approval, consent fields, role-tagged reference images | `src/types/entities.ts`, `src/lib/entities/service.ts`, `scripts/entity-card.ts`, skill `world-and-entity-bible`, [entity workflow](../entity-workflow.md) | Solid. Roles are free strings (`front`, `profile`, `packshot`, `establishing`); no coverage rules; a character's voice is only `providerVoiceId` plus a description, with no audio asset |
| Entity bindings into template scenes | `src/lib/entities/bindings.ts` (`compileEntityBindings`) | Only `scene.imageUrl` / `leftPanel.imageUrl`; not into model requests |
| Review board | `pnpm asset:board`, `src/lib/entities/board.ts` | Static HTML of cards and media |
| Prepared model inputs: segment trim/crop, ordered references, `@Video1`/`@Image1` markers, review board, rights, visual approval, result board and result review | `src/types/model-preparation.ts`, `src/lib/model-preparation/*`, `pnpm model:prepare` | The target pattern, but bound to Higgsfield Genjutsu: `genjutsuEndpoint()`, `genjutsuPrompt()` (`src/lib/model-preparation/prepare.ts:42`), three modes, `pipeline/model-preparations/<id>/` |
| Per-model reference limits as refusal guards | `src/lib/providers/fal-guards/seedance.ts` (Seedance 2.5 r2v: ≤30 images, ≤10 videos, ≤10 audio, ≤50 total, 1.8–30.2 s each and combined per modality, 300–6000 px, 24–60 fps, aspect 0.4–2.5), `kling.ts` (an element is a frontal image plus 1–3 references, or one video; one video element; video-to-video ≤4 elements plus images; motion control ≤10 s image orientation / ≤30 s video orientation), `nano.ts` (≤14 images) | Correct as last-line checks; planning cannot read them |
| Measured reference metadata | `src/lib/assets/provider-references.ts` (`asset://sha256/HASH` → measured bytes, size, duration, fps) | Reusable as is |
| Legacy marker CLI | `scripts/generate-video.ts:23,212-222` (Seedance 2 fast: `@Image1…9`, `@Video1…3`, `@Audio1…3`, URLs passed by hand) | Legacy route; no cards, no measurement, no marker check |
| Use cases | `src/lib/models/model-use-cases.json`: `character-sheet`, `reference-shot`, `replace-person`, `restyle-clip`, `storyboard`, `train-identity`, `clone-voice`, `lip-sync`, `trailer-world`, `portrait-motion` | Choose a model slot; say nothing about inputs to prepare |
| Voice cloning | `src/lib/elevenlabs/voices.ts` (instant/professional clone, samples, pronunciation dictionary) | Exists; not linked to character cards |
| Film material step | `MaterialItemSchema` (`src/types/film.ts:307`), step `material` in `src/lib/film/chain.ts:1358`, owner `asset-planner` | Item has `modelPreparation` (Genjutsu only); no list of a shot's inputs |
| Method | `playbooks/ai-film/AGENTS.md` §1–8: bible first, key frames before motion, image-to-video by default, consistency check | Prose; no check that a shot's inputs exist |
| Control-signal endpoints in the catalogue | `fal-ai/depth-anything-video`, `fal-ai/dwpose`, `fal-ai/dwpose/video`, `fal-ai/evf-sam` | Catalogued, used by nothing |
| Local matte engine | `src/lib/matte/` (BiRefNet ONNX, temporal smoothing) | Reusable for neutral-background cut-outs and masks |
| Blender kit | `scripts/blender/kit/{camera,stage,look,...}.py` | Renders beauty passes; no depth/normal/camera-trajectory export for model conditioning |

### 1.2 Gaps

1. **No per-shot input contract.** A generated shot does not record which references it is made from, so nothing can say "shot 4 lacks a profile view of `hero`" before money is spent.
2. **Model knowledge lives in three places:** guards (limits), `docs/higgsfield-prompting.md` (markers), and prose in playbooks. A planner cannot query it.
3. **Markers are model-specific and partly unverified.** The house `@Video1`/`@Image1` convention is documented for Genjutsu only and explicitly "not a universal syntax". Other families use other dialects (§3.9).
4. **No derivatives.** No trim to a model window, last-frame extraction, depth video, pose video, mask video, Blender passes or cleaned voice clip, and so no hashes or provenance for any of them.
5. **No coverage rules.** A character card with one front image passes as fully as one with a clean turnaround.
6. **QA dimensions for references exist only for Genjutsu** (`PreparationResultReviewSchema`).
7. **Catalogue drift:** Sora 2 was discontinued (API closed 2026-09-24), and the Veo 3.1 preview IDs on the Gemini API were shut down on 2026-10-22 in favour of Gemini Omni (§3.0). Profiles need status and `checkedAt` dates.

---

## 2. Decisions (proposed)

| # | Question | Proposal |
|---|---|---|
| D1 | One layer or per-provider tools | **One layer** (`refs:*`). Genjutsu becomes a profile plus a compatibility path; `model:prepare` stays as an alias until WP9 migrates it. |
| D2 | Where model reference knowledge lives | `src/lib/models/reference-profiles.json`: data, schema-validated, one entry per family, each limit tagged with an evidence tier (`official`, `wrapper`, `observed`, `unverified`), source URL and `checkedAt`. Guards stay as refusal checks and are tested for agreement with profiles. |
| D3 | Marker syntax | Per-profile **dialect** (§6.2). The compiler emits markers only from the profile; agents never write markers by hand. A dialect tagged `unverified` produces a warning in the plan and is recorded in memory after the first live result. |
| D4 | Unit of approval | The **pack** (ordered attachments + compiled prompt + target endpoint), bound by hash. Card approval stays separate; a pack can only use approved card revisions. |
| D5 | Immutability | Requirements are revisable drafts; derivatives and packs are immutable (new id for changed inputs), as in `model-preparations/`. |
| D6 | Where requirements live | `pipeline/references.json` (one file per project, shots → requirements), linked from `MaterialItem.referencePack`. Not inside `material.json`, to keep the material gate readable. |
| D7 | Derivative engines | Local first (ffmpeg, matte ONNX, a pinned local depth/pose model when available, Blender kit). Paid derivatives (fal depth/pose/SAM) go through `generate:model` with normal budget admission and are recorded as derivatives with `operationId`. |
| D8 | Enforcement | Phase 1: `generate:model` **warns** when a profiled endpoint receives reference fields without `context.referencePack`. Phase 2 (after WP9): **refuses** fresh paid submissions without a current pack, as Genjutsu already does. Resumes of historical jobs keep their identity. |
| D9 | Coverage rules | Advisory per entity kind, with roles from a fixed vocabulary plus `custom:*`; a pack's profile may make specific roles mandatory (for example, the Kling element frontal image). |
| D10 | Measured quality | Mechanical checks (resolution, duration, fps, aspect, alpha, border uniformity, black frames, cuts in a motion video, audio SNR/clipping) are sensors. Identity similarity is optional evidence, never a pass on its own (consistent with existing "pixel count does not prove identity" rules). |
| D11 | Real faces | The profile records each model's real-face policy. A pack with a `character` reference whose card has a non-`not-applicable` likeness consent must use a profile that permits real faces, or stop and ask. |
| D12 | MCP exposure | `refs:plan`, `refs:profiles` and the read/board/check actions of `refs:pack` are MCP tools; `refs:derive` with local engines and the approve/review actions are CLI-only, matching `model:prepare` and `speech:local`. |

---

## 3. What the 2026 practice says (craft basis)

This section is the evidence the skill references (WP8) are written from. Tiers: **[O]** official docs, **[P]** paper, **[3P]** wrapper or practitioner, **[U]** unverified. Every model limit is re-checked against `pnpm fal:models --schema ENDPOINT` and vendor docs when its profile is written (WP1). This table is a seed, not a source of truth.

### 3.0 Model status

- Sora 2 is discontinued: the app closed 2026-04-26 and the API 2026-09-24 ([OpenAI forum](https://community.openai.com/t/is-the-sora2-api-still-working/1379946)).
- The Veo 3.1 preview IDs on the Gemini API were shut down 2026-10-22. The current model is Gemini Omni 1.2 Flash ([AI Studio video](https://aistudio.google.com/docs/video), [Omni](https://aistudio.google.com/docs/omni)) [O]. Vertex still lists `veo-3.1-generate-001` [O].
- Runway's legacy Aleph was replaced by Aleph 2.0 / Edit Studio.
- Seedance 2.5 shipped 2026-07-31 with up to 50 references ([Dreamina FAQ](https://dreamina.capcut.com/ai-video/ai-video-reference-inputs-faq)) [O]. The repo guard already encodes it.

### 3.1 Characters

- Prepare one locked master image, a set of clearly different angles (front, three-quarter or profile, back) and a face close-up.
- Kling binds up to 4 images (front, side, back, detail) so the model "doesn't have to infer unseen areas". Even light and clear facial geometry are essential ([Kling, 2026-06-26](https://home.kling.ai/blog/kling-3-subject-binding-character-consistency)) [O].
- **Distinct beats many.** Close duplicates cause "view-dependent collapse": the model locks onto one reference angle and snaps between angles. Mv²ID trains on references at least 45° apart ([arXiv 2603.21299](https://www.alphaxiv.org/overview/2603.21299)) [P].
- More frames help identity only up to a point: HeyGen's TAVR ablation shows identity rising from 12 to 48 frames, with lip-sync flat ([HeyGen](https://www.heygen.com/research/tavr)) [P/vendor].
- **Wardrobe:** the Kling Motion Control face element carries the face only. Clothing, hair, makeup and props come from the character image or the prompt ([Kling MC guide](https://kling.ai/quickstart/motion-control-user-guide)) [O]. Practice: empty hands on turnarounds, props on their own sheet, one sheet per costume [3P].
- **Limits** (seed values):
  - Kling: 2–4 images per element, or a 3–8 s single-character video [O].
  - Gemini Omni: ≤3 images per character, 2 characters, 6 images total [O].
  - Nano Banana Pro: 14 images, resemblance for up to 5 people [O].
- **Real faces:** Seedance 2.x rejects real human faces in references [3P]. Gemini Omni blocks some recognisable people, and minors in the EEA, UK and Switzerland [O].
- **Several characters in one shot:** build the group key frame in an image model, then animate it. Kling Motion Control binds one element and picks the largest person [O]. Act-Two is single-character [O].

### 3.2 Locations

- Give the setting its own reference and its own role sentence. Restrict a video reference to "camera or action", or the motion reference rewrites the setting [O, Dreamina].
- Use one plate per lighting state: light and time of day bake into the result (§3.10).
- Keep plates empty unless people are intended, so that background people do not leak into the shot.
- For true multi-angle consistency, use a 3D proxy (§3.7) rather than more 2D plates.

### 3.3 Products and objects

- Use a front-facing label packshot under soft, even light, with no specular highlight crossing the text, and give hex colours per component.
- FLUX.2: quote exact text with font and placement; it has no negative prompts, and earlier words weigh more ([BFL FLUX.2 guide](https://docs.eu.bfl.ai/guides/prompting_guide_flux2)) [O].
- More angles do not reliably fix label drift. **Composite the approved logo or legal text in post** [3P].
- GPT-image `input_fidelity: "high"` is aimed at faces and logos; up to 16 inputs [3P].
- No video model documents alpha in reference inputs [U]. Flatten onto a neutral colour unless the profile says otherwise.

### 3.4 Style versus content

- Midjourney separates style and content by parameter: `--sref` for style, `--oref` with `--ow` 1–1000 for identity (V7) ([docs](https://docs.midjourney.com/hc/en-us/articles/36285124473997)) [O].
- Most other models separate them **only by role sentences in the prompt**:
  - FLUX.2: "subject from image 1, style from image 2, background from image 3" [O].
  - Dreamina: one role per asset; keep the set "small and coherent rather than filling every slot" [O].
- References from the same scene entangle identity with lighting and background ([Phantom-Data, arXiv 2506.18851](https://arxiv.org/html/2506.18851v1)) [P]. Rule: style references never contain the subject, and identity references carry no strong style.

### 3.5 Motion, performance and replacement video

- **Kling Motion Control** [O]:
  - One performer, head and body visible, single continuous shot, no cuts, no camera moves, moderate speed, real humans best.
  - 3–30 s; short edge ≥340 px, long edge ≤3850 px.
  - The character image framing matches the video (full body to full body). Element binding only works with video orientation.
- **Kling O1 / 3.0 Omni:**
  - One reference video, 3–10 s, ≤200 MB.
  - With a video attached, images plus elements ≤4.
  - No native audio when a video is input [O].
- **Runway Act-Two:**
  - Performer and character face the same way and fill similar screen space [O].
  - Driving video 3–30 s [3P].
  - Match the character image pose to the driving video's first frame [3P].
- **Wan 2.2 Animate:**
  - DWPose extracts pose and face; a SAM2 mask isolates the replaced person; width and height are multiples of 16 [O].
  - Coarse masks leak body shape; fine masks risk background drift [3P].
- **Luma Ray3 Modify:** input ≤10 s; the modified subject should appear in the start or end frame [O].
- **Gemini Omni:**
  - Reference videos ≤3 s: up to 3 for 3–10 s outputs, 1 for 11–15 s outputs.
  - Their audio is ignored.
  - Reasoning across several videos "is not supported and may degrade output" [O].
- **Seedance 2.x:**
  - Reference videos 2–30 s each, H.264/H.265, on public non-expiring URLs.
  - Seedance 2.0's combined length is ≤15 s per one wrapper [3P].
  - The Seedance 2.5 guard uses 30.2 s per modality.

### 3.6 Control signals

- **Depth:** use a temporally consistent video depth model. Video Depth Anything adds a temporal head and loss over Depth Anything V2 and processes long video in 32-frame overlapping segments ([arXiv 2501.12375](https://arxiv.org/html/2501.12375v3)) [P]. Per-frame DA-V2 flickers [3P].
- **Pose, depth, canny and lineart** control videos drive Wan VACE ([Comfy VACE](https://docs.comfy.org/tutorials/video/wan/vace)) [O]. Each constrains structure differently: pose drives the body only; depth drives layout and volume; lineart drives contours.
- Control videos match the target resolution, fps and frame count exactly (Wan: multiples of 16) [O].

### 3.7 3D previs

- A grey or clay render is a **composition and camera reference**, not a depth map. Depth conditioning needs a real exported depth pass and a route that accepts it [3P].
- Working pipelines:
  - Blender blockout → depth, pose and outline passes → VACE control.
  - Clay render → video reference ([fal blog, Jul 2026](https://fal.ai/blog/from-clay-3d-render-to-a-real-action-short-a-3d-to-ai-pipeline-with-total-control)) [3P].
- Research converges on a 3D proxy (point cloud, mesh, Gaussian splats) as geometric memory, with per-shot renders as conditioning:
  - GEN3C ([paper](https://research.nvidia.com/labs/toronto-ai/GEN3C/paper.pdf));
  - ReCamMaster ([arXiv 2503.11647](https://arxiv.org/abs/2503.11647));
  - NeoVerse ([arXiv 2601.00393](https://arxiv.org/pdf/2601.00393)) [P].
- Generated motion follows the guide; it is not keyframe-exact.

### 3.8 Audio

- **ElevenLabs:** instant clone from 1–2 min of clean, consistent speech; professional clone from 30–180 min; MP3 ≥192 kbps is enough. Pronunciation dictionaries support phonemes (model-limited) and aliases; prefer aliases outside English ([docs](https://elevenlabs.io/docs/product-guides/voices/voice-cloning)) [O].
- **Kling 3.0 Omni:** voice binding from a 5–30 s low-noise, moderate-pace, neutral clip [O].
- **Seedance 2.x:** audio references 2–30 s, WAV/MP3, ≤15 MB. They need at least one image or video reference [3P].
- **Wan 2.5/2.6:** `audio_url` drives sync; without it the model generates sound itself [O].
- **Gemini Omni:** no audio references [O].

### 3.9 Marker dialects

| Family | Dialect | Example | Tier |
|---|---|---|---|
| Seedance 2.x / 2.5 | indexed at-markers | `@Image1`, `@Video1`, `@Audio1` (some UIs show `@Image 1`; the Replicate wrapper uses `[Audio1]`) | 3P; house use in `generate:video` |
| Kling O1 / O3 / 3.0 Omni | element and indexed at-markers | `@Element1`, `@Image1`, `@Video1`, named elements; "Change X in @Video1 to @Element1" | O |
| Higgsfield Genjutsu | indexed at-markers | `@Video1`, `@Image1` | observed (house convention) |
| Runway Gen-4 References | named at-tags | `@hero` (3–15 alphanumeric characters, starting with a letter) | 3P |
| FLUX.2, Nano Banana, GPT-image, Qwen-Image-Edit | prose index | "the subject from image 1, the style of image 2" | O / 3P |
| Gemini Omni | natural language only | "the woman in the first reference image" (tags deprecated) | O |
| Midjourney | parameters | `--oref URL --ow 200 --sref URL` | O |

In every dialect, a reference that is not tied to an explicit requirement in the prompt tends to be ignored, and contradictory identity references blend [O, Dreamina].

### 3.10 Failure modes and how to measure them

- **Copy-paste and over-conditioning:** the reference's pose, lighting, background and layout are reproduced ([Phantom, ICCV 2025](https://openaccess.thecvf.com/content/ICCV2025/papers/Liu_Phantom_Subject-Consistent_Video_Generation_via_Cross-Modal_Alignment_ICCV_2025_paper.pdf); [ST-DRC, 2026](https://huggingface.co/papers/2606.02441.md)) [P].
- **View-dependent collapse** with near-duplicate angles (§3.1).
- **Kling face quality** drops when the element face differs strongly from the first-frame face [O].
- **Last-frame chaining** accumulates colour shift and distortion; artefacts are visible by about the third segment ([StreamingT2V, CVPR 2025](https://openaccess.thecvf.com/content/CVPR2025/papers/Henschel_StreamingT2V_Consistent_Dynamic_and_Extendable_Long_Video_Generation_from_Text_CVPR_2025_paper.pdf)) [P]. Mitigations: re-attach the original references to every shot; colour-match only the boundary frame against a fixed anchor.
- **Acceptance dimensions:** OpenS2V-Nexus scores subject consistency (NexusScore), naturalness (anti copy-paste) and text relevance separately ([NeurIPS 2025](https://proceedings.neurips.cc/paper_files/paper/2025/hash/dae77d03bd51a5acfe8519848a3af6c9-Abstract-Datasets_and_Benchmarks_Track.html)) [P]. The result review (§10.3) mirrors these three.

---

## 4. Goals and non-goals

**Goals**

1. An agent can ask, for any shot and target endpoint, "what must exist before I generate?" and get a machine-readable answer, offline.
2. Every reference input of a paid generation is an imported, hash-pinned asset or a reproducible derivative. Its role, marker and request field are recorded.
3. Prompts name inputs only through compiler-emitted markers that are guaranteed to match the attachments.
4. Model-specific limits, dialects and policies are data with evidence tiers, shared by the planner, the compiler, the guards and the docs.
5. The user approves what the model will actually see, on one board, before spending.
6. Results are reviewed against their pack on identity, preservation, naturalness and prompt fit, and the verdicts feed memory.

**Non-goals**

- Training identity models (LoRA, Soul ID): they remain `train-identity` and model-nonmedia work. A pack may *reference* a trained identity id.
- Judging creative quality automatically.
- Live provider acceptance: fixtures prove contracts only.
- Masks or regions the provider does not expose: a marker is not a mask.
- Rewriting the Genjutsu flow before WP9: it keeps working unchanged.

---

## 5. Concepts

| Term | Meaning |
|---|---|
| **Reference role** | What an input is *for*: `identity`, `wardrobe`, `expression`, `prop`, `product`, `location`, `lighting`, `style`, `first-frame`, `last-frame`, `keyframe`, `motion`, `performance`, `camera`, `depth`, `pose`, `edge`, `mask`, `source-video` (edit/replace target), `voice`, `sound`, `music` |
| **Entity view role** | The tag on a card reference (`front`, `three-quarter-left`, `profile-left`, `back`, `face-closeup`, `expression-*`, `outfit-*`, `packshot-front`, `plate-day`, `style-board`, `voice-sample`, …); fixed vocabulary plus `custom:*` |
| **Requirement** | One needed input of one shot: role, modality, preferred source, preparation spec and the sentence that tells the model what to take from it |
| **Derivative** | A file produced reproducibly from pinned inputs by a recorded recipe (trim, crop, extract-frame, depth-video, pose-video, mask-video, flatten, blender-pass, audio-clean…), with a receipt |
| **Model reference profile** | Data describing one family: slots per modality, field pointers, limits, dialect, element shapes, policies, evidence |
| **Pack** | Immutable bundle for one generation: endpoint, ordered attachments (each: hash, role, marker, JSON pointer), compiled prompt, measured media, warnings, board, rights, approval, result reviews |

Flow (one shot):

```
brief/script/shot-spec ──► refs:plan ──► pipeline/references.json   (requirements, status per input)
                                   │
entity cards (approved) ───────────┤
refs:derive (local/paid) ──────────┤
                                   ▼
                           refs:pack --action prepare ──► pack (attachments + compiled prompt + board)
                                   ▼
                     user approval (input + spend) ──► generate:model (context.referencePack)
                                   ▼
                refs:pack --action result-board / review-result ──► memory
```

---

## 6. Schemas

Zod sketches; `strict()` everywhere, hashes as `/^[a-f0-9]{64}$/`, asset ids as `sha256:<hex>`. Final names may change in WP0, but fields and invariants are the acceptance contract.

### 6.1 Reference roles and entity coverage (`src/types/references.ts`)

```ts
export const ReferenceRoleSchema = z.enum([
  "identity", "wardrobe", "expression", "prop", "product", "location", "lighting", "style",
  "first-frame", "last-frame", "keyframe", "motion", "performance", "camera",
  "depth", "pose", "edge", "mask", "source-video", "voice", "sound", "music",
]);
export const ModalitySchema = z.enum(["image", "video", "audio"]);

/** Card-level view tags (EntityCard.references[].role). Free strings remain readable; new cards use these. */
export const EntityViewRoleSchema = z.union([
  z.enum([
    "front", "three-quarter-left", "three-quarter-right", "profile-left", "profile-right", "back",
    "face-closeup", "full-body", "hands", "packshot-front", "packshot-back", "packshot-three-quarter",
    "label-detail", "plate-wide", "plate-medium", "plate-reverse", "style-board", "palette",
    "voice-sample", "performance-clip",
  ]),
  z.string().regex(/^(expression|outfit|plate|lighting|custom):[a-z0-9-]+$/),
]);

/** Optional measured/declared facts per card reference, used by coverage and pack checks. */
export const ReferenceViewFactsSchema = z.object({
  yawDeg: z.number().min(-180).max(180).optional(),      // declared or measured head/object yaw
  background: z.enum(["neutral", "transparent", "scene", "unknown"]).default("unknown"),
  lighting: z.enum(["even", "directional", "scene", "unknown"]).default("unknown"),
  outfitId: z.string().optional(),
  handsEmpty: z.boolean().optional(),
  containsOtherPeople: z.boolean().optional(),
  styleNeutral: z.boolean().optional(),
}).strict();
```

`EntityCard.references[]` gains optional `facts: ReferenceViewFactsSchema`. Character `voice` gains `sampleAssetIds: assetId[]` (audio), `pronunciation?: { dictionaryAssetId?, aliases?: {text, alias}[] }`, and `fixedSentence?: string`. All kinds gain `fixedSentence`: the verbatim invariant sentence the `ai-film` playbook already asks for, now stored once.

Coverage policy (`src/lib/references/coverage.json`, schema-validated):

```json
{ "character": { "required": ["front"], "recommended": ["three-quarter-left|three-quarter-right", "profile-left|profile-right", "face-closeup"],
                 "optional": ["back", "full-body", "expression:*", "outfit:*", "voice-sample"],
                 "rules": ["minDistinctYawDeg:45", "background:neutral", "lighting:even", "oneOutfitPerSheet", "handsEmptyOnTurnaround"] },
  "object":    { "required": ["packshot-front"], "recommended": ["packshot-three-quarter", "label-detail"], "rules": ["background:neutral", "lighting:even"] },
  "location":  { "required": ["plate-wide"], "recommended": ["plate-reverse", "plate-medium"], "rules": ["onePlatePerLighting", "noUnintendedPeople"] },
  "style":     { "required": ["style-board"], "rules": ["styleWithoutSubject"] } }
```

`pnpm entity:card --action coverage` reports `{ satisfied, missing[], ruleFindings[] }`. It is advisory (D9).

### 6.2 Model reference profile (`src/types/reference-profiles.ts`, data in `src/lib/models/reference-profiles.json`)

```ts
const Evidence = z.object({
  tier: z.enum(["official", "wrapper", "observed", "unverified"]),
  url: z.url().optional(), note: z.string().optional(), checkedAt: z.iso.date(),
}).strict();

const SlotSchema = z.object({
  id: z.string(),                                   // "images", "videos", "audio", "elements", "start", "end", "control"
  modality: ModalitySchema,
  pointer: z.string(),                              // JSON pointer template into input: "/image_urls", "/elements/{n}/frontal_image_url"
  roles: z.array(ReferenceRoleSchema).min(1),       // roles this slot can carry
  min: z.number().int().nonnegative().default(0),
  max: z.number().int().positive(),
  durationSec: z.object({ min: z.number(), max: z.number(), combinedMax: z.number().optional() }).optional(),
  pixels: z.object({ minEdge: z.number().optional(), maxEdge: z.number().optional(),
                     multipleOf: z.number().int().optional(), aspect: z.tuple([z.number(), z.number()]).optional() }).optional(),
  fps: z.tuple([z.number(), z.number()]).optional(),
  maxBytes: z.number().int().positive().optional(),
  formats: z.array(z.string()).optional(),          // mime types
  alpha: z.enum(["supported", "flatten", "unknown"]).default("unknown"),
  carries: z.array(z.string()).optional(),          // e.g. ["face"] for Kling MC face elements
  marker: z.enum(["indexed", "none"]).optional(), // absent = indexed; "none": positional (first/last frame, MC inputs), never named, prose only
  markerGroup: z.string().min(1).optional(),     // slots sharing a group share one marker index; absent = the modality
  evidence: Evidence,
}).strict();

export const ReferenceProfileSchema = z.object({
  schemaVersion: z.literal(1),
  family: z.string(),                               // "seedance-2.5", "kling-o3", "nano-banana-2.1", "genjutsu"
  endpoints: z.array(z.string()).min(1),            // exact ids or globs resolved against the catalogue
  provider: z.enum(["fal", "higgsfield"]),
  status: z.enum(["live", "retiring", "retired"]),
  slots: z.array(SlotSchema).min(1),
  totals: z.object({ max: z.number().int().optional(), withVideoMaxImages: z.number().int().optional() }).strict().default({}),
  dialect: z.object({
    kind: z.enum(["at-indexed", "at-element", "at-named", "prose-indexed", "natural", "parameter", "none"]),
    templates: z.record(ModalitySchema, z.string()).optional(), // { image: "@Image{n}", video: "@Video{n}", audio: "@Audio{n}" }
    elementTemplate: z.string().optional(),                      // "@Element{n}"
    evidence: Evidence,
  }).strict(),
  promptOrder: z.array(z.enum(["action", "bindings", "invariants", "camera", "audio", "preserve", "otherSubjects", "avoid", "additional"])).default(
    ["action", "bindings", "invariants", "camera", "audio", "preserve", "otherSubjects", "avoid", "additional"]),
  /** Named composition template; "default" is §7 step 5. "genjutsu-legacy" reproduces genjutsuPrompt() byte for byte:
   *  one "Reference bindings: @Image1 (entity, role); …" line, "Preserve: …", "Do not alter these other subjects: …". */
  promptTemplate: z.enum(["default", "genjutsu-legacy"]).default("default"),
  negativePrompt: z.boolean().default(false),
  policies: z.object({
    realFaces: z.enum(["allowed", "consented-flow", "rejected", "unknown"]),
    audioFromVideoRefs: z.enum(["used", "ignored", "unknown"]).default("unknown"),
    nativeAudioWithVideoInput: z.boolean().optional(),
    multiVideoReasoning: z.enum(["supported", "degrades", "unknown"]).default("unknown"),
  }).strict(),
  guidance: z.array(z.object({ text: z.string(), evidence: Evidence }).strict()).default([]),
}).strict();
```

Invariants:

- Every `endpoints` id resolves to a catalogue entry, and its slot pointers exist in the endpoint's input schema (`fal:models --schema`).
- A test asserts that profile limits agree with the corresponding guard (Seedance 2.5 30/10/10/50; Kling element 1+1–3; Nano 14).

### 6.3 Requirements (`pipeline/references.json`)

```ts
const Source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entity: EntityRefSchema, viewRole: EntityViewRoleSchema }).strict(),
  z.object({ kind: z.literal("asset"), assetId }).strict(),                     // imported original
  z.object({ kind: z.literal("derivative"), derivativeId: slug }).strict(),
  z.object({ kind: z.literal("shot-output"), shotId: slug, frame: z.enum(["first", "last"]) }).strict(), // chaining
]);

export const ReferenceRequirementSchema = z.object({
  key: slug,                                   // stable within the shot: "hero-identity", "market-plate", "dance-motion"
  role: ReferenceRoleSchema,
  modality: ModalitySchema,
  required: z.boolean().default(true),
  source: Source.optional(),                   // absent = still to be made/acquired
  prepare: z.array(DerivationStepSchema).default([]),   // §6.4 steps to apply before packing
  roleSentence: z.string().min(1).max(400),    // what the model takes from it: "the face and hair of the woman"
  status: z.enum(["missing", "planned", "pending-approval", "ready"]),
  notes: z.string().optional(),
}).strict();

export const ShotReferencesSchema = z.object({
  shotId: slug,
  materialItemId: z.string(),
  intent: z.enum(["keyframe-image", "image-to-video", "reference-to-video", "video-edit", "motion-transfer",
                  "character-replace", "control-to-video", "lip-sync", "voice", "extend"]),
  target: z.object({ family: z.string(), endpoint: z.string().optional() }).strict(),
  requirements: z.array(ReferenceRequirementSchema).min(1),
  chaining: z.enum(["none", "first-from-previous-last", "anchor-reinject"]).default("none"),
}).strict();

export const ReferencesPlanSchema = z.object({
  schemaVersion: z.literal(1),
  shots: z.array(ShotReferencesSchema),
}).strict();
```

Invariants checked by `refs:plan --action check`:

- Per shot, the requirement count per modality fits the profile's slots and totals.
- Roles map onto a slot that accepts them.
- `chaining: "first-from-previous-last"` is allowed only with `anchor-reinject` of every identity requirement (§3.10).
- `status: "ready"` implies a resolvable source whose media passes the slot limits after `prepare`.
- A `character` identity source from a card with a likeness-consent subject requires a profile with `realFaces ≠ rejected` (D11).

### 6.4 Derivatives (`pipeline/reference-derivatives/<id>/`)

```ts
export const DerivationStepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("trim"), startSec: z.number().nonnegative(), durationSec: z.number().positive() }).strict(),
  z.object({ op: z.literal("crop"), x: int, y: int, width: int, height: int }).strict(),
  z.object({ op: z.literal("scale"), width: int, height: int, fit: z.enum(["pad", "crop", "exact"]) }).strict(),
  z.object({ op: z.literal("fps"), fps: z.number().positive() }).strict(),
  z.object({ op: z.literal("snap"), multipleOf: z.number().int().positive() }).strict(),            // Wan: 16
  z.object({ op: z.literal("extract-frame"), at: z.union([z.literal("first"), z.literal("last"), z.number()]) }).strict(),
  z.object({ op: z.literal("flatten"), background: z.string().regex(/^#[0-9a-f]{6}$/i) }).strict(),
  z.object({ op: z.literal("cutout"), engine: z.literal("matte-onnx") }).strict(),                   // src/lib/matte
  z.object({ op: z.literal("strip-audio") }).strict(),
  z.object({ op: z.literal("depth-video"), engine: z.enum(["local", "fal"]), endpoint: z.string().optional() }).strict(),
  z.object({ op: z.literal("pose-video"), engine: z.enum(["local", "fal"]), endpoint: z.string().optional() }).strict(),
  z.object({ op: z.literal("mask-video"), engine: z.enum(["matte-onnx", "fal"]), prompt: z.string().optional() }).strict(),
  z.object({ op: z.literal("edge-video"), kind: z.enum(["canny", "lineart"]) }).strict(),
  z.object({ op: z.literal("blender-pass"), scene: z.string(), pass: z.enum(["beauty", "clay", "depth", "normal", "mist", "camera-path"]) }).strict(),
  z.object({ op: z.literal("audio-clean"), engine: z.enum(["local", "fal"]) }).strict(),
  z.object({ op: z.literal("audio-trim"), startSec: z.number(), durationSec: z.number() }).strict(),
  z.object({ op: z.literal("loudness"), lufs: z.number() }).strict(),
  z.object({ op: z.literal("contact-sheet"), columns: z.number().int().min(1).max(8) }).strict(),
]);

export const DerivativeSpecSchema = z.object({
  schemaVersion: z.literal(1), id: slug,
  input: z.object({ assetId }).strict().or(z.object({ derivativeId: slug }).strict()),
  steps: z.array(DerivationStepSchema).min(1),
  purpose: z.string().min(1),
}).strict();

export const DerivativeReceiptSchema = z.object({
  schemaVersion: z.literal(1), id: slug, specSha256: hash, createdAt: z.iso.datetime(),
  input: mediaPin, output: mediaPin,              // reuse ModelPreparationReceipt mediaPin
  engine: z.object({ kind: z.enum(["ffmpeg", "matte-onnx", "local-model", "blender", "fal"]),
                     version: z.string(), modelSha256: hash.optional(), operationId: z.string().optional() }).strict(),
  costUsd: z.number().nonnegative().nullable(),
  measurements: z.record(z.string(), z.number()).default({}),   // e.g. temporalFlicker, borderUniformity, snrDb
  warnings: z.array(z.string()),
}).strict();
```

The output is imported into the asset registry with `provenance.origin: "derivative"` and a link to the receipt, so packs refer to it by `assetId` like any other asset. A fal-backed op runs only through the existing `generate:model` admission (D7). The receipt records its `operationId`, and the derivative stays `pending` until the job finishes.

### 6.5 Pack (`pipeline/reference-packs/<id>/`)

```ts
export const ReferencePackSpecSchema = z.object({
  schemaVersion: z.literal(1), id: slug,
  shotId: slug, endpoint: z.string(), profileFamily: z.string(),
  attachments: z.array(z.object({
    requirementKey: slug,
    source: z.object({ assetId }).strict(),          // resolved: entity view, asset or derivative output
    slot: z.string(),                                // profile slot id
    order: z.number().int().positive(),              // 1-based within slot; marker index
    roleSentence: z.string().min(1),
    element: z.object({ index: z.number().int().positive(), part: z.enum(["frontal", "reference", "video", "voice"]) }).strict().optional(),
  }).strict()).min(1),
  prompt: z.object({
    action: z.string().min(1),                       // what happens; subject + motion + camera channels
    invariants: z.array(z.string()).default([]),     // entity fixedSentence(s), verbatim
    camera: z.string().optional(),
    audio: z.string().optional(),                    // dialogue/sfx/music lines in the model's own conventions
    preserve: z.array(z.string()).default([]),
    otherSubjects: z.array(z.string()).default([]),  // people/objects that must not change (Genjutsu parity)
    avoid: z.array(z.string()).default([]),          // rendered only when profile.negativePrompt, else folded into prose
    additional: z.string().max(6000).optional(),     // free text appended last (Genjutsu additionalPrompt)
  }).strict(),
  params: z.record(z.string(), z.unknown()).default({}),   // duration, aspect, resolution… validated by schema
  audioPolicy: z.enum(["native", "mute", "replace-in-edit", "reference-driven"]),
}).strict();

export const ReferencePackReceiptSchema = z.object({
  schemaVersion: z.literal(1), projectId: slug, id: slug, createdAt: z.iso.datetime(),
  spec: ReferencePackSpecSchema, profileSha256: hash, endpoint: z.string(),
  schemaSha256: hash, requestSha256: hash,
  attachments: z.array(z.object({ requirementKey: slug, marker: z.string(), pointer: z.string(),
                                  media: mediaPin, provenanceSha256: hash }).strict()),
  compiledPrompt: z.string(), markerMap: z.record(z.string(), z.string()),   // "@Image1" -> assetId
  warnings: z.array(z.string()), reviewFiles: z.array(z.object({ path: z.string(), sha256: hash }).strict()).min(1),
}).strict();
```

Rights, approval and result review reuse the model-preparation shapes, re-keyed to `packSha256`: `PreparationRightsSchema` → `PackRightsSchema`, `PreparationApprovalSchema` → `PackApprovalSchema`, and a generalised `PackResultReviewSchema` (§10.3). The request carries `context.referencePack: { id, sha256 }`, just as `context.modelPreparation` does today. `MaterialItem` gains `referencePack?: { id, sha256 }`. `modelPreparation` stays valid.

Hashes as implemented (WP4, `src/lib/references/packs/`): `receipt.requestSha256` is the canonical-JSON sha256 of `{ provider, endpoint, input }` (provider always written; export `requestDigest`), `packSha256` is that of the parsed receipt, and `request.json` is that request plus `context: { referencePack: { id, sha256: packSha256 } }` and nothing else. Receipt attachment `media` uses `DerivativeMediaPinSchema` (audio has no width or height). `PackApproval.rightsSha256` is present exactly when rights exist; `packRightsRequired` requires them for any video attachment or any attachment whose provenance ancestry is not generated (`manual`, `stock`, unregistered).

---

## 7. The compiler

`compilePack(spec, profile, schema) → { input, compiledPrompt, markerMap, warnings }`. It is a pure function except for the media reads, which are done once into `mediaPin`s.

1. **Resolve** each attachment to an asset and measure it (`importedReferenceMedia`). Refuse media outside slot limits. Do not auto-fix: fixes are explicit derivatives.
2. **Order**: within a slot, by `order`. Across slots, the profile's declared slot order. Identity references come first in prose-indexed dialects, because earlier words and images weigh more [O, FLUX.2].
3. **Bind** to request fields via slot pointers, producing `asset://sha256/...` values that the existing upload path resolves. Elements are assembled into their object shape (Kling: `frontal_image_url`, `reference_image_urls[]`, or `video_url`).
4. **Emit markers** from the dialect: `at-indexed` → `@Image{n}`, `@Video{n}`, `@Audio{n}`; `at-element` → `@Element{n}`; `prose-indexed` → "image {n}"; `natural` → a role description built from `roleSentence` ("the woman in the first reference image"); `parameter` → no prompt markers.
5. **Compose the prompt** in `profile.promptOrder`:
   - the action;
   - a bindings sentence per attachment ("@Image1 is the face and hair of Mara; @Image2 is the market at dusk, take only the place and light");
   - invariants, verbatim;
   - camera;
   - audio, in the profile's convention;
   - preserve;
   - avoid, as a negative prompt if supported, otherwise as prose ("keep …").
6. **Check bijection**: every marker in the final prompt maps to exactly one attachment, every attachment is named at least once, and there are no zero, out-of-range or foreign-dialect markers. This generalises the Genjutsu marker guard.
7. **Validate** the whole input against the endpoint schema and run the provider guard. The pack is valid only when both pass.

Snapshot tests (WP3) fix the compiled output for each profile on one fixture pack.

---

## 8. Storage

```
public/projects/<id>/
  entities/<kind>/<entity>/versions/NNNNNN.json      # existing; + facts, fixedSentence, voice samples
  pipeline/asset-registry.json                       # existing; derivatives imported with origin "derivative"
  pipeline/
    references.json                                  # requirements per shot (revisable draft, validated)
    reference-derivatives/<derivative-id>/
      spec.json  receipt.json  board.html            # immutable; output lives in the asset registry
    references-board.html                            # refs:plan --action board --save (CLI only)
    reference-packs/<pack-id>/
      spec.json  visual-review-template.json         # immutable
      receipt.json  request.json  board.html         # immutable; receipt.json written last; board = what the model will see
      rights.json  approval.json                     # user's statements, exact-hash bound
      results/<output-sha>/                          # result.json, board.html, result-N.png, review-template.json, review.json
    model-preparations/<id>/                         # existing Genjutsu path, read-only after WP9
src/lib/models/reference-profiles.json               # tracked profile data
src/lib/references/coverage.json                     # tracked coverage policy
```

Derivative and pack directories follow the `immutableWrite` and `assertPathWithin` rules of `src/lib/model-preparation/storage.ts`. Everything under `public/projects/` stays git-ignored (root rules).

---

## 9. Commands

All follow the CLI JSON contract, are registered in `src/lib/cli/commands.ts`, and are listed in the playbooks that use them.

| Command | Actions | Spend | MCP |
|---|---|---|---|
| `refs:profiles` | `list`, `show --family F`, `for --endpoint E`, `check` (profiles ↔ catalogue schemas ↔ guards) | none | yes |
| `refs:plan` | `draft --shot S --material-item M --intent I (--family F \| --endpoint E) [--entity kind:id[@rev]]… [--asset role:sha256:HEX]… [--chain-from S] [--write]` (proposes requirements from the intent, target profile, linked cards and imported assets), `check`, `status` (open inputs per shot with the resolving command), `board [--save]` | none | yes (no writes outside `references.json`; `--save` is CLI-only) |
| `refs:derive` | `plan --spec` (dry run: steps, engine, cost if fal), `run --spec [--confirm-spend] [--max-cost-usd]`, `show --id` | registered `may-spend` (only fal steps spend, through the durable job path) | `plan` and `show`; `run` is CLI-only |
| `refs:pack` | `prepare --spec`, `check --id`, `board --id`, `list`, `rights`, `approve --review --answer`, `request --id` (emits the validated request for `generate:model`), `result-board --result`, `review-result` | none | `prepare`, `check`, `board`, `request`, `result-board` yes; `rights`, `approve`, `review-result` CLI-only |
| `entity:card --action coverage` | coverage report | none | via existing tool |

`generate:model` gains:

- detection of profiled endpoints;
- the D8 warning, later the refusal;
- `context.referencePack` validation: the hash matches, the approval exists, the request bytes equal `request.json`.

---

## 10. Integration

### 10.1 Film chain (`src/lib/film/chain.ts`)

- The `material` step adds output `pipeline/references.json` (optional for film types with no generated items) and the done check **`references-ready`**. Every `generated-image` or `generated-video` item either has a shot in `references.json` (matched by `materialItemId`) or carries `referencePlan: {mode: "none", reason}` (text-only generation, D-level choice recorded). The check runs in two phases ([material](../production-chain/material.md)):
  - before the material approval: no `refs:plan --action check` error and no required requirement `missing` (planned, pending-approval and chained inputs may wait);
  - after it: every required requirement `ready`, and the item's `referencePack: {id, sha256}` bound to an approved, current pack.
- The step's commands include `refs:plan`, `refs:profiles`, `entity:card`, `refs:derive` (`--action plan --dry-run`) and `refs:pack`, so the step lease admits them at material for every film type; `refs:derive` is registered `may-spend` and follows the material spend rule.
- The two material approvals of `ai-film` (§3 of its playbook) become:
  1. approval of entity cards, key frames and **reference requirements** (board: `refs:plan --action board`);
  2. approval of packs and spend.
- `film:next` reports missing requirements by shot and the command that resolves each one.

### 10.2 Agents, skills and instructions

| File | Change |
|---|---|
| New skill `.agents/skills/reference-preparation/SKILL.md` + `references/{characters,locations,products,style,motion-video,control-signals,previs-3d,audio,markers,failure-modes}.md` | The craft from §3, as preparation specs and checklists with sources and tiers; the "how to prepare each artefact" contract for agents |
| `world-and-entity-bible` skill | View-role vocabulary, `facts`, `fixedSentence`, coverage, voice samples; when to fork a card (outfit, lighting) |
| `model-and-asset-production` skill | Production loop step 2½: "pack before request"; Genjutsu section points to the general pack flow after WP9 |
| `cinematography` skill | `shot-spec` names camera/motion references and whether a previs pass is needed |
| `.agents/agents/asset-planner.md` | Writes `references.json` with requirements and role sentences; proposes derivatives; never writes markers; leaves sources missing rather than inventing them |
| `.agents/agents/qa-reviewer.md`, `creative-critic.md` | Read the pack and result boards; the QA reviewer fills the mechanical dimensions, the critic judges identity and naturalness |
| `blender-3d` skill + `scripts/blender/kit/` | Depth/normal/mist/camera-path pass export for `blender-pass` |
| Playbooks `ai-film`, `teaser-trailer`, `ugc-ad`, `avatar-presenter`, `product-promo`, `video-remix` | Name `refs:plan`, `refs:derive`, `refs:pack` in Tools; replace prose on markers with "compiled by `refs:pack`" |
| `docs/` | New guide `docs/reference-packs.md` (current behaviour once landed); `higgsfield-prompting.md` marker section points to profiles; `entity-workflow.md` adds coverage |
| `src/lib/AGENTS.md`, `src/types/AGENTS.md`, `scripts/AGENTS.md`, `src/lib/film/AGENTS.md` | Describe the new modules, schemas, commands and the chain check, dated |
| `model-use-cases.json` | `reference-shot`, `character-sheet`, `replace-person`, `restyle-clip`, `lip-sync`, `trailer-world` gain `references: "refs:plan"` hints |

### 10.3 QA

**Mechanical sensors**, at derivative and pack time:

- **Size and format:** resolution/edge limits, aspect, fps, duration window, bytes, format, alpha versus slot.
- **Image content:** border uniformity as a neutral-background heuristic; luminance spread as an even-light heuristic.
- **Motion and control video:** black or frozen frames; scene cuts inside a motion reference (refused for Kling MC); camera motion estimate in a performance clip (warn); temporal flicker of depth video (frame-to-frame delta) (warn above threshold).
- **Audio:** SNR, clipping, length window, single speaker (speech:local diarisation when available).
- **Angles:** angle diversity from declared `yawDeg` (`minDistinctYawDeg`).

**Result review** (`PackResultReviewSchema`):

| Dimension | Values |
|---|---|
| `identity` | pass, fail, not-applicable |
| `wardrobe` | pass, fail, not-applicable |
| `preserved` | pass, fail |
| `otherSubjects` | pass, fail, not-applicable |
| `motion` | pass, fail, not-applicable |
| `naturalness` (no copy-paste of reference pose, light or background) | pass, fail |
| `promptFit` | pass, fail |
| `temporalConsistency` | pass, fail |
| `audio` | pass, fail, replace-in-edit |
| `verdict` | pass, repair, reshoot |

A failed dimension cannot pass, and reshoot asks the user (root rules).

Optional evidence: face-embedding similarity between the result frames and the identity attachments, recorded as a number with its model and version, never as a verdict (D10).

### 10.4 Learning loop

- After each result review, `pnpm memory --add` records an observation: profile family, attachment roles and count, verdict and failing dimension.
- When a problem repeats (`memory --consolidate`), the change goes to the profile's `guidance[]`, a coverage rule or a sensor threshold, with a test. This is the existing creative-postmortem route.
- A dialect tagged `unverified` is promoted to `observed` only after a recorded passing result.

---

## 11. Rights, consent and safety

- A pack inherits each card's likeness and voice consent. A `voice` attachment requires `voice.consent.status = documented` unless the voice is designed or synthetic and not a real person's.
- Source videos used as `source-video`, `motion` or `performance` need `PackRightsSchema` (the same fields as `PreparationRightsSchema`: owned, licensed or study-only; placements; audio rights).
- Real-face policy is checked per profile (D11). A rejected-faces model never receives a consented real face "to try".
- Public URLs required by providers (Seedance, non-expiring) are produced only by the existing upload and remote-media paths. Packs never embed foreign URLs that the user did not supply.

---

## 12. Acceptance criteria

The RFC is implemented when every criterion below (AC1–AC21) holds, with tests in `tests/` (node:test, synthetic fixtures, no paid APIs) unless marked *manual*.

**Profiles**

- AC1. `reference-profiles.json` validates. It has profiles for at least `seedance-2.0`, `seedance-2.5`, `kling-o1`, `kling-o3`, `kling-v3-motion-control`, `nano-banana-2.1`, `flux-2`, `genjutsu-{object-swap,motion-transfer,restyle}`, and `gemini-omni` or `veo-3.1` only if present in the catalogue. Every limit carries an evidence tier and `checkedAt`.
- AC2. `refs:profiles --action check` fails when a profile endpoint is missing from the catalogue, when a slot pointer does not exist in the endpoint schema, or when a limit disagrees with the guard. A test seeds one of each.

**Entities**

- AC3. Cards accept `facts`, `fixedSentence`, voice `sampleAssetIds` and the pronunciation fields. Old cards still validate, and their hashes are unchanged, because the new fields are optional and not defaulted into the hash.
- AC4. `entity:card --action coverage` reports `missing` and `ruleFindings` for a character with a front view only, and `satisfied` for a fixture turnaround with yaw spread ≥45°.

**Requirements**

- AC5. `refs:plan --action draft` produces a valid `references.json` for these fixture shots:
  - a keyframe-image shot;
  - an image-to-video shot;
  - a Seedance reference-to-video shot with two characters, one location and one audio;
  - a Kling motion-control shot;
  - a Wan-style control-to-video shot (if a profile exists) or a pose-plus-image Kling shot.
- AC6. `refs:plan --action check` rejects:
  - over-limit counts per modality and in total;
  - a role in a slot that does not accept it;
  - `ready` with a missing source;
  - last-frame chaining without anchor re-injection;
  - a consented real face aimed at a `realFaces: rejected` profile.

**Derivatives**

- AC7. Local ffmpeg derivatives (trim, crop, scale, fps, snap16, extract last frame, flatten, strip-audio, audio-trim, loudness, contact-sheet) are deterministic. The same spec gives the same output hash on the same machine and ffmpeg version, which is recorded in the receipt.
- AC8. A derivative spec is immutable: a changed spec under the same id fails with `FILE_EXISTS`. Outputs are registered with `origin: "derivative"` and a receipt link.
- AC9. A fal-backed derivative step plans through `generate:model --dry-run` and records `operationId`. Without approval it stays `pending` and is never marked ready. Tested with a fake transport.
- AC10. `blender-pass` emits depth (EXR or 16-bit PNG sequence plus a normalised preview video) and a camera-path JSON for a fixture scene. This is an environment-gated test, skipped without Blender.

**Packs and compiler**

- AC11. For each profile, a snapshot test fixes the compiled `input` and `compiledPrompt` for one fixture pack. The marker bijection holds: every marker resolves, every attachment is named, and the dialect is correct (`@Image1` versus "image 1" versus natural language).
- AC12. The compiler refuses media outside slot limits and never repairs it silently. The error names the derivative step that would fix it.
- AC13. `refs:pack --action prepare` writes the spec, receipt, request and board, immutably. The board shows each attachment with its marker, role sentence, measured facts and warnings, and the compiled prompt.
- AC14. `generate:model --dry-run` on a request with `context.referencePack` verifies the pack hash, the approval and the request bytes. A tampered request fails. Without a pack on a profiled endpoint with reference fields: warning in phase 1, refusal in phase 2 (feature flag in tests).
- AC15. Genjutsu parity (WP9):
  - the existing `tests/model-preparation.test.ts` passes unchanged;
  - a Genjutsu pack with `promptTemplate: "genjutsu-legacy"` produces the same request input (field values and attachment order), the same marker map and a byte-identical prompt to `genjutsuPrompt()` for the fixtures used there, including `otherSubjects`, `additionalPrompt` and `useMarkers: false`.

**Chain and agents**

- AC16. The `material` step's `references-ready` check fails for a generated item without ready requirements or a `referencePlan: {mode: "none", reason}`. `film:next` names the missing requirement and its command.
- AC17. `tests/commands-registry.test.ts`, `tests/agents-md.test.ts`, `tests/portable-craft-skills.test.ts` and `pnpm commands --write-doc` agree with the new commands, skills and AGENTS.md changes. All `AGENTS.md` files stay within their size budgets.
- AC18. The `reference-preparation` skill has a reference file per §3 subsection. Every model-specific number in it cites a source with tier and date, and a test greps that every numeric limit line carries a link.
- AC21. Agent behaviour is tested by behavioural instruction tasks in `bench/instructions/` (the RFC 0001 §4.5 format: `task.json`, `answers.json`, `check.mjs`), tier `no-spend`:
  - `reference-plan`: an agent following the `ai-film` playbook and the `asset-planner` brief, on a fixture project with approved cards and a three-shot script, writes a `references.json` that passes `refs:plan --action check`. Every generated material item has ready requirements, a pack or a `referencePlan: {mode: "none", reason}`, and the agent stops at the pack approval gate without fabricating approval.
  - `no-hand-markers`: `check.mjs` asserts that no prompt text outside a pack's `compiledPrompt` contains `@Image`, `@Video`, `@Audio` or `@Element`. That covers `material.json`, request files and the agent's notes.
  - `reference-derivative-first`: given an over-length motion clip, the agent proposes a `trim` derivative instead of passing the clip or editing limits.
  - The new skill and the edited agent files stay within the context budgets measured by `pnpm context:budget` (RFC 0001 §4.2).
- AC19. *manual* — one end-to-end dry run on a fixture project: cards → `refs:plan` → derivatives → pack → board → `generate:model --dry-run`. It completes with no hand-written markers, and the result is recorded in `out/qa/` (ignored).

**Gates**

- AC20. `pnpm check` passes: hygiene, format, lint, typecheck, tests. No media binaries are tracked; fixtures are tiny synthetic files generated in tests.

---

## 13. Development plan

The work runs in a separate worktree on branch `feat/reference-packs`. Packages are sized for one subagent each. The dependency graph allows three parallel lanes after WP0.

```
WP0 schemas ──┬─► WP1 profiles ──► WP3 compiler ──► WP4 packs CLI ──► WP6 generate:model integration ──► WP9 Genjutsu migration
              ├─► WP2 entity coverage ──────────────┘                     │
              ├─► WP5 derivatives (local) ──► WP5b paid + Blender passes   │
              └─► WP7 refs:plan + chain check ◄────────────────────────────┘
WP8 skill + instructions (starts after WP0, finalises after WP7)      WP10 QA sensors + result review (after WP4)
```

| WP | Scope | Main files | Depends | Tests and acceptance |
|---|---|---|---|---|
| WP0 | Schemas from §6 (roles, facts, profiles, requirements, derivatives, packs, rights, approvals, result review), exports, `src/types/AGENTS.md` | `src/types/references.ts`, `src/types/reference-profiles.ts`, `src/types/entities.ts`, `src/types/film.ts` | — | Schema unit tests incl. invariants; AC3 hash stability |
| WP1 | Profile data for AC1 families from the catalogue schema and §3 evidence; loader; `refs:profiles` CLI; agreement test with guards | `src/lib/models/reference-profiles.json`, `src/lib/references/profiles.ts`, `scripts/refs-profiles.ts` | WP0 | AC1, AC2 |
| WP2 | Coverage policy, `entity:card --action coverage`, voice samples, fixedSentence, board shows facts | `src/lib/references/coverage.{json,ts}`, `src/lib/entities/*`, `scripts/entity-card.ts` | WP0 | AC3, AC4 |
| WP3 | Pure compiler: resolve, order, bind, emit markers per dialect, compose, bijection, schema + guard validation | `src/lib/references/compile.ts`, `src/lib/references/dialects.ts` | WP0, WP1 | AC11, AC12; snapshot per profile |
| WP4 | Pack storage and CLI: prepare/check/board/rights/approve/request/result-board/review-result (generalised from `model-preparation`) | `src/lib/references/packs/*`, `scripts/refs-pack.ts` | WP3 | AC13; immutability; approval binding |
| WP5 | Local derivatives: ffmpeg ops, matte cut-out/flatten, receipts, registry import, board | `src/lib/references/derive/*`, `scripts/refs-derive.ts` | WP0 | AC7, AC8 |
| WP5b | fal-backed depth/pose/mask/audio-clean via `generate:model`'s library path (durable job, `pending.json` until published); Blender depth/normal/mist/clay/beauty/camera-path export. A fal or Blender step leads its derivative (chain earlier steps with `input.derivativeId`) | `src/lib/references/derive/{fal,blender}.ts`, `scripts/blender/kit/passes.py` | WP5 | AC9, AC10 (env-gated) |
| WP6 | `generate:model` and asset-plan integration: `context.referencePack`, warn then refuse, MaterialItem `referencePack` | `scripts/generate-model.ts`, `src/lib/providers/*`, `src/lib/asset-dispatcher.ts` | WP4 | AC14 |
| WP7 | `refs:plan` draft/check/status/board; chain `references-ready`; `film:next` hints | `src/lib/references/plan.ts`, `scripts/refs-plan.ts`, `src/lib/film/chain.ts` | WP1, WP2, WP4 | AC5, AC6, AC16 |
| WP8 | Skill `reference-preparation` and references; updates to bible/production/cinematography skills, asset-planner, qa-reviewer, critic, playbooks, docs guide, AGENTS.md files | `.agents/**`, `playbooks/**`, `docs/reference-packs.md` | WP0 (draft), WP7 (final) | AC17, AC18 |
| WP9 | Genjutsu as profiles; `model:prepare` delegates to packs; parity | `src/lib/model-preparation/*` | WP4, WP6 | AC15 |
| WP10 | Mechanical sensors (§10.3) at derive/pack time; result review dimensions; memory hook | `src/lib/references/sensors.ts`, `src/lib/sensors/*` | WP4, WP5 | Sensor unit tests on synthetic media; failed-dimension invariant |
| WP11 | E2E fixture project, behavioural instruction tasks, the manual dry run; release entry in `.changes/` | `tests/fixtures/references/*`, `bench/instructions/{reference-plan,no-hand-markers,reference-derivative-first}/`, `examples/` | all | AC19, AC20, AC21 |

**Order of merging:**

1. WP0.
2. WP1, WP2 and WP5 in parallel.
3. WP3.
4. WP4 and WP10.
5. WP6 and WP7.
6. WP5b.
7. WP9.
8. WP8 final.
9. WP11.

Each package rebases on the integration branch and runs `pnpm check` before it is merged into `feat/reference-packs`. The branch merges into `main` once, after AC1–AC21.

### 13.1 Subagent brief template

Each package is dispatched with this brief. Leaf agents do not spawn agents (root rules).

```
Goal: implement WP<n> of docs/rfcs/0003-reference-packs.md (§<sections>) in worktree <path>, branch feat/reference-packs-wp<n>.
Read first: the RFC sections named above; AGENTS.md of each area you touch (src/types, src/lib, scripts, tests, .agents as relevant);
the existing pattern you generalise (src/lib/model-preparation/* for packs, src/lib/providers/fal-guards/* for limits).
Do: the scope row of WP<n>, nothing else. Reuse helpers named in the RFC (importedReferenceMedia, immutableWrite,
assertPathWithin, runScript, CliErrorObject). Keep the CLI JSON contract. No paid calls; fakes for transports.
Tests: add node:test files covering the WP's acceptance criteria (AC<k>…); keep fixtures synthetic and tiny; register slow ones
in scripts/test-fast.ts per tests/AGENTS.md.
Update: the nearest AGENTS.md (dated 2026-MM-DD), the command registry and `pnpm commands --write-doc` for new commands.
Done when: `pnpm check` passes; the listed ACs have tests; report changed files, test names, and any RFC deviation with reason.
Not allowed: changing approved behaviour outside the WP; inventing provider fields or limits without a cited source;
writing markers by hand anywhere but dialect templates.
```

WP8, the instruction work, adds: "Every model number cites a source and tier from RFC §3; keep each `AGENTS.md` within its budget; skills describe decisions and checks, never duplicate `--help`."

---

## 14. Risks and open questions

| Risk | Mitigation |
|---|---|
| Provider limits change monthly | Profiles carry `checkedAt` and tiers; `refs:profiles --action check` in CI against the catalogue; `models:refresh` flags profiled endpoints whose schema hash changed |
| Unverified dialects produce silently ignored references | `unverified` warning in every plan and board; first live result recorded in memory; Seedance/Kling markers are official or observed |
| Over-engineering for simple shots | `referencePlan: {mode: "none", reason}`; the planner proposes the minimal set ("small and coherent", §3.4) |
| Local depth/pose models add weight downloads | Model weights via the existing model cache manifest (`src/lib/matte/models.json` pattern), never in git; fal fallback via budget |
| Genjutsu regression | WP9 last, behind parity tests (AC15) |
| Context growth in instruction files | Detail lives in the skill's references, loaded per task; AGENTS.md edits are pointers only |

Open questions for the maintainer:

- Q1. Should `references.json` be per shot (`pipeline/references/<shot>.json`) for very long films? The proposal is one file until a film exceeds about 60 shots.
- Q2. Which local depth and pose engine should be pinned: Video Depth Anything (small) and DWPose ONNX? This needs a licence check before WP5b.
- Q3. Should packs be shareable across projects (campaign reuse), as cards are pinned in campaigns? The proposal is "later": copy by hash.

## 15. Implementation notes (2026-11-17)

Contract text above was corrected where the implementation differs; the differences, for review:

- `MaterialItem.referencePlan` is an object, `{mode: "none", reason}`, not the string `"none"` (§10.1, AC16, AC21, §14).
- `references-ready` runs in two phases around the material approval (§10.1), so planned and chained inputs can wait for the first approval.
- Result-review "n/a" values are `not-applicable` (§10.3). Each result folder also holds `result.json`, stills and a `review-template.json`; a pack also writes `visual-review-template.json` (§8).
- `refs:pack` has a `list` action; `refs:plan --action board` writes a file only with `--save` (§9). `refs:plan --help` does not print the repeatable `--entity` and `--asset` flags, which `refs:plan` reads before argument parsing.
- `refs:derive` is registered `may-spend` as a whole; under an enforcing step lease its `plan` needs `--dry-run` before the material approval (§9, §10.1).
- Local `depth-video`, `pose-video`, `mask-video` and `audio-clean`, and lineart `edge-video`, are not built: `refs:derive --action plan` reports them as `not-implemented`; the working engines are fal (paid) and Blender passes (D7, §6.4). No profiled family has a depth, pose, edge or mask slot yet, so `control-to-video` carries a pose sequence as a motion input.
- Slots gained `marker: "none"` (positional inputs) and `markerGroup` (§6.2); the hash contract is in §6.5.
- The coverage policy's `minDistinctYawDeg` is 45, while `runReferenceSensors` calls the angle sensor with its default of 30 (`SENSOR_THRESHOLDS.minDistinctYawDeg`, documented as "as the coverage policy's"); open: align them.
- The skill's model-specific numbers are checked for a source link, tier and date by `tests/reference-preparation-skill.test.ts` (AC18).

## Appendix A. Preparation quick reference (agent-facing summary of §3)

| Artefact | Prepare | Avoid |
|---|---|---|
| Character identity | Master image; 3–4 views ≥45° apart; face close-up; even light; neutral background; empty hands; one outfit per sheet; fixed sentence | Near-duplicate angles; scene backgrounds; strong style; props in hand |
| Wardrobe | Its own `outfit:*` sheet or the identity image; stated in prompt when the element carries the face only | Expecting a face element to carry clothes |
| Location | `plate-wide` per lighting state, empty, plus a reverse angle; role sentence "take only the place and light" | Populated plates; one plate for day and night |
| Product | Front packshot, soft light, no highlight on label, hex colours; logo composite planned | Relying on more angles to fix text |
| Style | Board without the subject; role sentence "style only" | Style images containing the hero |
| First/last frame | Approved key frame at target aspect and resolution | Using a general reference as an endpoint |
| Motion/performance video | One performer, full body, single shot, no camera move, trimmed to the model window, framing matched to the character image | Cuts, handheld, multiple people |
| Camera reference | Previs clay or plate video with the intended move; or Blender camera path | Calling a clay render a depth map |
| Depth / pose / edge | Video Depth Anything / DWPose / lineart at exact output size, fps and frames (Wan: multiples of 16) | Per-frame depth flicker; mismatched frame counts |
| Mask | Matte or SAM video, coarse versus fine chosen for the shot | Masks that leak body shape when replacing a person |
| Voice | 5–30 s clean single speaker for video models; 1–2 min for instant clone; pronunciation aliases | Music under speech; several speakers; clipping |
| Chaining | Re-attach original references every shot; colour-match boundary only | Last frame → first frame for more than two segments |
