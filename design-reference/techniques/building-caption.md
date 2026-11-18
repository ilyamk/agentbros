---
id: building-caption
name: Building caption
intent: A small persistent sentence grows with the film, its highlight travelling word to word and surviving every cut.
route: remotion
timing: Tag moves in 4 frames; each word on its own cue
curve: expoOut
primitive: BuildingCaption, captionWords
demo: CaptionDemoL
sources: ["src/motion/kinetic-type.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx", "src/motion/lab/KineticLab.tsx"]
status: demonstrated
---

**What it does.** Words join in order. The old tag's left edge runs off as the new tag's right edge grows, by clipping, so it needs no measuring and cannot drift from the text.

**When it fits.** A run of big words that must add up to one sentence. Put it above all scenes, and pass colours for the current ground.

**When it does not.** Long captions or subtitles of speech: that is `captions-and-localization`. One line only, left-anchored.

**Timing.** Reference: ref-service-explainer throughout (Every / frame / of / this at 0.90 to 1.53 s); ugc-app 9.8 to 11.5 s for the larger form.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** Centre alignment snaps when a word is added, because width is not animated. Keep it left-anchored. Below about 24 px at 1080p it is decoration, not copy: phone check it.
