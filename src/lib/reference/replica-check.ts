import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress } from "../cli";
import { ShotsFileSchema } from "../vision/sheets";
import { ReplicaSpecSchema, type ReplicaShot, type ReplicaSpec } from "../../types/reference-replica";
import type { ReferenceShots, ReferenceSpeechText, ShotCamera, ShotColour } from "../../types/reference";
import { correctedShots, type CorrectedShot } from "./corrected";
import { probeVideo } from "../vision/media";
import { sampleFilm, type FilmSample } from "./align";
import { readAnalysisMedia, readLayer, referenceDirectory } from "./library";
import { mergedLab, shotColour } from "./look";
import { readSpeechText } from "./speech-text";

/** CIE76 distance between a spec's colour target and the measured shot above which the target needs a swap. */
export const COLOUR_TARGET_TOLERANCE = 2;
const BEZIER_TOLERANCE = 1e-3;
const SPRING_SHARE = 0.01;

/** `text` only when this machine holds the film's words (media/speech-text.full.json); `textId` otherwise. */
export type MeasuredText = {
  text?: string;
  textId?: number;
  startSec: number;
  endSec: number;
  onsetSec?: number;
  heightShare: number;
  centre: { x: number; y: number };
  box: { x: number; y: number; width: number; height: number };
};

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

/** Screen text per shot from the OCR boxes in speech-text.json (top-left origin, shares of the cropped frame): a cheap typography measurement. */
export function textInShot(
  speechText: ReferenceSpeechText | undefined,
  span: { startSec: number; endSec: number },
): MeasuredText[] {
  return (speechText?.screenText.items ?? [])
    .filter(
      (item) =>
        item.box &&
        (item.onsetSec ?? item.startSec) >= span.startSec - 1e-6 &&
        (item.onsetSec ?? item.startSec) < span.endSec,
    )
    .map((item) => {
      const box = item.box!;
      return {
        ...(item.text === undefined ? {} : { text: item.text }),
        ...(item.textId === undefined ? {} : { textId: item.textId }),
        startSec: item.startSec,
        endSec: item.endSec,
        ...(item.onsetSec === undefined ? {} : { onsetSec: item.onsetSec }),
        heightShare: round(box.height),
        centre: { x: round(box.x + box.width / 2), y: round(box.y + box.height / 2) },
        box,
      };
    });
}

/**
 * Each corrected shot's Lab from the reference media, exactly as ref:compare --tolerance replica reads its reference
 * side. Without the media (git-ignored), shots.json's colour: a whole detector shot as measured, a merge averaged by
 * samples, a split part not at all.
 */
function measuredColours(
  directory: string,
  corrected: CorrectedShot[],
  shots: ReferenceShots | undefined,
): (shot: CorrectedShot) => { L: number; a: number; b: number; percentiles?: ShotColour["percentiles"] } | undefined {
  let samples: FilmSample[] | undefined;
  try {
    if (corrected.length) {
      const { analysisMedia } = readAnalysisMedia(directory);
      emitProgress("Measuring each corrected shot's colour");
      samples = sampleFilm(analysisMedia, probeVideo(analysisMedia));
    }
  } catch {
    samples = undefined;
  }
  if (samples?.length) {
    const measured = new Map(corrected.map((shot) => [shot.id, shotColour(samples!, shot)]));
    return (shot) => {
      const { L, a, b, percentiles } = measured.get(shot.id)!;
      return { L, a, b, percentiles };
    };
  }
  return (shot) => {
    if (shot.split) return undefined;
    const colours = shot.sourceShots.map((id) => shots?.shots.find((row) => row.id === id)?.colour);
    if (!colours.length || !colours.every(Boolean)) return undefined;
    return colours.length === 1
      ? { L: colours[0]!.L, a: colours[0]!.a, b: colours[0]!.b, percentiles: colours[0]!.percentiles }
      : mergedLab(colours.map((colour) => colour!));
  };
}

