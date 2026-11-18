---
id: fanned-stack
name: Fanned stack of one object
intent: Many of one thing: a card or flat object fans out of itself like a deck.
route: remotion
timing: a dozen copies over about 53 f, sine.inOut, each copy 2 f after the one before, all landing together
curve: sine.inOut (inferred)
demo: src/motion/library/three/DepthCardFlythrough.tsx
sources: ["design-reference/library/flex/techniques.json"]
status: draft
---

**What it does.** `depth-card-flythrough` with `mode: "fan"`: the first card is copied `fan.copies` times, each rotated about the same bottom-left corner to its share of `fan.spread` degrees, with a per-copy delay so the deck opens from the bottom card up; the camera eases in as it opens. Mode of the block `depth-card-flythrough`.

**When it fits.** A card product (flex's metal card, cashfree's card fan); one per team, or as many as the customer needs.

**When it does not.** Different items: use the default fly-through or `scene-bento-collage`. A photoreal metal object in close-up with specular sweeps: render `scripts/blender/card_fan.py` (brushed anisotropic metal, a strip light sweeping across, shallow depth of field, the same `copies`, `spread`, `delay`, `at` and `fanFrames`) and pass it as the block's `plate` (`pnpm assets:sync --id plates:card-fan`); this block's own fan is the cheaper, graphic version.

**Timing.** flex t06: rendered objects close to camera; the green one fans into a stack of about a dozen copies like a deck over F327-F380 (about 53 frames); motion.json tracked too little of the shot to fit an ease, sine.inOut is inferred.

**Read.** `src/motion/library/three/DepthCardFlythrough.tsx` (`FanStack`); `fanAngles`, `sineInOut` in `src/motion/library/three/three-plan.ts`; `scripts/blender/card_fan.py` (60 f at 480x270 and 16 samples in about 62 s; production 1920x1080 at 96).

**Pitfalls.** Copies at the same depth z-fight; each sits 0.012 units in front of the one below. A spread past about 90 degrees sends the top card out of a landscape frame.
