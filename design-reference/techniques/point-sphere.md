---
id: point-sphere
name: Point or stroke sphere behind a claim
intent: A world-scale claim gets a world to sit on, drawn from seeded marks that pull out and turn while the number lands.
route: remotion
timing: pull-out 25 f (0.83 s) circ.out from 1.62x (flex) or expo.out (flame); text from +5 f, next word +9 f; slow constant turn
curve: circ.out or expo.out pull-out
demo: src/motion/library/three/PointSphere.tsx
sources: ["design-reference/library/flex/techniques.json", "design-reference/library/flame/techniques.json"]
status: draft
---

**What it does.** Seeded short great-circle strokes (`strokes`) or lattice dots (`dots`) on a unit sphere are rotated and projected in SVG each frame; marks at the back fade, the tint runs top to bottom between two colours and drifts. The sphere pulls out from close to rest. `land` keeps only marks on invented continents (a dotted globe, no map image); `ring` draws flame's thin circle. Block: `point-sphere`.

**When it fits.** "170+ countries", "users in 90 cities": a stat on a flat brand ground (flex); two words pinned at the frame edges with the globe between them (flame).

**When it does not.** A real map with real places: a procedural globe invents its coastlines. Decoration behind a line that is not about reach.

**Timing.** flex t12: hard cut, the sphere pulls out (z -0.62) over 0.829 s, circ.out (motion.json s013); the number fades in at +5 frames, the noun at +14. flame flank-words: the circle pulls out after the cut, expo.out over 8.12-8.80 s; colours drift pink to blue while it turns slowly.

**Read.** `src/motion/library/three/PointSphere.tsx`; `spherePoints`, `sphereArcs`, `rotate`, `project`, `pullOut`, `isLand`, `tintAt` in `src/motion/library/three/three-plan.ts`.

**Pitfalls.** Back marks at full opacity turn the sphere into a flat disc of noise: fade by depth. Thousands of SVG paths render slowly; keep strokes under about 600. On a white ground use a darker tint than on a dark one.
