# Design tokens and typography

**Spring presets** (from `design-tokens.ts`):
| Preset | Config | Use |
|--------|--------|-----|
| `animation.smooth` | damping: 200, stiffness: 100 | Default text reveals |
| `animation.bouncy` | damping: 12, stiffness: 80 | Cards, buttons |
| `animation.veryBouncy` | damping: 8, stiffness: 100 | Hook headlines |
| `animation.stiff` | damping: 200, stiffness: 200 | Quick snaps |

**Timing starting points:**
- Fast fade: 3-6 frames | Slow fade: 12-20 frames
- Stagger: 3-5 frames (fast), 8-12 (medium), 15+ (dramatic)
- Exits, transitions and the current renderer defaults: root [AGENTS.md](../AGENTS.md#design-principles).

**`src/lib/design-tokens.ts` holds the defaults for sizes, weights and spacing.** Depart from them when the idea needs it and check the result in frames.

```tsx
import { typography, spacing, animation } from "../lib/design-tokens";
import { displayFont, primaryFont, condensedFont } from "../lib/fonts";
const fmt = width > height ? "landscape" : height > width ? "vertical" : "square";
const h = typography.bigTitle[fmt]; // vertical: { fontSize: 84, fontWeight: 800, lineHeight: 0.95, ... }
```

Size/weight/line-height for vertical; square and landscape keep the same weight and line-height.

| Token | Vertical | Square | Landscape | Use |
|-------|----------|--------|-----------|-----|
| `hero` | 140/900/0.92 | 110 | 132 | Fill-width titles |
| `condensedHero` | 160/400/0.9 | 120 | 150 | Bebas Neue uppercase |
| `bigTitle` | 84/800/0.95 | 64 | 78 | Hook scenes |
| `headline` | 76/700/1.0 | 64 | 64 | Scene headers |
| `feature` | 56/700/1.05 | 44 | 50 | Card headlines |
| `subtext` | 30/400/1.5 | 24 | 26 | Descriptions |
| `cta` | 40/700/1.2 | 34 | 38 | CTA buttons |
| `small` | 24/500/1.4 | 20 | 22 | Labels |
| `accentSub` | 28/600/1.3 | 22 | 26 | Coloured uppercase subtitles |
| `serifAccent` | 72/700/1.0 | 56 | 64 | Playfair italic |

**Fonts** (`src/lib/fonts.ts`): `primaryFont` (Inter), `displayFont` (Space Grotesk), `condensedFont` (Bebas Neue), `serifFont` (Playfair italic), `serifNormalFont` (Playfair), `roundedFont` (DM Sans), `narrowFont` (Oswald), `geometricFont` (Montserrat). Cyrillic: [choosing a face](library-reference.md#fonts).

Heading sizes, the number of faces and pairings are choices. Keep the hierarchy clear at playback size.

**Safe zones** (vertical/square/landscape): top 200/60/60px, bottom 300/60/60px, sides 60/48/60px — use `spacing.safeTop/safeBottom/sidePadding[fmt]`.
