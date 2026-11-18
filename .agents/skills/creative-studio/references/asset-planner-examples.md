# Asset planner — worked examples

Reference for the [asset-planner](../../../agents/asset-planner.md) agent: spec examples, prompt structures, music prompts and the historical talking-head modes.

## AssetSpec shape

```jsonc
{
  "id": "s03-pain-meme",
  "kind": "meme",
  "source": "fal-model",
  "metadata": { "operationRequest": { "family": "nano-banana-2.1", "operation": "text-to-image", "input": { "prompt": "..." } } },
  "targetPath": "assets/memes/s03-pain.png",
  "status": "pending"
}
```

Three schema-tested modern specs: [docs/examples/modern-asset-plan.json](../../../../docs/examples/modern-asset-plan.json).

ID examples: `s01-hook-inline`, `s03-pain-meme`, `s04-solution-aiimage`, `s05-proof-stockvideo`, `s02-pain-sfx`, `bg-music`, `presenter-full`.

## Character-injected image prompt

`"CHARACTER: {visualPrompt}. ACTION: {scene action}. SETTING: {derived}. LIGHT: {derived}. STYLE: {motionStyle-appropriate style phrase}. CAMERA: medium shot, shallow depth of field."`

## Style phrases by `design.motionStyle`

- cinematic → "warm shallow depth of field, anamorphic"
- snappy → "bold graphic, high contrast"
- playful → "bright saturated, soft vignette"

Photoreal/text-heavy image models: favour photographic description and, if the headline should appear in the image, an explicit text instruction ("text overlay in bold sans-serif at bottom: 'YOUR HEADLINE'"). Stylised models: atmospheric description, no text. Memes: name the template, the top and bottom text and the tone.

## Music prompt starting points

- `cinematic` / `smooth` → "Cinematic orchestral underscore, subtle tension, resolves to warmth, 60–90 seconds, no lyrics"
- `snappy` / `playful` → "Upbeat electronic background track, punchy rhythmic feel, energetic, 30–60 seconds, no lyrics"
- Blend themes: "motif: {themes[0]}, {themes[1]}"

## Talking-head presenter prompt (80–180 words, in this order)

1. **CHARACTER** — the presenter's `visualPrompt`, condensed to one sentence.
2. **PERSONA / TONE** — `presenterPersona`, e.g. "calm economics-lecturer".
3. **WORD BUDGET** — `Total speaking time approx N seconds. The presenter says, in {language}, EXACTLY: "<all beats, natural pauses, no SSML>"`. Quoted dialogue is what makes the model speak it.
4. **DELIVERY ARC** — 2–4 emotional beats mapped to seconds ("0–4s: neutral curious tone. 4–9s: empathetic concern…").
5. **PHYSICAL CHOREOGRAPHY** — 2–3 gesture beats ("slight head-tilt on the contradiction", "single calm nod on the final stat").
6. **STYLE ANCHOR** — the same string in every presenter clip of a project, e.g. "Cinematic 35mm shallow depth of field, soft key light from camera-left, warm muted tones, slow deliberate camera, photographic realism not illustrative."
7. **CAMERA** — "Static medium-close shot, presenter centred, head and shoulders, vertical 9:16."
8. **CONSTRAINTS** — "No text overlays. No on-screen captions. No subtitles."

## Historical talking-head modes (Seedance 2.0)

These preserve old projects and lessons. They are not defaults, and their 15-second limits do not apply to Seedance 2.5. Never plan per-scene presenter clips to be concatenated: each cut snaps the presenter back to the reference keyframe, and lip-sync is lost.

**Mode A — native audio, single clip.** Seedance generates video and speech together. With `metadata.generateAudio: true`: voice-producer skips TTS for presenter beats (it reads `nativeAudioDirection`); composer sets `talkingHead.audioSource = "embedded"`; narrator-director writes `nativeAudioDirection`, not beats. Record this as a "Mode A handoff" note in asset-plan.md. Historical limit: ≤ 15 s.

```jsonc
{
  "id": "presenter-full", "kind": "ai-video", "source": "fal-bytedance",
  "prompt": "<presenter prompt above>",
  "targetPath": "talking-head/full.mp4",
  "metadata": { "model": "seedance-2-fast", "duration": 15, "aspect": "9:16", "resolution": "720p", "generateAudio": true },
  "status": "pending"
}
```

Optional `referenceImageUrls: [<presenter-portrait url>]`; the portrait spec then precedes it.

**Mode B — two segments with i2v continuity (> 15 s).** `presenter-seg1` and `presenter-seg2`, each ≤ 15 s, `generateAudio: true`. seg2 has `metadata.dependsOn: ["presenter-seg1"]`; its `referenceImageUrls` is patched with seg1's last frame (ffmpeg) after seg1 exists. The fetch step concatenates them into `talking-head/full.mp4`; presenter times stay cumulative across it.

**Mode C — recorded presenter.**

```jsonc
{
  "id": "presenter-full", "kind": "talking-head-clip", "source": "manual",
  "targetPath": "talking-head/full.mp4",
  "metadata": { "note": "Record one continuous take covering all scenes. Place at public/projects/{id}/talking-head/full.mp4." },
  "status": "pending"
}
```

**Optional `presenter-portrait`.** One `ai-image` (historically `fal-gpt-image`, 1024×1536) with the presenter's `visualPrompt` plus " — vertical 9:16 portrait, waist-up, looking directly into camera, neutral lecturer/blogger expression, photographic realism". A consistent face for stills and lipsync overrides; not a dependency of Mode A.

Historical prompt notes: `fal-gpt-image` favoured photoreal scenes with optional text; `fal-flux` favoured stylised images without text and needed background removal.
