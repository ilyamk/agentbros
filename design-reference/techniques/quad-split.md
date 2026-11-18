---
id: quad-split
name: Quad split of four films on a planned stagger
intent: "Function hook: four complete films at once show range in the first second; a cut plan keeps them reading as four instead of one busy frame."
route: remotion
timing: "ace (60 fps): four 50% x 50% cells, no gutter; 16 changes in 11.6 s, median gap 0.517 s, never more than two within 0.1 s; coinciding changes on opposite corners 1 frame apart (TR/BL 7.633/7.650, 10.067/10.083; BR/TL 5.017/5.167); the top right rests 1.9 s while the others change four times"
curve: none (hard cuts per cell); each cell keeps its own eases
primitive: layoutSeries, cutTiming
demo: src/motion/library/scenes/QuadSplit.tsx
sources: ["design-reference/library/ace/techniques.json", "src/motion/library/scenes/QuadSplit.tsx"]
status: draft
---

**What it does.** The frame splits into four gutterless cells, each a whole film with its own ground, palette and cuts, every cell mid-motion on every frame of the opening. A stage plans the cells' cuts so the eye can follow: no more than two changes inside 0.1 s, two that do fall together sit on opposite corners one frame apart, and one cell holds still through the busiest stretch so the eye has somewhere to rest. Library block `quad-split`; the planner is `planQuadCuts` in `src/motion/library/scenes/scene-plan.ts`.

**When it fits.** An opening that must show range before it shows depth: four uses, four customers, four features, four moods. Each cell's hero sits at 45-55% of its own width, so the four focal points form an even rectangle.

**When it does not.** One idea that needs the whole frame; small type (each cell is a quarter of the frame, so copy must be set at cell hero size); product screens that are not captured (the real-UI rule holds inside a cell).

**Timing.** ace 0-11.62 s at 60 fps: 16 boundaries, median gap 0.517 s (about 15 frames at 30 fps); at most two in 0.1 s (3 frames at 30, 6 at 60); diagonal pairs 1 frame apart at 60 fps, which at 30 fps rounds up to one frame; the top-right cell holds F342-F457 (1.9 s) while the others change four times. Ours: `windowSec` 0.1, `pairGap` 1, `restSec` 1.9; changes only ever move later, a request on its diagonal's frame becomes the pair, a neighbour's waits out the window, and when no cell holds 1.9 s under at least three changes of the others, the quietest cell in the densest stretch collapses its changes there to the stretch's end. Side by side with ace 7.60-8.10 s (`motion:strip --vs`) our default's top-right/bottom-left pair lands one frame apart as ace's does.

**Read.** `src/motion/library/scenes/QuadSplit.tsx`, `src/motion/library/scenes/scene-plan.ts`, `tests/motion-blocks-gap-scenes.test.ts`.

**Pitfalls.** The planner only delays: a cut that must land on a beat should be asked for on that beat and checked after planning. Children render at full frame size and are scaled into their cell, so a child's own text sizes halve; size cell copy for the cell. Four cells of video decode four streams at once.
