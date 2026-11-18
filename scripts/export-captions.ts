import path from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs, runScript, requireProject, CliErrorObject } from "../src/lib/cli";
import { TimelineEditStore, adaptLegacyProject } from "../src/lib/timeline-ir";
import { importLegacyCaptions } from "../src/lib/timeline-ir/caption-import";
import { captionCues, subtitleText } from "../src/lib/captions/delivery";
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    {
      name: "timeline",
      type: "boolean",
      description: "Use edited timeline snapshot",
    },
    { name: "track", description: "One explicit caption-owning track" },
    { name: "output", required: true, description: "Subtitle path" },
    {
      name: "format",
      choices: ["srt", "vtt"],
      default: "srt",
      description: "Subtitle format",
    },
    { name: "profile", description: "Caption delivery profile JSON" },
    {
      name: "dry-run",
      type: "boolean",
      description: "Return mapped cues without writes",
    },
    { name: "force", type: "boolean", description: "Replace existing export" },
  ] as const);
  requireProject(args.project!);
  const directory = path.resolve("public/projects", args.project!);
  const ir = args.timeline
    ? new TimelineEditStore(path.join(directory, "pipeline/timeline-edit.json")).read().timeline
    : importLegacyCaptions(
        adaptLegacyProject(JSON.parse(readFileSync(path.join(directory, "project.json"), "utf8")), args.project!),
        directory,
      );
  const cues = captionCues(ir, {
    trackId: args.track,
    profile: args.profile ? JSON.parse(readFileSync(args.profile, "utf8")) : undefined,
  });
  if (!cues.length)
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: "No aligned caption words available.",
    });
  if (args["dry-run"]) return { outputs: [], metadata: { dryRun: true, cues } };
  if (existsSync(args.output!) && !args.force)
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Subtitle output exists; use --force.",
    });
  mkdirSync(path.dirname(path.resolve(args.output!)), { recursive: true });
  writeFileSync(args.output!, subtitleText(cues, args.format === "vtt" ? "vtt" : "srt"));
  return {
    outputs: [args.output!],
    metadata: {
      cueCount: cues.length,
      format: args.format,
      source: args.timeline ? "edited-snapshot" : "canonical-alignment",
    },
  };
});
