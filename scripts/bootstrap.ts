/**
 * First-run setup for a fresh clone: probe, plan, apply the repository-scoped
 * steps, and write a report the agent hands to the user (what is installed,
 * this machine's limits, which keys unlock what, what to do next).
 *
 * Default is a read-only plan. `--apply` runs only `repo` steps (packages,
 * Chromium, pinned Python, .env copy, optional assets and a test render);
 * user- and system-scope installs are listed as needing consent and are run by
 * setup.sh / setup.ps1. Never prints a key's value.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import { collectDoctorChecks } from "../src/lib/doctor/collect";
import { goalStatuses, keyStatuses, parseGoals } from "../src/lib/setup/keys";
import { applyHarnesses, planHarnesses } from "../src/lib/harness/setup";
import {
  buildPlan,
  consentSteps,
  machineLimits,
  renderReport,
  requiredReady,
  type MachineProfile,
  type SetupStep,
} from "../src/lib/setup/plan";
import type { HostOs } from "../src/lib/doctor";

const SMOKE = "out/setup/smoke.mp4";
const REMOTION_CLI = path.join("node_modules", "@remotion", "cli", "remotion-cli.js");

function machineProfile(host: HostOs): MachineProfile {
  let diskFreeGb: number | undefined;
  try {
    const stats = statfsSync(process.cwd());
    diskFreeGb = Math.round((stats.bavail * stats.bsize) / 1024 ** 3);
  } catch {
    diskFreeGb = undefined;
  }
  let gpu = "none";
  if (process.platform === "darwin") gpu = process.arch === "arm64" ? "Apple Silicon (Metal)" : "Mac (Intel)";
  else {
    const nvidia = spawnSync("nvidia-smi", ["-L"], { encoding: "utf8", timeout: 10000 });
    if (!nvidia.error && nvidia.status === 0 && nvidia.stdout.trim()) gpu = nvidia.stdout.trim().split("\n")[0]!;
  }
  return {
    os: host,
    platform: process.platform,
    arch: process.arch,
    cpus: os.availableParallelism?.() ?? os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    ...(diskFreeGb !== undefined ? { diskFreeGb } : {}),
    gpu,
    node: process.versions.node,
  };
}

/**
 * pnpm as `pnpm bootstrap` was launched (npm_execpath): a JS entry runs under this
 * Node, a native pnpm binary runs directly; neither needs a shell on Windows.
 */
function pnpm(args: string[]): { ok: boolean; output: string } {
  const execPath = process.env["npm_execpath"];
  const options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const result =
    !execPath || !/pnpm/i.test(execPath)
      ? spawnSync("pnpm", args, options)
      : /\.[cm]?js$/i.test(execPath)
        ? spawnSync(process.execPath, [execPath, ...args], options)
        : spawnSync(execPath, args, options);
  return {
    ok: !result.error && result.status === 0,
    output: `${result.stderr ?? ""}${result.error?.message ?? ""}`.trim().split("\n").slice(-3).join(" "),
  };
}

function command(executable: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    ok: !result.error && result.status === 0,
    output: `${result.stderr ?? ""}${result.error?.message ?? ""}`.trim().split("\n").slice(-3).join(" "),
  };
}

function smokeRender(): { ok: boolean; output: string } {
  mkdirSync(path.dirname(SMOKE), { recursive: true });
  if (existsSync(SMOKE)) unlinkSync(SMOKE);
  const result = spawnSync(
    process.execPath,
    [REMOTION_CLI, "render", "src/index.ts", "SetupSmoke", SMOKE, "--log=error"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTBROS_NO_DOTENV: "1" },
    },
  );
  const rendered = !result.error && result.status === 0 && existsSync(SMOKE) && statSync(SMOKE).size > 0;
  if (!rendered)
    return { ok: false, output: `${result.stderr ?? ""}${result.error?.message ?? ""}`.trim().slice(-400) };
  const probe = command("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", SMOKE]);
  return { ok: true, output: probe.ok ? `1 s test render written` : "written (ffprobe unavailable)" };
}

async function applyStep(step: SetupStep): Promise<{ ok: boolean; output: string }> {
  switch (step.id) {
    case "install":
      return pnpm(["install", "--frozen-lockfile"]);
    case "chromium":
      // A child process: Remotion memoises ensureBrowser per process, and the doctor's probe
      // (downloads refused) already ran in this one.
      return command(process.execPath, [REMOTION_CLI, "browser", "ensure"]);
    case "python":
      return command(process.env["AGENTBROS_UV"] || "uv", ["python", "install"]);
    case "env":
      try {
        copyFileSync(".env.example", ".env", constants.COPYFILE_EXCL);
        return { ok: true, output: "created .env with empty keys" };
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error) };
      }
    case "assets":
      return pnpm(["assets:sync", "--all"]);
    case "harness": {
      const statuses = planHarnesses({ codeRoot: process.cwd() });
      const { written } = applyHarnesses(statuses, { codeRoot: process.cwd() });
      return { ok: true, output: written.length ? `wrote ${written.join(", ")}` : "nothing to write" };
    }
    case "smoke":
      return smokeRender();
    default:
      return { ok: false, output: `no repository action for ${step.id}` };
  }
}

/** Which harnesses this machine has and what wiring is left; never fails setup (an unreadable config is a conflict). */
function harnessPlan(): { todo: boolean; detail: string } {
  try {
    const selected = planHarnesses({ codeRoot: process.cwd() }).filter((status) => status.selected);
    const todo = selected.some((status) => status.actions.some((action) => action.state === "todo"));
    const userScope = selected.filter((status) =>
      status.actions.some((action) => action.kind === "mcp" && action.state === "manual"),
    );
    return {
      todo,
      detail:
        `${selected.map((status) => status.name).join(", ")}` +
        (userScope.length
          ? `; user-scope config for ${userScope.map((status) => status.name).join(", ")}: pnpm harness:setup --apply --global after the user agrees`
          : ""),
    };
  } catch (error) {
    return { todo: false, detail: `harness plan failed: ${(error as Error).message}` };
  }
}

