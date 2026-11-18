/**
 * The bespoke film chain as the console shows it (RFC 0004 §6.2, FR2): steps and statuses exactly as `deriveChain`
 * derives them (the same rows `film:status` prints), the current step and its next command from `nextAction`, and the
 * decisions waiting for the user, derived from that state, never from the journal. Read-only.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { artefactsExpect } from "../../film/expect";
import { REVISE_TARGET } from "../../feedback/step";
import { listFeedback } from "../../feedback/store";
import { ConceptSchema, CritiqueSchema } from "../../../types/creative";
import { MaterialSchema, MusicShortlistSchema } from "../../../types/film";
import { NarrationDirectionSchema } from "../../../types/narration";
import type { Decision, Quote, StepRow } from "../../../types/console";
import { stepById } from "../../film/chain";
import {
  approvalEvents,
  deriveChain,
  nextAction,
  openFilmProject,
  readSkip,
  type ChainState,
  type FilmProject,
  type NextAction,
  type StepState,
} from "../../film/state";
import { FileMemo } from "../../file-memo";
import { critiqueTotal } from "../../film/versions";
import {
  feedbackFileArgv,
  filmApproveArgv,
  memoryChangesArgv,
  filmRightsArgv,
  filmSkipArgv,
  musicRecordArgv,
  normaliseAnswer,
  splitCommand,
  type Argv,
} from "./argv";
import { bindFiles, cleanOptions, optionId, pendingDecision, type Binding } from "./decision";
import { canonicalHash, readJsonFile, text, type ProjectPaths } from "./files";
import { rubricAxes } from "./film-material";

export type FilmRead = {
  project: FilmProject;
  chain: ChainState;
  next: NextAction;
};

/** One hash memo per project directory, kept across view builds so an unchanged render is not re-read. */
const filmHashMemos = new Map<string, FileMemo<string>>();
const hashMemoFor = (projectDir: string): FileMemo<string> => {
  let memo = filmHashMemos.get(projectDir);
  if (!memo) {
    if (filmHashMemos.size >= 256) filmHashMemos.delete(filmHashMemos.keys().next().value!);
    filmHashMemos.set(projectDir, (memo = new FileMemo<string>(2048)));
  }
  return memo;
};

/** Opens the film and derives its chain and next action once (both read only). */
export function readFilm(paths: ProjectPaths): FilmRead {
  const project = openFilmProject(paths.projectDir, {
    rootDir: paths.rootDir,
    hashMemo: hashMemoFor(paths.projectDir),
  });
  const chain = deriveChain(project);
  const next = nextAction(project);
  return { project, chain, next };
}

/** The hash `--expect` carries and film:approve compares: the step's outputs' content (src/lib/film/expect.ts). */
export const outputsHash = (outputs: Record<string, string>): string => artefactsExpect(Object.values(outputs));

/** When a step closed: its receipt, its newest approval, or its skip. */
function closedAt(project: FilmProject, state: StepState): string | undefined {
  if (state.status !== "done" && state.status !== "skipped") return undefined;
  const times: string[] = [];
  const receipt = readJsonFile(path.join(project.projectDir, "pipeline", "chain", `${state.id}.json`)) as
    { at?: unknown } | undefined;
  if (typeof receipt?.at === "string") times.push(receipt.at);
  for (const event of approvalEvents(project, state.id)) times.push(event.at);
  const skip = readSkip(project, state.id);
  if (skip) times.push(skip.at);
  const valid = times.filter((time) => !Number.isNaN(Date.parse(time))).sort((a, b) => Date.parse(a) - Date.parse(b));
  return valid.length ? new Date(valid.at(-1)!).toISOString() : undefined;
}

function criticOf(state: StepState): StepRow["critic"] {
  if (!state.critic) return undefined;
  const parsed = state.critic.latest ? CritiqueSchema.safeParse(state.critic.latest) : undefined;
  return {
    round: Math.max(0, state.critic.round),
    ...(parsed?.success ? { score: critiqueTotal(parsed.data) } : {}),
    action: state.critic.action,
  };
}

