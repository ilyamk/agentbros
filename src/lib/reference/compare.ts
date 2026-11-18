import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress } from "../cli";
import { BACKGROUND, RgbImage } from "../vision/image";
import { decodeFrame, probeVideo, writeImage, type VideoInfo } from "../vision/media";
import { composeGrid, formatTimecode, tileSize, type Cell } from "../vision/sheets";
import type { ReferenceMotion } from "../../types/reference";
import {
  dtw,
  FEATURE_HZ,
  featureRows,
  pairShots,
  rgbToLab,
  sampleFilm,
  spanEnergy,
  spanHistogram,
  warpFromPath,
  addHistograms,
  emptyHistogram,
  type FilmSample,
  type Span,
} from "./align";
import { correctedShots } from "./corrected";
import {
  bySeverity,
  compareCamera,
  compareMotion,
  comparePalette,
  compareShotColour,
  compareTiming,
  type Finding,
} from "./findings";
import { readAnalysisMedia, readLayer, referenceDirectory } from "./library";
import { frameDifferenceCurve } from "./motion";
import { replicaFindings } from "./replica";
import { detectBoundaries } from "./shots";
import { runWorker } from "./worker";

const SAMPLES = 12;
const CLUSTERS = 5;
const round = (value: number, digits = 3) => Number(value.toFixed(digits));

export type Palette = { lab: [number, number, number]; share: number }[];

