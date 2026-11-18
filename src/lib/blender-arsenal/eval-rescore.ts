import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ExecutableArsenalPlanSchema, ExecutableEvalReportSchema, RescoreProvenanceSchema } from "./eval-schema";
import { CheckoutInventorySchema } from "./eval-checkout";
import { scoreExecutablePlan, distribution } from "./eval-executable";
import { executableScorerHash, readArsenalTasks } from "./eval";

/** Preserve all samples and original evidence; correct static checks without another model call. */
export function rescoreExecutableEval(
  reportFile: string,
  output: string,
  tasksFile = fileURLToPath(new URL("../../../bench/blender-arsenal/tasks.json", import.meta.url)),
) {
  const original = path.resolve(reportFile),
    report = ExecutableEvalReportSchema.parse(JSON.parse(readFileSync(original, "utf8")));
  const inventoryFile = path.join(path.dirname(original), "checkout-inventory.json");
  const inventory = CheckoutInventorySchema.parse(JSON.parse(readFileSync(inventoryFile, "utf8")));
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const inventoryHash = hash(JSON.stringify(inventory));
  if (inventoryHash !== report.inventorySha256) throw new Error("Saved checkout inventory hash changed");
  if (hash(readFileSync(tasksFile)) !== report.tasksSha256)
    throw new Error("Tasks changed; rescore requires the identical task manifest");
  if (hash(JSON.stringify(z.toJSONSchema(ExecutableArsenalPlanSchema))) !== report.schemaSha256)
    throw new Error("Output schema changed");
  // Supplied scripts live in raw replies; existing Python must still match the commit.
  // The evaluator worker itself is covered by the scorer identity.
  const changed = spawnSync("git", ["diff", "--name-only", report.revision, "--", "*.py"], {
    cwd: report.repository,
    encoding: "utf8",
    timeout: 15000,
  });
  if (
    changed.status !== 0 ||
    changed.stdout.split("\n").some((f) => f && f !== "scripts/workers/blender/avc_eval_plan.py")
  )
    throw new Error("Python checkout changed since the recorded revision");
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", "scripts/blender", "scripts/workers/blender"],
    { cwd: report.repository, encoding: "utf8", timeout: 15000 },
  );
  if (
    untracked.status !== 0 ||
    untracked.stdout.split("\n").some((f) => f.endsWith(".py") && f !== "scripts/workers/blender/avc_eval_plan.py")
  )
    throw new Error("Untracked Python modules prevent immutable source verification");
  for (const result of report.results)
    for (const command of result.plan?.commands ?? []) {
      const argv = command.argv,
        index = argv.indexOf("--script");
      const file = index >= 0 ? argv[index + 1] : argv.find((a) => a.startsWith("--script="))?.slice(9);
      if (
        !file ||
        result.plan?.execution.scripts.some((s) => s.path === file) ||
        !existsSync(path.resolve(report.repository, file))
      )
        continue;
      const recorded = spawnSync("git", ["show", `${report.revision}:${file}`], {
        cwd: report.repository,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (recorded.status !== 0 || hash(recorded.stdout) !== hash(readFileSync(path.resolve(report.repository, file))))
        throw new Error(`Existing scene source changed or was not tracked: ${file}`);
    }
  const tasks = readArsenalTasks(tasksFile);
  const provenance = {
    original,
    originalScorerSha256: report.scorerSha256,
    scorerSha256: executableScorerHash(),
    samplesRetained: report.results.length,
    inventorySha256: inventoryHash,
    originalErrors: report.results.filter((r) => r.error).map((r) => ({ id: r.id, sample: r.sample, error: r.error! })),
  };
  report.scorerSha256 = provenance.scorerSha256;
  for (const result of report.results) {
    const task = tasks.find((t) => t.id === result.id);
    if (!task) throw new Error(`Unknown task in saved response: ${result.id}`);
    const plan =
      result.plan === null
        ? null
        : ExecutableArsenalPlanSchema.parse(JSON.parse(readFileSync(result.responseFile, "utf8")));
    if (JSON.stringify(plan) !== JSON.stringify(result.plan))
      throw new Error(`Raw response changed: ${result.id}/s${result.sample}`);
    const retainedError = result.error?.startsWith("Static inspection failed:") ? null : result.error;
    try {
      Object.assign(
        result,
        scoreExecutablePlan(task, plan, report.repository, inventory, result.sample, retainedError),
        { plan },
      );
    } catch (cause) {
      Object.assign(
        result,
        scoreExecutablePlan(
          task,
          null,
          report.repository,
          inventory,
          result.sample,
          `Static inspection failed: ${String(cause)}`,
        ),
      );
    }
  }
  report.failures = report.results.filter((r) => r.error).length;
  report.total = report.results.reduce((sum, r) => sum + r.score, 0);
  report.percent = (report.total / report.maximum) * 100;
  report.perTask = tasks
    .filter((t) => report.results.some((r) => r.id === t.id))
    .map((t) => ({ id: t.id, ...distribution(report.results.filter((r) => r.id === t.id).map((r) => r.score)) }));
  report.overall = distribution(report.results.map((r) => r.score));
  const out = path.resolve(output);
  mkdirSync(path.dirname(out), { recursive: true });
  mkdirSync(out);
  const target = path.join(out, "report.json"),
    markdown = path.join(out, "report.md");
  writeFileSync(target, JSON.stringify(ExecutableEvalReportSchema.parse(report), null, 2) + "\n");
  writeFileSync(
    path.join(out, "provenance.json"),
    JSON.stringify(RescoreProvenanceSchema.parse(provenance), null, 2) + "\n",
  );
  writeFileSync(path.join(out, "checkout-inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
  writeFileSync(
    markdown,
    `# Executable plan rescore\n\nAll ${report.completed} saved samples retained. Mean ${report.overall.mean.toFixed(2)} ± ${report.overall.sd.toFixed(2)} population SD; ${report.failures} failures. Original evidence: ${original}.\n\n| Task | Mean ± SD | Range | n |\n|---|---:|---:|---:|\n${report.perTask.map((t) => `| ${t.id} | ${t.mean.toFixed(2)} ± ${t.sd.toFixed(2)} | ${t.min.toFixed(2)}–${t.max.toFixed(2)} | ${t.n} |`).join("\n")}\n`,
  );
  return { report, reportFile: target, markdownFile: markdown };
}