/** Step rows: `deriveChain`'s ids, statuses and reasons verbatim, plus title, owner, gate and durations. */
export function filmSteps(film: FilmRead, starts: Map<string, string>, now: number): StepRow[] {
  return film.chain.steps.slice(0, 128).map((state) => {
    const step = stepById(state.id);
    const started = starts.get(state.id);
    const closed = closedAt(film.project, state);
    const current = film.chain.current?.id === state.id;
    const startedMs = started ? Date.parse(started) : undefined;
    const durationMs =
      startedMs === undefined
        ? undefined
        : closed
          ? Math.max(0, Date.parse(closed) - startedMs)
          : current
            ? Math.max(0, now - startedMs)
            : undefined;
    const critic = criticOf(state);
    return {
      id: state.id,
      title: (step?.title ?? state.id).slice(0, 160),
      status: state.status,
      reasons: state.reasons.slice(0, 64).map((reason) => reason.slice(0, 2000)),
      ...(step?.owner ? { owner: step.owner.slice(0, 128) } : {}),
      ...(step?.skippable ? { skippable: true } : {}),
      ...(step?.gate === "user" ? { gate: true } : {}),
      ...(started && (!closed || Date.parse(closed) >= startedMs!)
        ? { startedAt: new Date(started).toISOString() }
        : {}),
      ...(closed ? { closedAt: closed } : {}),
      ...(durationMs !== undefined && (!closed || Date.parse(closed) >= startedMs!) ? { durationMs } : {}),
      ...(critic ? { critic } : {}),
    };
  });
}

/** The first plain `pnpm …` command of the next action, as argv. */
export function nextArgv(next: { commands?: string[]; thenRun?: string[]; briefCommand?: string }): Argv {
  for (const command of [
    ...(next.thenRun ?? []),
    ...(next.commands ?? []),
    ...(next.briefCommand ? [next.briefCommand] : []),
  ]) {
    const argv = splitCommand(command);
    if (argv) return argv.slice(0, 64);
  }
  return [];
}

export function filmCurrent(film: FilmRead) {
  const current = film.chain.current;
  // The step the next command acts on: nextAction's own step (a guard or a pending gate can sit before the chain's
  // first open step), else the chain's current step, so the step and its command always agree.
  const id = film.next.step ?? current?.id;
  if (!id) return undefined;
  const step = stepById(id);
  return {
    step: id,
    ...(step?.owner ? { owner: step.owner.slice(0, 128) } : {}),
    next: { argv: nextArgv(film.next), why: film.next.why.slice(0, 2000) },
  };
}

// --- Waiting decisions ---

/**
 * The verdict's rubric axes (D24): the project's frozen creative rubric (src/lib/film/creative-rubric.ts), the same
 * axes `view.film.human.rubric` carries and the verdict form offers.
 */
export const VERDICT_AXES: readonly string[] = rubricAxes();

export function verdictAxes(_film?: FilmRead): string[] {
  return [...VERDICT_AXES];
}

const PROVIDERS = ["fal", "elevenlabs", "higgsfield", "openai", "replicate", "google", "runway", "kling", "luma"];

/** The provider a material item's provenance names, when it names one we know; never invented. */
function providerIn(provenance: string): string | undefined {
  const lower = provenance.toLowerCase();
  return PROVIDERS.find((provider) => new RegExp(`(^|[^a-z])${provider}([^a-z]|$)`).test(lower));
}

export type QuoteContext = {
  ceilingUsd?: number;
  reservedUsd: number;
  spentUsd: number;
  maxAdmissibleUsd: number | null;
};

function finishQuote(
  base: { amountUsd: number | null; provider: string; endpoint?: string; summary?: string },
  bindTo: readonly Binding[],
  money: QuoteContext,
): Quote {
  const budgetAfterUsd =
    money.ceilingUsd !== undefined && base.amountUsd !== null
      ? Math.max(0, Math.round((money.ceilingUsd - money.reservedUsd - money.spentUsd - base.amountUsd) * 1e6) / 1e6)
      : null;
  const quote = {
    amountUsd: base.amountUsd,
    provider: base.provider.slice(0, 64),
    ...(base.endpoint ? { endpoint: base.endpoint.slice(0, 256) } : {}),
    maxAdmissibleUsd: money.maxAdmissibleUsd,
    budgetAfterUsd,
    ceilingUsd: money.ceilingUsd ?? null,
    ...(base.summary ? { summary: base.summary.slice(0, 240) } : {}),
  };
  return { ...quote, quoteHash: canonicalHash({ quote, bindTo: bindTo.map((b) => [b.path, b.sha256]) }) };
}

