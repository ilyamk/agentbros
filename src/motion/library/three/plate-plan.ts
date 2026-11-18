/**
 * Pure numbers of a Blender plate inside a library block: which rendered file shows on a block frame. No JSX, so node
 * tests import it. Blocks with a Blender route (`shaded-orb`, `printing-slip`, `depth-card-flythrough` fan,
 * `studio-product-stage` array, and `blender-plate` itself) take an optional `plate`; without it they draw in the browser.
 * The plates are rendered by the shots in scripts/blender/ (scripts/blender/AGENTS.md) and fetched by
 * `pnpm assets:sync --id plates:<name>` into public/shared/3d/plates/<name>.mp4 (staticFile name
 * `shared/3d/plates/<name>.mp4`). Defaults never name a plate, so previews need no render.
 */
import { z } from "zod";

export const plateSchema = z.object({
  /**
   * The render: a video (.mp4/.mov/.webm) or a frame pattern such as "projects/ID/blender/slip/frame-######.png"
   * (each `#` run is the zero-padded file number; PNG keeps alpha).
   */
  src: z.string().min(1),
  /** File number of the block's first frame for a pattern; default 1 (blender-run numbers from 1). Ignored for a video. */
  firstFrame: z.number().int().min(0).optional(),
  /** Frames in the plate; the last one holds after it. */
  frameCount: z.number().int().positive(),
  /** Block frame on which the plate's first frame shows (default 0); earlier frames show the first frame. */
  at: z.number().int().min(0).optional(),
  /** Default "cover". */
  fit: z.enum(["cover", "contain"]).optional(),
});

export type Plate = z.infer<typeof plateSchema>;

/** Map a timeline cue to a source-frame clock before applying the plate's end hold. */
export function renderPlateFrame(frame: number, sourceFps: number, timelineFps: number, at = 0) {
  return Math.floor((Math.max(0, frame - at) * sourceFps) / timelineFps);
}

export const isVideoPlate = (src: string) => /\.(mp4|mov|webm|m4v)$/i.test(src);

/** Index into the plate (0-based) at a block frame: before `at` the first frame, after the last frame a hold. */
export const plateIndex = (frame: number, plate: Pick<Plate, "frameCount" | "at">): number =>
  Math.max(0, Math.min(plate.frameCount - 1, Math.floor(frame) - (plate.at ?? 0)));

/** File of a frame pattern for a file number: each run of `#` is replaced, zero-padded to its length. */
export const plateFrameSrc = (pattern: string, fileNumber: number) =>
  pattern.replace(/#+/, (run) => String(fileNumber).padStart(run.length, "0"));

/** What to show at a block frame: a pattern file, or a video frame to freeze on. */
export const plateSource = (
  frame: number,
  plate: Plate,
): { kind: "image"; src: string } | { kind: "video"; src: string; frame: number } => {
  const index = plateIndex(frame, plate);
  return isVideoPlate(plate.src)
    ? { kind: "video", src: plate.src, frame: index }
    : { kind: "image", src: plateFrameSrc(plate.src, (plate.firstFrame ?? 1) + index) };
};
