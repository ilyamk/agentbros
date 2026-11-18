---
id: noise-matte-wipe
name: Organic noise matte wipe
intent: The next world arrives like weather (smoke, cloud, ink) instead of a geometric edge, so a change of mood reads as one continuous space.
route: remotion
timing: "smoke from a corner covering evenly over about 10 frames at 30 fps (20 at 60) with a soft tail (noiseMatteAcePreset: linear over 13); cloud from an edge in 11 frames, power1.inOut, on the beat; cloud cover 18 frames with 2-3 full frames, power2.inOut"
curve: linear in covered share (smoke), power1.inOut (cloud), power2.inOut (cover)
primitive: cutTiming
demo: src/motion/library/transitions/NoiseMatteWipe.tsx
sources: ["design-reference/library/ace/techniques.json", "design-reference/library/flex/techniques.json", "design-reference/library/muse/techniques.json", "src/motion/library/transitions/NoiseMatteWipe.tsx"]
status: draft
---

**What it does.** A soft, irregular front crosses the frame from a corner or an edge and opens the next scene behind it; or a cloud cover rises over the old scene, holds full for a couple of frames, and parts from the middle onto the new one. Library block: `noise-matte-wipe` (`mode: "reveal"` or `"cover"`, `origin`, `curve`, `feather`, `roughness`, `fringe`).

**When it fits.** A move from a light ground to a dark one, into an atmospheric plate (sky, storm, fog), or down through cloud into a new world. The film already has soft, natural material.

**When it does not.** Between interface shots, product cards or anything with hard geometry: use a shape wipe from the element, a ground swap or a caused morph. Never as the default scene change.

**Timing.** ace: dark smoke from the bottom-right covers the cell in 18 frames at 60 fps (F458-F476), frame differences 33, 38, 30, 31, 30, 20, 12, 7, 4 (power2.out by the differences); the next scene's orb fades in before the smoke finishes. Measured as the share of the cell gone dark, a 30-fps frame apart from F458: 0.04, 0.25, 0.37, 0.47, 0.65, 0.78, 0.85, 0.94, 0.97, 0.98: an even front with a soft tail (the differences stay flat because the covered area grows as the front moves out from the corner). Our power2.out over 9 frames covers 0.05, 0.47, 0.79, 0.95, much faster at the start, since our matte is full before the curve ends; `noiseMatteAcePreset` (linear over 13 frames, origin top-right) sits between our linear 12 and 14 renders. flex: a cloud-shaped matte from the right in 11 frames (F403-F413), power1.inOut, starting 0.035 s from a beat, with a slight chromatic fringe; the first word of the next line appears inside the revealed area at F407. muse: cumulus rises from the bottom F67-F77, fills the frame F78-F80 and the next shot emerges F81-F86; differences peak in the full-cloud frames (an S-curve). The perceived cut is where the front crosses half the field (reveal) or the middle of the full hold (cover): `noiseMattePhases(mode, hold, curve).cut`.

**Read.** `src/motion/library/transitions/NoiseMatteWipe.tsx`: `noiseMatteField`, `noiseMatteLevel`, `noiseMatteAlpha` (the matte is clamp((level - v) / feather) with v = (1 - roughness) * gradient + roughness * noise), `noiseMatteCoverLevel`, `noiseMattePhases`.

**Pitfalls.** The noise is a seeded SVG `feTurbulence` inside an inline `<mask>`, so only the level may change per frame: never animate `seed` or `baseFrequency`, which reshuffles the cloud on every frame. Too much `roughness` (above about 0.45) breaks the front into islands that read as a dissolve. A light cover over a light scene is invisible while it rises: give the cover a value that differs from the outgoing ground. muse's real clouds part around a CG subject; a flat cover cannot, so stage the subject behind it.