/** Material's paid quote: pending generated items. A single item without `maxCostUsd` makes the amount unknown. */
function materialQuote(film: FilmRead, bindTo: Binding[], money: QuoteContext): Quote | undefined {
  const material = MaterialSchema.safeParse(
    readJsonFile(path.join(film.project.projectDir, "pipeline", "material.json")),
  );
  if (!material.success) return undefined;
  const paid = material.data.items.filter((item) => item.route === "generated" && item.status !== "acquired");
  if (!paid.length) return undefined;
  const unknown = paid.some((item) => item.maxCostUsd === undefined);
  const amountUsd = unknown ? null : Math.round(paid.reduce((sum, item) => sum + item.maxCostUsd!, 0) * 1e6) / 1e6;
  const providers = [...new Set(paid.map((item) => providerIn(item.provenance) ?? "unknown"))];
  const endpoints = [
    ...new Set(paid.flatMap((item) => /\b([a-z0-9-]+\/[a-z0-9._/-]+)/i.exec(item.provenance)?.[1] ?? [])),
  ];
  return finishQuote(
    {
      amountUsd,
      provider: providers.length === 1 ? providers[0]! : "several",
      ...(endpoints.length === 1 ? { endpoint: endpoints[0] } : {}),
      summary: `${paid.length} generated item(s)${unknown ? ", at least one without a price bound: unknown price" : ""}.`,
    },
    bindTo,
    money,
  );
}

/** Narration's paid quote: the ElevenLabs route before its takes exist; exposure is the bound per take × spoken beats. */
function narrationQuote(film: FilmRead, bindTo: Binding[], money: QuoteContext): Quote | undefined {
  const pipeline = path.join(film.project.projectDir, "pipeline");
  const direction = NarrationDirectionSchema.safeParse(readJsonFile(path.join(pipeline, "narrator-direction.json")));
  if (!direction.success || direction.data.route !== "elevenlabs") return undefined;
  if (readJsonFile(path.join(pipeline, "narration.json")) !== undefined) return undefined;
  const beats = direction.data.beats.length;
  const amountUsd =
    direction.data.maxCostUsd !== undefined && beats > 0
      ? Math.round(direction.data.maxCostUsd * beats * 1e6) / 1e6
      : null;
  return finishQuote(
    {
      amountUsd,
      provider: "elevenlabs",
      endpoint: direction.data.modelId,
      summary: `${beats} take(s) at up to ${direction.data.maxCostUsd ?? "an unknown amount"} USD each.`,
    },
    bindTo,
    money,
  );
}

/**
 * A new round of a step's question after each change the user asked there: feedback items routed to the step or its
 * revise owner, and the console's applied decisions at the step (a change kept in memory reopens nothing).
 */
export function feedbackRound(projectDir: string, stepId: string): number {
  const targets = new Set([stepId, REVISE_TARGET[stepId] ?? stepId]);
  const items = listFeedback(projectDir).reduce(
    (count, record) => count + record.items.filter((item) => targets.has(String(item.routedTo))).length,
    0,
  );
  return items + appliedAt(projectDir, stepId);
}

/** The console's applied (or partly applied) decisions at a step, from `pipeline/inbox/` (WP5). */
function appliedAt(projectDir: string, stepId: string): number {
  const dir = path.join(projectDir, "pipeline", "inbox");
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const value = readJsonFile(path.join(dir, name)) as { step?: unknown; status?: unknown } | undefined;
    if (value?.step === stepId && (value.status === "applied" || value.status === "partial")) count++;
  }
  return count;
}

/** Whether the next action's commands record the answer with film:approve. */
const approves = (next: NextAction) => (next.thenRun ?? []).some((command) => /\bfilm:approve\b/.test(command));

export type FilmWaiting = { decisions: Decision[]; advisories: string[] };

type Option = NonNullable<Decision["options"]>[number];

/**
 * "Ask for changes". Once the film is rendered, feedback reopens the owning step (the console writes the user's words
 * as a feedback file); before that no command reopens a gate on the user's words, so they are kept in the memory.
 */
const changesOption = (paths: ProjectPaths, step: string): Option => ({
  id: "changes",
  label: "Ask for changes",
  argv: existsSync(path.join(paths.outDir, "film.mp4"))
    ? feedbackFileArgv(paths.id)
    : memoryChangesArgv(paths.id, step),
});

/** The plain pnpm commands of `thenRun`, with the chain's placeholder for the user's words normalised. */
function thenRunOptions(next: NextAction): Option[] {
  return (next.thenRun ?? [])
    .map((command) => splitCommand(command))
    .filter((argv): argv is string[] => argv !== undefined && argv[1] !== "film:next" && argv[1] !== "film:done")
    .slice(0, 22)
    .map((argv) => ({
      id: argv[1] === "feedback" && argv.includes("--clarify") ? "clarify" : optionId(argv[1]!),
      label: argv[1] === "feedback" && argv.includes("--clarify") ? "Say exactly what you want" : `Run ${argv[1]}`,
      argv: normaliseAnswer(argv).slice(0, 64),
    }));
}

