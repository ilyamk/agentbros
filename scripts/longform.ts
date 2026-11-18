import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs, runScript, requireProject, CliErrorObject } from "../src/lib/cli";
import { projectChapterPlan, renderChapters, remotionChapterBackend } from "../src/lib/longform/runner";
import { compileShort } from "../src/lib/longform/plans";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { ChapterManifestSchema } from "../src/types/longform";
import { assembleChapters } from "../src/lib/longform/assembly";
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    {
      name: "chapters",
      required: true,
      description: "Versioned chapters/protected-context JSON",
    },
    {
      name: "format",
      choices: ["vertical", "square", "landscape"],
      default: "landscape",
      description: "Output format",
    },
    {
      name: "apply",
      type: "boolean",
      description: "Actually render pending chapters; default is dry-run",
    },
    { name: "short", description: "Explicit approved short selection JSON" },
    { name: "output", description: "Short proposal JSON or assembled MP4 output" },
    {
      name: "assemble",
      type: "boolean",
      description: "Assemble all verified chapters into an exact local MP4; --apply executes",
    },
    {
      name: "captions",
      choices: ["on", "off"],
      default: "on",
      description: "Chapter caption variant; clean cache is independent",
    },
    { name: "font-context", description: "Workspace-contained verified font role manifest for local rendering" },
    {
      name: "audio-master",
      description: "Whole masters are rejected; use a chapter-local mix",
    },
  ]);
  const id = String(args.project);
  requireProject(id);
  try {
    if (args["audio-master"])
      throw new Error(
        "Whole-project audio masters cannot be reused for chapters or shorts; mix the selected timeline separately",
      );
    const manifest = ChapterManifestSchema.parse(JSON.parse(readFileSync(String(args.chapters), "utf8")));
    if (args.short) {
      if (args.assemble || args["font-context"] || args.captions === "off")
        throw new Error(
          "Short proposals cannot assemble or choose render font/caption variants; use video:workflow for concrete shorts",
        );
      if (args.apply)
        throw new Error("Short proposals do not render automatically; review/import their timeline explicitly");
      const ir = new TimelineEditStore(path.resolve("public/projects", id, "pipeline/timeline-edit.json")).read()
        .timeline;
      const result = compileShort(ir, JSON.parse(readFileSync(String(args.short), "utf8")), manifest.protectedSpans);
      const output = String(
        args.output ?? path.join("public/projects", id, "pipeline", result.shortId + ".short.json"),
      );
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, JSON.stringify(result, null, 2) + "\n", {
        flag: "wx",
      });
      return {
        outputs: [output],
        metadata: {
          shortId: result.shortId,
          evidence: result.evidence,
          apiCalls: 0,
        },
      };
    }
    if (args.output && args.assemble !== true) throw new Error("--output requires --short or --assemble");
    const plan = projectChapterPlan(id, manifest, {
      codeDir: path.resolve(import.meta.dirname, ".."),
      format: args.format as "vertical" | "square" | "landscape",
      captions: args.captions === "off" ? "off" : "on",
      fontContext: args["font-context"] ? String(args["font-context"]) : undefined,
    });
    const result = await renderChapters(plan, {
      dryRun: args.apply !== true,
      render: remotionChapterBackend(process.cwd(), { codeDir: path.resolve(import.meta.dirname, "..") }),
    });
    const assembly =
      args.assemble === true && args.apply === true
        ? assembleChapters(plan, result, {
            rootDir: process.cwd(),
            outputFile: args.output ? path.resolve(String(args.output)) : undefined,
          })
        : undefined;
    return {
      outputs: [...result.outputs, ...(assembly?.outputs ?? [])],
      metadata: {
        ...result,
        assemblyRequested: args.assemble === true,
        ...(assembly ? { assembly: assembly.metadata } : {}),
        apiCalls: 0,
        apiSpendUsd: 0,
      },
    };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({
      code: "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
