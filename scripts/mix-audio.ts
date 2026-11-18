import { writeFileSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs, runScript, ensureFfmpeg, ensureFfprobe, CliErrorObject, requireProject } from "../src/lib/cli";
import {
  mixLocalAudio,
  buildAudioMix,
  scopeMixPlanSources,
  LOUDNESS_PRESETS,
  type LoudnessPreset,
} from "../src/lib/audio/local-mix";
import { projectAudioMixWithInputs } from "../src/lib/audio/project-mix";
import { assertAudioMasterInputs } from "../src/lib/audio/master-inputs";
import { readLocalJson, localInputHash } from "../src/lib/audio/local-input";
runScript(async () => {
  const args = parseArgs([
    { name: "plan", description: "Local audio mix plan JSON" },
    { name: "project", description: "Project with initialized timeline" },
    { name: "output", required: true, description: "Output WAV path" },
    {
      name: "dry-run",
      type: "boolean",
      description: "Validate and return FFmpeg graph without creating output",
    },
    {
      name: "preset",
      choices: ["review", "social"],
      description: "Loudness target: review −16 LUFS / −1.5 dBTP, social −14 LUFS / −1.5 dBTP. Overrides the plan",
    },
    {
      name: "duck-db",
      type: "number",
      description: "Deepest music dip under speech in dB (−24 to −3, default −9). Overrides the plan",
    },
    {
      name: "force",
      type: "boolean",
      description: "Explicitly replace existing master",
    },
    {
      name: "scope-root",
      description:
        "Trusted MCP workspace boundary: --plan track sources resolve against it (default: the working directory) and must stay inside",
    },
  ]);
  ensureFfmpeg();
  ensureFfprobe();
  if (Boolean(args.plan) === Boolean(args.project))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Provide exactly one --plan or --project",
    });
  if (args.project) requireProject(String(args.project));
  try {
    const captured = args.project ? projectAudioMixWithInputs(String(args.project)) : undefined;
    const base = (captured?.plan ??
      scopeMixPlanSources(
        readLocalJson(String(args.plan)),
        realpathSync(path.resolve(String(args["scope-root"] ?? process.cwd()))),
      )) as Record<string, unknown>;
    const plan = {
      ...base,
      ...(args.preset ? LOUDNESS_PRESETS[args.preset as LoudnessPreset] : {}),
      ...(args["duck-db"] !== undefined ? { duckDb: args["duck-db"] } : {}),
    };
    if (args["dry-run"])
      return {
        outputs: [],
        metadata: { dryRun: true, ...buildAudioMix(plan) },
      };
    const result = mixLocalAudio(plan, String(args.output), {
      force: args.force === true,
      beforePublish: captured
        ? () => assertAudioMasterInputs(captured.inputs, projectAudioMixWithInputs(String(args.project)).inputs)
        : undefined,
    });
    const master = {
      source: path
        .relative(
          existsSync(path.resolve("public"))
            ? realpathSync(path.resolve("public"))
            : path.join(realpathSync(process.cwd()), "public"),
          realpathSync(path.resolve(String(args.output))),
        )
        .split(path.sep)
        .join("/"),
      sourceSha256: localInputHash(String(args.output)),
      durationSec: result.analysis.durationSec,
      integratedLufs: result.analysis.integratedLufs,
      truePeakDb: result.analysis.truePeakDb,
      targetLufs: result.plan.targetLufs,
      createdAt: new Date().toISOString(),
      ...(captured ? { projectInputs: captured.inputs } : {}),
    };
    const sidecar = String(args.output) + ".json";
    writeFileSync(sidecar, JSON.stringify(master, null, 2) + "\n");
    return {
      outputs: [result.output, sidecar],
      metadata: {
        audioMaster: master,
        analysis: result.analysis,
        duck: result.duck ?? null,
        ...(result.duckWarning ? { warnings: [result.duckWarning] } : {}),
        apiCalls: 0,
      },
    };
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
