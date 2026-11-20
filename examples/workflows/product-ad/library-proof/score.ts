import { mkdirSync, writeFileSync } from "node:fs";
import { synthesiseSfx, encodeWav, SFX_SAMPLE_RATE } from "../../../../src/lib/audio/sfx-synth";
import { CUT, cutCues } from "../../../../src/motion/library/scenes/transition-cut-plan";

// Align the synth's measured transient, including the leading air of the whoosh.
const fps = 30;
const mix = new Float32Array((CUT.end * SFX_SAMPLE_RATE) / fps);
for (const [index, cue] of cutCues.entries()) {
  if (!cue.sfx || cue.sfx === "none") continue;
  const kind = cue.sfx === "impact" ? "hit" : cue.sfx;
  const take = synthesiseSfx({ kind, seed: 19 + index, rootHz: kind === "glass" ? 73.42 : 49 });
  const start = Math.round((cue.frame / fps - take.alignSec) * SFX_SAMPLE_RATE);
  const gain = kind === "tick" ? 0.32 : kind === "glass" ? 0.33 : 0.58;
  for (let i = Math.max(0, -start); i < take.samples.length && start + i < mix.length; i++)
    mix[start + i] += gain * take.samples[i]!;
}
mkdirSync("public/projects/library-proof", { recursive: true });
writeFileSync("public/projects/library-proof/score.wav", encodeWav(mix));
