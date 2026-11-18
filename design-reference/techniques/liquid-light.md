---
id: liquid-light
name: Liquid light from a corner
intent: An accent of light arrives from a frame corner behind the final word, felt more than seen.
route: remotion
timing: grows over 17 f (0.57 s), expo.out, then a slow swell; the reference ends while it still grows
curve: expo.out growth (inferred, low confidence)
demo: src/motion/library/backgrounds/LiquidLight.tsx
sources: ["design-reference/library/ugc-app/techniques.json", "design-reference/library/nexaa/techniques.json"]
status: confirmed
---

**What it does.** Per frame, a small canvas computes for each pixel the distance and direction from one corner and passes them to `liquidLight`: a dark core inside a soft rim whose radius differs slightly per channel (red outside, blue inside: the refractive fringe), bent by noise and brighter along part of the arc so it reads as a crescent of caustic light; the canvas is scaled up, blurred and screened over the ground. Block: `liquid-light`.

**When it fits.** The last word of a question or a CTA on black (ugc-app); a closing line and wordmark on white (nexaa, as a soft glow); a quiet accent in the corner opposite the type.

**When it does not.** As a full-frame background under body text. When the shape must hold a real refraction of what is behind it: that is a shader pass in Hyperframes or a Blender render.

**Timing.** ugc-app corner-liquid-light: light first visible at F493 (16.43 s) from the bottom right, still growing at the file end F509 (0.57 s observed). Everything after the growth is our choice, a 6% swell. nexaa glow-ground-word-fade-up 25.33-27.38 s (24 fps): as the chat fades through white, a soft blue glow grows into the bottom-right corner over F612-F619 (about 0.33 s), then the closing sentence fades up word by word in front of it; the glow stays under the wordmark that follows (to 29.58 s). nexaa's light is a plain soft gradient on white, with no caustic rim and no per-channel fringe: it confirms the move (an accent of light from a corner behind the last words), not the liquid rim, which only ugc-app shows.

**Read.** `src/motion/library/backgrounds/LiquidLight.tsx`; `liquidRadius`, `liquidLight` in `src/motion/library/backgrounds/background-plan.ts`.

**Pitfalls.** A large radius with strong warp reads as a wobbling blob; keep the warp under a tenth of the radius. The field is computed at 1/6 resolution, which the blur hides; a thin rim at full resolution would be slow on CPU. Two references (ugc-app, nexaa): confirmed for the corner accent only; the rim and fringe rest on ugc-app alone, and nexaa's glow on white is closer to a radial gradient than to this block's rim.
