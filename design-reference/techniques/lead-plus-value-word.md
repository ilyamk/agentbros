---
id: lead-plus-value-word
name: Fixed lead phrase plus a changing italic value word
intent: "Function emphasis: an anthem run in two voices; the repeated lead becomes a chant, the eye stays at the centre and reads only the new word, so a one-second plate is enough; the last plate moves to its own ground as the payoff."
route: remotion
timing: "Holds of 30 frames (29-36 measured, near two beats); the lead on the cut frame, the value word fading up over 8 frames (power1.out); the last beat held 50 frames"
curve: power1.out on the value fade; hard cuts between beats
primitive: progress
demo: src/motion/library/typography/LeadPlusValue.tsx
sources: ["design-reference/library/flex/techniques.json", "design-reference/library/flex/edit.json", "src/motion/library/typography/LeadPlusValue.tsx"]
status: draft
---

**What it does.** A centred line: a light sans lead ("Not", "Just") and an italic serif value word. Each beat is a hard cut to a new ground or image plate with the lead already on; the value word fades up after it. The lead carries forward until a beat names a new one. The last beat can swap to a light ground with the value in an accent. Library block `lead-plus-value-word`.

**When it fits.** A list of values, benefits or audiences that should land as one rhythm, ending on the viewer or the brand.

**When it does not.** More than about six beats, or value words that need explaining. If the lead never changes and the list is the point, `type-word-rotate` keeps one sentence on screen instead of cutting.

**Timing.** flex 31.2-38.2 s (30 fps): six plates of 29-36 frames, the value word's difference falling 2.7 to 0.79 over F973-F980 (about 8 frames, power1.out), the last line on white held 49 frames. Ours, compared with `motion:strip --vs` over 31.23-36.83 s against 0-5.6 s: the same cut rhythm (ours 30 frames a beat), the value word fully on 7-8 frames after each cut.

**Read.** `src/motion/library/typography/LeadPlusValue.tsx`.

**Pitfalls.** The italic face must be loaded and measured as italic (`fontStyle` in the run's `additionalStyles`), or the value word measures and renders upright. Set every beat at one size, from the longest line, or the lead jumps in size on the cut. A final fade is off by default: the last frame is the thumbnail.