/** The guard's stop: a limit is reached; the user raises it (film:policy --raise, their words) or asks for changes. */
function presentBest(next: NextAction, paths: ProjectPaths): Decision | undefined {
  const raise = (next.raise ?? []).flatMap((command, index): Option[] => {
    const argv = splitCommand(command);
    if (!argv) return [];
    const limit = next.limits?.[index];
    const value = argv[argv.indexOf("--raise") + 1] ?? "";
    return [
      {
        id: optionId(`raise-${limit?.name ?? index + 1}`),
        label: `Raise ${value.replace("=", " to ")}`.slice(0, 160),
        argv: normaliseAnswer(argv).slice(0, 64),
        consequential: true,
      },
    ];
  });
  const limits = (next.limits ?? []).map((limit) => `${limit.name} ${limit.used}/${limit.max}`).join(", ");
  return pendingDecision(paths, {
    project: paths.id,
    kind: "gate",
    step: "present-best",
    title: (next.title ?? "A limit is reached: decide how to go on").slice(0, 200),
    summary: [next.why, limits ? `Limits: ${limits}.` : "", next.spend ? `Spent $${next.spend.usedUsd}.` : ""]
      .filter(Boolean)
      .join("\n"),
    // The policy is bound too: after a raise, a later stop on the same best version is a new decision.
    bindTo: bindFiles(paths, [
      ...(next.best ? [next.best.file] : []),
      ...(next.show ?? []),
      path.join(paths.projectDir, "pipeline", "policy.json"),
    ]),
    options: [...raise, changesOption(paths, "present-best")],
  });
}

