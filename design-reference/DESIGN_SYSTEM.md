# Design System — Agent Bros. Pictures

## Video Formats

| Platform        | Max Duration | Aspect | Resolution  |
|----------------|-------------|--------|-------------|
| Instagram Reel | 90s         | 9:16   | 1080×1920   |
| YouTube Short  | 60s         | 9:16   | 1080×1920   |
| TikTok         | 60s         | 9:16   | 1080×1920   |
| Feed Post      | N/A         | 1:1    | 1080×1080   |

All videos render at **30 fps** in both **vertical** (9:16) and **square** (1:1) formats.

---

## Color Palettes

Predefined palettes in `src/lib/design-tokens.ts → palettes`:

| Palette | Accent | Background | Text | Use Case |
|---------|--------|-----------|------|----------|
| `darkTech` | `#6C5CE7` | `#0F0F0F` | `#FFFFFF` | Default tech product |
| `neonGradient` | `#FF6B6B` | `#0D0221` | `#FFFFFF` | Bold, energetic |
| `oceanBlue` | `#00CEC9` | `#0A1628` | `#E8F4FD` | Calm, professional |
| `warmSunset` | `#FF9F43` | `#1A0A0A` | `#FFF5E1` | Warm, inviting |
| `forestGreen` | `#00B894` | `#0A1A0A` | `#E8FDE8` | Natural, eco |
| `minimalLight` | `#6C5CE7` | `#FAFAFA` | `#1A1A2E` | Clean, editorial |
| `coralPop` | `#E17055` | `#FFFFFF` | `#2D3436` | Friendly, bold |
| `whatsappDark` | `#25D366` | `#0A0A0F` | `#FFFFFF` | WhatsApp/green branded |

Custom colors are set per-project in `project.json → colors`.

---

## Typography

### Font Families (from `src/lib/fonts.ts`)

| Import | Font | Role |
|--------|------|------|
| `primaryFont` | Inter 400-900 | Body text, subtitles, descriptions |
| `displayFont` | Space Grotesk 500-700 | Scene headers, headlines |
| `condensedFont` | Bebas Neue 400 | MASSIVE uppercase poster titles |
| `serifFont` | Playfair Display italic | Elegant accent headlines |
| `serifNormalFont` | Playfair Display normal | Serif normal weight |
| `roundedFont` | DM Sans 400-900 | Friendly softer alternative |
| `narrowFont` | Oswald 400-700 | Compact bold text in tight spaces |
| `geometricFont` | Montserrat 400-900 | Modern geometric titles |
| `cyrillicCondensedFont` | Sofia Sans Extra Condensed, variable | Cyrillic poster titles |
| `cyrillicWideFont` | Unbounded, variable | Cyrillic wide display |
| `cyrillicGroteskFont` | Golos Text, variable | Cyrillic headlines and text |
| `cyrillicRoundedFont` | Rubik, variable | Cyrillic friendly sans |

