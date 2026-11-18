/**
 * What commands record in memory on their own: metrics lines and the delivery episode. Best-effort throughout: a memory
 * failure never fails the command, it comes back as a warning string for stderr and `metadata.memoryWarning`.
 * `root` is the workspace root (memory/ and public/projects/ under it; AGENTBROS_MEMORY_ROOT still wins for memory).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { MemoryMetricSchema, type MemoryEntry, type MemoryMetric } from "../../types/memory";
import { OperationStore } from "../jobs/store";
import { loadPlaybook, readProjectPlaybook } from "../playbooks/project";
import { addMemory, loadMemory, memoryDir, METRICS_FILE, recordMetric } from "./index";

export type MetricInput = Omit<MemoryMetric, "at" | "playbook"> & { at?: string; playbook?: string };

const CHECKOUT_MEMORY = path.resolve(import.meta.dirname, "..", "..", "..", "memory");
const projectDir = (projectId: string, root?: string) => path.resolve(root ?? process.cwd(), "public/projects", projectId);
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The project's bound playbook (pipeline/playbook.json), or undefined when unbound or unreadable. */
export function projectPlaybook(projectId: string, root?: string): string | undefined {
  try {
    return readProjectPlaybook(projectDir(projectId, root))?.id;
  } catch {
    return undefined;
  }
}

const same = (a: Omit<MemoryMetric, "at">, b: Omit<MemoryMetric, "at">) => a.project === b.project && a.event === b.event && a.step === b.step && a.value === b.value && a.detail === b.detail;

/**
 * Appends one metrics line; the playbook comes from the project's binding. With `once`, nothing is written when a line
 * with the same project, event, step, value and detail exists (checked under the memory lock): the detail carries the key.
 * Returns a warning instead of throwing.
 */
export function noteMetric(metric: MetricInput, root?: string, options: { once?: boolean } = {}): string | undefined {
  if (process.env.NODE_TEST_CONTEXT && !process.env.AGENTBROS_MEMORY_ROOT && memoryDir(root) === CHECKOUT_MEMORY) return `memory: the ${metric.event} metric was not recorded: a test may not write this checkout's memory/`;
  try {
    const playbook = metric.playbook ?? projectPlaybook(metric.project, root);
    const line: MemoryMetric = { ...metric, at: metric.at ?? new Date().toISOString(), ...(playbook ? { playbook } : {}), ...(metric.detail ? { detail: metric.detail.slice(0, 200) } : {}) };
    recordMetric(line, root, options.once ? { once: (existing) => same(existing, line) } : {});
    return undefined;
  } catch (error) {
    return `memory: the ${metric.event} metric was not recorded: ${reason(error)}`;
  }
}

/** film:approve. A proxy decision is not the user's verdict, so it records nothing. */
export function noteApproval(projectId: string, step: string, options: { proxy?: boolean } = {}, root?: string): string | undefined {
  if (options.proxy) return undefined;
  return noteMetric({ project: projectId, step, event: "approved" }, root);
}

/** film:done on a critic or creative-review step: value is the rounds used, read from the latest round's file name; once per count. */
export function noteRound(projectId: string, step: string, latestPath: string | undefined, root?: string): string | undefined {
  const rounds = Number(/(\d+)\.json$/.exec(latestPath ?? "")?.[1] ?? 0);
  return noteMetric({ project: projectId, step, event: "round", value: rounds }, root, { once: true });
}

/** film:measure and motion:check failures: the sensor and what failed. */
export function noteSensorFail(projectId: string, sensor: string, failing: readonly string[], options: { step?: string } = {}, root?: string): string | undefined {
  return noteMetric({ project: projectId, ...(options.step ? { step: options.step } : {}), event: "sensor-fail", value: failing.length, detail: `${sensor}: ${failing.join(", ")}` }, root);
}

/** project:remove and workspace:clean --scope projects: from here on the id's earlier lines belong to a deleted project. */
export function noteRemoved(projectId: string, root?: string): string | undefined {
  return noteMetric({ project: projectId, event: "removed" }, root);
}

/** A settled charge: value in USD, once per operation and receipt. */
export function noteSpend(projectId: string, usd: number, operationId: string, receiptId: string, root?: string): string | undefined {
  return noteMetric({ project: projectId, event: "spend", value: usd, detail: `operation ${operationId} receipt ${receiptId}` }, root, { once: true });
}

/** A project id from the first path under public/projects/<id>/, src/projects/<id>/ or out/<id>/ whose project exists. */
export function projectFromPaths(paths: readonly (string | undefined)[], root?: string): string | undefined {
  const base = path.resolve(root ?? process.cwd());
  for (const item of paths) {
    if (!item) continue;
    const relative = path.relative(base, path.resolve(base, item)).split(path.sep).join("/");
    const match = /^(?:public\/projects|src\/projects|out)\/([a-z0-9][a-z0-9-]*)\//.exec(relative);
    if (match && existsSync(projectDir(match[1]!, root))) return match[1];
  }
  return undefined;
}

