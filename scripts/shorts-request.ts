/**
 * Shorts step 3: the shorts-series request for a project (uncut or a recut) from approved selections, with the source
 * pin from the workflow's own inspection, so no agent writes TypeScript. With --chapters auto it first writes
 * pipeline/chapters.json: one whole-timeline chapter plus recording-edit protected spans mapped to output frames.
 */
import { requireUserWords } from "../src/lib/cli/user-words";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, relativisePath, requireFile, runScript } from "../src/lib/cli";
import { projectDir, readJson, validation } from "../src/lib/shorts/cli";
import {
  approvedSelections,
  buildSeriesRequest,
  chaptersFromRecordingEdit,
  sameManifest,
} from "../src/lib/shorts/request";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";

void runScript(async () => {
  const args = parseArgs([
    {
      name: "project",
      required: true,
      description: "Source project whose timeline the selections were ranked against (uncut or recut)",
    },
    {
      name: "selections",
      description:
        "proposals.json from shorts:rank --project (with --approved-by and --ids), or { version: 1, selections: [approved ShortSelection] }; without it only the chapters are written",
    },
    {
      name: "ids",
      description: "Comma-separated proposal ids the user approved (at least 2): the user's own decision",
    },
    {
      name: "approved-by",
      description:
        "Records the user's own approval: typed by the user, or relayed verbatim from what the user said; never inferred or chosen by an agent",
    },
    { name: "approved-at", description: "ISO time of the user's approval (default: now)" },
    { name: "series-id", description: "Series id (default: <project>-shorts)" },
    { name: "formats", default: "vertical", description: "vertical, square or vertical,square" },
    {
      name: "chapters",
      default: "auto",
      choices: ["auto", "keep"] as const,
      description:
        "auto writes pipeline/chapters.json from the timeline and recording-edit.json; keep uses the existing file",
    },
    {
      name: "force",
      type: "boolean",
      default: false,
      description: "Replace a different existing pipeline/chapters.json",
    },
    { name: "output", description: "Request JSON (default: the project's pipeline/shorts-series-request.json)" },
  ] as const);
  const projectId = args.project!;
  const ids = args.ids
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (Boolean(ids) !== Boolean(args["approved-by"]))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --ids and --approved-by together" });
  if (args["approved-by"] !== undefined) requireUserWords(args["approved-by"], "--approved-by");
  const dir = projectDir(projectId);
  const chapterFile = "pipeline/chapters.json";
  const chaptersPath = path.join(dir, chapterFile);
  let chapters: Record<string, unknown> = { chapters: "kept" };
  if (args.chapters === "auto") {
    const journal = path.join(dir, "pipeline/timeline-edit.json");
    requireFile(journal);
    const ir = validation(() => new TimelineEditStore(journal).read().timeline);
    const editFile = path.join(dir, "pipeline/recording-edit.json");
    const { manifest, dropped } = validation(() =>
      chaptersFromRecordingEdit(ir, existsSync(editFile) ? JSON.parse(readFileSync(editFile, "utf8")) : null, dir),
    );
    if (existsSync(chaptersPath) && !sameManifest(chaptersPath, manifest) && !args.force)
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: `${relativisePath(chaptersPath)} differs from the generated chapters; pass --force to replace it or --chapters keep to use it`,
      });
    mkdirSync(path.dirname(chaptersPath), { recursive: true });
    writeFileSync(chaptersPath, `${JSON.stringify(manifest, null, 2)}\n`);
    chapters = {
      chapters: "written",
      protectedSpans: manifest.protectedSpans.length,
      protectedSpansCutAway: dropped,
      recordingEdit: existsSync(editFile),
    };
  } else requireFile(chaptersPath);
  if (!args.selections) {
    if (args.chapters !== "auto" || ids)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Without --selections only --chapters auto runs (it writes the chapters); approval needs --selections",
      });
    return {
      outputs: [relativisePath(chaptersPath)],
      metadata: {
        ...chapters,
        request: null,
        approval:
          "The user approves clips by running shorts:request on the CLI with --selections, --ids and --approved-by; an agent never records it",
      },
    };
  }
  const selectionsJson = readJson(args.selections);
  const approvedAt = args["approved-at"] ?? new Date().toISOString();
  const selections = validation(() =>
    approvedSelections(
      selectionsJson.value,
      projectId,
      ids ? { ids, approvedBy: args["approved-by"]!, approvedAt } : undefined,
    ),
  );
  const formats = args.formats!.split(",").map((s) => s.trim());
  if (!formats.every((f) => f === "vertical" || f === "square"))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--formats takes vertical and/or square" });
  const { request, plan } = validation(() =>
    buildSeriesRequest(selections, {
      rootDir: process.cwd(),
      projectId,
      seriesId: args["series-id"] ?? `${projectId}-shorts`,
      formats: formats as ("vertical" | "square")[],
      chapterFile,
    }),
  );
  const output = path.resolve(args.output ?? path.join(dir, "pipeline/shorts-series-request.json"));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(request, null, 2)}\n`);
  return {
    outputs: [relativisePath(output), ...(args.chapters === "auto" ? [relativisePath(chaptersPath)] : [])],
    metadata: {
      seriesId: request.seriesId,
      episodes: request.episodes.map((e) => e.selection.id),
      ...chapters,
      plan,
      next: `pnpm video:workflow --scenario shorts-series --action create --request ${relativisePath(output)}`,
    },
  };
});
