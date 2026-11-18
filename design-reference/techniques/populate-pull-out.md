---
id: populate-pull-out
name: Populate, then pull out
intent: Many small arrivals become one picture of the full result.
route: remotion
timing: "items every 4-6 frames under a constant drift (about 16% of the width, 4% zoom); then 1.2x to 1x on expo.out, fastest in the first 3 frames, settled in 15; two-stage variant jumps and settles on circ.out over about 38 frames"
curve: linear drift, expo.out pull, circ.out second stage
primitive: easeFamily, stagger
demo: src/motion/library/camera/PopulatePullOut.tsx
sources: ["design-reference/library/postiz/techniques.json", "design-reference/library/context-dev/techniques.json", "src/motion/library/camera/PopulatePullOut.tsx"]
status: draft
---

**What it does.** While the view is close and drifting, items land one at a time; then the camera pulls back to the whole board, grid or crowd. Library block: `populate-pull-out`.

**When it fits.** A planner that fills, a grid of records, a crowd of results: anything whose point is how much there is once it is full.

**When it does not.** When each item needs reading: the pull-back makes them small. Keep the drift to this one shot; a whole frame drifting through a film is the `motion-spread` slop signature.

**Timing.** Measured: per-frame differences after the pull starts 1.96, 8.65, 10.73, 8.91, 7.07, 5.50, 4.13 ... 0.49 over 15 frames (expo.out); the drift before it is linear (constant speed). The two-stage reference peaks at once and settles over 1.3 s on circ.out.

**Read.** `src/motion/library/camera/PopulatePullOut.tsx` (`pullOutPose`, `dropFrames`).

**Pitfalls.** Place items with `dropFrames` so no two land on one frame (motion:check `SIMULTANEOUS_ENTRY`). The board is usually a product screen: capture it or replicate it pixel-faithfully.
