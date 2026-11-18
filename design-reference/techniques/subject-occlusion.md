---
id: subject-occlusion
name: Title behind the subject
intent: Words feel inside the picture rather than pasted on it, because the subject stands in front of them.
route: remotion
timing: "title rises from 0.55 of its height below its rest over 26 frames (expo out) from frame 8, then holds; the matte follows the plate frame by frame, held on its last frame"
curve: expo.out
demo: src/motion/library/effects/SubjectOcclusion.tsx
sources: ["src/motion/library/effects/SubjectOcclusion.tsx", "docs/matte.md"]
status: draft
---

**What it does.** Three layers: the plate, a large fitted title, and the plate's subject on top. The top layer is the same plate again, masked by the subject's matte from `pnpm matte`, so the subject covers the title wherever it stands in front of it. Library block `subject-occlusion`; the matte is a per-frame sequence (`cutout/frame-%05d.png` with `maskMode: "alpha"`, or the grey `alpha/` frames with `"luminance"`), a still takes one PNG.

**When it fits.** A hook or chapter title over a portrait, a talking head or a hero product shot, where the word should sit in the scene's depth: behind the head, behind a product's silhouette. One word or a short line in a condensed face large enough to pass behind the subject on both sides.

**When it does not.** A subject that fills the frame (nothing left of the title to read) or one that crosses the whole title (the word disappears). Fine hair, smoke, glass or motion blur against a busy background: both engines leave a hard or haloed edge there, and the layering shows it. A matte with gaps (an empty frame in `matte.json` `coverage.emptyFrames`) lets the title flash over the subject for that frame.

**Timing.** Not measured from a reference yet: this card is `draft`. Ours: the title rises over 26 frames on expo out from `enterAt` and holds; the matte index is `matteStart` plus the source frames elapsed (`sourceFps` against the film's fps), held on the last frame.

**Read.** `src/motion/library/effects/SubjectOcclusion.tsx` (`matteFileAt`, `occlusionRise`); the matte route, engines and quality limits in `docs/matte.md`.

**Pitfalls.** Draw the subject layer from the plate itself, never a separately decoded cut-out over it: colour and position then match by construction. A video plate is trimmed by `matteStart`, so a range that does not start on a whole film frame drifts by under a frame; start mattes on a frame that maps cleanly. Check stills at the widest gesture and at the title's arrival: a matte edge that flickers on a still background shows more against the title than against the plate (`matte.json` `temporal.flickerAfter.stableEdge`).
