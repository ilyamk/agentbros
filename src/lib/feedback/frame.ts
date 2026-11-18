/**
 * Frame feedback (`pnpm feedback --project P --frame N [--region x,y,w,h] --answer "<words>" [--watched <render>]
 * [--expect <sha256>] [--fps F] [--aspect A] --confirm`, RFC 0004 §8, US11): the user points at one frame of a render
 * they watched, optionally at an area of it, and says what should change there. The words become one feedback item
 * carrying the frame, its time and the region, routed by aspect (a shot by default: build) like any feedback, so the
 * open file reopens the step and the next build or fixer brief shows the frame and region (src/lib/film/brief.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RegionSchema } from "../../types/console";
import { assertPathWithin } from "../cli";
import { probeRender } from "../sensors/render-file";
import type { Aspect } from "../../types/feedback";
import { ChainRefusal, type FilmProject } from "../film/state";
import { planFeedback, type FeedbackPlan } from "./apply";

export type Region = { x: number; y: number; w: number; h: number };

/** `x,y,w,h` in normalised frame coordinates (0–1), inside the frame. */
export function parseRegion(text: string): Region {
  const parts = text.split(",").map((part) => part.trim());
  const numbers = parts.map((part) => (/^\d*\.?\d+(?:e-?\d+)?$/i.test(part) ? Number(part) : Number.NaN));
  if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value)))
    throw new ChainRefusal(`--region is x,y,w,h: four numbers from 0 to 1 (got "${text}").`);
  const [x, y, w, h] = numbers as [number, number, number, number];
  const parsed = RegionSchema.safeParse({ x, y, w, h });
  if (!parsed.success)
    throw new ChainRefusal(
      `--region ${text} is not an area inside the frame: x and y from 0, w and h above 0, x+w and y+h at most 1.`,
    );
  return parsed.data;
}

export interface FrameFeedbackInput {
  frame: number;
  words: string;
  region?: Region;
  /** Root-relative render the user watched (default out/<id>/film.mp4), inside the project or its out/ folder. */
  watched?: string;
  /** SHA-256 of the render the user watched: refused when it changed. */
  expect?: string;
  /** Frames per second the frame number counts in (the viewer's); else the render's, else the film's plan. */
  fps?: number;
  aspect?: Aspect;
  at?: string;
}

/** How the render was timed: the frame rate, where it came from, and its frame count when it could be read. */
export interface FrameTiming {
  fps: number;
  fpsFrom: "flag" | "render" | "plan";
  frameCount?: number;
}

export type RenderProber = (file: string) => { fps: number; frameCount: number } | undefined;

/** ffprobe's frame rate and frame count, or undefined (no ffprobe, not a video). */
export const probeWatched: RenderProber = (file) => {
  try {
    const probe = probeRender(file);
    return Number.isFinite(probe.fps) && probe.fps > 0 && Number.isFinite(probe.frameCount)
      ? { fps: probe.fps, frameCount: probe.frameCount }
      : undefined;
  } catch {
    return undefined;
  }
};

const planFps = (projectDir: string): number | undefined => {
  for (const file of ["pipeline/cue-sheet.json", "pipeline/motion-plan.json"]) {
    try {
      const fps = (JSON.parse(readFileSync(path.join(projectDir, file), "utf8")) as { fps?: unknown }).fps;
      if (typeof fps === "number" && fps > 0 && fps <= 240) return fps;
    } catch {
      // absent or unreadable: try the next
    }
  }
  return undefined;
};

/** The watched render, resolved and confined to the project folder or its out/<id>/ renders. */
export function watchedFile(project: FilmProject, watched: string | undefined): string {
  const relative = watched ?? `out/${project.id}/film.mp4`;
  const file = path.resolve(project.rootDir, relative);
  const roots = [project.projectDir, path.join(project.rootDir, "out", project.id)];
  const inside = roots.some((root) => {
    try {
      assertPathWithin(root, file);
      return true;
    } catch {
      return false;
    }
  });
  if (!inside)
    throw new ChainRefusal(
      `--watched ${relative} is outside the project: a render under public/projects/${project.id}/ or out/${project.id}/.`,
    );
  return file;
}

/** The frame rate and frame count the frame is checked against; refused when no rate is known (never assumed). */
export function frameTiming(
  project: FilmProject,
  file: string,
  fps?: number,
  probe: RenderProber = probeWatched,
): FrameTiming {
  const probed = existsSync(file) ? probe(file) : undefined;
  if (fps !== undefined) {
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new ChainRefusal(`--fps ${fps} is not a frame rate.`);
    // The frame counts in the viewer's rate; the render's count, in that rate, bounds it.
    const frameCount = probed ? Math.round((probed.frameCount / probed.fps) * fps) : undefined;
    return { fps, fpsFrom: "flag", ...(frameCount ? { frameCount } : {}) };
  }
  if (probed) return { fps: probed.fps, fpsFrom: "render", frameCount: probed.frameCount };
  const fromPlan = planFps(project.projectDir);
  if (fromPlan) return { fps: fromPlan, fpsFrom: "plan" };
  throw new ChainRefusal(
    "The render's frame rate is unknown (no ffprobe answer, no fps in the cue sheet or motion plan): pass --fps.",
  );
}

/** Validates and routes one frame comment; writes nothing (writeFeedback does, on --confirm). */
export function planFrameFeedback(
  project: FilmProject,
  input: FrameFeedbackInput,
  probe: RenderProber = probeWatched,
): FeedbackPlan & { timing: FrameTiming } {
  if (!Number.isInteger(input.frame) || input.frame < 0)
    throw new ChainRefusal(`--frame is a frame number from 0 (got ${input.frame}).`);
  if (input.expect !== undefined && !/^[a-f0-9]{64}$/.test(input.expect))
    throw new ChainRefusal("--expect is the lowercase hex SHA-256 of the render the user watched.");
  const file = watchedFile(project, input.watched);
  const timing = frameTiming(project, file, input.fps, probe);
  if (timing.frameCount !== undefined && input.frame >= timing.frameCount)
    throw new ChainRefusal(
      `--frame ${input.frame} is past the render's last frame (${timing.frameCount} frames at ${timing.fps} fps).`,
    );
  const second = Math.round((input.frame / timing.fps) * 1000) / 1000;
  const plan = planFeedback(
    project,
    {
      verdict: "revise",
      watched: {
        path: path.relative(project.rootDir, file),
        ...(input.expect ? { sha256: input.expect } : {}),
      },
      items: [
        {
          quote: input.words,
          aspect: input.aspect ?? "shot",
          severity: "must",
          at: { fromSec: second, toSec: second },
          frame: input.frame,
          ...(input.region ? { region: input.region } : {}),
        },
      ],
    },
    input.at,
  );
  return { ...plan, timing };
}
