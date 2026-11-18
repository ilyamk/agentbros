---
id: element-to-ground
name: A small element grows into the ground
intent: The thing the eye is parked on becomes the room, so the next scene arrives with no cut to search after.
route: remotion
timing: "orb about 10% of the width to past the corners in about 8 frames on circ.in; button 48% of the width to full bleed in about 24 frames on sine.in; cut before it fills"
curve: circ.in (orb), sine.in (button)
primitive: easeFamily
demo: src/motion/library/transitions/CausedMorph.tsx
sources: ["design-reference/library/flame/techniques.json", "design-reference/library/cashfree/techniques.json", "design-reference/library/muse/edit.json", "design-reference/library/muse/techniques.json", "design-reference/library/polymarket/techniques.json", "src/motion/library/transitions/CausedMorph.tsx"]
status: draft
---

**What it does.** A disc or a call-to-action pill grows, slowly then fast, past the frame's edges; its fill becomes the next scene's ground, and the pill's top sheen becomes the new frame's top edge. Library block: `caused-morph` with `mode: "orb"` or `"pill"`, plus `<GroundRim>` on the next scene. Two variants: the button lit by a band from each side edge as it grows, its label shrinking (`sheenFrom: "edges"`, `edgeSheenPreset`); and the button that does not flood but drains to white and becomes a round window the next picture rises into (`mode: "window"`, `windowPreset`).

**When it fits.** An end card that is the inside of the button the viewer was asked to press; a brand orb that becomes the brand's ground.

**When it does not.** When the element's colour is not the next ground: use `colour-flood`, which floods an accent and cuts.

**Timing.** Measured: button 48% (F412), 59% (F426), 88% (F431), full bleed F436, sine.in; orb 10% (F113) to past the edges (F121), circ.in. The orb's diameter grows geometrically to twice the frame's half-diagonal, so it covers every corner on the cut; the pill grows geometrically on both axes while its top edge rises to y = 0. The label rides the pill at its own size and fades in the second half. polymarket: the button grows for 0.57 s on power2.in (frame differences 6.3-8.6, then 9.1, 12.0, 19.6), lightening from each edge, and is cut before it fills. muse: the send button drains top-down in 5 frames (F590-F594) while the mic fades, the white disc drifts to centre in 5 (F594-F599), the character rises into it in 5 (F600-F605); the disc is then the portrait, about 0.34 of the width (`windowState`, thirds on power2.inOut).

**Read.** `src/motion/library/transitions/CausedMorph.tsx` (`growShape`, `GroundRim`, `windowState`, `edgeSheenReach`).

**Pitfalls.** Pass `curve` and `sheen` only with orb and pill; rect and bars keep their own ease. The next scene must paint the same ground colour, or the cut shows. In window mode the next scene must hold its picture in a disc at `windowX`, `windowY`, `windowSize` on the same ground: the seam ends on that scene in full.
