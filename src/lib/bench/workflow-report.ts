import { WorkflowReportSchema, type WorkflowFinding, type WorkflowReport } from "../../types/workflow-evaluation";
import { runtimeStatus } from "../runtime";
import type { WorkflowObserver } from "./workflow-observer";

export function workflowReport(
  observer: WorkflowObserver,
  options: {
    scenarioSha256: string;
    mode: WorkflowReport["mode"];
    commit: string;
    outcome?: string;
    findings?: WorkflowFinding[];
    harness?: WorkflowReport["harness"];
    tokens?: WorkflowReport["metrics"]["tokens"];
    observedTokens?: WorkflowReport["metrics"]["observedTokens"];
    limitations?: string[];
    noSpend?: boolean;
  },
): WorkflowReport {
  const findings = [...(options.findings ?? [])],
    commands = observer.events.filter((e) => e.kind === "command" || e.kind === "discovery");
  for (const event of observer.events)
    if (event.exitCode === null && !event.passed)
      findings.push({ boundary: "prerequisites", status: "failed", message: event.detail, eventId: event.id });
  if (
    observer.scenario.requiresLeaf &&
    !findings.some((f) => f.status === "skipped") &&
    !observer.events.some((e) => e.actor !== "root" && e.passed && e.kind === "command")
  )
    findings.push({
      boundary: "observation",
      status: "inconclusive",
      message: "Required leaf execution has no independently captured child command trace.",
    });
  if (!options.outcome && !findings.length)
    findings.push({
      boundary: "consumption",
      status: "inconclusive",
      message: "No independently validated terminal outcome.",
    });
  const signatures = commands.map((e) => JSON.stringify([e.actor, e.command, e.argv]));
  const status = findings.some((f) => f.status === "failed")
    ? "failed"
    : findings.some((f) => f.status === "inconclusive")
      ? "inconclusive"
      : findings.some((f) => f.status === "skipped")
        ? "skipped"
        : "passed";
  const runtime = runtimeStatus();
  return WorkflowReportSchema.parse({
    version: observer.scenario.version,
    ...(observer.scenario.version === 3
      ? {
          noSpend: options.noSpend ?? false,
          layers: {
            ...Object.fromEntries(
              ["contract", "native", "agent", "quality"].map((layer) => [
                layer,
                {
                  status: "skipped",
                  reason:
                    layer === "agent" && options.noSpend
                      ? "Harness evaluation is forbidden by the no-spend policy."
                      : layer === "quality"
                        ? "No independently reviewed quality corpus was evaluated."
                        : "Not executed in this campaign.",
                },
              ]),
            ),
            [options.mode]: {
              status,
              reason: options.outcome
                ? "Observed terminal outcome: " + options.outcome
                : findings
                    .map((f) => f.message)
                    .join("; ")
                    .slice(0, 2000) || "No validated outcome.",
            },
          },
        }
      : {}),
    protocol: "agent-workflow",
    runId: observer.runId,
    scenario: observer.scenario.id,
    scenarioSha256: options.scenarioSha256,
    source: observer.source
      ? { sha256: observer.source.sha256, dirty: observer.source.dirty }
      : { sha256: "0".repeat(64), dirty: true },
    mode: options.mode,
    status,
    outcome: options.outcome ?? null,
    commit: options.commit,
    seed: observer.scenario.seed,
    runtime: { version: runtime.actual, executable: runtime.executable, role: runtime.role },
    harness: options.harness ?? null,
    findings,
    events: observer.events,
    metrics: {
      commands: commands.length,
      failedCommands: commands.filter((e) => !e.passed).length,
      repeatedCommands: signatures.length - new Set(signatures).size,
      actors: new Set(observer.events.map((e) => e.actor)).size,
      elapsedMs: performance.now() - observer.started,
      tokens: options.tokens ?? null,
      observedTokens: options.observedTokens ?? null,
      observedMediaSpendUsd: 0,
      pendingOwnedCommands: observer.activeProcesses,
      orphanProcesses: null,
    },
    limitations: [
      "Assertions accept equivalent routes; only causal artefact dependencies require ordering.",
      "Recorded executions and consumers are observed by the trusted local evaluator. This is not an OS isolation boundary; direct harness actions outside the observer are not certified.",
      "Orphan processes outside the tracked executor groups are not measured; pendingOwnedCommands counts direct owned commands that have not closed.",
      "Model content quality and human production approval are separate from protocol acceptance.",
      ...(options.mode === "contract"
        ? ["Fixture backends test contracts; no real-agent tool selection or installed-model quality is established."]
        : []),
      ...(options.limitations ?? []),
    ],
  });
}
