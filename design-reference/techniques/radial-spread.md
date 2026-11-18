---
id: radial-spread
name: Radial spread from a seed point
intent: Many small things arrive in order of distance from one point, so the eye reads a spread, a contagion or a growing reach.
route: remotion
timing: one seed item, a pause, then items every 2-3 frames outward, each a one-frame pop (steps)
curve: steps(1)
primitive: stagger, radialOrder
demo: src/motion/library/effects/DotField.tsx
sources: ["design-reference/library/paper-style/techniques.json", "design-reference/library/context-dev/techniques.json", "src/motion/timing.ts"]
status: draft
---

**What it does.** Orders points by distance from an origin and turns the order into start delays: `stagger(n, { kind: "radial", step, points, origin })`. Points at the same distance start together, so a grid fills in rings; `ring` groups distances into bands; `inward` reverses it. `radialOrder` gives the order itself.

**When it fits.** Pins spreading on a map, a grid of cards turning into dots from its centre, tiles resolving outward, anything where where-from matters more than which-first.

**When it does not.** Under about eight items (the order is not readable); a list that must read in its own order.

**Timing.** paper-style pin-spread 27.0-28.6 s: one pin at F810, a 0.6 s pause, then pins every 2-3 frames outward from F829 to at least F856, each a single-frame pop (steps(14)). context-dev t11 14.13-14.90 s: cards become cobalt dots on a ring widening from the grid centre over 23 frames, the ring speeding up (power1.in); `dot-field` shapes the radial delays with that ease.

**Read.** `stagger`, `radialOrder` in `src/motion/timing.ts`; `dotFieldPlan` in `src/motion/library/effects/effects-plan.ts`.

**Pitfalls.** The origin defaults to the centre of the points' bounding box, not the frame centre; pass `origin` for a seed elsewhere. On an even grid many points tie: the spread then moves in visible rings, which is the point; add a seeded jitter if it should feel organic.
