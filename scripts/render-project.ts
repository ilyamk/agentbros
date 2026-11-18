/** Render canonical project.json through the generic project compositions. */
import { prepareRenderFontContext } from "../src/lib/font-resources/render-context";
import { generationInputHash } from "../src/lib/jobs/runner";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { publishRenderReceipt } from "../src/lib/delivery/render-receipt";
import { parseFrameRange, rangeOutputFile, renderWithWatchdog, type FrameRange } from "../src/lib/render-run";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runScript, parseArgs, emitProgress, CliErrorObject } from "../src/lib/cli";
import { planProjectRender, type RenderJob } from "../src/lib/render-plan";
import type { VideoFormat } from "../src/types/video";
import { ensureAssetsForCli, needsForProject } from "../src/lib/shared-assets/cli";

const SPECS = [
  {
    name: "font-context",
    description: "Verified cached font context JSON; exact faces and displayed glyphs, no arbitrary JavaScript",
  },
  {
    name: "captions",
    choices: ["on", "off"],
    description: "Burn-in captions on (default) or a separate clean deliverable",
  },
  {
    name: "audio-master",
    description: "Measured audio master sidecar JSON; explicitly replaces every original audio layer",
  },
  {
    name: "project",
    required: true,
    description: "Project ID under public/projects",
  },
  {
    name: "format",
    choices: ["vertical", "square", "landscape"],
    description: "One output format (default: project formats)",
  },
  {
    name: "timeline",
    type: "boolean",
    description: "Render the explicitly edited timeline journal",
  },
  {
    name: "frames",
    description:
      "Inclusive output frames start-end for an excerpt, e.g. 300-449; written as {format}-frames-START-END.mp4 with a partial receipt that delivery never accepts",
  },
  {
    name: "stall-minutes",
    type: "number",
    default: 5,
    description:
      "Kill and retry the render once when its frame count stops advancing this long; a second stall fails with RENDER_STALLED",
  },
  {
    name: "dry-run",
    type: "boolean",
    description: "Validate assets and return render plan without launching Chromium",
  },
] as const;

async function executeRender(
  job: RenderJob,
  stallMinutes: number,
  fonts?: ReturnType<typeof prepareRenderFontContext>,
): Promise<number> {
  // Both child streams are diagnostics. Only runScript writes parent stdout.
  const { attempts } = await renderWithWatchdog({
    command: job.command,
    args: job.args,
    env: {
      ...process.env,
      VIDEO_FONT_CONTEXT: fonts?.contextFile ?? "",
      VIDEO_FONT_PROJECT: fonts ? job.props.projectId : "",
    },
    stallMs: stallMinutes * 60_000,
    label: job.format,
    notify: emitProgress,
  });
  return attempts;
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  const planned = planProjectRender(args.project!, args.format as VideoFormat | undefined, process.cwd(), {
    timeline: args.timeline === true,
    audioMaster: args["audio-master"],
    captions: args.captions === "off" ? "off" : "on",
  });
  const stallMinutes = Number(args["stall-minutes"]);
  if (!(stallMinutes > 0))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--stall-minutes must be a positive number" });
  const ranges = new Map<RenderJob, FrameRange>();
  const plan = {
    ...planned,
    jobs: planned.jobs.map((job) => {
      if (!args.frames) return job;
      let range: FrameRange;
      try {
        range = parseFrameRange(args.frames, job.durationInFrames);
      } catch (error) {
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const outputFile = rangeOutputFile(job.outputFile, range);
      const excerpt = {
        ...job,
        outputFile,
        args: [
          ...job.args.map((arg) => (arg === job.outputFile ? outputFile : arg)),
          `--frames=${range.start}-${range.end}`,
        ],
      };
      ranges.set(excerpt, range);
      return excerpt;
    }),
  };
  const fontContexts = args["font-context"]
    ? plan.jobs.map((job) => prepareRenderFontContext(args.project!, args["font-context"]!, job.props))
    : [];
  const receipts: string[] = [];
  if (!args["dry-run"]) await ensureAssetsForCli(needsForProject(args.project!));
  if (!args["dry-run"]) {
    for (const [index, job] of plan.jobs.entries()) {
      const fonts = fontContexts[index];
      mkdirSync(path.dirname(job.outputFile), { recursive: true });
      emitProgress(`Rendering ${plan.name}: ${job.format} → ${job.outputFile}`);
      const identityOptions = {
        fontContext: fonts?.contextFile,
        fontCaptureFiles: fonts?.captureFiles,
        timeline: args.timeline === true,
        audioMaster: args["audio-master"],
        captions: args.captions === "off" ? ("off" as const) : ("on" as const),
      };
      const before = captureRenderIdentity(args.project!, job.format, identityOptions);
      if (before.propsHash !== generationInputHash(JSON.parse(JSON.stringify(job.props))))
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Render plan changed before capture; retry from the current project revision",
        });
      const attempts = await executeRender(job, stallMinutes, fonts);
      if (attempts > 1) emitProgress(`${job.format} rendered on attempt ${attempts} after a stall`);
      const after = captureRenderIdentity(args.project!, job.format, identityOptions);
      const range = ranges.get(job);
      receipts.push(
        publishRenderReceipt(
          job.outputFile,
          before,
          after,
          undefined,
          range && { startFrame: range.start, endFrame: range.end, totalFrames: job.durationInFrames },
        ),
      );
    }
  }
  return {
    outputs: args["dry-run"] ? [] : plan.jobs.map((job) => job.outputFile),
    metadata: { dryRun: args["dry-run"], receipts, fontContexts, ...(args.frames ? { partial: true } : {}), ...plan },
  };
});