/** Every valid metrics line of the current project with this id, in order: lines before its last `removed` tombstone were a deleted project's. */
export function readMetrics(projectId: string, root?: string): MemoryMetric[] {
  const file = path.join(memoryDir(root), METRICS_FILE);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = MemoryMetricSchema.safeParse(JSON.parse(line));
        return parsed.success && parsed.data.project === projectId ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  let start = 0;
  lines.forEach((metric, index) => {
    if (metric.event === "removed") start = index + 1;
  });
  return lines.slice(start);
}

function settledUsd(projectId: string, metrics: readonly MemoryMetric[], root?: string): number {
  try {
    const store = new OperationStore(projectId, { directory: path.join(projectDir(projectId, root), "pipeline") });
    if (existsSync(store.file)) return store.summary().settledUsd;
  } catch {
    // fall back to the spend lines
  }
  return metrics.filter((metric) => metric.event === "spend").reduce((sum, metric) => sum + (metric.value ?? 0), 0);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Drafts the project's episode from measured data, once: written only when no episode names this project. The summary
 * holds the playbook's title and numbers, never the project's own names. Returns the entry, or undefined when one exists.
 */
export function draftEpisode(projectId: string, root?: string): MemoryEntry | undefined {
  if (loadMemory(root).entries.some((entry) => entry.type === "episode" && entry.scope.project === projectId)) return undefined;
  const metrics = readMetrics(projectId, root);
  const playbook = projectPlaybook(projectId, root);
  let title = "Unbound film";
  if (playbook) {
    try {
      title = loadPlaybook(playbook).title;
    } catch {
      title = playbook;
    }
  }
  const delivered = metrics.filter((metric) => metric.event === "delivered").at(-1);
  const formats = /formats: ([a-z, ]+)/.exec(delivered?.detail ?? "")?.[1]?.split(", ").filter(Boolean) ?? [];
  const roundsByStep = new Map<string, number>();
  for (const metric of metrics) if (metric.event === "round" && metric.step) roundsByStep.set(metric.step, Math.max(roundsByStep.get(metric.step) ?? 0, metric.value ?? 0));
  const rounds = [...roundsByStep.values()].reduce((sum, value) => sum + value, 0);
  const count = (event: MemoryMetric["event"]) => metrics.filter((metric) => metric.event === event).length;
  const spend = settledUsd(projectId, metrics, root);
  const summary = `${title} delivered${formats.length ? ` in ${formats.join(", ")}` : ""}: ${plural(rounds, "review round")}, ${plural(count("approved"), "approval")}, $${spend.toFixed(2)} settled spend`.slice(0, 160);
  const body = [
    `Formats: ${formats.join(", ") || "unknown"}; outputs: ${delivered?.value ?? "unknown"}.`,
    `Review rounds by step: ${[...roundsByStep].map(([step, value]) => `${step} ${value}`).join(", ") || "none"}.`,
    `Approvals ${count("approved")}, rejections ${count("rejected")}, sensor failures ${count("sensor-fail")}, workarounds ${count("workaround")}.`,
    `Settled spend: $${spend.toFixed(2)}.`,
  ].join("\n");
  // One id per project, whatever the day: two deliveries racing past midnight collide on it under the memory lock.
  const day = (metrics[0]?.at ?? new Date().toISOString()).slice(0, 10).replaceAll("-", "");
  const slug = projectId.length <= 79 ? projectId : createHash("sha1").update(projectId).digest("hex").slice(0, 12);
  try {
    return addMemory(
      {
        id: `episode-${day}-${slug}`,
        type: "episode",
        summary,
        body,
        scope: { project: projectId, ...(playbook ? { playbooks: [playbook] } : {}) },
        source: { kind: "measured", evidence: `pnpm delivery --action check; memory/${METRICS_FILE}; public/projects/${projectId}/pipeline/operations.json` },
      },
      root,
    );
  } catch (error) {
    if (error instanceof CliErrorObject && error.code === "FILE_EXISTS") return undefined;
    throw error;
  }
}

/** A production-ready delivery: the delivered metric once per snapshot (value: media outputs, detail: formats), then the episode once. */
export function noteDelivered(projectId: string, outputs: number, formats: readonly string[], snapshotId: string, root?: string): string | undefined {
  const warning = noteMetric({ project: projectId, event: "delivered", value: outputs, detail: `formats: ${formats.join(", ")}; snapshot ${snapshotId.slice(0, 16)}` }, root, { once: true });
  try {
    draftEpisode(projectId, root);
    return warning;
  } catch (error) {
    return [warning, `memory: the episode was not drafted: ${reason(error)}`].filter(Boolean).join("; ");
  }
}
