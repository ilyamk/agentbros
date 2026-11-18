import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CliErrorObject, emitProgress } from "../cli";
import { COMMAND_REGISTRY } from "../cli/commands";
import { ExecutableArsenalPlanSchema, ExecutableEvalReportSchema } from "./eval-schema";
import { inspectCheckout } from "./eval-checkout";
import { scoreExecutablePlan, distribution } from "./eval-executable";
import { ArsenalPlanSchema, ArsenalTasksSchema, EVAL_WEIGHTS, type ArsenalPlan, type ArsenalTask } from "./eval-schema";

const sourceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const aliases = COMMAND_REGISTRY.flatMap((c) => (c.alias ? [c.alias] : []));
export function readArsenalTasks(file: string) {
  const tasks = ArsenalTasksSchema.parse(JSON.parse(readFileSync(file, "utf8"))).tasks;
  for (const task of tasks)
    for (const command of task.expected.commands)
      if (!aliases.includes(command)) throw new Error(`Unknown rubric command: ${command}`);
  return tasks;
}

/** Rubric scores declared plans, never artistic quality or whether a command really rendered a shot. */
export function scoreArsenalPlan(task: ArsenalTask, input: unknown, error: string | null = null) {
  const parsed = ArsenalPlanSchema.safeParse(input);
  if (!parsed.success) error ??= parsed.error.message;
  const p = parsed.success ? parsed.data : null;
  const commands = p?.commands ?? [];
  const validCommand = (argv: string[]) =>
    argv[0] === "pnpm" && aliases.includes(argv[1]!) && !argv.some((a) => /[\n\r]|[;&|`]|\$\(/.test(a));
  const tokens = (argv: string[]) =>
    argv.flatMap((a) =>
      a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a],
    );
  const acquireAliases = new Set(
    aliases.filter((a) => /^(?:fetch:|generate:|media:fetch$|asset:fetch|fal:batch$|sfx:fetch$|sfx:generate$)/.test(a)),
  );
  const commandSafe = commands.every((c) => {
    const argv = tokens(c.argv),
      alias = argv[1];
    const checkFlags = c.argv.filter((a) => a === "--check" || a.startsWith("--check=") || a.startsWith("--no-check"));
    const readOnlySync = checkFlags.length === 1 && ["--check", "--check=true"].includes(checkFlags[0]!);
    const download =
      (alias === "assets:sync" && !readOnlySync) ||
      acquireAliases.has(alias!) ||
      ["fetch", "install", "trial", "add", "import", "acquire"].some((action) => argv.includes(action));
    const approval =
      (alias === "blender:ext" && ["install", "approve"].some((a) => argv.includes(a))) ||
      argv.includes("--extensions");
    if (approval && c.phase !== "after-approval") return false;
    if (download && !["after-consent", "after-approval"].includes(c.phase)) return false;
    // No owner decision was supplied in these briefs: literal consent would be fabricated.
    for (const flag of ["--consent", "--approved-by"]) {
      for (let index = 0; index < argv.length; index++) {
        if (argv[index] === flag && !/^\$[A-Z][A-Z0-9_]*$/.test(argv[index + 1] ?? "")) return false;
      }
    }
    return true;
  });
  const cache = p?.determinism.cachePath;
  const bakePathValid =
    !!cache &&
    !path.posix.isAbsolute(cache) &&
    !cache.includes("\\") &&
    !cache.split("/").includes("..") &&
    path.posix.normalize(cache).startsWith("blender-arsenal/local/bakes/");
  // Native Blender has no canonical ids: accept common API names and explained equivalents.
  const builtinTerms: Record<string, RegExp> = {
    "seeded-particles": /particle|trajector|dust/i,
    "geometry-nodes": /geometry[ _-]*nodes|\bGN\b/i,
    "voronoi-cells": /voronoi|clipped.{0,20}(?:cell|shard|mesh)|boolean.{0,20}intersect/i,
    "procedural-materials": /procedural.{0,30}(?:wood|material|desk)|wood.{0,30}procedural/i,
    essentials: /essentials/i,
    "emission-curves": /(?:bevel|emiss|neon).{0,30}curve|curve.{0,30}(?:bevel|emiss|neon)/i,
    "font-objects": /\bFONT\b|blender[ _-]*text|text.{0,20}(?:curve|object)/i,
    "string-to-curves": /string.{0,10}to.{0,10}curves/i,
    "cycles-caustics": /cycles|refractive.{0,20}caustic/i,
    "cloth-simulation": /cloth|fabric.{0,20}simulat/i,
    "scene-time": /scene[ _-]*time|loop.{0,20}(?:sine|cosine)|(?:sine|cosine).{0,20}loop/i,
    "linked-mesh-instances": /linked[ _-]*mesh|instanc/i,
    "kit-camera-handheld": /handheld|kit\.camera/i,
    "fcurve-noise": /f.?curve.{0,20}noise|noise.{0,20}f.?curve/i,
  };
  const fit =
    p?.choices.some((c) =>
      c.kind === "builtin"
        ? task.expected.builtins.some((id) => id === c.id || builtinTerms[id]?.test(`${c.id} ${c.reason}`))
        : { recipe: task.expected.recipes, collection: task.expected.collections, extension: task.expected.extensions }[
            c.kind
          ].includes(c.id),
    ) ?? false;
  const needsBake =
    task.expected.requiresBake ||
    !!p?.choices.some((c) => c.kind === "recipe" && ["dust-burst", "cloth-drape"].includes(c.id));
  const verdicts: Record<keyof typeof EVAL_WEIGHTS, [boolean, string]> = {
    fit: [fit, "At least one task-appropriate recipe, collection, extension or named built-in alternative."],
    commands: [
      commands.length > 0 &&
        commands.every((c) => validCommand(c.argv)) &&
        task.expected.commands.some((a) => commands.some((c) => c.argv[1] === a)),
      "Every argv uses an existing registry alias and includes a task-relevant command; flags are not execution-validated.",
    ],
    builtInFirst: [
      !!p &&
        p.builtIn.method.length >= 15 &&
        p.builtIn.comparison.length >= 20 &&
        p.choices.some((c) => c.kind === "builtin") &&
        (commands.findIndex((c) => c.phase !== "inspect") < 0 || commands[0]?.phase === "inspect"),
      "Names a built-in option, compares its value and inspects before production.",
    ],
    consent: [
      !!p &&
        commandSafe &&
        (!p.acquisition.needsDownload || p.acquisition.consent === "required") &&
        p.acquisition.note.length >= 15,
      "Acquisition and extension approval remain explicitly conditional; no consent is fabricated.",
    ],
    determinism: [
      !!p &&
        (!needsBake || (p.determinism.method !== "frame-function" && bakePathValid)) &&
        /pixel/i.test(p.determinism.pixelCheck) &&
        /alone|isolated|single|individual|independen/i.test(p.determinism.pixelCheck) &&
        /range|sequence|within frames/i.test(p.determinism.pixelCheck),
      "Fixed seed and frame-alone/range pixel comparison; simulation tasks require a local bake.",
    ],
    intent: [!!p && p.shot.intent.length >= 25, "Names the film function and what the viewer notices."],
    camera: [!!p && p.shot.camera.length >= 25, "States a camera choice with a reason."],
    light: [!!p && p.shot.light.length >= 25, "States lighting with a mood or ratio."],
    kit: [
      !!p &&
        p.shot.kit.some((k) =>
          /(?:\bkit\.(?:camera|light|curves|anim|stage|look)\b|\b(?:camera|light|curves|anim|stage|look)\.|scripts\/blender\/kit\/(?:camera|light|curves|anim|stage|look)\.py)/.test(
            k,
          ),
        ),
      "Names a real kit module or function.",
    ],
    credits: [
      !!p &&
        (!task.expected.requiresCredit ||
          (p.credits.required &&
            p.credits.lines.some((line) => /CC-BY|CC BY/.test(line) && /author|creator|credit|https?:/i.test(line)))),
      "CC-BY tasks retain an author/source/licence credit.",
    ],
  };
  const checks = Object.entries(EVAL_WEIGHTS).map(([criterion, points]) => {
    const [pass, reason] = verdicts[criterion as keyof typeof EVAL_WEIGHTS];
    return {
      criterion: criterion as keyof typeof EVAL_WEIGHTS,
      pass: !!p && pass && !error,
      points: p && pass && !error ? points : 0,
      reason,
    };
  });
  return {
    id: task.id,
    score: checks.reduce((sum, check) => sum + check.points, 0),
    maximum: 100 as const,
    checks,
    error,
  };
}

export function harnessArguments(
  harness: "codex" | "claude",
  repo: string,
  model: string,
  schemaFile: string,
  responseFile: string,
) {
  if (harness === "codex")
    return [
      "exec",
      "--sandbox",
      "read-only",
      "--model",
      model,
      "--ephemeral",
      "--ignore-user-config",
      "--output-schema",
      schemaFile,
      "--json",
      "--output-last-message",
      responseFile,
      "-C",
      repo,
      "-",
    ];
  return [
    "-p",
    "--model",
    model,
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    readFileSync(schemaFile, "utf8"),
  ];
}

export function arsenalEvalPrompt(task: ArsenalTask, schema: unknown) {
  return `Produce an executable Blender shot plan for this brief: ${task.brief}\nInspect this checkout's instructions, command registry and parser flags, recipe META, pinned assets and extension states. This is read-only: do not execute production commands, write files, download, install, enable extensions, contact services, delegate or ask for approval. Do not read bench/, prior eval outputs or other checkouts. No new acquisition/extension consent is granted.\nReturn JSON matching the schema. Every command must be a literal pnpm alias argv supported by THIS checkout, with all required flags and valid values. Supply complete runnable Python in execution.scripts for each future scene path used by blender:run; an absent script without supplied code is a fault. Do not substitute TODOs or pseudocode. Existing scripts can be referenced but must fit the shot. Raw Python is allowed: supply concrete meshes/nodes/materials, frame-derived animation, fixed seeds, camera lens/move, lighting settings, and bake calls plus an arsenal cache path for simulations. Inspect actual kit signatures rather than guessing them. Existing built-in recipes are preferred where suitable; give real ids and typed bounded parameters both in commands/code and execution.recipes. The execution.recipes.params field is a JSON object encoded as a string (same bytes as --params), not prose. Assets must be pinned, in collections, indexed locally or in the checkout's Essentials inventory. List actual external asset ids in execution.assets and material assetId; null is appropriate for procedural materials. No asset download is needed for native procedural scenes. A proposed extension requires explicit execution.extensions.requiresApproval plus conditional command phases. Use concrete frames, seed, lens, light mood/preset/temperature and material values, implemented in code or parameters. Define the intended camera move in code. Include the frame-alone/range pixel-check plan and CC-BY credits. This evaluator validates syntax, imports, flags, ids and params without rendering; complete native scene implementations are judged by concrete setup and determinism evidence, not merely a prose promise.\n${JSON.stringify(schema)}`;
}

async function runHarness(binary: string, argv: string[], prompt: string, cwd: string, timeoutMs: number) {
  return await new Promise<{ stdout: string; stderr: string; error: string | null }>((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn(binary, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "",
      stderr = "",
      failure: string | null = null,
      size = 0;
    const stop = (reason: string) => {
      failure = reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    const timer = setTimeout(() => stop(`Harness timed out after ${timeoutMs} ms`), timeoutMs);
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        stop("Harness exceeded 16 MiB output");
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.stdin.on("error", () => {
      /* A failed launch closes stdin. */
    });
    child.on("error", (error) => {
      failure = error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, error: failure ?? (code === 0 ? null : `Harness exited ${code}`) });
    });
    child.stdin.end(prompt);
  });
}

export function executableScorerHash() {
  const names = ["eval.ts", "eval-schema.ts", "eval-checkout.ts", "eval-executable.ts"];
  return hash(
    names.map((name) => readFileSync(path.join(sourceRoot, "src/lib/blender-arsenal", name), "utf8")).join("\n") +
      readFileSync(path.join(sourceRoot, "scripts/workers/blender/avc_eval_plan.py"), "utf8"),
  );
}

export async function evaluateArsenal(options: {
  harness: "codex" | "claude";
  repository: string;
  output: string;
  tasksFile?: string;
  tasks?: string[];
  model?: string;
  timeoutMs?: number;
  samples?: number;
  concurrency?: number;
}) {
  const tasksFile = options.tasksFile ?? path.join(sourceRoot, "bench/blender-arsenal/tasks.json");
  const all = readArsenalTasks(tasksFile),
    tasks = options.tasks ? all.filter((t) => options.tasks!.includes(t.id)) : all;
  if (!tasks.length || options.tasks?.some((id) => !all.some((t) => t.id === id)))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Unknown or empty task selection" });
  const samples = options.samples ?? 1,
    concurrency = options.concurrency ?? 1;
  if (
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > 10 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "samples must be 1–10 and concurrency 1–4" });
  const repo = path.resolve(options.repository),
    out = path.resolve(options.output),
    inventory = inspectCheckout(repo);
  const schema = z.toJSONSchema(ExecutableArsenalPlanSchema);
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 15_000 });
  if (revision.status !== 0) throw new Error("Evaluation repository must be a git checkout");
  mkdirSync(path.dirname(out), { recursive: true });
  mkdirSync(out);
  const schemaFile = path.join(out, "plan.schema.json");
  writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
  writeFileSync(path.join(out, "checkout-inventory.json"), JSON.stringify(inventory, null, 2));
  const model = options.model ?? (options.harness === "codex" ? "gpt-6.1-sol" : "sonnet");
  const report = ExecutableEvalReportSchema.parse({
    version: 2,
    generatedAt: new Date().toISOString(),
    harness: options.harness,
    model,
    repository: repo,
    revision: revision.stdout.trim(),
    tasksSha256: hash(readFileSync(tasksFile)),
    schemaSha256: hash(JSON.stringify(schema)),
    scorerSha256: executableScorerHash(),
    inventorySha256: hash(JSON.stringify(inventory)),
    samples,
    results: [],
    perTask: [],
    overall: distribution([]),
    total: 0,
    maximum: tasks.length * samples * 100,
    percent: 0,
    completed: 0,
    failures: 0,
  });
  const reportFile = path.join(out, "report.json"),
    markdownFile = path.join(out, "report.md");
  const jobs = tasks.flatMap((task) => Array.from({ length: samples }, (_, i) => ({ task, sample: i + 1 })));
  let cursor = 0;
  const save = () => {
    report.results.sort(
      (a, b) => tasks.findIndex((t) => t.id === a.id) - tasks.findIndex((t) => t.id === b.id) || a.sample - b.sample,
    );
    report.completed = report.results.length;
    report.failures = report.results.filter((r) => r.error).length;
    report.total = report.results.reduce((sum, r) => sum + r.score, 0);
    report.percent = (report.total / report.maximum) * 100;
    report.perTask = tasks.map((t) => ({
      id: t.id,
      ...distribution(report.results.filter((r) => r.id === t.id).map((r) => r.score)),
    }));
    report.overall = distribution(report.results.map((r) => r.score));
    writeFileSync(reportFile, JSON.stringify(ExecutableEvalReportSchema.parse(report), null, 2) + "\n");
    writeFileSync(
      markdownFile,
      `# Executable Blender planning evaluation\n\n${options.harness} / ${model}; revision ${report.revision}; ${samples} samples/task.\n\nOverall ${report.overall.mean.toFixed(2)} ± ${report.overall.sd.toFixed(2)} (population SD across plans), range ${report.overall.min.toFixed(2)}–${report.overall.max.toFixed(2)}; ${report.failures} harness/schema failures.\n\n| Task | Mean ± SD | Range | n |\n|---|---:|---:|---:|\n${report.perTask.map((r) => `| ${r.id} | ${r.mean.toFixed(2)} ± ${r.sd.toFixed(2)} | ${r.min.toFixed(2)}–${r.max.toFixed(2)} | ${r.n} |`).join("\n")}\n\nStatic verification against this checkout's saved inventory. Syntax/flags/ids/parameter validation is not a render or full Blender API proof. Failures count as zero. Raw responses and per-check findings are retained.\n`,
    );
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      for (;;) {
        const job = jobs[cursor++];
        if (!job) return;
        const { task, sample } = job,
          key = `${task.id}-s${sample}`;
        emitProgress(`Arsenal executable evaluation: ${key} (${options.harness}, ${model})`);
        const responseFile = path.join(out, `${key}.response.json`),
          eventsFile = path.join(out, `${key}.events.jsonl`),
          stderrFile = path.join(out, `${key}.stderr.txt`);
        const prompt = arsenalEvalPrompt(task, schema);
        writeFileSync(path.join(out, `${key}.prompt.txt`), prompt);
        const started = Date.now();
        const result = await runHarness(
          process.env.ARSENAL_EVAL_HARNESS_BIN ?? options.harness,
          harnessArguments(options.harness, repo, model, schemaFile, responseFile),
          prompt,
          repo,
          options.timeoutMs ?? 360_000,
        );
        writeFileSync(eventsFile, result.stdout);
        writeFileSync(stderrFile, result.stderr);
        if (/invalid_json_schema/.test(result.stdout)) cursor = jobs.length; // A run-wide schema rejection cannot improve on later tasks.
        let plan: z.infer<typeof ExecutableArsenalPlanSchema> | null = null,
          error = result.error;
        try {
          if (options.harness === "claude") {
            const envelope = JSON.parse(result.stdout) as {
              structured_output?: unknown;
              result?: string;
              is_error?: boolean;
            };
            if (envelope.is_error) throw new Error("Claude reported is_error");
            writeFileSync(
              responseFile,
              JSON.stringify(envelope.structured_output ?? JSON.parse(envelope.result ?? "null")),
            );
          }
          plan = ExecutableArsenalPlanSchema.parse(JSON.parse(readFileSync(responseFile, "utf8")));
        } catch (cause) {
          error ??= String(cause);
        }
        let scored;
        try {
          scored = scoreExecutablePlan(task, plan, repo, inventory, sample, error);
        } catch (cause) {
          error = `Static inspection failed: ${String(cause)}`;
          scored = scoreExecutablePlan(task, null, repo, inventory, sample, error);
        }
        report.results.push({ ...scored, elapsedMs: Date.now() - started, responseFile, eventsFile, stderrFile, plan });
        save();
      }
    }),
  );
  return { report, reportFile, markdownFile };
}
