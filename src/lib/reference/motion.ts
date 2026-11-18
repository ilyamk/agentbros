import { decodeFrames, type VideoInfo } from "../vision/media";
import {
  ReferenceMotionSchema,
  type ReferenceMotion,
  type ReferenceShots,
  type ReferenceSpeechText,
} from "../../types/reference";
import { runWorker } from "./worker";

type WorkerMotion = {
  engine: string;
  stride: number;
  shots: ReferenceMotion["shots"];
  curve: ReferenceMotion["energyCurve"];
  textOnSec: number[];
  cadence?: ReferenceMotion["cadence"];
  staticOverlayShare?: number;
};

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

/** Mean frame difference (0-255) at about 10 samples a second: the metric needs only ffmpeg, so it also compares a render. */
export function frameDifferenceCurve(media: string, info: VideoInfo): { timeSec: number; energy: number }[] {
  const step = Math.max(1, Math.round(info.fps / 10));
  const curve: { timeSec: number; energy: number }[] = [];
  const batch = 600;
  let previous: Buffer | undefined;
  for (let startFrame = 0; startFrame < info.frameCount; startFrame += batch * step) {
    const frames = decodeFrames(media, info, { startFrame, count: batch, step, width: 64, height: 36 });
    frames.forEach((frame, index) => {
      if (previous) {
        let total = 0;
        for (let offset = 0; offset < frame.data.length; offset++)
          total += Math.abs(frame.data[offset]! - previous[offset]!);
        curve.push({
          timeSec: round((startFrame + index * step) / info.fps),
          energy: round(total / frame.data.length),
        });
      }
      previous = frame.data;
    });
    if (frames.length < batch) break;
  }
  return curve;
}

function fallbackLayer(
  referenceId: string,
  media: string,
  info: VideoInfo,
  shots: ReferenceShots["shots"],
  reason: string,
  fix: string,
): ReferenceMotion {
  const curve = frameDifferenceCurve(media, info);
  return ReferenceMotionSchema.parse({
    schemaVersion: 1,
    referenceId,
    status: {
      available: true,
      engine: "ffmpeg-frame-difference",
      unavailableReason: `Fell back from optical flow, so camera estimates are unknown. ${reason}`,
      fix,
    },
    method: "ffmpeg-frame-difference",
    energyCurve: curve,
    shots: shots.map((shot) => {
      const inside = curve.filter((row) => row.timeSec > shot.startSec + 0.05 && row.timeSec < shot.endSec);
      const peak = inside.reduce<(typeof inside)[number] | undefined>(
        (best, row) => (!best || row.energy > best.energy ? row : best),
        undefined,
      );
      return {
        shotId: shot.id,
        meanEnergy: inside.length ? round(inside.reduce((sum, row) => sum + row.energy, 0) / inside.length) : 0,
        peakEnergy: peak?.energy ?? 0,
        ...(peak ? { peakSec: peak.timeSec } : {}),
        cameraEstimate: "unknown",
      };
    }),
  });
}

type ShotCameraFit = NonNullable<ReferenceMotion["shots"][number]["camera"]>;
const SUSPECT_RMSE = 0.1;
const SUSPECT_TRACKED_SHARE = 0.5;
const SUSPECT_LENGTH_RATIO = 1.5;

/** Why a camera fit is probably not a camera ease. Empty when it looks sound. Written fits keep their own `suspect` flag. */
export function suspectFitReasons(camera: ShotCameraFit, shot?: { startSec: number; endSec: number }): string[] {
  const reasons = [...(camera.suspectReasons ?? [])];
  if (camera.suspect && !reasons.length) reasons.push("marked suspect");
  const ease = camera.ease;
  if (!ease) return reasons;
  const [x1, y1, x2, y2] = ease.cubicBezier;
  if (
    [x1, y1, x2, y2].some((value) => !Number.isFinite(value)) ||
    x1 < 0 ||
    x1 > 1 ||
    x2 < 0 ||
    x2 > 1 ||
    Math.abs(y1) > 2.5 ||
    Math.abs(y2) > 2.5
  )
    reasons.push("degenerate bezier");
  const rmse = ease.pick === "gsap" ? ease.gsapRmse : ease.pick === "bezier" ? ease.bezierRmse : ease.springRmse;
  if (rmse > SUSPECT_RMSE) reasons.push(`fit error ${rmse} above ${SUSPECT_RMSE}`);
  if (camera.trackedShare !== undefined && camera.trackedShare < SUSPECT_TRACKED_SHARE)
    reasons.push(`only ${camera.trackedShare} of frames tracked: likely element motion`);
  if (
    shot &&
    camera.durationSec !== undefined &&
    camera.durationSec > SUSPECT_LENGTH_RATIO * (shot.endSec - shot.startSec)
  )
    reasons.push(`fitted ${camera.durationSec} s in a ${round(shot.endSec - shot.startSec)} s shot`);
  return [...new Set(reasons)];
}

/** Marks fits that are probably not camera eases, so readers (ref:corpus) can leave them out. */
export function markSuspectFits(
  shots: ReferenceMotion["shots"],
  spans: ReferenceShots["shots"],
): ReferenceMotion["shots"] {
  return shots.map((row) => {
    if (!row.camera) return row;
    const reasons = suspectFitReasons(
      row.camera,
      spans.find((shot) => shot.id === row.shotId),
    );
    return reasons.length ? { ...row, camera: { ...row.camera, suspect: true, suspectReasons: reasons } } : row;
  });
}

/** Also refines screen-text onsets, because it holds the decoded frames. They come back in `textOnSec`, in item order. */
export function analyseMotion(request: {
  referenceId: string;
  media: string;
  info: VideoInfo;
  shots: ReferenceShots["shots"];
  screenText?: ReferenceSpeechText["screenText"]["items"];
}): { layer: ReferenceMotion; textOnSec?: number[] } {
  const transitions = request.shots
    .filter((shot) => shot.transitionStartSec !== undefined)
    .map((shot) => ({ startSec: shot.transitionStartSec, endSec: shot.transitionEndSec }));
  const worker = runWorker<WorkerMotion>("motion", request.media, {
    shots: request.shots.map((shot) => ({ id: shot.id, startSec: shot.startSec, endSec: shot.endSec })),
    transitions,
    text: (request.screenText ?? []).map((item) => ({ startSec: item.startSec, box: item.box })),
  });
  if (worker.ok)
    return {
      layer: ReferenceMotionSchema.parse({
        schemaVersion: 1,
        referenceId: request.referenceId,
        status: { available: true, engine: worker.value.engine },
        method: `${worker.value.engine} every ${worker.value.stride} frames`,
        energyCurve: worker.value.curve,
        shots: markSuspectFits(worker.value.shots, request.shots),
        ...(worker.value.cadence ? { cadence: worker.value.cadence } : {}),
        ...(worker.value.staticOverlayShare !== undefined
          ? { staticOverlayShare: worker.value.staticOverlayShare }
          : {}),
      }),
      textOnSec: worker.value.textOnSec,
    };
  try {
    return {
      layer: fallbackLayer(request.referenceId, request.media, request.info, request.shots, worker.reason, worker.fix),
    };
  } catch (error) {
    return {
      layer: ReferenceMotionSchema.parse({
        schemaVersion: 1,
        referenceId: request.referenceId,
        status: {
          available: false,
          unavailableReason: `${worker.reason}; ${error instanceof Error ? error.message : String(error)}`,
          fix: worker.fix,
        },
        method: "none",
        shots: [],
      }),
    };
  }
}
