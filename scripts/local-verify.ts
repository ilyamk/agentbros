import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { verifyLocal } from "../src/lib/apple/verify";
import { LocalTaskSchema } from "../src/types/local-capabilities";
runScript(async () => {
  const args = parseArgs([
    {
      name: "task",
      required: true,
      choices: LocalTaskSchema.options.filter(
        (task) => !["vision.ocr", "vision.similarity", "vision.classify", "vision.matte"].includes(task),
      ),
      description: "New Apple-domain task to exercise on this host; legacy backends retain their existing verification",
    },
    { name: "language", description: "Source language" },
    { name: "target-language", description: "Translation target language" },
    {
      name: "assist-task",
      choices: ["summarise", "tags", "chapters", "shot-notes"],
      description: "Exact assistance operation under qualification",
    },
    { name: "voice", description: "Exact installed voice under test" },
    {
      name: "suite",
      choices: ["smoke", "quality"],
      default: "smoke",
      description: "Smoke checks execution; quality compares at least three pinned labelled cases against baselines",
    },
    { name: "input", description: "Smoke fixture in the task command format" },
    {
      name: "benchmark",
      description: "Quality benchmark JSON: pinned input, reference and baseline files, licence, task and language",
    },
  ] as const);
  const result = await verifyLocal({
    task: LocalTaskSchema.parse(args.task),
    language: args.language,
    targetLanguage: args["target-language"],
    voice: args.voice,
    assistTask: args["assist-task"] as "summarise" | "tags" | "chapters" | "shot-notes" | undefined,
    suite: args.suite as "smoke" | "quality",
    input: args.input,
    benchmark: args.benchmark,
  });
  if (!result.metadata.passed)
    throw new CliErrorObject({ code: "VALIDATION", message: "Local quality qualification failed", details: result });
  return result;
});
