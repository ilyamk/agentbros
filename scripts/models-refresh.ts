import { readFileSync, writeFileSync } from "node:fs";
import { hfPricesPath, loadHiggsfieldPrices, serialiseHiggsfieldPrices } from "../src/lib/models/hf-pricing";
import { spawn } from "node:child_process";
import path from "node:path";
import { emitResult, parseArgs, runScript } from "../src/lib/cli";
import {
  refreshModels,
  retainFailedHiggsfieldPrices,
  ModelsRefreshQuerySchema,
  type RefreshStep,
  type RefreshStepResult,
} from "../src/lib/models/models-refresh";
import { COMMAND_REGISTRY } from "../src/lib/cli/commands";

function runStep(step: RefreshStep): Promise<RefreshStepResult> {
  const previous = step.id === "hf:pricing" ? [...loadHiggsfieldPrices().values()] : [];
  return new Promise((resolve, reject) => {
    const script = COMMAND_REGISTRY.find(
      (entry) => entry.alias === (step.id === "fal:historical" ? "fal:pricing" : step.id),
    )?.script;
    if (!script) {
      reject(new Error("Missing refresh step registration."));
      return;
    }
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.resolve(import.meta.dirname, "..", script), ...step.args],
      { stdio: ["ignore", "pipe", "pipe"], shell: false },
    );
    let stdout = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => process.stderr.write(data));
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        const result = JSON.parse(stdout);
        if (step.id === "hf:pricing" && Array.isArray(result.metadata?.failures)) {
          const failed = result.metadata.failures.map((row: { endpoint: string }) => row.endpoint);
          const current = [...loadHiggsfieldPrices().values()];
          const retained = retainFailedHiggsfieldPrices(previous, current, failed);
          const syncedAt =
            (result.metadata.partial ?? failed.length > 0)
              ? null
              : JSON.parse(readFileSync(hfPricesPath(), "utf8")).syncedAt;
          writeFileSync(hfPricesPath(), serialiseHiggsfieldPrices(retained, syncedAt));
          result.metadata.retainedHistoricalPrices = retained
            .filter((row) => previous.includes(row))
            .map((row) => row.endpoint);
        }
        resolve({ ok: code === 0 && result.ok === true, metadata: result.metadata });
      } catch {
        reject(new Error("Refresh step returned no valid JSON envelope."));
      }
    });
  });
}
runScript(async () => {
  const startedAt = Date.now();
  const args = parseArgs([
    { name: "provider", choices: ["fal", "higgsfield", "all"], description: "Providers to refresh (default all)" },
    { name: "dry-run", type: "boolean", description: "List steps and local slot proposals without network or writes" },
    { name: "sample-image", description: "Public sample image URL for free Higgsfield estimates" },
    { name: "sample-video", description: "Public sample video URL for free Higgsfield estimates" },
    { name: "sample-audio", description: "Public sample audio URL for free Higgsfield estimates" },
    {
      name: "resume",
      type: "boolean",
      description: "Reuse catalogue checkpoints; pricing always resumes completed work",
    },
  ] as const);
  const report = await refreshModels(
    ModelsRefreshQuerySchema.parse({
      provider: args.provider,
      dryRun: args["dry-run"],
      resume: args.resume,
      sampleImage: args["sample-image"],
      sampleVideo: args["sample-video"],
      sampleAudio: args["sample-audio"],
    }),
    { runStep },
  );
  if (!report.ok)
    emitResult({
      ok: false,
      error: "NETWORK",
      message: "Model refresh partially failed; inspect metadata.steps and the report.",
      metadata: report,
      elapsedMs: Date.now() - startedAt,
    });
  return { outputs: report.reportFile ? [report.reportFile] : [], metadata: report };
});
