/**
 * Builds a pending {@link Decision} (RFC 0004 §6.3) from what the user would look at. Its id is deterministic:
 * `<kind>-<step>-<16 hex>` over (project, kind, step, every bound path and sha256), so it is stable across refreshes
 * and changes as soon as a bound file changes. `createdAt` is the newest bound file's mtime, never the clock.
 */
import path from "node:path";
import { decisionExpect } from "../expect";
import { DecisionSchema, type Decision, type DecisionKind, type MediaRef, type Quote } from "../../../types/console";
import { STRATEGY_DOCUMENTS } from "../../../types/console-document";
import {
  bindingFile,
  bindingPath,
  canonicalHash,
  hashFile,
  locate,
  mediaKind,
  statOf,
  toIso,
  type ProjectPaths,
} from "./files";

export type Binding = { path: string; sha256: string };

/** Bindings for files the user sees (absolute or root-relative); files outside the project and `out/<id>/` are left out. */
export function bindFiles(paths: ProjectPaths, files: Iterable<string>): Binding[] {
  const bindings = new Map<string, Binding>();
  for (const file of files) {
    const where = locate(paths, file);
    if (!where) continue;
    const binding = bindingPath(where);
    const hash = hashFile(bindingFile(paths, binding));
    if (hash) bindings.set(binding, { path: binding, sha256: hash });
  }
  return [...bindings.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The deterministic decision id. `round` (above 0 once the user asked for changes at this step) makes a new gate
 * round a new decision even when its files did not change (WP5: a decided id never runs twice).
 */
export function decisionId(
  project: string,
  kind: DecisionKind,
  step: string,
  bindTo: readonly Binding[],
  round = 0,
): string {
  const sorted = [...bindTo].sort((a, b) => a.path.localeCompare(b.path)).map((b) => [b.path, b.sha256]);
  const digest = canonicalHash({ project, kind, step, bindTo: sorted, ...(round > 0 ? { round } : {}) }).slice(0, 16);
  const safeStep = step.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "step";
  return `${kind}-${safeStep}-${digest}`;
}

/** Media refs for the bound files the console can show. */
export function mediaOf(bindTo: readonly Binding[], step: string): MediaRef[] {
  return bindTo.flatMap((binding): MediaRef[] => {
    const kind =
      step === "strategy" && STRATEGY_DOCUMENTS.some((file) => file === binding.path)
        ? "document"
        : mediaKind(binding.path);
    if (!kind) return [];
    const out = binding.path.startsWith("@out/");
    return [
      {
        ...(out ? { root: "out" as const } : {}),
        path: out ? binding.path.slice(5) : binding.path,
        kind,
        label: path.posix.basename(binding.path).slice(0, 160),
        sha256: binding.sha256,
      },
    ];
  });
}

export type DecisionInput = {
  project: string;
  kind: DecisionKind;
  step: string;
  title: string;
  summary?: string;
  bindTo: Binding[];
  options?: Decision["options"];
  quote?: Quote;
  cardId?: string;
  recommendation?: Decision["recommendation"];
  /** Media beyond the bound files (a card's own media). */
  media?: MediaRef[];
  /** Overrides the bound files' newest mtime (a card's createdAt). */
  createdAt?: string;
  /** How many times the user asked for changes at this step (part of the id). */
  round?: number;
};

/** A pending decision, or undefined when it would not validate (the caller adds an advisory). */
export function pendingDecision(paths: ProjectPaths, input: DecisionInput): Decision | undefined {
  const newest = Math.max(0, ...input.bindTo.map((b) => statOf(bindingFile(paths, b.path))?.mtimeMs ?? 0));
  const media = input.media ?? mediaOf(input.bindTo, input.step);
  const decision = {
    v: 1 as const,
    id: decisionId(input.project, input.kind, input.step, input.bindTo, input.round),
    project: input.project,
    kind: input.kind,
    step: input.step.slice(0, 64),
    title: input.title.slice(0, 200),
    ...(input.summary ? { summary: input.summary.slice(0, 2000) } : {}),
    ...(input.recommendation ? { recommendation: input.recommendation } : {}),
    bindTo: input.bindTo.slice(0, 64),
    expect: decisionExpect({ bindTo: input.bindTo.slice(0, 64), ...(input.quote ? { quote: input.quote } : {}) }),
    ...(media.length ? { media: media.slice(0, 48) } : {}),
    ...(input.options?.length ? { options: cleanOptions(input.options).slice(0, 24) } : {}),
    ...(input.quote ? { quote: input.quote } : {}),
    ...(input.cardId ? { cardId: input.cardId } : {}),
    status: "pending" as const,
    createdAt: input.createdAt ?? toIso(newest),
  };
  const parsed = DecisionSchema.safeParse(decision);
  return parsed.success ? parsed.data : undefined;
}

type Option = NonNullable<Decision["options"]>[number];

/**
 * Options the contract accepts: ids made safe and unique (a repeated option is dropped, a clashing id gets a suffix), an
 * empty label replaced by the id, an empty argv dropped. One bad option never drops the whole decision; `onIssue` hears
 * each repair (for an advisory).
 */
export function cleanOptions(options: readonly Option[], onIssue?: (message: string) => void): Option[] {
  const out: Option[] = [];
  const seen = new Map<string, string>();
  for (const option of options) {
    if (!option.argv.length) {
      onIssue?.(`option ${option.id || "(no id)"} has no command; left out`);
      continue;
    }
    const argvKey = JSON.stringify(option.argv);
    let id = optionId(option.id);
    if (seen.has(id)) {
      if (seen.get(id) === argvKey) {
        onIssue?.(`option ${id} appears twice; kept once`);
        continue;
      }
      let n = 2;
      while (seen.has(`${id.slice(0, 120)}-${n}`)) n++;
      onIssue?.(`option id ${id} is used twice; the second is ${id.slice(0, 120)}-${n}`);
      id = `${id.slice(0, 120)}-${n}`;
    }
    seen.set(id, argvKey);
    const label = option.label.trim() ? option.label.slice(0, 160) : id.slice(0, 160);
    if (!option.label.trim()) onIssue?.(`option ${id} has no label; its id is shown`);
    out.push({ ...option, id, label, argv: option.argv.slice(0, 64) });
  }
  return out;
}

/** An option id from free text (`idea-a`, `candidate-3`). */
export const optionId = (value: string): string =>
  (value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "option").slice(0, 128);
