import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ContributionEvidenceSchema, type ContributionEvidence } from "../../types/contrib-tools";
import { DEFAULT_CATEGORIES } from "./categories";
import { parseChangeEntry } from "./changes";
import { commitOf } from "../context/repository";
import { changedFiles, contributionBase, uncommittedCode } from "./git";
import { contributionCategories, contributionGates } from "./gates";
import { intake, IntakeContextSchema, sizeClass, type ChangedFile } from "./intake";
import type { CategoriesFile } from "../../types/contrib";
import { emitProgress } from "../cli";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  interrupted?: boolean;
}
export type CommandRunner = (command: string[], root: string) => CommandResult;
export const runCommand: CommandRunner = (command, root) => {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
};
export type GateRunner = (command: string[], root: string, timeoutMs: number) => CommandResult | Promise<CommandResult>;
export const runGate: GateRunner = (command, root, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      interrupted = false;
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 2000, stdio: "ignore" });
        } else if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The process may already have exited. */
      }
    };
    let forceStop: Promise<void> | undefined;
    const terminate = () => {
      stop("SIGTERM");
      forceStop ??= new Promise((done) => {
        setTimeout(() => {
          stop("SIGKILL");
          done();
        }, 1000);
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const interrupt = () => {
      interrupted = true;
      terminate();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-8 * 1024 * 1024);
      process.stderr.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8 * 1024 * 1024);
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      // Descendants can close their pipes before exiting; still finish killing the group.
      await forceStop;
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      resolve({
        exitCode: interrupted ? 130 : timedOut ? 124 : (code ?? 1),
        stdout: timedOut || interrupted ? "" : stdout,
        stderr: interrupted
          ? "Gate interrupted."
          : timedOut
            ? `${stderr.slice(-400)}\nGate timed out after ${timeoutMs} ms.`
            : stderr,
        interrupted,
      });
    });
  });
