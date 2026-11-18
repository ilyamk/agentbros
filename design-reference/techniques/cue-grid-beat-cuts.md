---
id: cue-grid-beat-cuts
name: Beat cuts from a cue grid
intent: Cuts and accents land on the beat, computed from the tempo instead of placed by eye.
route: remotion
timing: 120 BPM is one cue every 15 frames at 30 fps; 8-frame accent of 5 percent scale
curve: expoOut
primitive: beatGrid, activeCue, cuePulse
demo: BeatLineL
sources: ["src/motion/lab/BeatLine.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Builds cues from BPM. Each word cuts in on its frame with a small scale accent, and a ruler shows the same cues.

**When it fits.** Music-led copy, lists and short words, with a known or measured tempo.

**When it does not.** Speech-led films, where cuts follow the voice. Long words that cannot be read in one beat.

**Timing.** `beatGrid(fps, 120, 6)` gives six cues. `cuePulse(cue, frame, 8)` decays over 8 frames.

**Read.** `src/motion/lab/BeatLine.tsx`

**Pitfalls.** A grid assumes a steady tempo. Check it against the actual track, including any offset, before trusting it.
