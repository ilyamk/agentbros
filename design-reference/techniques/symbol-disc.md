---
id: symbol-disc
name: A disc whose symbol changes, or that spins into place
intent: One round token stands for a value that changes form (a currency, a plan, a state), or a coin-like object arrives with weight.
route: remotion
timing: cycle: settles in 5 frames (power3.out), symbol and fill swap after 16-17 frames, no other motion; spin: lands face-on in 20 frames (power2.out), past edge-on in the first half
curve: power3.out, power2.out
demo: src/motion/library/effects/SymbolDisc.tsx
sources: ["design-reference/library/foren/techniques.json", "design-reference/library/polymarket/techniques.json", "src/motion/library/effects/SymbolDisc.tsx"]
status: draft
---

**What it does.** In `cycle` a disc rides in on a thick trail of its own width, settles and drifts, and on each cue frame swaps its glyph and fill at once. In `spin` it enters oversized at the frame edge, turns about its vertical axis (a 2D squash with a visible rim, a moving sheen and a horizontal speed smear) and lands face-on on its spot, where `shared-element-carry` can take it into a card slot. Block: `symbol-disc`.

**When it fits.** Payments and currencies, a token or badge that changes state, an icon that lands in an interface slot.

**When it does not.** A real brand coin or logo that must look rendered in 3D (render it in Blender, `blender-3d`); more than three or four swaps in a row (it becomes a slot machine).

**Timing.** foren mirrored-symbol-trail 12.43-14.70 s: the disc (about 0.18 of frame height) enters from lower right on its trail and settles in 5 frames, power3.out, then drifts; its symbol and fill swap after 17 frames, and after 16 on the mirrored shot. polymarket object-into-slot 6.5-7.2 s: the disc enters oversized at the right edge under motion blur, spins past edge-on (about 4 frames in), shows its face by about 8 frames and shrinks into the card's icon slot by 20 frames, power2.out. A `motion:strip --vs` against 6.47-7.23 s matched the turn after the spin went to half a turn from the back at 5x scale; the reference shrinks later than our power2.out, and its glossy 3D rim is richer than the 2D one.

**Read.** `src/motion/library/effects/SymbolDisc.tsx`; `symbolIndex`, `discEntry`, `spinPose` in `src/motion/library/effects/effects-plan.ts`.

**Pitfalls.** The spin is drawn in 2D on purpose: a 3D transform keeps a stale raster and fails determinism (src/motion/AGENTS.md traps). Put swaps on the line's spoken words or the music, not on an even clock.
