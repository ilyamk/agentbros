import { existsSync } from "node:fs";
import path from "node:path";
import { boundedFile } from "../apple/runtime";
import { inspectCapabilities, LOCAL_CAPABILITIES, readLocalPolicy, type CapabilityOptions } from "./index";
import type { LocalTask, LocalTaskRequest } from "../../types/local-capabilities";

/** Optional affordances, never a prescribed route or a replacement for stage gates. */
export const STAGE_LOCAL_TASKS: Readonly<Record<string, readonly LocalTask[]>> = {
  intake: ["text.analyse", "text.assist"],
  brief: ["text.analyse", "text.assist"],
  transcript: ["speech.transcribe"],
  "speech-mask": ["speech.transcribe"],
  research: ["text.analyse", "text.assist"],
  strategy: ["text.analyse", "text.assist"],
  ideas: ["text.analyse", "text.assist"],
  script: ["text.analyse", "text.assist"],
  "script-variants": ["text.analyse", "text.assist"],
  voiceover: ["speech.synthesise"],
  narration: ["speech.synthesise"],
  "audio-prep": ["speech.synthesise", "audio.events"],
  reframe: ["vision.faces", "vision.saliency"],
  vertical: ["vision.faces", "vision.saliency"],
  photo: ["vision.saliency"],
  reference: ["vision.ocr", "vision.classify", "image.describe"],
  ingest: ["vision.ocr", "vision.classify", "audio.events"],
  selects: ["vision.classify", "audio.events"],
  localisation: ["text.translate"],
  localization: ["text.translate"],
  localise: ["text.translate"],
  translate: ["text.translate"],
  "audio-events": ["audio.events"],
  "image-description": ["image.describe"],
};
export function localStage(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (typeof value === "string") {
    const name = value
      .trim()
      .toLowerCase()
      .replace(/^run /u, "")
      .replace(/ stage$/u, "")
      .replace(/^\d+-/u, "");
    return Object.hasOwn(STAGE_LOCAL_TASKS, name) ? name : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["step", "stage", "currentStage", "next", "summary", "title", "nextAction"]) {
    const result = localStage(record[key], depth + 1);
    if (result) return result;
  }
  return undefined;
}
export async function localSuggestions(
  projectId: string,
  step: unknown,
  root = process.cwd(),
  options: CapabilityOptions = {},
) {
  const stage = localStage(step);
  if (!stage) return {};
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const state = record(record(step).state);
  const project = path.join(root, "public/projects", typeof state.project === "string" ? state.project : projectId);
  const read = (name: string): Record<string, unknown> => {
    try {
      const file = path.join(project, name);
      return existsSync(file) ? record(JSON.parse(boundedFile(file).toString())) : {};
    } catch {
      return {};
    }
  };
  const goals = { ...read("pipeline/footage-goals.json"), ...record(state.goals) },
    brief = read("pipeline/brief.json"),
    config = read("project.json");
  const language = [goals.language, brief.language, config.language].find((v) => typeof v === "string") as
    string | undefined;
  const targetLanguage = [goals.targetLanguage, brief.targetLanguage, config.targetLanguage].find(
    (v) => typeof v === "string",
  ) as string | undefined;
  const tasks = STAGE_LOCAL_TASKS[stage]!.filter(
    (task) => task !== "speech.transcribe" || goals.transcriber !== "scribe",
  );
  const needsLanguage = tasks.some(
    (task) => task.startsWith("text.") || task.startsWith("speech.") || task === "image.describe",
  );
  const requirements = [
    ...(needsLanguage && !language ? ["language"] : []),
    ...(tasks.includes("text.translate") && !targetLanguage ? ["targetLanguage"] : []),
  ];
  const requests: LocalTaskRequest[] = tasks
    .filter(
      (task) => !(task.startsWith("text.") || task.startsWith("speech.") || task === "image.describe") || !!language,
    )
    .filter((task) => task !== "text.translate" || !!targetLanguage)
    .map((task) => ({
      task,
      language,
      ...(task === "text.translate" ? { targetLanguage } : {}),
      purpose: task === "speech.transcribe" ? "production" : "draft",
    }));
  const states = await inspectCapabilities(requests, options),
    policy = readLocalPolicy(options.root);
  const ready = states
    .filter((s) => s.state === "ready")
    .map((s) => ({
      task: s.task,
      argv: s.command!,
      purpose: requests.find((r) => r.task === s.task)?.purpose ?? "draft",
      quality: s.quality,
      guide: "docs/local-macos.md",
      ...(["text.analyse", "text.assist", "image.describe", "audio.events"].includes(s.task) &&
      ["intake", "script-variants", "material", "sound"].includes(stage)
        ? {
            consumer:
              "Optional film:brief --local-evidence <project-owned result.json>; retain receipt and original inputs. Independent critics refuse this input.",
          }
        : {}),
      input:
        s.task === "speech.transcribe"
          ? "Source media; choose new --output and --vad-output paths."
          : s.task === "text.analyse"
            ? "UTF-8 text file via --input; a new --output JSON path."
            : "Prepare task-specific --input and a new --output; inspect the command --help for its schema.",
    }));
  const preparations = states
    .filter((s) => s.prepare || s.userAction)
    .map((s) => ({
      task: s.task,
      ...(s.prepare ? { argv: s.prepare } : { userAction: s.userAction }),
      reason: s.reason,
      interaction:
        policy.mode === "autonomous" && s.userAction
          ? "Use an installed alternative or report a blocker; do not wait for stdin."
          : "Follow the configured download policy; user-only settings require the user.",
    }));
  const alternatives = states
    .filter((s) => s.state !== "ready")
    .map((s) => ({
      task: s.task,
      reason: s.reason,
      alternative: LOCAL_CAPABILITIES.find((d) => d.task === s.task)!.alternative,
    }));
  if (!ready.length && !preparations.length && !requirements.length && !alternatives.length) return {};
  return {
    localTools: {
      ready,
      ...(preparations.length ? { preparation: preparations[0], preparations } : {}),
      ...(requirements.length ? { requirements } : {}),
      ...(alternatives.length ? { alternatives } : {}),
    },
  };
}
export type LocalToolHints = Awaited<ReturnType<typeof localSuggestions>>;
export function localToolPrompt(hints: LocalToolHints): string {
  return "localTools" in hints
    ? `\n\n## Optional local tools for this task\n\nThese are alternatives, not mandatory steps. Availability can change: recheck before execution. Prepare inputs, inspect results and retain source IDs; draft outputs do not grant production approval.\n\n${JSON.stringify(hints.localTools)}\n`
    : "";
}
