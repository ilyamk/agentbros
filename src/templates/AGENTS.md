# Templates — Agent Rules

Last updated: 2026-11-16

Reusable frame-driven components. The Remotion-only animation and media rules in the [root AGENTS.md](../../AGENTS.md) apply, and `pnpm lint` enforces them here. `src/lib/design-tokens.ts` holds the default values. `RegisteredTemplate` and `TalkingHeadScene` still fade out over their last 9 frames; that is current behaviour, not a rule.

| Path | Contents |
|------|----------|
| `text/` | Text animation components (table below) |
| `backgrounds/`, `effects/`, `overlays/` | `GradientBackground`, `GridPattern`; `GlowPulse`, `Particles`, `GradientShift`; `Vignette`, `ScanLines`, `NoiseGrain` |
| `components/` | `LottieAsset` |
| `talkinghead/` | `TalkingHeadLayout`, `TalkingHeadVideo`, `KaraokeCaptions` |
| `leftpanel/` | `LeftPanelRouter` and panels; `_canvas.ts` carries the shared light/dark canvas |
| `registry/` | Components for registered templates (`src/lib/templates/`, [recipes](../../docs/template-recipes.md)) |

---

## Talking-Head Format (landscape 1920×1080)

Split-screen frame: **right** = presenter video, **left** = dynamic visual panel, **bottom** = karaoke captions, all wrapped in a peach (`#F4B89C`) padded border.

### Project schema
In `project.json`:
```jsonc
{
  "formats": ["landscape"],
  "talkingHead": {
    "enabled": true,
    "presenterVideo": "projects/{id}/talking-head/full.mp4",
    "borderColor": "#F4B89C",
    "rightPanelWidthFraction": 0.32,
    "captionStyle": { "activeColor": "#FFE600", "fontSize": 56 }
  },
  "scenes": [{
    "id": "hook",
    "text": "TTS text matching what the presenter said",
    "presenterStartSec": 0,
    "presenterEndSec": 4,
    "leftPanel": { "kind": "chart", "data": [...], "chartType": "line" }
  }]
}
```

### Left panel kinds
| Kind | Use | Source |
|------|-----|--------|
| `chart` | animated line/area/bar chart from data points | inline JSON data |
| `sketch` | hand-drawn line graph (e.g. catastrophic curve) | normalised [0–1] points |
| `screenshot` | UI/website screenshot with Ken Burns | `assets/screenshots/` |
| `tweet` | X/Twitter post mockup | inline (author/handle/text) |
| `meme` | meme image | `assets/memes/` (gpt-image-2) |
| `aiImage` | AI-generated image with strong Ken Burns | fal.ai gpt-image-2 / FLUX |
| `archival` | clip from a longer source video | `assets/videos/` |
| `text` | typographic statement (no visual) | inline string |

### Components (USE THESE)
- `<TalkingHeadLayout>` from `src/templates/talkinghead/` — split-screen frame
- `<TalkingHeadVideo>` — `<Video>` slice with `startSec`/`endSec` (via `trimBefore`/`trimAfter`)
- `<KaraokeCaptions>` — word-level karaoke (consumes `WordAlignment[]`)
- `<LeftPanelRouter panel={scene.leftPanel}>` from `src/templates/leftpanel/` — dispatcher; switches on `panel.kind`

### Karaoke captions pipeline
1. Generate voiceover: `pnpm generate:voiceover -- --project <id>`
2. Align: `pnpm align:captions -- --project <id>` — produces `voiceover/{sceneId}.words.json` via ElevenLabs forced alignment.
3. `KaraokeCaptions` reads the JSON via `staticFile()` + `fetch` at runtime.

Each `WordAlignment = { text, start, end, loss }` with seconds-based timestamps.

