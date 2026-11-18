---
id: giant-word-pull-out
name: Giant word pulled back to reading size
intent: "Function hook or transition: the first word fills and overflows the frame, so the eye gets one shape and a direction before anything is read, then it brakes into a calm line and reads at once."
route: remotion
timing: "17 frames at 30 fps (nexaa: 14 at 24) from 2.5x to 1; near full size for the first fifth, half the travel by a third, 93% by 0.7; settled width 0.43 of the frame for a word alone; the rest of the line follows 3 frames a word"
curve: "bezier(0.5, 0.2, 0.15, 1), fitted to the word's width frame by frame"
primitive: pullOutScale, pullOutCurve
demo: src/motion/library/typography/GiantWordPullOut.tsx
sources: ["design-reference/library/nexaa/techniques.json", "design-reference/library/muse/techniques.json", "src/motion/type-track.ts", "src/motion/library/typography/GiantWordPullOut.tsx"]
status: draft
---

**What it does.** One word starts at a multiple of its settled size, centred on the line, overflowing both edges, and shrinks into its slot on one ease, blurred only by its own speed. Optionally it sweeps in from one side (`fromX`), recolours from an accent to ink, and the rest of the line arrives word by word in its final place, so the line never re-centres. Library block `giant-word-pull-out`.

**When it fits.** An opener ("Meet", a name); a tagline after a spectacle shot, where the type itself is the wipe.

**When it does not.** A word that must be read on the first frame. Several in a row: it is an entrance, once a film.

**Timing.** nexaa 0.0-0.58 s (24 fps), word width as a share of the frame read from the strip: about 1.07, 0.98 at 0.12 s, 0.90 at 0.16, 0.78 at 0.20, 0.66 at 0.25, 0.60 at 0.29, 0.56 at 0.33, 0.50 at 0.41, 0.46 at 0.50, 0.45 settled at 0.58 s. Ours with `word: "Meet"`, `from: 2.5`, `width: 0.43`, compared with `motion:strip --vs` over 0-0.67 s: within about a frame at every sample, settled at 0.57 s. muse 29.8-30.9 s: the same move with a side sweep, the third word following, blue to ink by about 1 s.

**Read.** `src/motion/library/typography/GiantWordPullOut.tsx`, `src/motion/type-track.ts` (`pullOutScale`).

**Pitfalls.** The camera fit in nexaa's motion.json, bezier(0.306, 0.311, 0.028, 1.046), runs about 3 frames ahead of the type; fit the visible width, not the camera. Scaling about the line's centre throws a word that sits left of centre off the frame at 4x; start it centred and move it to its slot on the same ease. Keep the blur outside the scaled element, or it is scaled with it.