export function gateTimeoutMs(command: string[], timeoutMin?: number): number {
  if (timeoutMin !== undefined && (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || timeoutMin * 60000 > 2147483647))
    throw new Error("--timeout-min must be positive and fit within the timer limit.");
  // contrib:fails-on-base runs each test file twice within a 50-minute proof budget (fails-on-base.ts).
  return (
    (timeoutMin ??
      (command.includes("contrib:fails-on-base")
        ? 55
        : command.some((arg) => /^(?:test(?::|$)|--test$)/.test(arg))
          ? 30
          : 5)) * 60000
  );
}
function summary(result: CommandResult): string {
  try {
    const json = JSON.parse(result.stdout) as { message?: string; ok?: boolean };
    return (json.message ?? (json.ok ? "Passed" : "Failed")).slice(0, 500);
  } catch {
    const text = (result.stderr.trim() || result.stdout.trim() || (result.exitCode ? "Failed" : "Passed")).slice(-500);
    if (!result.exitCode) return text;
    // node:test ends with a "✖ failing tests:" section listing "test at tests/x.test.ts:44:1" per failure.
    // Read only the last section, so test output that merely prints such lines cannot name phantom files.
    const output = `${result.stdout}\n${result.stderr}`,
      marker = output.lastIndexOf("✖ failing tests:");
    const failing =
      marker < 0
        ? []
        : [...new Set([...output.slice(marker).matchAll(/^test at (\S+?:\d+):\d+$/gm)].map((match) => match[1]!))];
    if (!failing.length) return text;
    return `Failing: ${failing.slice(0, 10).join(", ")}${failing.length > 10 ? ` and ${failing.length - 10} more` : ""}.`;
  }
}
/** Run the same intake evaluator, omitting only checks whose facts require a PR body/accountability. */
export function structuralIntake(
  files: ChangedFile[],
  labels: string[] = [],
  config: CategoriesFile = DEFAULT_CATEGORIES,
) {
  const added = files.find(
    (file) => file.status === "A" && file.path !== ".changes/README.md" && /^\.changes\/[^/]+\.md$/.test(file.path),
  );
  let category = "";
  try {
    category = parseChangeEntry(added?.content ?? "", added?.path).category;
  } catch {
    /* Intake reports the malformed entry. */
  }
  const size = sizeClass(files.reduce((sum, file) => sum + file.additions + file.deletions, 0));
  const body =
    category && added
      ? `<!-- agentbros:pr\ncategory: ${category}\nsize: ${size}\nissue: 1\nautonomy: human\nharness: other\nmodel: structural\nowner: structural\nchange: ${added.path}\n-->`
      : "";
  const result = intake(
    { prBody: body, changedFiles: files, authorTier: 3, cla: true, openPrCount: 1, labels },
    config,
  );
  return { ...result, findings: result.findings.filter((finding) => finding.gate !== "G0") };
}
export async function checkContribution(
  options: {
    root: string;
    base?: string;
    category?: string;
    body?: string;
    context?: string;
    skip?: string[];
    only?: string[];
    timeoutMin?: number;
  },
  runner: GateRunner = runGate,
  config = DEFAULT_CATEGORIES,
): Promise<ContributionEvidence> {
  const { root } = options;
  gateTimeoutMs([], options.timeoutMin);
  const base = contributionBase(root, options.base),
    head = commitOf(root, "HEAD");
  const dirtyBefore = uncommittedCode(root);
  const files = changedFiles(root, base);
  const entries = files.filter(
    (file) => file.status === "A" && file.path !== ".changes/README.md" && /^\.changes\/[^/]+\.md$/.test(file.path),
  );
  const categories = contributionCategories(files, options.category, config);
  if (!entries.length)
    emitProgress(
      "Warning: missing committed .changes entry. Run pnpm change:add, review the entry, then make a local commit before pnpm contrib:check.",
    );
  if (dirtyBefore.length)
    emitProgress(
      `Warning: dirty working tree (${dirtyBefore.join(", ")}). Make a local commit including the change:add entry before pnpm contrib:check; intake reads committed changes.`,
    );
  const planned = contributionGates(categories, base, options.body, options.context, config);
  // A category gate identical to an always-on gate (lint, typecheck) would run the same command twice.
  const commonCommands = new Set(
    planned.filter((gate) => !gate.name.startsWith("category:")).map((gate) => gate.command.join(" ")),
  );
  const plan = planned.filter(
    (gate) => !gate.name.startsWith("category:") || !commonCommands.has(gate.command.join(" ")),
  );
  const names = new Set(plan.map((gate) => gate.name));
  for (const name of [...(options.skip ?? []), ...(options.only ?? [])])
    if (!names.has(name)) throw new Error(`Unknown gate: ${name}`);
  const evidence: ContributionEvidence = {
    version: 1,
    base,
    head,
    categories,
    gates: [],
    notVerified: plan.map((gate) => gate.name),
    dirtyPaths: dirtyBefore,
  };
  const save = () => {
    evidence.dirtyPaths = [...new Set([...dirtyBefore, ...uncommittedCode(root)])].sort();
    const warning =
      "Committed HEAD: gates ran with uncommitted source/configuration or tracked changes. Make a local commit, then rerun contrib:check.";
    if (evidence.dirtyPaths.length && !evidence.notVerified.includes(warning)) evidence.notVerified.push(warning);
    ContributionEvidenceSchema.parse(evidence);
    mkdirSync(path.join(root, ".contrib"), { recursive: true });
    const file = path.join(root, ".contrib/evidence.json");
    writeFileSync(`${file}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  };
  save();
  for (const gate of plan) {
    if (options.skip?.includes(gate.name) || (options.only?.length && !options.only.includes(gate.name))) continue;
    const started = Date.now();
    const timeoutMs = gateTimeoutMs(gate.command, options.timeoutMin);
    emitProgress(`Starting ${gate.name} (timeout ${timeoutMs / 60000} min): ${gate.command.join(" ")}`);
    let result: CommandResult;
    try {
      if (gate.name === "contrib:intake" && !options.body) {
        const context = IntakeContextSchema.parse(
          options.context ? JSON.parse(readFileSync(path.resolve(root, options.context), "utf8")) : {},
        );
        const structural = structuralIntake(files, context.labels, config);
        result = {
          exitCode: structural.findings.some((row) => row.severity === "block") ? 1 : 0,
          stdout: JSON.stringify({
            ok: !structural.findings.length,
            message:
              structural.findings.map((row) => row.message).join("; ") ||
              "Structural intake passed; PR body and accountability not verified",
          }),
          stderr: "",
        };
        evidence.notVerified.push("PR body, CLA, trust tier and open-PR limits");
      } else result = await runner(gate.command, root, timeoutMs);
    } catch (error) {
      result = { exitCode: 1, stdout: "", stderr: String(error) };
    }
    evidence.gates.push({
      name: gate.name,
      command: gate.command,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      summary: summary(result),
    });
    evidence.notVerified = evidence.notVerified.filter((name) => name !== gate.name);
    save();
    emitProgress(`Finished ${gate.name}: exit ${result.exitCode}, ${Date.now() - started} ms — ${summary(result)}`);
    if (result.interrupted) break;
  }
  return evidence;
}
