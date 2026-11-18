---
id: text-bloom
name: Text bloom with an entry flash
intent: Type reads as lit, not printed: a soft colour glow and a slight chromatic edge that flare on the frame the word arrives.
route: remotion
timing: glow flashes on the entry frame and settles in 3 frames (about 0.1 s, power2.out), then rests faint
curve: power2.out
primitive: TextBloom, flashDecay
demo: TextBloomL
sources: ["design-reference/library/ugc-app/techniques.json", "src/motion/fx.tsx", "src/motion/lab/TextBloomDemo.tsx"]
status: demonstrated
---

**What it does.** Wraps type (or any layer with alpha) in a glow of its own silhouette flooded with one colour and blurred, screened under it, plus a red and blue split of a pixel or two. On `flashAt` the glow and the split jump up and settle over `flashFrames` (`flashDecay`, power2.out), so a word cut on reads as switched on.

**When it fits.** Light type on a dark ground in a lens-like or screen-lit film: words passing a lens, a key word landing in a lit scene, a product name on black.

**When it does not.** Dark type on paper (the glow muddies it); every line of a film (it becomes decoration); small captions, where the split reads as a rendering fault.

**Timing.** ugc-app pass-through-type 13.07-16.17 s: the bloom flash on the key word settles in 3 frames (F452-F455), power2.out; the glow stays faint while the words track. Our default is `flashFrames` 3, `strength` 0.55, `fringe` 1.5 px at 1080.

**Read.** `TextBloom` and `flashDecay` in `src/motion/fx.tsx` and `src/motion/timing.ts`; lab piece `src/motion/lab/TextBloomDemo.tsx` (composition `TextBloomL`).

**Pitfalls.** The children render twice: keep sound outside. A large `radius` on big type bands on 8-bit grounds; add FilmGrain. The glow takes the silhouette only, so a word on its own opaque box blooms as a box.
