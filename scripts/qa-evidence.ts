import { attachVideoReview } from "../src/lib/vision/review-adapters";
import { parseArgs, runScript, CliErrorObject, ensureFfmpeg, ensureFfprobe } from "../src/lib/cli";
import { planProjectRender } from "../src/lib/render-plan";
import { ReviewService } from "../src/lib/review-ui/service";
import { planEvidenceEvents } from "../src/lib/qa-evidence/events";
import { extractEvidenceFrames, artifactHash } from "../src/lib/qa-evidence/frames";
import { renderBrowserEvidence } from "../src/lib/qa-evidence/browser";
import { recordRepairEvidence } from "../src/lib/qa-evidence/repair";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Selected project" },
    { name: "format", default: "vertical", description: "Format" },
    { name: "input", description: "Rendered video to measure" },
    { name: "audio-master", description: "Use the exact master sidecar passed to render" },
    { name: "font-context", description: "Use the exact validated local font context passed to render" },
    {
      name: "browser",
      type: "boolean",
      description: "Measure actual production DOM",
    },
    {
      name: "offline-fonts",
      type: "boolean",
      description: "Smoke-only local font substitute",
    },
    { name: "timeline", type: "boolean", description: "Use edit timeline" },
    { name: "captions", default: "on", description: "on/off" },
    { name: "dry-run", type: "boolean", description: "Plan only" },
    { name: "max", type: "number", default: 40, description: "Event cap" },
    {
      name: "intentional-dark-frames",
      description: "Comma-separated explicit darkness frame numbers",
    },
    { name: "repair-file", description: "JSON repair evidence request" },
  ]);
  try {
    const id = String(args.project),
      guard = new ReviewService(id);
    if (args["repair-file"]) {
      const request = JSON.parse(readFileSync(String(args["repair-file"]), "utf8"));
      const directory = guard.safe(path.join(guard.project, "pipeline/qa-evidence"));
      return {
        outputs: [path.join(directory, "repair-evidence.json")],
        metadata: recordRepairEvidence(directory, request),
      };
    }
    if (!["vertical", "square", "landscape"].includes(String(args.format))) throw new Error("Invalid format");
    if (!["on", "off"].includes(String(args.captions))) throw new Error("Invalid captions");
    if (args["font-context"] && args["offline-fonts"])
      throw new Error("Choose font context or offline substitute, not both");
    if (!Number.isInteger(args.max) || Number(args.max) < 2 || Number(args.max) > 300)
      throw new Error("Event cap must be 2..300");
    const job = planProjectRender(id, args.format as "vertical", process.cwd(), {
        timeline: !!args.timeline,
        captions: args.captions as "on" | "off",
        audioMaster: args["audio-master"] as string | undefined,
      }).jobs[0],
      plan = planEvidenceEvents(job.props);
    const events = plan.events.slice(0, Number(args.max));
    if (events.at(-1)?.frame !== plan.durationInFrames - 1 && events.length > 1)
      events[events.length - 1] = plan.events.at(-1)!;
    if (args["dry-run"])
      return {
        outputs: [],
        metadata: {
          ...plan,
          selectedEvents: events,
          omittedEvents: plan.events.length - events.length,
          productionApproval: false,
        },
      };
    ensureFfmpeg();
    ensureFfprobe();
    const identityOptions = {
      timeline: !!args.timeline,
      captions: args.captions as "on" | "off",
      audioMaster: args["audio-master"] as string | undefined,
      fontContext: args["font-context"] as string | undefined,
    };
    const renderIdentity = captureRenderIdentity(
      id,
      args.format as "vertical" | "square" | "landscape",
      identityOptions,
    );
    const input = path.resolve(String(args.input ?? job.outputFile));
    if (!existsSync(input)) throw new Error("Render the video or provide --input before evidence extraction");
    const directory = guard.safe(path.join(guard.project, "pipeline/qa-evidence", `${args.format}-${randomUUID()}`));
    mkdirSync(directory, { recursive: true });
    const darkness = String(args["intentional-dark-frames"] ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    if (darkness.some((f) => !Number.isInteger(f) || f < 0 || f >= plan.durationInFrames))
      throw new Error("Intentional dark frames must be explicit valid frame integers");
    const extraction = extractEvidenceFrames(input, directory, events, plan.durationInFrames, 30, darkness);
    let browser;
    if (args.browser) {
      const originalWrite = process.stdout.write;
      process.stdout.write = process.stderr.write.bind(process.stderr);
      try {
        browser = await renderBrowserEvidence(job.props, events, path.join(directory, "browser"), {
          offlineFonts: !!args["offline-fonts"],
          fontContext: args["font-context"] as string | undefined,
        });
      } finally {
        process.stdout.write = originalWrite;
      }
    }
    const review = attachVideoReview(
      input,
      directory,
      events.map((event) => ({ ...event, basis: "declared" })),
      {
        profile: "typography",
        measurements: [
          ...extraction.frames.map((f) => ({
            frame: f.frame,
            name: "mean luma (0-255)",
            value: f.meanLuma,
            sourceSha256: extraction.inputSha256,
            basis: "measured" as const,
            evidence: `extracted MP4 F${f.frame}; owning evidence.json`,
          })),
          ...(browser?.frames.flatMap((f) =>
            f.measurement
              ? [
                  {
                    frame: f.frame,
                    name: "production DOM diagnostics",
                    value: Array.isArray(f.measurement.findings)
                      ? `${f.measurement.findings.length} diagnostic findings; full measurements in owning evidence.json`
                      : "Diagnostic capture present; finding count unavailable; see owning evidence.json",
                    sourceSha256: extraction.inputSha256,
                    basis: "measured" as const,
                    evidence: `browser F${f.frame}; diagnostic composition, confirm against MP4`,
                  },
                ]
              : [],
          ) ?? []),
        ],
      },
      "qa-evidence",
    );
    const report = {
      reviewPack: review.reviewPack,
      reviewWarnings: review.reviewWarnings,
      version: 1,
      sourceHash: artifactHash(input),
      propsHash: createHash("sha256").update(JSON.stringify(job.props)).digest("hex"),
      projectId: id,
      format: args.format,
      createdAt: new Date().toISOString(),
      plan,
      selectedEvents: events,
      omittedEvents: plan.events.length - events.length,
      extraction,
      browser,
      status: "requires-manual-review",
      productionApproval: false,
      renderIdentity,
    };
    if (
      captureRenderIdentity(id, args.format as "vertical" | "square" | "landscape", identityOptions)
        .sourceSnapshotHash !== renderIdentity.sourceSnapshotHash
    )
      throw new Error("Render sources changed during evidence capture; retry on the current snapshot");
    const file = path.join(directory, "evidence.json");
    writeFileSync(file, JSON.stringify(report, null, 2));
    return {
      outputs: [
        file,
        ...review.outputs,
        path.join(directory, "contact-sheet.html"),
        ...extraction.frames.map((f) => f.file),
        ...(browser?.frames.map((f) => f.file) ?? []),
      ],
      metadata: report,
    };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({
      code: "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
