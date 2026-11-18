---
id: pixel-resolve
name: The next picture resolves out of coarse pixels
intent: The new shot reads as rendered by a screen or a system, so a cut into a website, an interface or a digital mark feels made rather than spliced.
route: remotion
timing: "mosaic: 3 overexposed frames, then coarse blocks to full detail in 8-10 frames, power2.out, stepped; ring: grid-snapped square ring grows from the mark over about 0.7 s, sine.out"
curve: power2.out (mosaic), sine.out (ring)
primitive: cutTiming, stagger, radialOrder
demo: src/motion/library/transitions/PixelResolve.tsx
sources: ["design-reference/library/cashfree/techniques.json", "design-reference/library/gojiberry/techniques.json", "src/motion/library/transitions/PixelResolve.tsx"]
status: draft
---

**What it does.** `mosaic`: a few overexposed frames replace the old scene, then the new one arrives as big square blocks that halve, step by step, to full detail. `ring`: a ring of grid-snapped squares grows outward from a point with the new scene inside it; behind the front the ring's colour thins into the picture. Library block: `pixel-resolve`.

**When it fits.** A cut into a live site, a 3D illustration or a screen-made world (mosaic); a brand mark that blooms into its end card (ring). Both suit a product whose identity is digital or pixel-built.

**When it does not.** Photographic or emotional material, where pixels read as a broken stream; a film that has no other digital texture; more than once or twice a film.

**Timing.** cashfree: three mint-white frames F148-F150 (4.93-5.00 s), the next shot resolves F151-F160 with frame differences 8.5, 10.2, 0.2, 10.0, 11.4, 25.4, 10.1, 4.0, 0.02: stepped (some frames hold) and front-loaded, power2.out. gojiberry (60 fps): hard cut from black to white at F1110; the ring grows F1110-F1151 (0.7 s) fast then slow, sine.out, leaving a warm peach gradient; the wordmark types on later at about 3 frames a letter. The cut is perceived on the seam's first frame.

**Read.** `src/motion/library/transitions/PixelResolve.tsx`: `pixelBlock` (halvings on power2.out), `pixelMosaicPhases`, `ringCells` (ranks from `stagger` kind `radial` with `ring` one cell wide), `ringCellState`, `ringFront`.

**Pitfalls.** CSS `image-rendering: pixelated` does nothing to live DOM content: the mosaic is an SVG filter (sample one pixel per block with `feFlood`/`feTile`, grow it with `feMorphology`), so the block size must be a whole number of pixels and change on steps, never smoothly (a smooth size shimmers). Keep the ring's cell large (about 5% of the short side): small cells read as noise. A mosaic over text keeps it unreadable for the first half: put the headline in after the resolve, as cashfree does.