function easeIssue(shot: ReplicaShot, measured: ShotCamera | undefined): string | undefined {
  const ease = shot.camera?.ease;
  if (!ease) return undefined;
  const fitted = measured?.ease;
  if (!fitted)
    return `${shot.id}: camera.ease is set but reference shot ${shot.referenceShot} has no fitted ease in motion.json; run ref:analyze --layers motion (needs uv), or drop the ease and mark the shot observed`;
  if (ease.pick === "gsap") {
    if (!ease.gsap) return `${shot.id}: ease.pick is gsap but ease.gsap is missing`;
    if (ease.gsap !== fitted.gsap)
      return `${shot.id}: ease.gsap ${ease.gsap} is not the reference's fitted ${fitted.gsap}`;
  } else if (ease.pick === "bezier") {
    if (!ease.cubicBezier) return `${shot.id}: ease.pick is bezier but ease.cubicBezier is missing`;
    if (ease.cubicBezier.some((value, index) => Math.abs(value - fitted.cubicBezier[index]!) > BEZIER_TOLERANCE))
      return `${shot.id}: ease.cubicBezier [${ease.cubicBezier.join(", ")}] is not the reference's fitted [${fitted.cubicBezier.join(", ")}]`;
  } else {
    const spring = ease.spring?.remotion;
    if (!spring) return `${shot.id}: ease.pick is spring but ease.spring.remotion is missing`;
    const want = fitted.spring.remotion;
    const off = (key: "mass" | "stiffness" | "damping") =>
      Math.abs(spring[key] - want[key]) > SPRING_SHARE * Math.max(Math.abs(want[key]), 1e-6);
    if (off("mass") || off("stiffness") || off("damping"))
      return `${shot.id}: ease.spring.remotion ${JSON.stringify(spring)} is not the reference's fitted ${JSON.stringify(want)}`;
  }
  return undefined;
}

export function replicaShotsFile(spec: ReplicaSpec) {
  return {
    shots: spec.shots.map((shot) => ({
      id: shot.id,
      startSec: round(shot.startFrame / spec.fps),
      endSec: round((shot.startFrame + shot.durationFrames) / spec.fps),
    })),
  };
}

/**
 * Validates a replica spec against its reference record: every corrected reference shot covered once and in place,
 * frames that tile the reference's length, eases taken from motion.json, colour targets that match the measured shots
 * unless swapped, and replica-shots.json in step with the spec.
 */
