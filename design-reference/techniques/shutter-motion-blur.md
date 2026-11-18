---
id: shutter-motion-blur
name: Sub-frame shutter
intent: Fast object motion gets true motion blur, only while it moves.
route: remotion
timing: 16 samples, 220 degree shutter; 14-frame entry and exit; windows on frames 0-22 and 38-56
curve: expoOut, expoIn
primitive: Shutter, velocity, track
demo: ShutterStopL
sources: ["src/motion/lab/ShutterStop.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Renders children several times per frame at fractional times and averages them, inside set windows.

**When it fits.** A short, fast move of one object, where a CSS blur would look applied.

**When it does not.** Long shots or heavy layers: it costs `samples` times the render of its children.

**Timing.** The word enters over frames 2 to 16 on `expoOut`, drifts 26 pixels, and leaves over frames 40 to 54 on `expoIn`.

**Read.** `src/motion/lab/ShutterStop.tsx`

**Pitfalls.** Children get fractional frames, so floor before seeding and paint an opaque background. At high speed samples show as steps: blur each by the gap to the next. Fit fonts outside the shutter, because samples mount and unmount with the windows.
