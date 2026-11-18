---
id: chip-wall
name: A wall of chips, then one
intent: Scale first (all of these), then focus (this one), in one continuous move.
route: remotion
timing: "wall dissolves in and creeps; push ramps over about 0.2 s, then halves its speed about every 0.3 s over about 0.87 s (chipWallFirecrawlPush: 6, 9 and 26 f at 30 fps; the defaults keep 3 and 7.5); all but one chip fade over about 1.3 s"
curve: expo.out
primitive: progress, stagger
demo: src/motion/library/ui/ChipWall.tsx
sources: ["design-reference/library/firecrawl/techniques.json", "src/motion/library/ui/ChipWall.tsx"]
status: draft
---

**What it does.** A dense seeded grid of small labelled chips dissolves in and creeps, then pushes toward one chip until its label reads; every other chip fades in a seeded order, leaving the picked one alone with a badge. Library block: `chip-wall`.

**When it fits.** Integrations, sources, files or models: a claim of connecting to all of them that narrows to the one that is new.

**When it does not.** Fewer than about 30 items (it reads as a list, not a wall); labels the viewer must read before the push.

**Timing.** firecrawl: the wall dissolves in over 17.25-17.52 s and creeps; from F1096 (60 fps) the change ramps over 5 frames to about 18 a frame, then halves about every 15 frames (expo.out) to legible size by 19.2 s. Re-measured by the wall's row pitch (autocorrelation of the row profile, 39 px at F1096 to 124 px by F1160): the push's share done a 30-fps frame apart is 0.05 after 2, 0.13 after 4, 0.24 after 6, 0.47 after 10, 0.69 after 14, 0.84 after 18, 0.92 after 22, 0.98 after 28. The 3-frame ramp of the defaults is at 0.21 after 4, so ours reads early; `chipWallFirecrawlPush` (ramp 6, half-life 9, over 26 frames) fits every sample within 0.02. From 19.3 s all but one chip fade over about 1.3 s; the last chip holds still with a 'new' badge from 20.63 s.

**Read.** `src/motion/library/ui/ChipWall.tsx`, `pushProgress`, `chipWallLayout` and `isolateOpacity` in `src/motion/library/ui/ui-plan.ts`.

**Pitfalls.** The push carries chips past the frame edges; they are declared with `intendedOverflow` until the isolate removes them. Labels are the film's own (real integration names need the owners' consent for their marks). One reference so far: draft. The reference was measured at 60 fps: its 5 and 15 frames are about 3 and 7.5 frames at 30 fps, which the defaults use; measured by scale rather than by frame differences, the ramp is longer (`chipWallFirecrawlPush`).