export function checkReplicaSpec(request: { specPath: string; libraryRoot: string; writeShots?: boolean }) {
  if (!existsSync(request.specPath))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No replica spec at ${request.specPath}` });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(request.specPath, "utf8"));
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${request.specPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const parsed = ReplicaSpecSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${request.specPath}: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    });
  const spec = parsed.data;
  const directory = referenceDirectory(request.libraryRoot, spec.reference);
  const source = readLayer(directory, "source.json");
  if (!source)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `No reference ${spec.reference} at ${directory}. Run ref:add, or pass --library-root.`,
    });

  const issues: string[] = [];
  const warnings: string[] = [];
  const fps = spec.fps;
  const toFrame = (seconds: number) => Math.round(seconds * fps);

  if (spec.rights.status !== source.rights.status)
    issues.push(
      `rights.status is ${spec.rights.status} but the reference's source.json says ${source.rights.status}; rerun ref:add with the user's answer or fix the spec`,
    );

  const ids = new Set<string>();
  for (const shot of spec.shots) {
    if (ids.has(shot.id)) issues.push(`${shot.id}: id is used twice`);
    ids.add(shot.id);
  }
  const referenceFrames = toFrame(source.probe.durationSec);
  const specFrames = spec.shots.reduce((sum, shot) => sum + shot.durationFrames, 0);
  if (Math.abs(specFrames - referenceFrames) > 1)
    issues.push(
      `shots sum to ${specFrames} frames; the reference is ${referenceFrames} frames (${source.probe.durationSec} s at ${fps} fps)`,
    );
  let tiled = true;
  if (spec.shots[0]!.startFrame !== 0) {
    tiled = false;
    issues.push(`${spec.shots[0]!.id}: the first shot starts at frame ${spec.shots[0]!.startFrame}, not 0`);
  }
  spec.shots.slice(1).forEach((shot, index) => {
    const previous = spec.shots[index]!;
    const gap = shot.startFrame - (previous.startFrame + previous.durationFrames);
    if (gap) {
      tiled = false;
      issues.push(`${shot.id}: ${gap > 0 ? "gap" : "overlap"} of ${Math.abs(gap)} frames after ${previous.id}`);
    }
  });

  const shots = readLayer(directory, "shots.json");
  const edit = readLayer(directory, "edit.json");
  const motion = readLayer(directory, "motion.json");
  const speechText = readSpeechText(directory);
  let corrected: CorrectedShot[] = [];
  if (!shots?.shots.length)
    issues.push(`reference ${spec.reference} has no shots.json; run ref:analyze --layers shots`);
  else {
    corrected = correctedShots(shots, edit);
    if (!edit)
      warnings.push(
        "no edit.json: shots are the detector's, uncorrected; the reference-analyst writes corrections after looking",
      );
  }
  const byId = new Map(corrected.map((shot) => [shot.id, shot]));
  const colourOf = measuredColours(directory, corrected, shots);
  const covering = new Map<string, string[]>();
  for (const shot of spec.shots)
    covering.set(shot.referenceShot, [...(covering.get(shot.referenceShot) ?? []), shot.id]);
  const swapped = new Set(spec.swaps.flatMap((swap) => swap.shots ?? []));

  if (corrected.length) {
    for (const reference of corrected) {
      const users = covering.get(reference.id) ?? [];
      if (!users.length)
        issues.push(`reference shot ${reference.id} (${reference.startSec}-${reference.endSec} s) is not covered`);
      if (users.length > 1)
        issues.push(`reference shot ${reference.id} is covered ${users.length} times (${users.join(", ")})`);
    }
    for (const shot of spec.shots) {
      const reference = byId.get(shot.referenceShot);
      if (!reference) {
        const parts = corrected.filter((row) => row.id.startsWith(`${shot.referenceShot}.`)).map((row) => row.id);
        const into = corrected.find((row) => row.sourceShots.includes(shot.referenceShot));
        issues.push(
          `${shot.id}: referenceShot ${shot.referenceShot} is not a corrected shot${parts.length ? `; it was split into ${parts.join(", ")}` : into ? `; it is merged into ${into.id}` : ""}`,
        );
        continue;
      }
      const start = toFrame(reference.startSec);
      if (Math.abs(shot.startFrame - start) > 1)
        issues.push(
          `${shot.id}: starts at frame ${shot.startFrame}; reference shot ${reference.id} starts at frame ${start}`,
        );

      const whole = !reference.split && reference.sourceShots.length === 1;
      const measuredCamera = motion?.shots.find((row) => row.shotId === reference.sourceShots[0])?.camera;
      if (shot.camera?.ease && !motion)
        issues.push(
          `${shot.id}: camera.ease is set but the reference has no motion.json; run ref:analyze --layers motion`,
        );
      else {
        if (shot.camera?.ease && !whole)
          warnings.push(
            `${shot.id}: ${reference.id} is ${reference.split ? "part of a split" : "a merge"}; its ease was fitted over detector shot ${reference.sourceShots[0]}`,
          );
        const problem = easeIssue(shot, measuredCamera);
        if (problem) issues.push(problem);
        if (shot.camera?.ease && measuredCamera?.ease && shot.camera.ease.pick !== measuredCamera.ease.pick)
          warnings.push(`${shot.id}: ease.pick ${shot.camera.ease.pick}; the fit prefers ${measuredCamera.ease.pick}`);
        if (shot.camera && !shot.camera.ease && measuredCamera?.ease && !shot.camera.kind.includes("static"))
          warnings.push(
            `${shot.id}: the camera moves but has no ease; motion.json has ${measuredCamera.ease.gsap} (${measuredCamera.ease.css})`,
          );
      }

      const measured = colourOf(reference);
      if (!measured)
        warnings.push(
          `${shot.id}: no measured colour for ${reference.id}: the reference media is missing${reference.split ? " and it is a split part" : " and shots.json has no colour"}; take the target from ref:compare's reference side after the first render`,
        );
      else if (!swapped.has(shot.id)) {
        const distance = Math.hypot(shot.colour.L - measured.L, shot.colour.a - measured.a, shot.colour.b - measured.b);
        if (distance > COLOUR_TARGET_TOLERANCE)
          issues.push(
            `${shot.id}: colour target L ${shot.colour.L} a ${shot.colour.a} b ${shot.colour.b} is ${distance.toFixed(1)} from the measured L ${measured.L} a ${measured.a} b ${measured.b}; copy the measurement or record a swap with shots: ["${shot.id}"]`,
          );
      }
      const text = textInShot(speechText, reference);
      if (text.length && !shot.type.length && !swapped.has(shot.id))
        warnings.push(
          `${shot.id}: screen text measured in ${reference.id} (${text.map((item) => (item.text === undefined ? `text #${item.textId ?? "?"}` : JSON.stringify(item.text))).join(", ")}) but the shot lists no type`,
        );
    }
  }

  const shotsPath = path.join(path.dirname(request.specPath), "replica-shots.json");
  const outputs: string[] = [];
  const expected = replicaShotsFile(spec);
  if (request.writeShots) {
    if (tiled) {
      writeFileSync(shotsPath, `${JSON.stringify(expected, null, 2)}\n`);
      outputs.push(shotsPath);
    } else issues.push("replica-shots.json not written: the spec's frames do not tile");
  } else if (existsSync(shotsPath)) {
    const file = ShotsFileSchema.safeParse(JSON.parse(readFileSync(shotsPath, "utf8")));
    const halfFrame = 0.5 / fps;
    const inStep =
      file.success &&
      file.data.shots.length === expected.shots.length &&
      file.data.shots.every(
        (row, index) =>
          row.id === expected.shots[index]!.id &&
          Math.abs(row.startSec - expected.shots[index]!.startSec) <= halfFrame &&
          Math.abs(row.endSec - expected.shots[index]!.endSec) <= halfFrame,
      );
    if (!inStep) issues.push("replica-shots.json is out of step with the spec; rerun with --write-shots");
  } else warnings.push("no replica-shots.json beside the spec; rerun with --write-shots before ref:compare");

  const measured = corrected.map((reference) => {
    const colour = colourOf(reference);
    return {
      referenceShot: reference.id,
      sourceShots: reference.sourceShots,
      startFrame: toFrame(reference.startSec),
      durationFrames: toFrame(reference.endSec) - toFrame(reference.startSec),
      transitionIn: reference.transitionIn,
      ...(colour ? { colour } : {}),
      text: textInShot(speechText, reference),
    };
  });
  return {
    outputs,
    metadata: {
      spec: request.specPath,
      /** The film chain's replica-spec step holds the check to this exact spec. */
      specSha256: createHash("sha256").update(readFileSync(request.specPath)).digest("hex"),
      reference: spec.reference,
      passed: issues.length === 0,
      issues,
      warnings,
      frames: { spec: specFrames, reference: referenceFrames, fps },
      shots: {
        spec: spec.shots.length,
        reference: corrected.length,
        corrected: Boolean(edit),
        unreachable: spec.shots.filter((shot) => shot.unreachable).map((shot) => shot.id),
      },
      measured,
    },
  };
}
