import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { runAppleTask } from "../src/lib/apple/tasks";
import { preparePortableVoice, runPortableVoice } from "../src/lib/speech/portable-voice";
import { boundedFile, NativeUnavailable, objectHash, fileHash } from "../src/lib/apple/runtime";
import { LocalTaskSchema } from "../src/types/local-capabilities";
import { ScriptSchema, StoryboardSchema } from "../src/types/pipeline";
import { NarrationDirectionSchema } from "../src/types/narration";
runScript(async () => {
  const args = parseArgs([
    { name: "task", required: true, choices: LocalTaskSchema.options, description: "Fixed by the command alias" },
    {
      name: "engine",
      choices: ["apple", "portable"],
      description: "Voice synthesis engine (default: Apple system voice on macOS, portable on other platforms)",
    },
    { name: "prepare", type: "boolean", description: "Prepare the pinned portable voice runtime and models" },
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
      description: "Installed Apple voice identifier, or supertonic:0 through supertonic:9 for the portable engine",
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
    const pipeline = args.project ? path.resolve("public/projects", args.project, "pipeline") : undefined;
    const directionFile = pipeline && path.join(pipeline, "narrator-direction.json");
    const direction =
      task === "speech.synthesise" && directionFile && existsSync(directionFile)
        ? NarrationDirectionSchema.safeParse(JSON.parse(boundedFile(directionFile).toString())).data
        : undefined;
    const planned = direction?.route === "local" ? direction.localVoice : undefined;
    if (
      (args.engine && planned?.engine && args.engine !== planned.engine) ||
      (args.voice && planned?.voice && args.voice !== planned.voice)
    )
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Voice selection disagrees with pipeline/narrator-direction.json",
      });
    const voice = args.voice ?? planned?.voice;
    const purpose = planned?.purpose ?? (args.purpose as "draft" | "production");
    const engine =
      args.engine ??
      planned?.engine ??
      (voice?.startsWith("supertonic:") || process.platform !== "darwin" ? "portable" : "apple");
    if ((args.engine || args.prepare) && task !== "speech.synthesise")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--engine and --prepare belong to voiceover:local" });
    if (args.prepare) {
      if (engine !== "portable" || args.input || args.project || args.output)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "Use --engine portable --prepare without input, project or output",
        });
      return preparePortableVoice(args["dry-run"] === true);
    }
    let input = args.input,
      language = args["source-language"] ?? args.language;
    if (!input && task === "speech.synthesise" && args.project) {
      const storyboard = path.join(pipeline!, "storyboard.json");
      let units: { id: string; text: string }[];
      if (direction?.route !== "local" && existsSync(storyboard)) {
        const value = StoryboardSchema.parse(JSON.parse(boundedFile(storyboard).toString()));
        units = value.scenes.map((s) => ({ id: s.id, text: s.voiceoverText }));
      } else {
        const value = ScriptSchema.parse(JSON.parse(boundedFile(path.join(pipeline!, "script.json")).toString()));
        units = value.beats.map((b) => ({ id: b.id, text: b.text }));
        language ??= value.language;
      }
      if (args.scene) {
        units = units.filter((u) => u.id === args.scene);
        if (!units.length) throw new Error("Scene ID not found");
      }
      if (!language) throw new Error("TTS language is required");
      // The input request is retained, so its provenance never points into a deleted temporary directory.
      const retained = path.join(pipeline!, "local-inputs", `tts-${objectHash({ language, units }).slice(0, 24)}.json`);
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
            `${task}-${objectHash({ source: fileHash(input), language, targetLanguage: args["target-language"], voice, ...(task === "speech.synthesise" && engine === "portable" ? { engine } : {}), features: args.features, operations: args.operations, assistTask: args["assist-task"], purpose: args.purpose }).slice(0, 24)}.json`,
          )
        : undefined);
    if (!output) throw new Error("--output or --project is required");
    if (task === "speech.synthesise" && engine === "portable")
      return runPortableVoice({
        input,
        output,
        language,
        voice,
        purpose,
        dryRun: args["dry-run"] === true,
        force: args.force === true,
      });
    try {
      return await runAppleTask({
        task,
        input,
        output,
        language,
        targetLanguage: args["target-language"],
        voice,
        features: args.features?.split(","),
        operations: args.operations?.split(","),
        assistTask: args["assist-task"] as "summarise" | "tags" | "chapters" | "shot-notes",
        purpose,
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
