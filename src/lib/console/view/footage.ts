/**
 * The user's own recording (footage route) as the console shows it: `footageNext` (src/lib/footage/next.ts) with
 * `save: false`, so nothing is written; steps in `STEP` order with the current one; decisions from its `ask` answers
 * (the recut plan's edit hash, shorts, caption style, a paid transcription's quote). Read-only.
 */
import path from "node:path";
import type { Decision, StepRow, StepStatus } from "../../../types/console";
import { footageNext, footageNextWithState, STEP, type FootageNext, type FootageState } from "../../footage/next";
import { normaliseAnswer, splitCommand } from "./argv";

/** The projector's stand-in for the user's words in a derived argv (actions.ts runs it with the words in place). */
const ANSWER = "<the user's words>";
import { bindFiles, optionId, pendingDecision } from "./decision";
import { canonicalHash, type ProjectPaths } from "./files";
import { nextArgv, type QuoteContext } from "./film";

export const readFootage = (paths: ProjectPaths): FootageNext =>
  footageNext(paths.id, { rootDir: paths.rootDir, save: false });

/** footage:next's answer with the state it decided from (the panels' material is read from that state). */
export const readFootageWithState = (paths: ProjectPaths): { next: FootageNext; state: FootageState } =>
  footageNextWithState(paths.id, { rootDir: paths.rootDir, save: false });

const ORDER = Object.values(STEP).map(([id, title]) => ({ id, title }));

export function footageSteps(next: FootageNext, starts: Map<string, string>, now: number): StepRow[] {
  const index = ORDER.findIndex((step) => step.id === next.step);
  const finished = next.step === STEP.done[0];
  return ORDER.map((step, position): StepRow => {
    const status: StepStatus =
      finished || (index >= 0 && position < index)
        ? "done"
        : position === index
          ? next.action === "ask"
            ? "awaiting-gate"
            : next.action === "stop"
              ? "blocked"
              : "running"
          : "pending";
    const started = starts.get(step.id);
    return {
      id: step.id,
      title: step.title,
      status,
      reasons: position === index ? [next.why.slice(0, 2000)] : [],
      ...(step.id === STEP.approve[0] || step.id === STEP.shorts[0] ? { gate: true } : {}),
      ...(started ? { startedAt: new Date(started).toISOString() } : {}),
      ...(started && position === index && !finished ? { durationMs: Math.max(0, now - Date.parse(started)) } : {}),
    };
  });
}

export const footageCurrent = (next: FootageNext) =>
  next.step === STEP.done[0]
    ? undefined
    : {
        step: next.step,
        next: {
          argv: next.argv?.[0]?.slice(0, 64) ?? nextArgv(next),
          why: next.why.slice(0, 2000),
        },
      };

/** Every plain `pnpm` command of `thenRun` except the loop's own `footage:next`, with the user's words as placeholder. */
function optionsOf(next: FootageNext) {
  return (next.thenRun ?? [])
    .map((command) => splitCommand(command))
    .filter((argv): argv is string[] => !!argv && argv[1] !== "footage:next" && argv[1] !== "project:new")
    .slice(0, 24)
    .map((argv, index) => ({
      id: optionId(`${argv[1]}-${index + 1}`),
      label: (next.answers?.[index] ?? `Run ${argv[1]}`).slice(0, 160),
      argv: normaliseAnswer(argv).slice(0, 64),
    }));
}

/** The decisions a recording waits on, from footage:next's `ask` (FR2). */
export function footageWaiting(
  next: FootageNext,
  paths: ProjectPaths,
  money: QuoteContext,
): { decisions: Decision[]; advisories: string[] } {
  if (next.action !== "ask") return { decisions: [], advisories: [] };
  const state = next.state as { request?: { file?: string; planFile?: string | null; planHash?: string | null } };
  const shown = [
    ...(next.show ?? []),
    ...(next.step === STEP.approve[0] && state.request?.file ? [state.request.file] : []),
    ...(next.step === STEP.approve[0] && state.request?.planFile ? [state.request.planFile] : []),
  ].map((file) => (path.isAbsolute(file) ? file : path.resolve(paths.rootDir, file)));
  const bindTo = bindFiles(paths, shown);
  const options = optionsOf(next);
  const summary = (next.question ?? next.why).slice(0, 2000);
  const base = { project: paths.id, step: next.step, bindTo, summary };
  let decision: Decision | undefined;
  if (next.step === STEP.approve[0]) {
    const hash = state.request?.planHash;
    // The console's approval is `recut:plan --approve` with the hash derived here (never the client's); it runs only
    // with the console grant, so an agent cannot record it (src/lib/footage/approve.ts). The user's other path stays
    // footage:next's: write the review into the request by hand.
    decision = pendingDecision(paths, {
      ...base,
      kind: "gate",
      title: `Approve the recut plan${hash ? ` (edit hash ${hash.slice(0, 12)})` : ""}`,
      summary: `${summary.slice(0, 1700)}\n\nApproving records that you watched the whole source and that no cut changes the meaning.`,
      ...(hash
        ? {
            options: [
              {
                id: optionId("approve"),
                label: "Approve the edit hash",
                argv: ["pnpm", "recut:plan", "--project", paths.id, "--approve", hash, "--answer", ANSWER],
              },
            ],
          }
        : {}),
    });
  } else if (next.cost) {
    const amountUsd = next.cost.expectedUsd;
    const ceiling = money.ceilingUsd;
    const quote = {
      amountUsd,
      provider: next.cost.model.split(":")[0]!.slice(0, 64) || "unknown",
      endpoint: next.cost.model.slice(0, 256),
      maxAdmissibleUsd: money.maxAdmissibleUsd,
      budgetAfterUsd:
        ceiling !== undefined && amountUsd !== null
          ? Math.max(0, Math.round((ceiling - money.reservedUsd - money.spentUsd - amountUsd) * 1e6) / 1e6)
          : null,
      ceilingUsd: ceiling ?? null,
      summary: `${next.cost.minutes} min at list price (${next.cost.source}, ${next.cost.asOf}).`.slice(0, 240),
    };
    decision = pendingDecision(paths, {
      ...base,
      kind: "quote",
      title: `${next.title}: paid transcription`.slice(0, 200),
      quote: { ...quote, quoteHash: canonicalHash({ quote, bindTo: bindTo.map((b) => [b.path, b.sha256]) }) },
      options: options.map((option) => ({ ...option, consequential: true })),
    });
  } else {
    decision = pendingDecision(paths, {
      ...base,
      kind: next.step === STEP.shorts[0] || next.step === STEP.captions[0] ? "choice" : "gate",
      title: next.title.slice(0, 200),
      options,
    });
  }
  return decision
    ? { decisions: [decision], advisories: [] }
    : { decisions: [], advisories: [`waiting: the decision at ${next.step} could not be built.`] };
}