/** The decisions a film waits on, from `nextAction` and the chain state (FR2): every user question is one. */
export function filmWaiting(film: FilmRead, paths: ProjectPaths, money: QuoteContext): FilmWaiting {
  const { next, chain } = film;
  const project = paths.id;
  const advisories: string[] = [];
  const built = (decision: Decision | undefined, where: string): FilmWaiting => {
    if (!decision) advisories.push(`waiting: the decision at ${where} could not be built.`);
    return { decisions: decision ? [decision] : [], advisories };
  };
  if (next.action === "stop" && next.step === "present-best") {
    // The policy cannot be read: nothing to decide in the console, the file must be fixed.
    if (!next.limits?.length) {
      advisories.push(`The agent stops: ${next.why}`.slice(0, 2000));
      return { decisions: [], advisories };
    }
    return built(presentBest(next, paths), "present-best");
  }
  if (next.action !== "ask" || !next.step) return { decisions: [], advisories };
  const state = chain.steps.find((item) => item.id === next.step);
  const step = stepById(next.step);
  if (!state || !step) return { decisions: [], advisories };
  const shown = [...Object.keys(state.outputs), ...(next.show ?? [])];
  const bindTo = bindFiles(paths, shown);
  const expect = outputsHash(state.outputs);
  const question = next.question?.slice(0, 2000);
  const round = feedbackRound(paths.projectDir, step.id);
  const base = { project, step: step.id, bindTo, ...(question ? { summary: question } : {}), round };
  const skip: Option[] =
    step.skippable && !state.firstAsk
      ? [{ id: "skip", label: `Skip ${step.title.toLowerCase()}`.slice(0, 160), argv: filmSkipArgv(project, step.id) }]
      : [];
  const changes = changesOption(paths, step.id);

  if (state.firstAsk && step.id === "music") {
    const issues: string[] = [];
    const options = cleanOptions(
      musicCandidates(paths).map((candidate) => ({
        id: optionId(`candidate-${candidate.id}`),
        label: `${candidate.title ?? ""}${candidate.creator ? ` — ${candidate.creator}` : ""}`.trim().slice(0, 160),
        argv: musicRecordArgv(project, candidate.route, candidate.id),
      })),
      (issue) => issues.push(issue),
    ).slice(0, 24);
    if (issues.length) advisories.push(`music shortlist: ${issues.join("; ")}.`.slice(0, 2000));
    return built(pendingDecision(paths, { ...base, kind: "choice", title: "Choose the music", options }), step.id);
  }
  if (step.id === "rights")
    return built(
      pendingDecision(paths, {
        ...base,
        kind: "choice",
        title: "Rights to the film we copy",
        options: (["owned", "licensed", "study-only"] as const).map((status) => ({
          id: status,
          label: status === "owned" ? "It is my film" : status === "licensed" ? "I have a licence" : "Study only",
          argv: filmRightsArgv(project, status),
        })),
      }),
      step.id,
    );
  if (!approves(next)) {
    // A question the chain asks without film:approve: a repeated objection (feedback --clarify), a fixer that made no
    // progress within its rounds, … The user's answer goes through the command it names, else as feedback.
    const options = [...thenRunOptions(next), ...(next.thenRun?.length ? [] : [changes])];
    return built(
      pendingDecision(paths, {
        ...base,
        kind: "gate",
        title: (question ? `${step.title}: your answer is needed` : `${step.title}: decide how to go on`).slice(0, 200),
        summary: [question, next.why].filter(Boolean).join("\n"),
        options,
      }),
      step.id,
    );
  }
  if (step.id === "human") {
    const axes = verdictAxes(film);
    return built(
      pendingDecision(paths, {
        ...base,
        kind: "verdict",
        title: "Final verdict on the film",
        summary: [question, `Rubric axes (1–10): ${axes.join(", ")}.`].filter(Boolean).join("\n"),
        // No approve option (WP10b): the verdict is given only on the film.human form (score, axes, texts, frame
        // comments, D24); asking for changes instead stays on the card (WP3).
        options: [changes],
      }),
      step.id,
    );
  }
  if (step.id === "concept" && !state.critic) {
    const concept = ConceptSchema.safeParse(readJsonFile(path.join(paths.projectDir, "pipeline", "concept.json")));
    const candidates = concept.success ? concept.data.candidates : [];
    return built(
      pendingDecision(paths, {
        ...base,
        kind: "choice",
        title: "Choose the idea",
        options: [
          ...candidates.slice(0, 23).map((candidate) => ({
            id: optionId(`idea-${candidate.id}`),
            label: (text(candidate.title, 160) ?? candidate.id).slice(0, 160),
            // The pick is recorded: concept.json's selectedId becomes this idea (film:approve --choice).
            argv: filmApproveArgv(project, step.id, expect, candidate.id),
          })),
          changes,
        ],
        ...(concept.success
          ? { recommendation: { by: step.owner, text: `Recommended: idea ${concept.data.selectedId}.` } }
          : {}),
      }),
      step.id,
    );
  }
  const quote =
    step.id === "material"
      ? materialQuote(film, bindTo, money)
      : step.id === "narration"
        ? narrationQuote(film, bindTo, money)
        : undefined;
  const pastCritic = Boolean(state.critic && state.critic.action === "ask");
  // No command raises a critic's or a fixer's round limit: "another round" is the user's feedback ("changes").
  return built(
    pendingDecision(paths, {
      ...base,
      kind: quote ? "quote" : "gate",
      title: (pastCritic
        ? `${step.title}: go on past the critic?`
        : quote
          ? `Approve ${step.title.toLowerCase()} and its cost`
          : `Approve ${step.title.toLowerCase()}`
      ).slice(0, 200),
      ...(quote ? { quote } : {}),
      options: [
        {
          id: "approve",
          label: pastCritic ? "Go on with this version" : "Approve",
          argv: filmApproveArgv(project, step.id, expect),
          ...(quote ? { consequential: true } : {}),
        },
        changes,
        ...skip,
      ],
    }),
    step.id,
  );
}

/** The music shortlist's candidates, read leniently: one malformed candidate never hides the others. */
function musicCandidates(paths: ProjectPaths): { id: string; route: string; title?: string; creator?: string }[] {
  const raw = readJsonFile(path.join(paths.projectDir, "pipeline", "music-shortlist.json")) as
    { candidates?: unknown } | undefined;
  const strict = MusicShortlistSchema.safeParse(raw);
  const list = strict.success ? strict.data.candidates : Array.isArray(raw?.candidates) ? raw.candidates : [];
  return list.flatMap((item) => {
    const candidate = item as { id?: unknown; route?: unknown; title?: unknown; creator?: unknown };
    if (typeof candidate.id !== "string" || !candidate.id.trim() || typeof candidate.route !== "string") return [];
    return [
      {
        id: candidate.id,
        route: candidate.route,
        ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
        ...(typeof candidate.creator === "string" && candidate.creator ? { creator: candidate.creator } : {}),
      },
    ];
  });
}
