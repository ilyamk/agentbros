import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderStill } from "@remotion/renderer";
import { CliErrorObject, emitProgress, ensureFfmpeg, parseArgs, runScript } from "../src/lib/cli";
import { resolveCaptionStyle } from "../src/lib/captions/profiles";
import { AD_PLATFORMS, resolveUiZone, withUiZone, type Box } from "../src/lib/captions/readability";
import { ensureModel, YUNET } from "../src/lib/multicam/models";
import type { Detections } from "../src/lib/multicam/reframe";
import { runMulticamWorker } from "../src/lib/multicam/worker";
import { planProjectRender } from "../src/lib/render-plan";
import { DEFAULT_ENTRY, GL_CHOICES, withComposition } from "../src/lib/vision/composition";
import {
  choosePosition,
  legibilityRanges,
  legibilityTargets,
  positionRanges,
} from "../src/motion/library/captions/legibility";
import { chooseLevel } from "../src/motion/library/captions/plan";
import type { TimelineIR } from "../src/types/timeline";
import type { VideoFormat } from "../src/types/video";

const SPECS = [
  { name: "project", required: true, description: "Project whose timeline captions use a library preset" },
  {
    name: "format",
    choices: ["vertical", "square", "landscape"],
    default: "vertical",
    description: "Render format to sample",
  },
  {
    name: "profile",
    description: "Measure this preset instead of the timeline's caption style (its command file then sets it)",
  },
  {
    name: "placement",
    choices: ["organic", "ad"],
    description:
      "Interface to keep captions clear of on vertical: organic posts, or paid ads (larger bands; default: what the timeline records, else organic)",
  },
  {
    name: "platform",
    choices: ["all", ...AD_PLATFORMS],
    description: "With --placement ad: one platform's ad bands, or all (default; the intersection of their safe zones)",
  },
  {
    name: "faces",
    choices: ["on", "off"],
    default: "on",
    description: "Detect faces on the clean stills (local YuNet, free) so captions keep clear of them",
  },
  {
    name: "frames",
    description:
      "Measure only pages within this inclusive frame range, e.g. 0-299, for a preview; other pages keep the defaults",
  },
  { name: "output", description: "Command file for timeline:edit (default: pipeline/caption-place.json)" },
  { name: "gl", choices: GL_CHOICES, default: "angle", description: "Chromium GL backend" },
] as const;

type Still = { rgb: Uint8Array; width: number; height: number };

const readRgb = (file: string, width: number, height: number): Still => {
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
    maxBuffer: width * height * 3 + 1024,
  });
  return { rgb: new Uint8Array(rgb), width, height };
};

