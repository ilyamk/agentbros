import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import { APPLE_DOMAINS } from "../src/lib/apple/runtime";
import { ASR_MODELS, prepareLocalEngines, type AsrModelName, type LocalEngine } from "../src/lib/local-engines/prepare";
runScript(async () => {
  const args = parseArgs([
    {
      name: "engines",
      default: "asr,ocr",
      description:
        "Comma-separated: asr, ocr, matte, visual, category, earshot-bank, earshot-find, apple-speech, apple-text, apple-translation, apple-tts, apple-audio, apple-vision, apple-foundation",
    },
    {
      name: "output-dir",
      description: "Engine directory outside the repository (default ~/.cache/agentbros/local-engines)",
    },
    {
      name: "model",
      default: "small",
      description: `Multilingual whisper model: ${Object.keys(ASR_MODELS).join(", ")}`,
    },
    { name: "language", default: "auto", description: "Whisper language code pinned in the config, or auto" },
    { name: "threads", type: "number", description: "Whisper CPU threads, 1 to 8" },
    {
      name: "ocr-languages",
      default: "ru-RU,en-US",
      description: "Apple Vision recognition languages, in priority order",
    },
    {
      name: "allow-download",
      type: "boolean",
      default: false,
      description:
        "Explicit one-operation permission to download requested resources; never accepts terms or changes system settings",
    },
    {
      name: "dry-run",
      type: "boolean",
      default: false,
      description: "Report state and plan; no download, build or write",
    },
  ] as const);
  const engines = args.engines!.split(",").map((engine) => engine.trim());
  if (
    engines.some(
      (engine) =>
        ![
          "asr",
          "ocr",
          "matte",
          "visual",
          "category",
          "earshot-bank",
          "earshot-find",
          ...APPLE_DOMAINS.map((d) => `apple-${d}`),
        ].includes(engine),
    )
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose a documented local engine (see --help)" });
  if (!(args.model! in ASR_MODELS))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Choose --model from ${Object.keys(ASR_MODELS).join(", ")}`,
    });
  const result = await prepareLocalEngines({
    engines: engines as LocalEngine[],
    outputDir: args["output-dir"],
    model: args.model as AsrModelName,
    language: args.language,
    threads: args.threads,
    ocrLanguages: args["ocr-languages"]!.split(",").map((language) => language.trim()),
    dryRun: args["dry-run"],
    allowDownload: args["allow-download"],
    onProgress: emitProgress,
  });
  const outputs = Object.values(result.engines).flatMap(
    (engine) => (engine as { configFile?: string }).configFile ?? [],
  );
  return { outputs: result.dryRun ? [] : outputs, metadata: result };
});
