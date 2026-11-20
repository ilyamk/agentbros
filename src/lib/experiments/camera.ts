import { z } from "zod";
import type { ReadStop } from "../../motion/library/ui/CameraRead";
import { experimentError } from "./project";

const positive = z.number().finite().positive();
const frame = z.number().int().nonnegative();
const rect = z.object({ x: z.number(), y: z.number(), width: positive, height: positive }).strict();
export const CameraRequestSchema = z
  .object({
    capture: z.string().min(1),
    words: z.string().min(1),
    compositionFps: z.number().int().min(1).max(120).default(30),
    captureStartSec: z.number().nonnegative().default(0),
    wordsStartSec: z.number().nonnegative().default(0),
    actions: z
      .array(
        z
          .object({
            event: frame,
            word: frame,
            target: rect.optional(),
            holdSec: z.number().min(0.5).max(15).default(0.8),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const CaptureSchema = z.object({
  fps: positive,
  width: positive,
  height: positive,
  scale: positive,
  frames: frame,
  events: z.array(z.object({ frame, action: z.string(), x: z.number().optional(), y: z.number().optional() })),
});
const WordsSchema = z.object({ words: z.array(z.object({ text: z.string(), start: z.number().nonnegative() })) });
type CameraRequest = z.infer<typeof CameraRequestSchema>;

function stopFor(
  target: z.infer<typeof rect>,
  stage: { width: number; height: number },
  viewportRatio: number,
  timing: Pick<ReadStop, "move" | "hold" | "label">,
): ReadStop {
  const wide = Math.max(stage.width, stage.height * viewportRatio);
  const tall = wide / viewportRatio;
  const zoom = Math.max(1, Math.min(2.25, wide / (target.width * 1.15), tall / (target.height * 1.15)));
  const bound = (centre: number, span: number, limit: number) =>
    span >= limit ? limit / 2 : Math.max(span / 2, Math.min(limit - span / 2, centre));
  return {
    ...timing,
    zoom,
    cx: bound(target.x + target.width / 2, wide / zoom, stage.width) / stage.width,
    cy: bound(target.y + target.height / 2, tall / zoom, stage.height) / stage.height,
  };
}

export function proposeTutorialCamera(rawCapture: unknown, rawWords: unknown, request: CameraRequest) {
  const capture = CaptureSchema.parse(rawCapture);
  const { words } = WordsSchema.parse(rawWords);
  const fps = request.compositionFps;
  const compositionFrame = (captureFrame: number) => Math.round((captureFrame * fps) / capture.fps);
  const durationInFrames = compositionFrame(capture.frames);
  if (!durationInFrames) experimentError("The capture is shorter than one composition frame.");
  const initial = { cx: 0.5, cy: 0.5, zoom: 1, move: 1, hold: 0 };
  const stops: ReadStop[] = [{ ...initial }];
  const portraitStops: ReadStop[] = [{ ...initial }];
  const findings: { event: number; reason: string }[] = [];
  const cursor = capture.events.flatMap(({ frame: at, x, y, action }) =>
    at < capture.frames && x !== undefined && y !== undefined
      ? [
          {
            frame: Math.min(durationInFrames - 1, compositionFrame(at)),
            captureFrame: at,
            x: x * capture.scale,
            y: y * capture.scale,
            action,
          },
        ]
      : [],
  );
  let previousArrival = 0;
  let previouslyMapped = -1;
  for (const mapping of request.actions) {
    const { event: index, word, target } = mapping;
    const event = capture.events[index];
    const spoken = words[word];
    if (!event || !spoken || event.frame >= capture.frames || event.frame <= previouslyMapped)
      experimentError(
        "Camera mappings must reference existing, strictly increasing capture frames and existing spoken words.",
      );
    previouslyMapped = event.frame;
    const spokenFrame = Math.round((spoken.start + request.wordsStartSec - request.captureStartSec) * capture.fps);
    if (Math.abs(event.frame - spokenFrame) > Math.max(1, Math.round(capture.fps * 0.2)))
      findings.push({
        event: index,
        reason: `Timing review: capture frame ${event.frame}, spoken frame ${spokenFrame}.`,
      });
    if (
      !target ||
      target.x < 0 ||
      target.y < 0 ||
      target.x + target.width > capture.width ||
      target.y + target.height > capture.height
    ) {
      findings.push({
        event: index,
        reason: "Frame this action manually using a measured target in capture CSS pixels.",
      });
      continue;
    }
    const arrival = compositionFrame(event.frame);
    const move = Math.max(1, Math.round(fps * 0.25));
    const hold = Math.ceil(mapping.holdSec * fps);
    const gap = arrival - previousArrival - move;
    if (gap < stops.at(-1)!.hold || arrival + hold > durationInFrames) {
      findings.push({
        event: index,
        reason: "Review the cut or extend the capture for the requested move and reading hold.",
      });
      continue;
    }
    stops.at(-1)!.hold = gap;
    portraitStops.at(-1)!.hold = gap;
    const timing = { move, hold, label: spoken.text };
    stops.push(stopFor(target, capture, 16 / 9, timing));
    portraitStops.push(stopFor(target, capture, 9 / 16, timing));
    previousArrival = arrival;
  }
  const remaining = durationInFrames - previousArrival;
  stops.at(-1)!.hold = remaining;
  portraitStops.at(-1)!.hold = remaining;
  return {
    version: 1,
    fps,
    captureFps: capture.fps,
    durationInFrames,
    stage: { width: capture.width * capture.scale, height: capture.height * capture.scale },
    stops,
    portraitStops,
    cursor,
    findings,
  };
}
