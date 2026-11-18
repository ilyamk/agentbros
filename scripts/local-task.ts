import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { runAppleTask } from "../src/lib/apple/tasks";
import { boundedFile, NativeUnavailable, objectHash, fileHash } from "../src/lib/apple/runtime";
import { LocalTaskSchema } from "../src/types/local-capabilities";
import { ScriptSchema, StoryboardSchema } from "../src/types/pipeline";
runScript(async () => {
  const args = parseArgs([
    { name: "task", required: true, choices: LocalTaskSchema.options, description: "Fixed by the command alias" },
    {
      name: "input",
      description:
        "Local input: plain UTF-8 text for analyse, a versioned text-unit request for translation/TTS/assist, or media for events/Vision/image description",
    },
    { name: "output", description: "New result JSON path; generated assets and provenance are written beside it" },
    {
      name: "project",
      description: "Project ID; TTS can read its storyboard/script and defaults to pipeline/local-results/",
    },
    { name: "scene", description: "One TTS scene/beat ID from the project" },
    { name: "language", description: "Source language; inferred from a text-unit request when present" },
    { name: "source-language", description: "Translation source language" },
    { name: "target-language", description: "Translation target language" },
    {
      name: "voice",
      description: "Installed system voice identifier; an explicit unavailable voice is never replaced",
    },
    {
      name: "features",
      description: "Vision features: faces,people,pose,saliency,quality,flow,tracking; bounded to 32 sampled frames",
    },
    { name: "operations", description: "Natural Language operations: language,sentences,tokens,entities,lemmas" },
    {
      name: "assist-task",
      choices: ["summarise", "tags", "chapters", "shot-notes"],
      default: "summarise",
      description: "Structured advisory Foundation Models operation",
    },
    {
      name: "purpose",
      choices: ["draft", "production"],
      default: "draft",
      description: "Draft by default; production requires fresh task/language qualification",
    },
    {
      name: "dry-run",
      type: "boolean",
      description: "Read inputs and report availability; no preparation, downloads or inference",
    },
    {
      name: "force",
      type: "boolean",
      description: "Explicitly replace result files; agent must already have overwrite authority",
    },
  ] as const);
  const task = LocalTaskSchema.parse(args.task),
    work = mkdtempSync(path.join(tmpdir(), "avc-local-task-"));
  try {
    if (args.project) requireProject(args.project);
    let input = args.input,
      language = args["source-language"] ?? args.language;
    if (!input && task === "speech.synthesise" && args.project) {
      const pipeline = path.resolve("public/projects", args.project, "pipeline"),
        storyboard = path.join(pipeline, "storyboard.json");
      let units: { id: string; text: string }[];
      if (existsSync(storyboard)) {
        const value = StoryboardSchema.parse(JSON.parse(boundedFile(storyboard).toString()));
        units = value.scenes.map((s) => ({ id: s.id, text: s.voiceoverText }));
      } else {
        const value = ScriptSchema.parse(JSON.parse(boundedFile(path.join(pipeline, "script.json")).toString()));
        units = value.beats.map((b) => ({ id: b.id, text: b.text }));
        language ??= value.language;
      }
      if (args.scene) {
        units = units.filter((u) => u.id === args.scene);
        if (!units.length) throw new Error("Scene ID not found");
      }
      if (!language) throw new Error("TTS language is required");
      // The input request is retained, so its provenance never points into a deleted temporary directory.
      const retained = path.join(pipeline, "local-inputs", `tts-${objectHash({ language, units }).slice(0, 24)}.json`);
      const text = JSON.stringify({ version: 1, kind: "scenes", sourceLanguage: language, units }) + "\n";
      if (!args["dry-run"]) {
        mkdirSync(path.dirname(retained), { recursive: true });
        if (existsSync(retained) && boundedFile(retained).toString() !== text)
          throw new Error("Local TTS source request changed; use a new request filename via --input");
        if (!existsSync(retained)) writeFileSync(retained, text, { flag: "wx" });
        input = retained;
      } else {
        input = path.join(work, "request.json");
        writeFileSync(input, text);
      }
    }
    if (!input) throw new Error("--input is required (or --project for TTS)");
    const output =
      args.output ??
      (args.project
        ? path.join(
            "public/projects",
            args.project,
            "pipeline/local-results",
            `${task}-${objectHash({ source: fileHash(input), language, targetLanguage: args["target-language"], voice: args.voice, features: args.features, operations: args.operations, assistTask: args["assist-task"], purpose: args.purpose }).slice(0, 24)}.json`,
          )
        : undefined);
    if (!output) throw new Error("--output or --project is required");
    try {
      return await runAppleTask({
        task,
        input,
        output,
        language,
        targetLanguage: args["target-language"],
        voice: args.voice,
        features: args.features?.split(","),
        operations: args.operations?.split(","),
        assistTask: args["assist-task"] as "summarise" | "tags" | "chapters" | "shot-notes",
        purpose: args.purpose as "draft" | "production",
        dryRun: args["dry-run"],
        force: args.force,
      });
    } catch (error) {
      if (error instanceof NativeUnavailable)
        throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: error.message, details: { ...error.issue } });
      throw error;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
