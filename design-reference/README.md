# Design Reference

## Agent video systems

See [Agent video systems](agent-video-systems.md) for Hyperframes, Claude Motion,
the existing external references, and concrete adaptation tasks. The catalogue
distinguishes source-code review from README-only research and records pinned
revisions, compatibility constraints, and license provenance.

This folder contains visual and motion references that the AI agent analyzes
before generating video compositions. Drop your files into the appropriate
subfolder so the agent knows what it's looking at.

## Folder Guide

```
design-reference/
│
├── screenshots/          ← Static frames / screenshots of videos you like
│   ├── reels/            Instagram Reels references
│   ├── shorts/           YouTube Shorts references
│   ├── tiktoks/          TikTok references
│   └── square/           Square (feed post) references
│
├── videos/               ← Full reference videos (mp4, mov, webm)
│   ├── reels/            Instagram Reels you want to emulate
│   ├── shorts/           YouTube Shorts you want to emulate
│   ├── tiktoks/          TikTok videos you want to emulate
│   └── square/           Square format references
│
├── brand-assets/         ← Your product's visual identity
│   ├── logos/            Logo files (svg, png) — all variants
│   ├── product-shots/    App screenshots, product photos, mockups
│   └── icons/            Feature icons, UI elements
│
├── typography/           ← Font specimens, text style examples
│                         Screenshots of text treatments you like
│
├── motion-reference/     ← GIFs or short clips showing animation styles
│                         Transition examples, entrance effects, kinetic text
│
├── mood-boards/          ← Overall aesthetic direction
│                         Collages, Pinterest boards exported as images,
│                         general vibe references
│
├── DESIGN_SYSTEM.md      ← Colors, fonts, sizes, spacing rules
├── color-palettes.md     ← Ready-to-use color schemes
└── scene-storyboard.md   ← ASCII wireframes for each scene type
```

## How the AI Agent Uses This

1. **Before generating** — the agent reads `DESIGN_SYSTEM.md` for hard rules
   (colors, fonts, safe zones) and scans `mood-boards/` + `screenshots/` to
   understand the visual tone.

2. **Per-platform** — when producing an Instagram Reel, it looks at
   `screenshots/reels/` and `videos/reels/` for format-specific patterns
   (text placement, pacing, transitions).

3. **Brand consistency** — `brand-assets/` is checked for logos, product
   imagery, and icons to embed into scenes.

4. **Motion style** — `motion-reference/` tells the agent what kind of
   animations to use (snappy vs smooth, bouncy vs elegant).

## Naming Convention

Use descriptive names so the agent understands context:

```
screenshots/reels/competitor-appX-hook-screen.png
screenshots/reels/style-neon-gradient-cta.png
videos/tiktoks/trending-text-animation-example.mp4
brand-assets/logos/logo-white-on-dark.svg
brand-assets/product-shots/dashboard-mobile-v2.png
motion-reference/spring-bounce-entrance.gif
mood-boards/dark-tech-aesthetic.png
```

## Supported Formats

| Type        | Formats                          |
|-------------|----------------------------------|
| Images      | `.png` `.jpg` `.jpeg` `.webp` `.svg` |
| Videos      | `.mp4` `.mov` `.webm`           |
| Animations  | `.gif` `.mp4`                    |
