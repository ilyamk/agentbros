---
id: material-fill
name: Material fill, brushed metal or embossed relief
intent: A ground or an object reads as a real material, not a gradient, so a tile can be held and a white ground has depth.
route: remotion
timing: tile from 6% to 20% of the width in 10 f, power2.out; ground fades in over 8 f; specular pass every 75 f
curve: power2.out tile growth, sine in-out specular pass
demo: src/motion/library/backgrounds/MaterialFill.tsx
sources: ["design-reference/library/flame/techniques.json"]
status: draft
---

**What it does.** `brushed`: an SVG fractal noise stretched along one axis (streaks), desaturated and contrasted, laid over a grey gradient with two specular bands crossing at different speeds. `emboss`: a seeded maze (one wall per cell on a square grid) stroked three times, shadow offset down-right, highlight up-left, base on top, so the walls stand up from a white ground; a soft sheen crosses it slowly. `fill: "tile"` puts the material in a rounded square that grows from a dot. Block: `material-fill`.

**When it fits.** A product idea becoming an object (flame's metal tile inside the opening guide box); a quiet white ground under a wordmark that needs texture without colour (flame's embossed maze).

**When it does not.** Photoreal metal in close-up with real reflections: use `extruded-mark` or a Blender plate. Busy relief under small text.

**Timing.** flame guide-frame-opens-to-object: a dot at the centre from F37 grows into the brushed tile, 6% of the width at F46 and 20% by F56 (about 10 frames), against the outward lines. implode-and-blur: the embossed maze fades in under the last wisp of the sphere cluster at F131; the first wordmark letter at F132.

**Read.** `src/motion/library/backgrounds/MaterialFill.tsx`; `specularBand`, `mazeSegments`, `tileGrow` in `src/motion/library/backgrounds/background-plan.ts`.

**Pitfalls.** A specular band at constant speed reads as a scanner; it eases at the edges. Isotropic noise reads as stone, not metal: the noise must be stretched about 200 times along the brushing. The relief disappears on a mid-grey ground; keep it white or near white.