/** Faces per still in frame pixels: YuNet, and the head (top quarter) of a HOG person where no face was found. */
async function detectFaces(stills: string[], work: string, width: number, height: number): Promise<Box[][]> {
  if (!stills.length) return [];
  const video = path.join(work, "stills.avi");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-framerate",
    "1",
    "-i",
    path.join(work, "page-%04d.jpg"),
    "-c:v",
    "mjpeg",
    "-q:v",
    "2",
    video,
  ]);
  const model = await ensureModel(YUNET, "reframe", ".onnx");
  const detections = runMulticamWorker<Detections>("detect", {
    media: path.resolve(video),
    model,
    sampleFps: 1,
    maxWidth: 640,
    faceScore: 0.6,
    personScore: 0.5,
  });
  rmSync(video, { force: true });
  const byFrame = new Map(detections.samples.map((sample) => [sample.frame, sample]));
  return stills.map((_, index) => {
    const sample = byFrame.get(index);
    if (!sample) return [];
    const toPx = (b: { x: number; y: number; w: number; h: number }, headOnly: boolean): Box => ({
      left: b.x * width,
      right: (b.x + b.w) * width,
      top: b.y * height,
      bottom: (b.y + b.h * (headOnly ? 0.25 : 1)) * height,
    });
    return sample.faces.length
      ? sample.faces.map((face) => toPx(face, false))
      : sample.people.map((person) => toPx(person, true));
  });
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  const project = args.project!;
  const job = planProjectRender(project, args.format as VideoFormat, process.cwd(), { timeline: true, captions: "off" })
    .jobs[0];
  if (!job) throw new CliErrorObject({ code: "VALIDATION", message: `No ${args.format} render job for ${project}` });
  const props = {
    ...job.props,
    ...(args.profile ? { captionStyle: { profile: args.profile } } : {}),
  } as typeof job.props & { timeline?: TimelineIR; captionStyle?: unknown };
  if (!props.timeline)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${project} has no timeline; placement and legibility apply to timeline renders`,
    });
  const fail = (code: "VALIDATION" | "INVALID_INPUT", error: unknown) =>
    new CliErrorObject({ code, message: error instanceof Error ? error.message : String(error) });
  let measured: ReturnType<typeof resolveCaptionStyle>;
  let uiZone: ReturnType<typeof resolveUiZone>;
  try {
    measured = resolveCaptionStyle(props);
  } catch (error) {
    throw fail("VALIDATION", error);
  }
  try {
    uiZone = resolveUiZone(
      args.placement as "organic" | "ad" | undefined,
      args.platform as Parameters<typeof resolveUiZone>[1],
      measured.options?.uiZone,
    );
  } catch (error) {
    throw fail("INVALID_INPUT", error);
  }
  // The zone is recorded with the style, so the render lays pages out in the same box they were measured in.
  props.captionStyle = { ...measured, options: withUiZone(measured.options, uiZone) };
  const pipeline = path.join("public", "projects", project, "pipeline");
  const work = path.join("out", project, "caption-place");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const propsFile = path.join(work, "clean-props.json");
  writeFileSync(propsFile, JSON.stringify(props));

  const sampled = await withComposition(
    { entry: DEFAULT_ENTRY, composition: job.compositionId, publicDir: "public", gl: args.gl!, propsFile },
    async ({ serveUrl, browser, composition, inputProps, chromiumOptions }) => {
      let found: ReturnType<typeof legibilityTargets>;
      try {
        found = legibilityTargets(
          props as { timeline: TimelineIR },
          composition.fps,
          composition.width,
          composition.height,
        );
      } catch (error) {
        throw new CliErrorObject({
          code: "VALIDATION",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const range = args.frames ? /^(\d+)-(\d+)$/.exec(args.frames) : null;
      if (args.frames && !range)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `--frames must be "a-b"; got "${args.frames}"` });
      if (range)
        found.targets = found.targets.filter(
          (target) => target.frame >= Number(range[1]) && target.frame <= Number(range[2]),
        );
      const stills: string[] = [];
      for (const [index, target] of found.targets.entries()) {
        const still = path.join(work, `page-${String(index).padStart(4, "0")}.jpg`);
        emitProgress(`Clean still ${index + 1}/${found.targets.length} at frame ${target.frame}`);
        await renderStill({
          serveUrl,
          composition,
          inputProps,
          frame: Math.min(target.frame, composition.durationInFrames - 1),
          output: path.resolve(still),
          imageFormat: "jpeg",
          jpegQuality: 90,
          overwrite: true,
          puppeteerInstance: browser,
          chromiumOptions,
          logLevel: "error",
        });
        stills.push(still);
      }
      return { ...found, stills, fps: composition.fps, width: composition.width, height: composition.height };
    },
  );

  const faces =
    args.faces === "on"
      ? await detectFaces(sampled.stills, work, sampled.width, sampled.height)
      : sampled.stills.map(() => []);
  let previous: { clip: string; position: "lower" | "middle" | "upper" } | null = null;
  const pages = sampled.targets.map((target, index) => {
    const still = readRgb(sampled.stills[index]!, sampled.width, sampled.height);
    // An explicit position in the caption-style options is the editor's: it is measured, never moved.
    const placed = sampled.explicitPosition
      ? { position: target.p.position, box: target.box, candidates: [], findings: [] }
      : choosePosition(target.p, target.layout, target.local, sampled.fps, sampled.height, {
          faces: faces[index]!,
          still,
          previous: previous?.clip === target.clip ? previous.position : undefined,
        });
    previous = { clip: target.clip, position: placed.position };
    const choice = chooseLevel(target.p, still, placed.box);
    return {
      clip: target.clip,
      pageIndex: target.pageIndex,
      start: target.start,
      end: target.end,
      frame: target.frame,
      text: target.text,
      position: placed.position,
      level: choice.level,
      still: sampled.stills[index]!,
      faces: faces[index]!.map((f) => ({
        left: Math.round(f.left),
        top: Math.round(f.top),
        right: Math.round(f.right),
        bottom: Math.round(f.bottom),
      })),
      candidates: placed.candidates,
      findings: [...placed.findings, ...(choice.finding ? [choice.finding] : [])].map(({ code, message }) => ({
        code,
        message,
      })),
    };
  });

  const fallback = sampled.targets[0]?.p.position ?? "lower";
  const legibility = legibilityRanges(pages);
  const positions = sampled.explicitPosition ? [] : positionRanges(pages, fallback);
  const journalFile = path.join(pipeline, "timeline-edit.json");
  const journal = existsSync(journalFile)
    ? (JSON.parse(readFileSync(journalFile, "utf8")) as {
        revision?: number;
        timeline?: { captionStyle?: Record<string, unknown> };
      })
    : null;
  const style: Record<string, unknown> = (args.profile ? { profile: args.profile } : undefined) ??
    journal?.timeline?.captionStyle ??
    (props.captionStyle as Record<string, unknown> | undefined) ?? { profile: sampled.profile };
  const options = {
    ...withUiZone(style.options as Record<string, unknown> | undefined, uiZone),
    legibility,
    ...(sampled.explicitPosition ? {} : { positions }),
  };
  const command = { type: "caption-style", style: { ...style, options } };
  const output = args.output ?? path.join(pipeline, "caption-place.json");
  writeFileSync(output, `${JSON.stringify(command, null, 2)}\n`);
  const report = path.join(work, "report.json");
  writeFileSync(
    report,
    `${JSON.stringify({ profile: sampled.profile, uiZone, explicitPosition: sampled.explicitPosition, positions, legibility, pages, sizeFindings: sampled.sizeFindings }, null, 2)}\n`,
  );
  const count = <K extends string>(values: K[]) =>
    values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {});
  const flagged = pages.flatMap((page) =>
    page.findings.map((finding) => ({ pageIndex: page.pageIndex, clip: page.clip, text: page.text, ...finding })),
  );
  const revision = journal?.revision ?? "<revision>";
  return {
    outputs: [output, report],
    metadata: {
      profile: sampled.profile,
      uiZone,
      pages: pages.length,
      positions: count(pages.map((page) => page.position)),
      levels: count(pages.map((page) => String(page.level))),
      explicitPosition: sampled.explicitPosition,
      findings: flagged,
      sizeFindings: sampled.sizeFindings,
      next: [
        `pnpm timeline:edit --project ${project} --revision ${revision} --command-file ${output} --dry-run`,
        `pnpm timeline:edit --project ${project} --revision ${revision} --command-file ${output}`,
      ],
    },
  };
});
