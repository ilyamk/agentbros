import { parseArgs, runScript } from "../src/lib/cli";
import { inspectCapabilities, LOCAL_CAPABILITIES } from "../src/lib/local-capabilities";
import { LocalTaskSchema } from "../src/types/local-capabilities";
runScript(async () => {
  const args = parseArgs([
    {
      name: "task",
      choices: LocalTaskSchema.options,
      description: "One local task; unready capabilities are hidden unless explicitly requested or --all",
    },
    { name: "language", description: "Input language or BCP-47 locale" },
    { name: "source-language", description: "Translation source language" },
    { name: "target-language", description: "Translation target language" },
    {
      name: "assist-task",
      choices: ["summarise", "tags", "chapters", "shot-notes"],
      description: "Exact assistance operation to inspect",
    },
    { name: "voice", description: "Required installed voice identifier" },
    { name: "purpose", choices: ["draft", "production"], default: "draft", description: "Required task qualification" },
    { name: "all", type: "boolean", description: "Include unsupported and unprepared capabilities with reasons" },
    {
      name: "refresh",
      type: "boolean",
      description: "Refresh the passive local status cache; no model downloads or generation",
    },
  ] as const);
  const tasks = args.task ? [LocalTaskSchema.parse(args.task)] : LOCAL_CAPABILITIES.map((c) => c.task);
  const states = await inspectCapabilities(
    tasks.map((task) => ({
      task,
      language: args["source-language"] ?? args.language,
      targetLanguage: args["target-language"],
      assistTask: args["assist-task"] as "summarise" | "tags" | "chapters" | "shot-notes" | undefined,
      voice: args.voice,
      purpose: args.purpose as "draft" | "production",
    })),
    { refresh: args.refresh, persist: args.refresh },
  );
  const capabilities = args.all || args.task ? states : states.filter((c) => c.state === "ready");
  const preparation = states.find((c) => c.prepare)?.prepare;
  return { metadata: { capabilities, ...(!args.all && preparation ? { preparation } : {}), passive: true } };
});