`displayFont`, `condensedFont` and `roundedFont` are Latin only. Choosing a face: [src/lib/AGENTS.md](../src/lib/AGENTS.md#fonts).

### Typography Scale (from `design-tokens.ts`)

| Token | Vertical (px/weight/lh) | Square (px/weight/lh) | Usage |
|-------|------------------------|----------------------|-------|
| `hero` | 120 / 900 / 0.92 | 88 / 900 / 0.92 | MASSIVE fill-width titles |
| `condensedHero` | 140 / 400 / 0.9 | 100 / 400 / 0.9 | Bebas Neue uppercase posters |
| `bigTitle` | 84 / 800 / 0.95 | 64 / 800 / 0.95 | Hook scenes, hero text |
| `headline` | 68 / 700 / 1.0 | 52 / 700 / 1.0 | Scene headers |
| `feature` | 56 / 700 / 1.05 | 44 / 700 / 1.05 | Card headlines, product names |
| `subtext` | 30 / 400 / 1.5 | 24 / 400 / 1.5 | Supporting descriptions |
| `cta` | 40 / 700 / 1.2 | 34 / 700 / 1.2 | CTA button text |
| `small` | 24 / 500 / 1.4 | 20 / 500 / 1.4 | Labels, tags |
| `accentSub` | 28 / 600 / 1.3 | 22 / 600 / 1.3 | Colored uppercase subtitles |
| `serifAccent` | 72 / 700 / 1.0 | 56 / 700 / 1.0 | Italic Playfair accent |

### Typography Guidance

Tokens and these notes are defaults; choose what the idea needs and check it in frames.

1. **Clear hierarchy** — one element is plainly the most important at playback size. `hero`, `condensedHero` and `bigTitle` are strong starting points for hooks.
2. **Tight line-height for large headlines** — 0.9-1.0 reads as one block; allow room for Cyrillic ascenders and descenders.
3. **Pairing** — one display and one body face is dependable; more faces need a reason.
4. **Accent colour** — useful for leading the eye to the key word.

---

## Device & Mockup Rules

### Core Principle

**Devices MUST be shown LARGE — filling 60-85% of the frame.** Cropping is encouraged and preferred over showing the full device small.

### Display Modes

| Mode | Description | When to Use |
|------|-------------|-------------|
| **Full Device** | Whole phone visible, fills 60-80% | Product overview, full-screen UI |
| **Top Crop** | Only top portion visible | Notifications, headers, top sheets |
| **Bottom Crop** | Phone extends below frame edge | Chat views, bottom sheets, tab bars |
| **Sandwich** | Two partial phones with text between | Before/after, comparison |
| **Float Out** | UI elements pop out of phone frame | Widgets, interactive elements |

### Phone Dimensions (from `design-tokens.ts`)

| Property | Vertical | Square |
|----------|----------|--------|
| Phone width | 520px | 480px |
| Phone height | ~1123px | ~1037px |
| Aspect ratio | 2.16:1 | 2.16:1 |
| Bezel radius | 12% of width | 12% of width |
| Dynamic Island | 28% × 7.5% of width | 28% × 7.5% of width |

### Frame Styles

| Style | Background Usage | Look |
|-------|-----------------|------|
| `dark` | Bright/gradient backgrounds | Dark metallic bezel |
| `silver` | Dark backgrounds | Polished silver bezel |
| `light` | White/light backgrounds | Subtle light frame |

### Layout Presets

**Vertical (1080×1920):**
- `textTopPhoneBottom` — text in top 38%, phone from 38% down (cropped at bottom)
- `fullBleed` — phone fills ~80% of frame (width: 580px)
- `centered` — phone in middle, text above/below
- `topCrop` — only top 40% of phone visible

**Square (1080×1080):**
- `textTopPhoneBottom` — text in top 42%, phone fills bottom (cropped)
- `sandwich` — partial top phone + text center + partial bottom phone
- `centeredFloat` — phone center with floating elements
- `fullBleed` — phone fills nearly entire frame

### Mockup Animation Rules

1. **Always add float animation** — ±5-10px Y oscillation (3s period)
2. **Entrance: slide-up with bounce** — `spring({ damping: 12-14, stiffness: 80 })`
3. **Subtle tilt** — 3-5° rotateY for perspective depth
4. **Background for showcase: LIGHT or BRIGHT GRADIENT** — dark backgrounds make phones disappear
5. **Frame MUST contrast background** — dark on light, light on dark
6. **Screenshot fills screen** — `objectFit: "cover"`, no black bars

---

## Scene Types

### 1. Title Scene (Hook)
- Centered text, large headline (`bigTitle` or `hero` token)
- Accent line divider animation
- Bouncy scale entrance (`veryBouncy` spring)
- Purpose: Grab attention in first 1-2 seconds

### 2. Feature Scene
- Left-aligned card layout with accent border
- Decorative dot grid pattern
- Gradient background shift
- Purpose: Present key features or pain points

### 3. Product Scene
- Centered product name with radial glow
- Pulsing glow effect (ambient)
- Bouncy spring entrance
- Purpose: Hero moment for the product

### 4. Phone Showcase Scene
- Realistic iPhone mockup with Dynamic Island
- Bright gradient background + SVG pattern overlay
- Phone slides up with bounce + float animation
- Purpose: Show actual product UI/screenshots

### 5. CTA Scene
- Large headline + animated button with glow
- Button has subtle pulse animation (1.08 scale)
- Strong contrast for readability
- Purpose: Drive action (sign up, download, etc.)

---

## Animation Principles

### Spring Presets (from `design-tokens.ts → animation`)

| Preset | Config | Usage |
|--------|--------|-------|
| `smooth` | damping: 200, stiffness: 100 | Clean reveals, no bounce |
| `bouncy` | damping: 12, stiffness: 80 | Playful entrances |
| `veryBouncy` | damping: 8, stiffness: 100 | Impact moments, hooks |
| `stiff` | damping: 200, stiffness: 200 | Quick snaps |

### Rules

1. **Determinism law:** every animated value is a pure function of the frame; randomness only with `random(seed)`.
2. **Forbidden, because they run on their own clock:** CSS transitions, CSS animations, `@keyframes`, Tailwind `animate-*`, WAAPI, framer-motion, react-spring, `requestAnimationFrame`, timers, R3F `useFrame`. GSAP only as a paused timeline seeked to `frame / fps` ([root AGENTS.md](../AGENTS.md#animation-rules)).
3. **Exits:** chosen per scene. The final frame does not fade unless the script intends it: it serves as thumbnail and loop frame.
4. **Transitions:** chosen per cut from the idea and rhythm. `TransitionSeries` duration is the sum of scenes minus the sum of transitions.

Starting point: stagger elements in the same scene by 3-6 frames. Vocabulary: [motion grammar](../.agents/skills/motion-and-typography/references/motion-grammar.md).

### Text Animation Components (from `src/templates/text/`)

| Component | Effect | Best For |
|-----------|--------|----------|
| `WordByWord` | Words appear one at a time | Hook headlines, statements |
| `LineByLine` | Lines stagger in | Multi-line headings |
| `LetterReveal` | Characters animate in sequence | Cinematic title reveals |
| `SlideReveal` | Text slides from behind mask | Clean editorial reveals |
| `ScaleWord` | Words scale in with bounce | Impactful single statements |
| `ClipReveal` | Clip-path mask wipes open | Modern editorial text |
| `TypewriterText` | Character-by-character | Technical, code-like text |
| `WordHighlight` | Highlighter pen on word | Emphasis on key term |

---

## Safe Zones

| Zone | Vertical | Square | Reason |
|------|----------|--------|--------|
| Top | 200px | 60px | Platform UI overlay (time, battery) |
| Bottom | 300px | 60px | Captions, platform controls |
| Sides | 60px | 48px | Edge padding |

---

## Audio Layers

1. **Voiceover** — ElevenLabs TTS, volume: 1.0
2. **Background Music** — ElevenLabs Sound Gen, looped, volume: 0.15-0.20
3. **Sound Effects** — Freesound.org (CC0), for transitions and impacts