const labDistance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** Deterministic k-means in Lab, seeded along lightness. */
export function extractPalette(image: RgbImage, clusters = CLUSTERS): Palette {
  const points: [number, number, number][] = [];
  for (let offset = 0; offset + 2 < image.data.length; offset += 3)
    points.push(rgbToLab(image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!));
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const centres = Array.from(
    { length: clusters },
    (_, index) => [...sorted[Math.floor(((index + 0.5) * sorted.length) / clusters)]!] as [number, number, number],
  );
  const counts = new Array<number>(clusters).fill(0);
  for (let pass = 0; pass < 8; pass++) {
    const sums = centres.map(() => [0, 0, 0]);
    counts.fill(0);
    for (const point of points) {
      let best = 0;
      let bestDistance = Infinity;
      centres.forEach((centre, index) => {
        const distance = labDistance(point, centre);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      counts[best]!++;
      sums[best]![0]! += point[0];
      sums[best]![1]! += point[1];
      sums[best]![2]! += point[2];
    }
    centres.forEach((centre, index) => {
      if (counts[index])
        centre.splice(
          0,
          3,
          sums[index]![0]! / counts[index]!,
          sums[index]![1]! / counts[index]!,
          sums[index]![2]! / counts[index]!,
        );
    });
  }
  return centres.map((lab, index) => ({ lab, share: counts[index]! / points.length })).filter((row) => row.share > 0);
}

/** Share-weighted Lab distance from each colour to its nearest match in the other palette, both ways. */
export function paletteDistance(a: Palette, b: Palette): number {
  const oneWay = (from: Palette, to: Palette) =>
    from.reduce((sum, row) => sum + row.share * Math.min(...to.map((other) => labDistance(row.lab, other.lab))), 0);
  return (oneWay(a, b) + oneWay(b, a)) / 2;
}

export function pearson(a: number[], b: number[]): number | undefined {
  const count = Math.min(a.length, b.length);
  if (count < 3) return undefined;
  const meanA = a.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
  const meanB = b.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
  let product = 0;
  let squaresA = 0;
  let squaresB = 0;
  for (let index = 0; index < count; index++) {
    product += (a[index]! - meanA) * (b[index]! - meanB);
    squaresA += (a[index]! - meanA) ** 2;
    squaresB += (b[index]! - meanB) ** 2;
  }
  return squaresA && squaresB ? product / Math.sqrt(squaresA * squaresB) : undefined;
}

export function cutDistance(reference: number[], render: number[], tolerance = 0.1) {
  const nearest = (time: number, others: number[]) => Math.min(...others.map((other) => Math.abs(other - time)));
  const distances =
    reference.length && render.length
      ? [...reference.map((time) => nearest(time, render)), ...render.map((time) => nearest(time, reference))]
      : [];
  return {
    referenceCount: reference.length,
    renderCount: render.length,
    ...(distances.length
      ? { meanNearestSec: round(distances.reduce((sum, value) => sum + value, 0) / distances.length) }
      : {}),
    toleranceSec: tolerance,
    referenceMatched: reference.length
      ? round(reference.filter((time) => render.length && nearest(time, render) <= tolerance).length / reference.length)
      : 0,
    renderMatched: render.length
      ? round(render.filter((time) => reference.length && nearest(time, reference) <= tolerance).length / render.length)
      : 0,
  };
}

function fitted(media: string, info: VideoInfo, frame: number, width: number, height: number): RgbImage {
  const scale = Math.min(width / info.width, height / info.height);
  const innerWidth = Math.max(2, Math.round(info.width * scale));
  const innerHeight = Math.max(2, Math.round(info.height * scale));
  const tile = RgbImage.filled(width, height, BACKGROUND);
  tile.blit(
    decodeFrame(media, info, frame, innerWidth, innerHeight).image,
    Math.floor((width - innerWidth) / 2),
    Math.floor((height - innerHeight) / 2),
  );
  return tile;
}

function sideBySide(
  reference: string,
  referenceInfo: VideoInfo,
  render: string,
  renderInfo: VideoInfo,
  output: string,
): void {
  const video =
    "[0:v:0]scale=-2:720,setsar=1,fps=30[left];[1:v:0]scale=-2:720,setsar=1,fps=30[right];[left][right]hstack=inputs=2:shortest=1[v]";
  // Original in the left ear, recreation in the right.
  const both = referenceInfo.hasAudio && renderInfo.hasAudio;
  const audio = both
    ? ";[0:a:0]aformat=channel_layouts=mono[la];[1:a:0]aformat=channel_layouts=mono[ra];[la][ra]join=inputs=2:channel_layout=stereo[a]"
    : "";
  const audioMap = both
    ? ["-map", "[a]"]
    : referenceInfo.hasAudio
      ? ["-map", "0:a:0"]
      : renderInfo.hasAudio
        ? ["-map", "1:a:0"]
        : [];
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      reference,
      "-i",
      render,
      "-filter_complex",
      video + audio,
      "-map",
      "[v]",
      ...audioMap,
      "-c:v",
      "libx264",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      output,
    ],
    { encoding: "utf8", timeout: 1800000, killSignal: "SIGKILL" },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Side-by-side failed: ${result.error?.message ?? result.stderr.slice(-500)}`,
    });
}

const spansFromCuts = (cuts: number[], durationSec: number, prefix = "s"): Span[] => {
  const edges = [0, ...cuts.filter((time) => time > 0 && time < durationSec), durationSec];
  return edges.slice(0, -1).map((startSec, index) => ({
    id: `${prefix}${index + 1}`,
    startSec: round(startSec),
    endSec: round(edges[index + 1]!),
  }));
};

const weightedHistogram = (samples: FilmSample[], shots: Span[]) =>
  shots.reduce((sum, shot) => {
    const histogram = spanHistogram(samples, shot);
    const total = histogram[0].reduce((count, value) => count + value, 0) || 1;
    const weight = shot.endSec - shot.startSec;
    return addHistograms(
      sum,
      histogram.map((channel) => channel.map((value) => (value / total) * weight)) as typeof histogram,
    );
  }, emptyHistogram());

type RenderMotion = { shots: { shotId: string; camera?: NonNullable<ReferenceMotion["shots"][number]["camera"]> }[] };

/**
 * Aligns the recreation to the reference by DTW over 4 Hz picture and motion features, pairs each recreation shot with
 * the reference shot it answers, and compares them shot to shot: timing, motion, colour (Lab histograms by Wasserstein
 * distance) and, when both sides have fitted camera moves, the moves. The older same-clock fields stay as they were.
 * `tolerance: "replica"` pairs against the analyst's corrected shots and writes findings at the replica tolerances.
 */
export function compareReference(request: {
  libraryRoot: string;
  id: string;
  render: string;
  renderShots?: Span[];
  camera?: boolean;
  tolerance?: "style" | "replica";
  swappedShots?: string[];
}) {
  const replica = request.tolerance === "replica";
  const directory = referenceDirectory(request.libraryRoot, request.id);
  const { analysisMedia: media } = readAnalysisMedia(directory);
  const referenceInfo = probeVideo(media);
  const renderInfo = probeVideo(path.resolve(request.render));
  const render = path.resolve(request.render);
  const output = path.join(directory, "compare");
  mkdirSync(output, { recursive: true });

  emitProgress("Detecting cuts in the recreation");
  const referenceShots = readLayer(directory, "shots.json");
  const edit = replica ? readLayer(directory, "edit.json") : undefined;
  const corrected = replica && referenceShots?.shots.length ? correctedShots(referenceShots, edit) : undefined;
  const referenceCuts = corrected
    ? corrected.slice(1).map((shot) => shot.startSec)
    : referenceShots
      ? referenceShots.shots.slice(1).map((shot) => shot.startSec)
      : detectBoundaries(media).boundaries.map((row) => row.timeSec);
  const renderDetected = request.renderShots ? undefined : detectBoundaries(render);
  const renderCuts = request.renderShots
    ? request.renderShots.slice(1).map((shot) => shot.startSec)
    : renderDetected!.boundaries.map((row) => row.timeSec);

  emitProgress("Comparing motion energy");
  const referenceCurve = frameDifferenceCurve(media, referenceInfo);
  const renderCurve = frameDifferenceCurve(render, renderInfo);
  const correlation = pearson(
    referenceCurve.map((row) => row.energy),
    renderCurve.map((row) => row.energy),
  );

  emitProgress("Comparing palettes and drawing the sheet");
  const shared = Math.min(referenceInfo.durationSec, renderInfo.durationSec);
  const { width, height } = tileSize(referenceInfo, 320);
  const cells: Cell[] = [];
  const samples = Array.from({ length: SAMPLES }, (_, index) => {
    const timeSec = ((index + 0.5) * shared) / SAMPLES;
    const left = fitted(
      media,
      referenceInfo,
      Math.min(referenceInfo.frameCount - 1, Math.floor(timeSec * referenceInfo.fps)),
      width,
      height,
    );
    const right = fitted(
      render,
      renderInfo,
      Math.min(renderInfo.frameCount - 1, Math.floor(timeSec * renderInfo.fps)),
      width,
      height,
    );
    cells.push(
      { image: left, label: `ORIG ${formatTimecode(timeSec)}` },
      { image: right, label: `NEW ${formatTimecode(timeSec)}` },
    );
    const smallA = fitted(
      media,
      referenceInfo,
      Math.min(referenceInfo.frameCount - 1, Math.floor(timeSec * referenceInfo.fps)),
      64,
      36,
    );
    const smallB = fitted(
      render,
      renderInfo,
      Math.min(renderInfo.frameCount - 1, Math.floor(timeSec * renderInfo.fps)),
      64,
      36,
    );
    return {
      timeSec: round(timeSec),
      paletteDistance: round(paletteDistance(extractPalette(smallA), extractPalette(smallB)), 2),
    };
  });
  const sheet = writeImage(
    composeGrid(cells, { title: "ORIGINAL AND RECREATION AT THE SAME TIMES", columns: 6, groupSize: 2 }),
    path.join(output, "sheet.jpg"),
  );
  const video = path.join(output, "side-by-side.mp4");
  sideBySide(media, referenceInfo, render, renderInfo, video);

  emitProgress("Aligning the two films in time");
  const referenceSamples = sampleFilm(media, referenceInfo);
  const renderSamples = sampleFilm(render, renderInfo);
  const alignment = dtw(featureRows(referenceSamples), featureRows(renderSamples));
  const warp = warpFromPath(
    alignment.path,
    referenceSamples.map((sample) => sample.timeSec),
    renderSamples.map((sample) => sample.timeSec),
  );
  const offsets = warp.pairs.map(([referenceSec, renderSec]) => renderSec - referenceSec).sort((a, b) => a - b);
  const alignedCuts = cutDistance(
    referenceCuts.map((time) => round(warp.toRender(time))),
    renderCuts,
  );
  const alignedEnergy = alignment.path.map(
    ([row, column]) => [referenceSamples[row]!.energy, renderSamples[column]!.energy] as const,
  );
  const alignedCorrelation = pearson(
    alignedEnergy.map((row) => row[0]),
    alignedEnergy.map((row) => row[1]),
  );

  const referenceSpans: Span[] = corrected
    ? corrected.map(({ id, startSec, endSec }) => ({ id, startSec, endSec }))
    : referenceShots
      ? referenceShots.shots.map((shot) => ({ id: shot.id, startSec: shot.startSec, endSec: shot.endSec }))
      : spansFromCuts(referenceCuts, referenceInfo.durationSec, "ref");
  const renderSpans = request.renderShots ?? spansFromCuts(renderCuts, renderInfo.durationSec);
  const referenceMotion = readLayer(directory, "motion.json");
  const measuredCamera = new Map(
    (referenceMotion?.shots ?? []).filter((shot) => shot.camera).map((shot) => [shot.shotId, shot.camera!]),
  );
  // A corrected shot keeps a fitted move only when it is one whole detector shot.
  const referenceCamera = corrected
    ? new Map(
        corrected
          .filter((shot) => !shot.split && shot.sourceShots.length === 1 && measuredCamera.has(shot.id))
          .map((shot) => [shot.id, measuredCamera.get(shot.id)!]),
      )
    : measuredCamera;
  let renderCamera = new Map<string, NonNullable<RenderMotion["shots"][number]["camera"]>>();
  let cameraNote: string | undefined;
  if (request.camera === false) cameraNote = "Camera moves not compared: --no-camera.";
  else if (!referenceCamera.size)
    cameraNote =
      "Camera moves not compared: the reference's motion.json has no fitted moves. Rerun ref:analyze --layers motion.";
  else {
    emitProgress("Fitting the recreation's camera moves");
    const worker = runWorker<RenderMotion>("motion", render, { shots: renderSpans, transitions: [], text: [] });
    if (worker.ok)
      renderCamera = new Map(
        worker.value.shots.filter((shot) => shot.camera).map((shot) => [shot.shotId, shot.camera!]),
      );
    else cameraNote = `Camera moves not compared: ${worker.reason} ${worker.fix}`;
  }

  const findings: Finding[] = [];
  const medianOffset = offsets.length ? offsets[Math.floor(offsets.length / 2)]! : 0;
  if (!replica && Math.abs(medianOffset) > 0.5)
    findings.push({
      component: "alignment",
      where: "whole film",
      severity: Math.abs(medianOffset) > 2 ? "major" : "minor",
      text: `Whole film: aligned, the recreation runs ${Math.abs(medianOffset).toFixed(2)} s ${medianOffset > 0 ? "behind" : "ahead of"} the reference (median offset).`,
    });
  for (const time of replica ? [] : referenceCuts) {
    const mapped = warp.toRender(time);
    if (renderCuts.every((cut) => Math.abs(cut - mapped) > alignedCuts.toleranceSec))
      findings.push({
        component: "cuts",
        where: `${round(mapped, 2)} s`,
        severity: "minor",
        text: `Reference cut at ${time.toFixed(2)} s (aligned to ${mapped.toFixed(2)} s here) has no cut within ${alignedCuts.toleranceSec} s.`,
        referenceSec: round(time),
        renderSec: round(mapped),
      });
  }
  const pairs = pairShots(renderSpans, referenceSpans, warp).map((pair) => {
    const where = `${pair.render.id} vs ref ${pair.reference?.id ?? "none"}`;
    if (!pair.reference)
      return {
        id: pair.render.id,
        startSec: pair.render.startSec,
        endSec: pair.render.endSec,
        referenceShot: null,
        referenceSpan: pair.referenceSpan,
        overlapShare: 0,
      };
    const at = { renderSec: pair.render.startSec, referenceSec: pair.reference.startSec };
    const colour = compareShotColour(
      where,
      spanHistogram(referenceSamples, pair.reference),
      spanHistogram(renderSamples, pair.render),
      at,
    );
    const energy = {
      reference: round(spanEnergy(referenceSamples, pair.reference), 5),
      render: round(spanEnergy(renderSamples, pair.render), 5),
    };
    const durations = {
      reference: round(pair.reference.endSec - pair.reference.startSec),
      render: round(pair.render.endSec - pair.render.startSec),
    };
    const timing = compareTiming(where, durations.reference, durations.render, at);
    const motion = compareMotion(where, energy.reference, energy.render, at);
    const ours = renderCamera.get(pair.render.id);
    const theirs = referenceCamera.get(pair.reference.id);
    const camera = ours && theirs ? compareCamera(where, theirs, ours, at) : undefined;
    findings.push(
      ...(replica ? [] : [...colour.findings, ...(timing ? [timing] : []), ...(camera?.findings ?? [])]),
      ...(motion ? [motion] : []),
    );
    return {
      id: pair.render.id,
      startSec: pair.render.startSec,
      endSec: pair.render.endSec,
      referenceShot: pair.reference.id,
      referenceSpan: pair.referenceSpan,
      overlapShare: pair.overlapShare,
      durationSec: durations,
      frameChange: energy,
      colour: colour.numbers,
      ...(camera ? { camera: { ...camera.numbers, reference: theirs!.kind, render: ours!.kind } } : {}),
    };
  });
  const palette = comparePalette(
    weightedHistogram(referenceSamples, referenceSpans),
    weightedHistogram(renderSamples, renderSpans),
  );
  findings.push(...palette.findings);
  const strict = replica
    ? replicaFindings({
        fps: renderInfo.fps,
        referenceCuts,
        renderCuts,
        warp,
        referenceShots: referenceSpans,
        swappedShots: request.swappedShots,
        pairs: pairs.map((pair) =>
          pair.referenceShot === null
            ? { id: pair.id, startSec: pair.startSec, referenceShot: null, cameraComparable: false }
            : {
                id: pair.id,
                startSec: pair.startSec,
                referenceShot: pair.referenceShot,
                referenceStartSec: referenceSpans.find((shot) => shot.id === pair.referenceShot)?.startSec,
                durationSec: pair.durationSec,
                colour: pair.colour,
                camera: pair.camera,
                cameraComparable: referenceCamera.has(pair.referenceShot) && renderCamera.has(pair.id),
              },
        ),
      })
    : undefined;
  if (strict) {
    findings.push(...strict.findings);
    for (const pair of pairs)
      if ("camera" in pair && pair.camera && strict.easeNotes.has(pair.id))
        Object.assign(pair.camera, { easeNote: strict.easeNotes.get(pair.id) });
  }

  const result = {
    schemaVersion: 1,
    referenceId: request.id,
    render,
    durationSec: {
      reference: round(referenceInfo.durationSec),
      render: round(renderInfo.durationSec),
      difference: round(renderInfo.durationSec - referenceInfo.durationSec),
    },
    format: {
      reference: `${referenceInfo.width}x${referenceInfo.height}@${round(referenceInfo.fps, 2)}`,
      render: `${renderInfo.width}x${renderInfo.height}@${round(renderInfo.fps, 2)}`,
    },
    cuts: {
      ...cutDistance(referenceCuts, renderCuts),
      renderDetector: renderDetected?.detector.name ?? "render-shots",
      aligned: alignedCuts,
    },
    palette: {
      meanDistance: round(samples.reduce((sum, row) => sum + row.paletteDistance, 0) / samples.length, 2),
      unit: "CIE76 Lab distance, share-weighted over 5 colours per frame",
      samples,
    },
    motion: {
      correlation: correlation === undefined ? null : round(correlation),
      alignedCorrelation: alignedCorrelation === undefined ? null : round(alignedCorrelation),
      method:
        "frame difference at about 10 samples a second, compared on the shared time axis; alignedCorrelation pairs the samples along the DTW path",
    },
    alignment: {
      method: `DTW over ${FEATURE_HZ} Hz samples: an 8x4 Lab grid and frame change, cityblock cost, Sakoe-Chiba band 0.25`,
      meanCost: round(alignment.cost, 4),
      medianOffsetSec: round(medianOffset),
      offsetRangeSec: offsets.length ? [round(offsets[0]!), round(offsets.at(-1)!)] : [0, 0],
      path: warp.pairs
        .filter((_, index, all) => index % Math.max(1, Math.ceil(all.length / 200)) === 0)
        .map(([referenceSec, renderSec]) => [round(referenceSec), round(renderSec)]),
    },
    look: {
      ...palette.numbers,
      unit: "Wasserstein distance per Lab channel between duration-weighted histograms (L in lightness points, a and b in colour points)",
    },
    shots: pairs,
    ...(cameraNote ? { cameraNote } : {}),
    ...(strict
      ? {
          tolerance: "replica" as const,
          renderSha256: createHash("sha256").update(readFileSync(render)).digest("hex"),
          referenceShots: {
            source: edit ? "shots.json with edit.json corrections" : "shots.json (no edit.json: the detector's list)",
            count: referenceSpans.length,
          },
          summary: strict.summary,
        }
      : {}),
    findings: bySeverity(findings),
  };
  const report = path.join(output, "compare.json");
  writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
  return { outputs: [report, sheet, video], result };
}
