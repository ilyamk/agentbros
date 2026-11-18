import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boundedFile } from "../apple/runtime";
import {
  WorkflowReportSchema,
  WorkflowScenarioSchema,
  type WorkflowFinding,
  type WorkflowReport,
} from "../../types/workflow-evaluation";
import { command, contained, digest, fail, writeJson } from "./io";
import { captureWorkflowSource } from "./workflow-source";
import { WORKFLOW_SUITE, workflowScenarios } from "./workflow-scenarios";
import { WorkflowObserver } from "./workflow-observer";
import { workflowReport } from "./workflow-report";
import { stageWorkflowMaterial } from "./workflow-fixtures";
import { workflowAdapter } from "./workflow-adapters";
import { workflowAgent, type WorkflowAgentOptions } from "./workflow-agent";

export function nativeModelRefusal(event: WorkflowReport["events"][number] | undefined): boolean {
  if (!event || event.kind !== "command" || event.passed) return false;
  try {
    const result = JSON.parse(event.stdout ?? "{}");
    return result.ok === false && result.error === "STAGE_INCOMPLETE" && result.details?.code === "MODEL_REFUSAL";
  } catch {
    return false;
  }
}

export interface WorkflowRunOptions {
  root: string;
  scenario?: string;
  mode?: WorkflowReport["mode"];
  suite?: string;
  dryRun?: boolean;
  noSpend?: boolean;
  agent?: WorkflowAgentOptions;
  signal?: AbortSignal;
}
export async function runWorkflowEvaluation(options: WorkflowRunOptions) {
  const root = realpathSync(options.root),
    mode = options.mode ?? "contract";
  const entries = workflowScenarios(root, options.suite ?? WORKFLOW_SUITE).filter(
    (e) => !options.scenario || options.scenario === "all" || e.scenario.id === options.scenario,
  );
  if (!entries.length) fail("Unknown workflow scenario");
  const noSpend = !!options.noSpend || entries.some((e) => e.noSpend);
  if (noSpend && mode === "agent") fail("The no-spend policy forbids agent mode before any harness probe or launch");
  const commit = command("git", ["rev-parse", "--verify", "HEAD^{commit}"], root);
  if (mode === "agent" && (!options.agent?.allowAgent || !options.agent.model?.trim()))
    fail("Agent mode requires explicit --allow-agent, --harness and --model. Harness usage may be billed.");
  for (const entry of entries)
    if (
      mode === "agent" &&
      entry.profile &&
      (entry.profile.harness !== options.agent?.harness || entry.profile.model !== options.agent?.model)
    )
      fail("Harness/model differs from the registered workflow profile");
  const plan = {
    mode,
    noSpend,
    commit,
    scenarios: entries.map((e) => ({
      id: e.scenario.id,
      sha256: e.sha256,
      suiteVersion: e.suiteVersion,
      profile: e.profile,
      limits: e.scenario.limits,
    })),
    suite: options.suite ?? WORKFLOW_SUITE,
  };
  if (options.dryRun) return { outputs: [], metadata: { ...plan, dryRun: true } };
  mkdirSync(path.join(root, "out/bench"), { recursive: true, mode: 0o700 });
  const source = captureWorkflowSource(root);
  const fixtureHarness =
    mode === "agent" && !!process.env[`BENCH_HARNESS_BIN_${options.agent!.harness.replaceAll("-", "_").toUpperCase()}`];
  if (mode === "agent" && !fixtureHarness && source.dirty)
    fail("Real-agent evaluation requires a clean, committed trusted source tree");
  const campaign = mkdtempSync(path.join(root, "out/bench/workflow-"));
  writeJson(path.join(campaign, "campaign.json"), { ...plan, source: { sha256: source.sha256, dirty: source.dirty } });
  writeJson(path.join(campaign, "source-inventory.json"), source.files);
  const reports: WorkflowReport[] = [],
    outputs: string[] = [];
  for (const entry of entries) {
    if (options.signal?.aborted) break;
    const evidence = path.join(campaign, entry.scenario.id),
      worktree = mode === "agent";
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
    const workspace = worktree
      ? path.join(root, ".cache/bench/worktrees", path.basename(campaign), entry.scenario.id)
      : realpathSync(mkdtempSync(path.join(tmpdir(), "avc-workflow-")));
    let added = false;
    let observer: WorkflowObserver;
    try {
      if (worktree) {
        mkdirSync(path.dirname(workspace), { recursive: true });
        command("git", ["worktree", "add", "--detach", workspace, commit], root);
        added = true;
        if (existsSync(path.join(root, "node_modules")))
          symlinkSync(path.join(root, "node_modules"), path.join(workspace, "node_modules"), "dir");
      }
      observer = new WorkflowObserver(root, workspace, evidence, entry.scenario, source, options.signal);
    } catch (error) {
      if (added) command("git", ["worktree", "remove", "--force", workspace], root);
      else if (!worktree) rmSync(workspace, { recursive: true, force: true });
      throw error;
    }
    const findings: WorkflowFinding[] = [],
      limitations: string[] = [];
    let observedTokens: WorkflowReport["metrics"]["observedTokens"] = null;
    let outcome: string | undefined,
      harness: WorkflowReport["harness"] = null,
      tokens: WorkflowReport["metrics"]["tokens"] = null;
    try {
      writeFileSync(path.join(evidence, "scenario.json"), entry.bytes, { flag: "wx", mode: 0o600 });
      const adapter = workflowAdapter(entry.scenario);
      if (!adapter)
        findings.push({
          boundary: "observation",
          status: "inconclusive",
          message: "No independent oracle is registered for this scenario.",
        });
      else if (entry.scenario.modes && !entry.scenario.modes.includes(mode))
        findings.push({
          boundary: "environment",
          status: "skipped",
          message: "This scenario does not apply to " + mode + " mode.",
        });
      else if (mode === "agent" && process.platform === "win32")
        findings.push({
          boundary: "environment",
          status: "skipped",
          message: "Agent IPC launchers and owned process-group cleanup are not qualified on Windows.",
        });
      else if (!entry.scenario.platforms.includes(process.platform as "darwin" | "linux" | "win32"))
        findings.push({
          boundary: "environment",
          status: "skipped",
          message: "Scenario does not support this platform.",
        });
      else {
        await stageWorkflowMaterial(observer);
        const discovery = await observer.execute("commands", ["--query", "local:capabilities"]);
        if (!discovery.event.passed) fail("Public command discovery failed");
        if (mode === "contract") {
          const result = await adapter.contract(observer);
          outcome = result.outcome;
          if (result.skip) findings.push({ boundary: "environment", status: "skipped", message: result.skip });
        } else if (mode === "native") {
          const result = adapter.native
            ? await adapter.native(observer)
            : { skip: "No installed-native adapter is registered." };
          outcome = result.outcome;
          if (result.skip) findings.push({ boundary: "environment", status: "skipped", message: result.skip });
        } else if (!adapter.agent) {
          findings.push({
            boundary: "observation",
            status: "inconclusive",
            message:
              "This scenario has deterministic contract coverage; a real-agent terminal oracle is not yet registered. No harness was started.",
          });
        } else {
          const result = await workflowAgent(observer, {
            ...options.agent!,
            expectedHarnessVersion: entry.profile?.harnessVersion,
            signal: options.signal,
          });
          harness = result.harness;
          tokens = result.tokens;
          observedTokens = result.observedTokens;
          if (harness.fixture)
            limitations.push("Trusted executable override: this is a fake harness trial, not real-agent acceptance.");
          if (result.observationError)
            findings.push({ boundary: "observation", status: "failed", message: result.observationError });
          if (!result.tokens)
            findings.push({
              boundary: "harness",
              status: "inconclusive",
              message: "Harness did not report usage; the observed shared token bound is unknown.",
            });
          if (result.result.status !== "completed" || !result.tracesComplete || result.tokenLimitExceeded)
            findings.push({
              boundary: "harness",
              status: "failed",
              message: result.tokenLimitExceeded
                ? `Shared observed token limit exceeded: ${JSON.stringify(result.observedTokens)} against ${entry.scenario.limits.tokens}.`
                : `Harness did not finish within the shared limits: ${result.result.status}; complete traces=${result.tracesComplete}.`,
            });
          if (entry.scenario.requiresLeaf && !result.childTrace)
            findings.push({
              boundary: "observation",
              status: "inconclusive",
              message: "A real child harness trace with observed execution is missing.",
            });
          outcome = await adapter.agent(observer, result.observedChildren);
        }
      }
    } catch (error) {
      const last = observer.events.at(-1);
      const modelRefusal = mode === "native" && nativeModelRefusal(last);
      const boundary =
        error instanceof Error && error.message.startsWith("Trusted source")
          ? "observation"
          : last?.kind === "discovery"
            ? "discovery"
            : last?.kind === "validation"
              ? "validation"
              : last?.kind === "consumption"
                ? "consumption"
                : last?.kind === "preparation"
                  ? "preparation"
                  : "execution";
      findings.push({
        boundary: modelRefusal ? "quality" : boundary,
        status: modelRefusal ? "inconclusive" : "failed",
        message: error instanceof Error ? error.message.slice(0, 4000) : "Workflow evaluation failed",
      });
    } finally {
      observer.stop();
      if (worktree) command("git", ["worktree", "remove", "--force", workspace], root);
      else rmSync(workspace, { recursive: true, force: true });
    }
    if (outcome && !entry.scenario.outcomes.includes(outcome as (typeof entry.scenario.outcomes)[number]))
      findings.push({
        boundary: "validation",
        status: "failed",
        message: "Terminal outcome differs from the registered scenario contract.",
      });
    const report = workflowReport(observer, {
      scenarioSha256: entry.sha256,
      mode,
      commit,
      outcome,
      findings,
      harness,
      tokens,
      observedTokens,
      limitations,
      noSpend,
    });
    const file = path.join(evidence, "report.json");
    writeJson(file, report);
    reports.push(report);
    outputs.push(path.relative(root, file));
  }
  const counts = {
    passed: reports.filter((r) => r.status === "passed").length,
    failed: reports.filter((r) => r.status === "failed").length,
    skipped: reports.filter((r) => r.status === "skipped").length,
    inconclusive: reports.filter((r) => r.status === "inconclusive").length,
  };
  writeJson(path.join(campaign, "summary.json"), {
    version: entries.some((e) => e.scenario.version === 3) ? 3 : 2,
    ...plan,
    counts,
    reports: outputs,
  });
  return {
    outputs: [...outputs, path.relative(root, path.join(campaign, "summary.json"))],
    metadata: {
      ...plan,
      counts,
      completed: counts.failed === 0 && counts.inconclusive === 0 && !options.signal?.aborted,
      accepted: reports.length > 0 && counts.passed === reports.length && !options.signal?.aborted,
      cancelled: options.signal?.aborted ?? false,
    },
  };
}