runScript(async () => {
  const args = parseArgs([
    { name: "apply", type: "boolean", description: "Run the repository-scoped steps (never user or system installs)" },
    { name: "assets", type: "boolean", description: "Also download shared media (pnpm assets:sync --all)" },
    { name: "smoke", type: "boolean", description: "Also render a one-second test video to out/setup/smoke.mp4" },
    {
      name: "goal",
      description:
        "Comma-separated goals to focus the key advice on (voiceover, music, sfx, transcription, speaker-diarisation, image-generation, video-generation, stock-media, 3d-models, reference-download)",
    },
    { name: "report", default: "out/setup/REPORT.md", description: "Where to write the report for the user" },
  ] as const);
  let focusGoals: string[];
  try {
    focusGoals = parseGoals(args.goal);
  } catch (error) {
    throw new CliErrorObject({ code: "INVALID_INPUT", message: (error as Error).message });
  }
  const report = path.resolve(args.report!);
  const root = process.cwd();
  if (!report.startsWith(path.join(root, "out") + path.sep))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--report must be inside out/" });

  const appliedByWrapper = (process.env["AGENTBROS_SETUP_APPLIED"] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  /** Checks proven by this run (an installed Chromium, a rendered test video) override probes Remotion memoised. */
  const proven = new Set<string>();
  const planFor = async () => {
    const facts = await collectDoctorChecks();
    facts.checks = facts.checks.map((check) =>
      proven.has(check.id) ? { ...check, status: "ok", detail: "installed in this run" } : check,
    );
    const steps = buildPlan(facts.os, facts.checks, {
      envFile: existsSync(".env"),
      envExample: existsSync(".env.example"),
      assets: !!args.assets,
      smoke: !!args.smoke,
      appliedByWrapper,
      harness: harnessPlan(),
    });
    return { facts, steps };
  };

  emitProgress("Checking this machine…");
  let { facts, steps } = await planFor();
  const results: Record<string, string> = {};
  const ok: Record<string, boolean> = {};
  if (args.apply) {
    for (const step of steps) {
      if (step.scope !== "repo" || step.state !== "todo") continue;
      emitProgress(`Applying: ${step.title}`);
      const result = await applyStep(step);
      results[step.id] = result.output;
      ok[step.id] = result.ok;
      if (!result.ok) emitProgress(`  failed: ${result.output}`);
    }
    // Re-probe so the report states what is true now, not what was attempted.
    const smokeDone = results["smoke"] !== undefined && existsSync(SMOKE);
    if (ok["chromium"] || smokeDone) proven.add("chromium");
    ({ facts, steps } = await planFor());
    steps = steps.map((step) => {
      if (step.id === "smoke") return { ...step, state: smokeDone ? "applied" : args.smoke ? "failed" : "skipped" };
      if (step.id in results && (step.state === "done" || step.state === "skipped"))
        return { ...step, state: step.state === "done" ? "applied" : step.state };
      if (step.id in results && step.state === "todo") return { ...step, state: "failed", detail: results[step.id] };
      return step;
    });
  }

  const machine = machineProfile(facts.os);
  const activate = process.env["AGENTBROS_SETUP_ACTIVATE"]?.trim() || undefined;
  const keys = keyStatuses();
  const goals = goalStatuses(keys);
  const text = renderReport({
    date: new Date().toISOString().slice(0, 10),
    mode: args.apply ? "apply" : "plan",
    machine,
    steps,
    checks: facts.checks,
    keys,
    goals,
    focusGoals,
    ...(activate ? { activate } : {}),
    ...(steps.find((step) => step.id === "smoke")?.state === "applied" ? { smokeOutput: SMOKE } : {}),
  });
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(report, text);
  const json = path.join(path.dirname(report), "setup.json");
  const ready = requiredReady(steps);
  const consent = consentSteps(steps).map((step) => ({ id: step.id, scope: step.scope, command: step.command }));
  const metadata = {
    mode: args.apply ? "apply" : "plan",
    ready,
    os: facts.os,
    machine,
    limits: machineLimits(machine),
    steps: steps.map(({ id, scope, required, state, command: cmd }) => ({ id, scope, required, state, command: cmd })),
    needsConsent: consent,
    ...(activate ? { activate } : {}),
    keys: Object.fromEntries(keys.map((key) => [key.name, key.state])),
    goals: Object.fromEntries(goals.map((goal) => [goal.id, goal.ready])),
    next: ready
      ? "Hand out/setup/REPORT.md to the user, then read AGENTS.md."
      : consent.length
        ? "Show the user the needsConsent steps; after a yes run ./setup.sh --apply --system (Windows: ./setup.ps1 -Apply -System)."
        : "Run pnpm bootstrap --apply.",
  };
  writeFileSync(json, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stderr.write(`\n${ready ? "Ready." : "Not ready yet."} Report: ${path.relative(root, report)}\n`);
  const outputs = [path.relative(root, report), path.relative(root, json)];
  if (steps.find((step) => step.id === "smoke")?.state === "applied") outputs.push(SMOKE);
  const failed = steps.filter((step) => step.state === "failed");
  if (args.apply && (failed.length || !ready))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: failed.length
        ? `Setup step(s) failed: ${failed.map((step) => step.id).join(", ")}. See ${path.relative(root, report)}.`
        : `Required steps remain: see ${path.relative(root, report)}.`,
      details: { ...metadata, outputs },
    });
  return { outputs, metadata };
});
