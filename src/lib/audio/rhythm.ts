import { execFileSync } from "node:child_process";
import { z } from "zod";
import { hashFile } from "../assets/registry";
import { mediaProbe } from "./analysis";
import { analyzeRhythmPcm } from "./rhythm-kernel";
import { RhythmOverridesSchema } from "./rhythm-overrides";
export { RhythmOverridesSchema } from "./rhythm-overrides";

/** Conservative local amplitude-onset analysis. Does not identify speech or impose cuts. */
export function analyzeRhythm(file: string, overrides?: z.infer<typeof RhythmOverridesSchema>) {
  const durationSec = Number(mediaProbe(file).format.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 1800)
    throw new Error("Rhythm analysis accepts finite audio up to 30 minutes");
  const bytes = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
    { maxBuffer: Math.ceil(durationSec * 16000 * 4) + 1048576 },
  );
  const report = analyzeRhythmPcm(bytes, durationSec, "", overrides).report;
  report.sourceSha256 = hashFile(file);
  return report;
}