Live presenter rules are under [Talking-head essentials](#talking-head-essentials). Presenter specs for a template project: [asset-planner examples](../../.agents/skills/creative-studio/references/asset-planner-examples.md).

### Karaoke styling defaults
Bold italic, font-size 56 (landscape), `WebkitTextStroke: 8px #000`, active word `#FFE600`, inactive `#FFFFFF`. Override via `talkingHead.captionStyle`.

### Layout defaults
- Border colour: `#F4B89C` (peach)
- Right panel width: 32% of inner width
- Outer padding: 40px, panel gap: 24px, border radius: 28px


---

## Text animation components

Ready-made; write a custom frame-driven component when the idea needs more.

From `src/templates/text/`:

| Component | Props | Entrances |
|-----------|-------|-----------|
| `WordByWord` | `text, entrance, staggerSec, accentWordIndex, accentColor` | fade, slideUp, scale, pop |
| `LineByLine` | `lines, entrance, staggerSec` | slideUp, slideLeft, fade, clipReveal |
| `LetterReveal` | `text, entrance, staggerSec` | fade, slideUp, scale, rotateIn |
| `SlideReveal` | `text, direction` | left, right, up, down |
| `ScaleWord` | `text, bounce, staggerSec` | none, soft, hard |
| `ClipReveal` | `text, direction` | left, right, center |
| `TypewriterText` | `text, charsPerSecond` | — |
| `WordHighlight` | `text, highlightWord, highlightColor` | — |
| `CountUp` | `from, to, suffix` | — |

## Backgrounds and effects

**Gradient presets** (`gradients` from design-tokens), a palette rather than a closed list:

| Preset | Feel | Use |
|--------|------|-----|
| `cleanLight` | Solid #F0F0F0 | Minimal editorial |
| `cleanDark` | Solid #0A0A0F | Dark minimal |
| `aurora` | Purple/blue/teal/pink | Tech products |
| `sunset` | Orange/pink/purple | Bold promos |
| `ocean` | Deep blue/teal | Professional |
| `purplePinkTeal` | Bright purple-pink-teal | Phone showcases |
| `greenMint` | Green/mint | WhatsApp/green brand |
| `iridescent` | Blue/teal/yellow | Playful |
| `polarLights` | Purple/teal cinematic | Dramatic |
| `minimalLight` | Barely-visible pastels | Ultra-clean |

```tsx
<GradientBackground {...gradients.aurora} />  // animated by default
```

**Effects:** `GlowPulse`, `Particles`, `GradientShift` (from `src/templates/effects/`)
**Overlays:** `Vignette`, `ScanLines`, `NoiseGrain` (from `src/templates/overlays/`)
**Other:** `GridPattern` (backgrounds), `LottieAsset` (components)

**Layer stack:** Background → Scene content (TransitionSeries) → Effects → Overlays → Voiceover audio → Background music

## Device mockups

Starting points, not law.

- Phone fills **60-85%** of frame. Use `phoneMockup.width[fmt]` from tokens (560 vertical, 640 square, 480 landscape).
- **Crop preferred** — let phone extend beyond frame edges.
- A subtle float (`sin(frame)`, ±5-10px Y) is a dependable starting point; hold the phone still when the edit needs it.
- A light background often suits a showcase; choose by the idea and keep the frame contrast below.
- Frame style contrasts bg: dark frame on light bg, silver/light on dark bg.
- One phone per scene (exception: sandwich layout).
- Use `<Img>` from remotion, `objectFit: "cover"`, Dynamic Island present.
- Entrance: slide-up (bouncy) or scale (smooth) are dependable; choose the exit the edit needs.

## Talking-head essentials

Do not break these:

- The presenter is one continuous file, `talking-head/full.mp4`. Never concatenate three or more short clips.
- One audio owner: with native presenter audio, `talkingHead.audioSource = "embedded"` and no ElevenLabs voiceover for those beats. Layering both produces a double voice.
- `TransitionSeries` duration = sum of scenes − sum of transitions; otherwise the final frames render black.
- `design.json.talkingHead.leftPanelCanvas` is set once by design-director. Do not switch panel mood between scenes.
- Choose each transition with `transitionToNext`; left unset, the renderer fades for 12 frames.
- Hold a panel while its visual argument is unchanged: at most 3–4 panel changes in a video of 20 seconds or less.
- Budget words per language: about 2.3 words/sec for Russian and 2.5 for English at a calm pace.
- Run `pnpm pipeline:check` (stateless) before rendering; `error` findings block shipping. It checks audio-source coherence (`AUDIO_SOURCE_MISMATCH`, `MODE_A_VOICEOVER_LEAK`), transition maths, panel-mood adjacency, word budget (`WORD_BUDGET_OVERFLOW`) and asset coverage.
- Chart panels carry a title, axis units and a callout (`title`, `yUnit`, `callout`, `annotations[]`); never a bare line. For a single number, `kind: "text"` with `size: "hero"` lands harder.
- In vertical and square, `TalkingHeadVideo` crops the presenter at `objectPosition: 50% 30%` so the head stays in frame; override per format with `talkingHead.presenterCrop`. Face position is not detected: check stills after a format change.
- One storyboard, several formats: `brief.outputFormats` lists them, each format is a composition sharing the same props, and `TalkingHeadLayout` switches side-by-side or stacked from `useVideoConfig()`. To add vertical to a finished landscape project, add the format to `project.json.formats` and render it.

## Playbooks

A new template, recipe or style goes into the playbooks of the tasks it serves in the same commit (`starter.template` or `starter.style`, or a route `alternatives` entry with `kind: template`); `pnpm playbook --uses <id>` shows where an id is used ([playbooks](../../playbooks/AGENTS.md)).

## See also

- [Template recipes](../../docs/template-recipes.md) and the registry in `src/lib/templates/`; `tests/templates-recipes.test.ts`, `tests/talkinghead-audio.test.ts`.
- [src/components/AGENTS.md](../components/AGENTS.md) for the compositions that mount these components.

`scene.visualisation` displays pinned prepared plans directly, retaining the final reading hold; it does not inherit the older template exit fade.
