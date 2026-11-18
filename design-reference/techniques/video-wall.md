---
id: video-wall
name: One column widens into a wall of real people
intent: "Function proof: a crowd of real users, seen as clips, arrives tile by tile and the camera pulls back until it is a wall."
route: remotion
timing: "ugc-app (30 fps): white blurred tiles F133-F141 resolve into clips by about F148, outward from the centre; pull-back from F156 on power2.out for 0.5 s then power1.out for 1.7 s to about 16 columns, still moving at the cut F207"
curve: power2.out then power1.out (pull-back); linear (tile resolve)
primitive: stagger, radialOrder
demo: src/motion/library/camera/VideoWall.tsx
sources: ["design-reference/library/ugc-app/techniques.json", "src/motion/library/camera/VideoWall.tsx", "src/motion/library/camera/PopulatePullOut.tsx"]
status: draft
---

**What it does.** Columns of portrait clips on a dark ground: soft white blocks appear ring by ring outward from the centre and un-blur into their clips, while the camera pulls back from a few columns to the whole wall. Library block `populate-pull-out` with `variant: "wall"` around `<VideoWall>` (`src/motion/library/camera/VideoWall.tsx`); the tiles use `placeholder-resolve`'s white tiles (`resolvePlan`, `PlaceholderTile`), the pose and plan are `wallScale`, `wallTiles`, `wallPlan`, `wallScrollY` and `wallCurve` in `src/motion/library/camera/camera-plan.ts`.

**When it fits.** Social proof whose meaning is that these are real people: customer clips, creators, community. Only with consented, real material.

**When it does not.** Generated faces presented as users. Fewer than about 30 clips: the wall repeats visibly.

**Timing.** ugc-app 2.90-6.90 s at 30 fps: frame differences 36.9, 68.2, 36.4 at F133-F135 as the tiles appear, the pull's differences falling evenly from about 22 (F157) to 11.6 (F205), still moving at the cut. Ours: tiles ring by ring one frame apart (a ring one tile wide), each resolving in 8 frames; the pull power2.out over 15 frames to `midScale`, then power1.out over 51 to 1; columns offset vertically so they read as feeds. Side by side with ugc-app 4.38-6.90 s (`motion:strip --vs`) the tile proportions (16 columns of portrait tiles), the dark ground and the pace of the pull match; Later added: column scroll (`wallScroll`, `WALL_SCROLL` 0.012 of a tile height a frame, neighbours in opposite directions, read off ugc-app 6.50-6.90 s where neighbouring columns slide 10-20 px in 8 frames at a tile height of about 190 px; approximate, since the pull dominates the motion), the bow of the wall on a cylinder (`wallCurve`, `WALL_CURVE` 0.35 rad half-angle; ugc-app's bow is slight and not measured in degrees) and a frame-fixed vignette that darkens and softens the outer columns (`<WallVignette>`, `WALL_VIGNETTE` 0.85; ugc-app F190 edges under half the centre's brightness, corners near black). All three default off; `populatePullOutWallPreset` turns them on (strip against ugc-app 5.5-7.0 s: out/qa/wsg-finish/wall-vs.jpg).

**Read.** `src/motion/library/camera/VideoWall.tsx`, `src/motion/library/camera/camera-plan.ts`, `src/motion/library/camera/PopulatePullOut.tsx`, `tests/motion-blocks-gap-scenes.test.ts`.

**Pitfalls.** Every tile decodes its clip at once: use low-resolution proxies. The white tiles blur with CSS, which adds up across a large wall while they resolve. The second stage is long on purpose; cut before it ends, as the reference does.
