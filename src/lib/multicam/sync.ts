import { pythonRequirementsHash } from "../python";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, emitProgress } from "../cli";
import { MulticamSyncSchema, type MulticamSource, type MulticamSync } from "../../types/multicam";
import { extractWav, probe, sha256File } from "./media";
import { coarseOffset, runMulticamWorker } from "./worker";

export type SyncThresholds = MulticamSync["thresholds"];
export const DEFAULT_THRESHOLDS: SyncThresholds = {
  minStandardScore: 10,
  minPeakRatio: 3,
  searchMs: 20,
  driftToleranceMs: 16,
};
const WINDOW_SEC = 2;
const MIN_DRIFT_SPAN_SEC = 30;
const MAX_DRIFT_PPM = 1000;

type Window = { referenceSec: number; offsetSec: number; peakRatio: number };
type Refined = { overlap: [number, number]; start: Window | null; end: Window | null };

export function sourceIds(files: string[], ids?: string[]): string[] {
  if (ids) {
    if (ids.length !== files.length)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--ids must name every input" });
    return ids;
  }
  const seen = new Map<string, number>();
  return files.map((file) => {
    const base =
      path
        .basename(file, path.extname(file))
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^[^a-zA-Z0-9]+/, "")
        .slice(0, 56) || "source";
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

/** Offset model, drift and verdict for one non-reference source from its measurements. */
export function assess(
  coarse: { offsetSec: number; standardScore: number },
  refined: Refined,
  thresholds: SyncThresholds,
): Pick<MulticamSource, "offsetSec" | "overlap" | "drift" | "confidence"> & { reasons: string[] } {
  const reasons: string[] = [];
  if (coarse.standardScore < thresholds.minStandardScore)
    reasons.push(`coarse standard score ${coarse.standardScore.toFixed(1)} < ${thresholds.minStandardScore}`);
  const start = refined.start;
  if (!start) reasons.push("no overlapping audible window to refine");
  else if (start.peakRatio < thresholds.minPeakRatio)
    reasons.push(`GCC-PHAT peak ratio ${start.peakRatio.toFixed(2)} < ${thresholds.minPeakRatio}`);
  const [overlapStart, overlapEnd] = refined.overlap;
  const end = refined.end && refined.end.peakRatio >= thresholds.minPeakRatio ? refined.end : null;
  const ppm = start && end ? ((end.offsetSec - start.offsetSec) / (end.referenceSec - start.referenceSec)) * 1e6 : null;
  const accumulatedMs = ppm === null ? null : ppm * 1e-6 * (overlapEnd - overlapStart) * 1000;
  const offsetSec = start
    ? start.offsetSec + (ppm ?? 0) * 1e-6 * (overlapStart - start.referenceSec)
    : coarse.offsetSec;
  return {
    offsetSec,
    overlap: { startSec: overlapStart, endSec: overlapEnd },
    drift: {
      measured: ppm !== null,
      ppm,
      accumulatedMs,
      needsResample: accumulatedMs !== null && Math.abs(accumulatedMs) > thresholds.driftToleranceMs,
    },
    confidence: reasons.length ? "low" : "high",
    reasons,
  };
}

export function syncSources(
  files: string[],
  options: { ids?: string[]; reference?: number; thresholds?: Partial<SyncThresholds> },
): MulticamSync {
  if (files.length < 2)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "multicam:sync needs at least two inputs" });
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const ids = sourceIds(files, options.ids);
  const referenceIndex = options.reference ?? 0;
  if (!Number.isInteger(referenceIndex) || referenceIndex < 0 || referenceIndex >= files.length)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--reference must index an input" });
  const work = mkdtempSync(path.join(tmpdir(), "multicam-sync-"));
  try {
    const probes = files.map((file) => {
      const result = probe(file);
      if (!result.audio)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `${file} has no audio stream; sync needs sound on every input`,
        });
      return result;
    });
    const wavs = files.map((file, index) => {
      const wav = path.join(work, `${index}.wav`);
      emitProgress(`Extracting audio ${index + 1}/${files.length}: ${path.basename(file)}`);
      extractWav(file, wav);
      return wav;
    });
    const failures: Record<string, string[]> = {};
    const sources: MulticamSource[] = files.map((file, index) => {
      const media = probes[index]!;
      const base = {
        id: ids[index]!,
        file,
        sha256: sha256File(file),
        durationSec: media.durationSec,
        video: media.video ? { fps: media.video.fps, width: media.video.width, height: media.video.height } : null,
      };
      const containerShift = media.video ? media.video.startSec - media.audio!.startSec : null;
      if (index === referenceIndex) {
        return {
          ...base,
          offsetSec: 0,
          videoOffsetSec: containerShift,
          overlap: { startSec: 0, endSec: media.durationSec },
          coarse: null,
          refine: null,
          drift: { measured: false, ppm: null, accumulatedMs: null, needsResample: false },
          confidence: "reference" as const,
        };
      }
      emitProgress(`Coarse offset ${base.id} (audio-offset-finder)`);
      const coarse = coarseOffset(wavs[referenceIndex]!, wavs[index]!);
      emitProgress(`GCC-PHAT refinement and drift ${base.id}`);
      const refined = runMulticamWorker<Refined>("refine", {
        reference: wavs[referenceIndex],
        target: wavs[index],
        coarseOffsetSec: coarse.offsetSec,
        windowSec: WINDOW_SEC,
        searchMs: thresholds.searchMs,
        minDriftSpanSec: MIN_DRIFT_SPAN_SEC,
        maxDriftPpm: MAX_DRIFT_PPM,
      });
      const verdict = assess(coarse, refined, thresholds);
      if (verdict.reasons.length) failures[base.id] = verdict.reasons;
      return {
        ...base,
        offsetSec: verdict.offsetSec,
        videoOffsetSec: containerShift === null ? null : verdict.offsetSec + containerShift,
        overlap: verdict.overlap,
        coarse,
        refine: refined.start ? { start: refined.start, end: refined.end } : null,
        drift: verdict.drift,
        confidence: verdict.confidence,
      };
    });
    const report = MulticamSyncSchema.parse({
      version: 1,
      referenceId: ids[referenceIndex],
      sampleRate: 48000,
      thresholds,
      sources,
      tools: {
        coarse: `audio-offset-finder (uv.lock ${pythonRequirementsHash()})`,
        refine: `scripts/workers/multicam.py gcc-phat uv.lock ${pythonRequirementsHash()}`,
      },
    });
    if (Object.keys(failures).length) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Low sync confidence for ${Object.keys(failures).join(", ")}: ${Object.values(failures).flat().join("; ")}. Check the inputs share audible sound, or sync these by hand.`,
        details: { failures, report },
      });
    }
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