/** Integrity/replay checks treat recordings as data and never execute their argv or submitted code. */
export function checkWorkflowEvidence(directory: string) {
  const root = realpathSync(directory),
    report = WorkflowReportSchema.parse(
      JSON.parse(boundedFile(path.join(root, "report.json"), 16 * 1024 * 1024).toString()),
    );
  const bytes = boundedFile(path.join(root, "scenario.json"), 1024 * 1024);
  if (digest(bytes) !== report.scenarioSha256) fail("Recorded scenario hash differs from the registered run");
  const scenario = WorkflowScenarioSchema.parse(JSON.parse(bytes.toString()));
  if (
    scenario.id !== report.scenario ||
    scenario.seed !== report.seed ||
    (report.outcome && !scenario.outcomes.includes(report.outcome as (typeof scenario.outcomes)[number]))
  )
    fail("Recorded scenario identity or outcome differs from its contract");
  let pins = 0;
  for (const event of report.events)
    for (const pin of [...event.inputs, ...event.outputs]) {
      const blob = boundedFile(contained(root, "blobs/" + pin.sha256), 67108864);
      if (blob.length !== pin.bytes || digest(blob) !== pin.sha256) fail("Recorded artefact bytes changed");
      pins++;
    }
  return {
    outputs: [],
    metadata: {
      integrity: true,
      scenario: report.scenario,
      recordedStatus: report.status,
      pins,
      executionAuthenticity: "not-established",
      limitations: ["Local recording integrity does not authenticate its author or rerun a real agent."],
    },
  };
}
