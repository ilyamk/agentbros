/**
 * Applying the user's decision (RFC 0004 D9, FR3, FR5): `POST /api/projects/:id/decisions`.
 *
 * Under a per-project lock: a decision already decided returns its first outcome (no second spawn); otherwise the
 * pending decision is found again in the CURRENT derived state (by id, or by kind and step), refused with 409 when it
 * is gone or superseded or when the request's `expect` is not the hash of what is bound now; the action table
 * (actions.ts) builds the exact argv from that decision, the user's choice and words; the owning CLI runs with
 * `AGENTBROS_ACTOR=user AGENTBROS_CHANNEL=console`; the inbox file records request, argv, envelope and status; the
 * journal gets `decision.applied` or `decision.refused`. A refused CLI result is returned verbatim.
 *
 * Who can call it: only the console server, after its Host, exact-Origin, session token and CSRF-header checks (D15).
 * No MCP tool or CLI applies a decision (D17). The token lives in `out/console/session.json` (mode 0600) and is
 * readable by any process of the same OS user, so an agent running as that user is kept out by policy and by
 * the absence of any agent-facing path, not by the operating system.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FRAME_NOTES_DIR,
  type CliEnvelope,
  type Decision,
  type DecisionRequest,
  type DecisionResponse,
  type InboxDecisionFile,
  InboxDecisionFileSchema,
} from "../../types/console";
import { detectRoute } from "../pipeline/route";
import { stepArtefact } from "../feedback/step";
import { listFeedback } from "../feedback/store";
import { artefactsExpect } from "../film/expect";
import { openFilmProject, stepState, type FilmProject } from "../film/state";
import { OperationStore } from "../jobs/store";
import { HttpError } from "../local-server/errors";
import { ANSWER_PLACEHOLDER, flagValue, planDecision, pnpmArgv, type ActionPlan, type CommandPlan } from "./actions";
import { decisionExpect } from "./expect";
import { archiveRefused, MAX_REFUSED_ATTEMPTS, readInbox, refusedAttempts, writeInbox } from "./inbox";
import { projectTarget, recordEvent } from "./journal";
import type { ConsoleActions } from "./data";
import type { ConsoleDocumentSave } from "../../types/console-document";
import { saveStrategyDocument } from "./documents";
import { needsIntent, removeIntent, writeIntent } from "./intent";
import { createSpawnCli, isAmbiguous, type SpawnCli } from "./spawn";
import { ulid } from "./ulid";
import {
  isUserInput,
  planUserInput,
  sameUserInput,
  USER_INPUT_WINDOW_MS,
  userInputEvidence,
  userInputId,
  type UserInputKind,
} from "./user-actions";

export interface ActionsDeps {
  /** The project's pending decisions, derived from its files now (WP3's `deriveWaiting`). */
  deriveWaiting(rootDir: string, project: string): Promise<Decision[]>;
  spawnCli: SpawnCli;
  now(): Date;
  /** The project's route (`film`, `footage`, …): how a quote is approved. */
  routeOf(rootDir: string, project: string): string;
  /**
   * The `--expect` hashes of a film step now (film:approve, feedback --step), or undefined when the project is not a
   * film; then the decision's own bindings stand in. Default: from the chain (film/expect.ts, feedback/step.ts).
   */
  stepExpects(rootDir: string, project: string, step: string): { approve?: string; feedback?: string } | undefined;
  /** The job store's ceiling now (a `policy` change that lowers it also runs `budget`); undefined without a store. */
  storeCeilingOf(rootDir: string, project: string): number | undefined;
  /** Environment the journal reads its switches from (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/** The job store's ceiling of a project, read without creating the store. */
export function defaultStoreCeilingOf(rootDir: string, project: string): number | undefined {
  const directory = path.join(rootDir, "public/projects", project, "pipeline");
  if (!existsSync(path.join(directory, "operations.json"))) return undefined;
  try {
    return new OperationStore(project, { directory }).ceilingUsd() ?? undefined;
  } catch {
    return undefined;
  }
}

export interface DecideOptions {
  /** Build and return the argv without running anything (`?dryRun=1`). */
  dryRun?: boolean;
}

/** The chain's own hashes of a film step: what film:approve and feedback --step compare `--expect` with. */
export function defaultStepExpects(
  rootDir: string,
  project: string,
  step: string,
): { approve?: string; feedback?: string } | undefined {
  let film: FilmProject;
  let outputs: Record<string, string>;
  try {
    film = openFilmProject(path.join(rootDir, "public/projects", project), { rootDir });
    outputs = stepState(film, step).outputs;
  } catch {
    return undefined;
  }
  let feedback: string | undefined;
  try {
    feedback = stepArtefact(film, step).expect;
  } catch {
    feedback = undefined;
  }
  const hashes = Object.values(outputs);
  return { ...(hashes.length ? { approve: artefactsExpect(hashes) } : {}), ...(feedback ? { feedback } : {}) };
}

export const defaultRouteOf = (rootDir: string, project: string): string =>
  detectRoute(path.join(rootDir, "public/projects", project)).route ?? "unknown";

const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  new HttpError(409, code, message, extra);
const unprocessable = (message: string) => new HttpError(422, "INVALID_INPUT", message);

/** The pending decision a request names, from the current derived state. */
function findPending(waiting: readonly Decision[], request: DecisionRequest): Decision | undefined {
  if (request.decisionId) return waiting.find((decision) => decision.id === request.decisionId);
  const kind = request.kind!;
  const matches = waiting.filter(
    (decision) =>
      (decision.kind === kind || (kind === "verdict" && decision.step === "human")) &&
      (request.step === undefined || decision.step === request.step),
  );
  if (matches.length > 1)
    throw new HttpError(422, "INVALID_INPUT", `Several ${kind} decisions are waiting: name one by decisionId.`);
  return matches[0];
}

/** Same request again: same decision, choice, words and payload (a double submit). */
const sameRequest = (decided: InboxDecisionFile, request: DecisionRequest) =>
  decided.answer === request.answer &&
  (decided.choice ?? null) === (request.choice ?? null) &&
  JSON.stringify(decided.verdict ?? null) === JSON.stringify(request.verdict ?? null) &&
  JSON.stringify(decided.frameComments ?? null) === JSON.stringify(request.frameComments ?? null);

const KIND_NOT_HERE: Partial<Record<string, string>> = {
  "card-answer": "Answer a card at /api/projects/:id/cards/:cardId/answer (WP11).",
};

/** Kinds whose request must carry `expect`: the user approves exactly what they reviewed (FR3). */
const EXPECT_REQUIRED = new Set(["quote", "gate", "verdict"]);

/** An implicit option's argv as the projector writes options: the words as the placeholder. */
const withPlaceholder = (argv: string[], words: string): string[] =>
  argv.map((token) => token.replace(`=${words}`, `=${ANSWER_PLACEHOLDER}`));

const aliasOf = (argv: readonly string[]) => (argv[0] === "pnpm" ? argv[1] : argv[0]);

/** The `--expect` of the decision's own film:approve option: the outputs hash derived with the bindings the user saw. */
const derivedApproveExpect = (decision: Decision): string | undefined => {
  for (const option of decision.options ?? [])
    if (aliasOf(option.argv) === "film:approve") {
      const value = flagValue(option.argv, "--expect");
      if (value) return value;
    }
  return undefined;
};

/**
 * Whether the chain shows that this decision's command applied (after a timeout or crash): film:approve leaves an
 * approval event with these exact words from the console, feedback --step an item with them. Nothing else counts:
 * a decision also disappears when its material changes or it is decided elsewhere.
 */
function appliedEvidence(rootDir: string, decision: Decision, words: string, alias: string): boolean {
  const projectDir = path.join(rootDir, "public/projects", decision.project);
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  };
  if (alias === "film:approve" && decision.step) {
    const value = readJson(path.join(projectDir, "pipeline/approvals", `${decision.step}.json`)) as
      { events?: { answer?: unknown; channel?: unknown }[] } | undefined;
    return (value?.events ?? []).some((event) => event.answer === words && event.channel === "console");
  }
  if (alias === "feedback")
    return listFeedback(projectDir).some(
      (record) => record.source.channel === "console" && record.items.some((item) => item.quote === words),
    );
  return false;
}

const primaryAlias = (decided: InboxDecisionFile) =>
  (decided.argv?.[0] === "pnpm" ? decided.argv[1] : decided.argv?.[0]) ?? "";

interface Ran {
  command: CommandPlan;
  argv: string[];
  envelope: CliEnvelope;
}

type FollowUp = { argv: string[]; ok: boolean; error?: string; message?: string; outputs?: unknown };

const followUpOf = (ran: Ran): FollowUp => ({
  argv: ran.argv,
  ok: ran.envelope.ok,
  ...(ran.envelope.error ? { error: ran.envelope.error } : {}),
  ...(ran.envelope.message ? { message: ran.envelope.message } : {}),
  ...(ran.envelope.outputs ? { outputs: ran.envelope.outputs } : {}),
});

const storedFollowUps = (decided: InboxDecisionFile): FollowUp[] => {
  const value = decided.result?.metadata?.["followUps"];
  return Array.isArray(value) ? (value as FollowUp[]) : [];
};

/** A frame note's files (2026-11-20), from the decisive command or a follow-up: what `console:wait` hands the agent. */
function frameNoteFiles(decided: InboxDecisionFile, followUps: readonly FollowUp[]): { note?: string; still?: string } {
  const files = [decided.result?.outputs, ...followUps.map((item) => item.outputs)]
    .flatMap((outputs) => (Array.isArray(outputs) ? outputs : []))
    .filter((file): file is string => typeof file === "string" && file.includes(`/${FRAME_NOTES_DIR}/`));
  const note = files.find((file) => file.endsWith(".json"));
  const still = files.find((file) => file.endsWith(".png"));
  return { ...(note ? { note } : {}), ...(still ? { still } : {}) };
}

const replyOf = (decided: InboxDecisionFile): DecisionResponse => ({
  ok: decided.status === "applied" && storedFollowUps(decided).every((item) => item.ok),
  decision: decided,
});

export function createDecisionActions(
  rootDir: string,
  deps: Partial<ActionsDeps> & Pick<ActionsDeps, "deriveWaiting">,
) {
  const spawnCli = deps.spawnCli ?? createSpawnCli();
  const now = deps.now ?? (() => new Date());
  const routeOf = deps.routeOf ?? defaultRouteOf;
  const stepExpects = deps.stepExpects ?? defaultStepExpects;
  const storeCeilingOf = deps.storeCeilingOf ?? defaultStoreCeilingOf;
  const locks = new Map<string, Promise<unknown>>();

  /** Runs `work` after every earlier apply of this project has finished. */
  const serialised = <T>(project: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(project) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    locks.set(project, settled);
    void settled.then(() => {
      if (locks.get(project) === settled) locks.delete(project);
    });
    return next;
  };

  async function run(project: string, command: CommandPlan): Promise<Ran> {
    let dir: string | undefined;
    try {
      const files = (command.attachments ?? []).map((attachment) => {
        dir ??= mkdtempSync(path.join(tmpdir(), "agentbros-console-"));
        const file = path.join(dir, attachment.name);
        writeFileSync(
          file,
          attachment.encoding === "base64" ? Buffer.from(attachment.content, "base64") : attachment.content,
          { mode: 0o600 },
        );
        return file;
      });
      const args = [...command.args, ...(command.attachments ?? []).flatMap((a, index) => [a.flag, files[index]!])];
      const { envelope } = await spawnCli({ rootDir, project, alias: command.alias, args });
      return { command, argv: pnpmArgv(command, files), envelope };
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  function journal(decision: InboxDecisionFile, plan: ActionPlan | undefined) {
    // An unknown outcome is not journalled until it is reconciled: it is neither applied nor refused.
    if (decision.status === "unknown" || decision.status === "pending" || decision.status === "superseded") return;
    const result = decision.result;
    const followUps = storedFollowUps(decision);
    recordEvent(
      projectTarget(rootDir, decision.project),
      {
        kind: decision.status === "refused" ? "decision.refused" : "decision.applied",
        project: decision.project,
        ...(decision.step ? { step: decision.step } : {}),
        actor: "user",
        channel: "console",
        ...(result ? { ok: result.ok && followUps.every((item) => item.ok) } : {}),
        ...(result?.error ? { error: result.error } : {}),
        ...(result?.message ? { message: result.message.slice(0, 2048) } : {}),
        data: {
          decisionId: decision.id,
          decisionKind: decision.kind,
          answer: decision.answer!,
          status: decision.status,
          ...(decision.choice ? { choice: decision.choice } : {}),
          ...(plan ? { action: plan.action, aliases: plan.commands.map((command) => command.alias) } : {}),
          ...(decision.verdict ? { score: decision.verdict.score } : {}),
          ...frameNoteFiles(decision, followUps),
        },
      },
      { env: deps.env ?? process.env },
    );
  }

  /** The envelope recorded for a decision: the decisive command's, with every follow-up's outcome and the hint. */
  function resultOf(first: CliEnvelope, followUps: FollowUp[], hint: string | undefined, extra = {}): CliEnvelope {
    if (!followUps.length && !hint && !Object.keys(extra).length) return first;
    return {
      ...first,
      metadata: {
        ...first.metadata,
        ...extra,
        ...(followUps.length ? { followUps } : {}),
        ...(hint ? { hint } : {}),
      },
    };
  }

  /** A partial decision retried with the same request: only the follow-ups that failed run again. */
  async function retryFollowUps(decided: InboxDecisionFile, request: DecisionRequest): Promise<DecisionResponse> {
    const plan = planDecision({
      project: decided.project,
      route: routeOf(rootDir, decided.project),
      decision: { ...decided, status: "pending" },
      request,
    });
    const stored = storedFollowUps(decided);
    const followUps: FollowUp[] = [];
    for (const [index, command] of plan.commands.slice(1).entries()) {
      const previous = stored[index];
      followUps.push(previous?.ok ? previous : followUpOf(await run(decided.project, command)));
    }
    const allOk = followUps.every((item) => item.ok);
    const retried: InboxDecisionFile = {
      ...decided,
      status: allOk ? "applied" : "partial",
      decidedAt: now().toISOString(),
      result: resultOf(
        { ...decided.result!, metadata: { ...decided.result!.metadata, followUps: undefined } },
        followUps,
        plan.hint,
      ),
    };
    writeInbox(rootDir, retried);
    journal(retried, plan);
    return replyOf(retried);
  }

  /**
   * What an earlier outcome of this id answers now: the stored outcome for the same request, 409 ALREADY_DECIDED for
   * another one, a retry of failed follow-ups for a partial, or undefined to go on (a refusal retried, or an unknown
   * outcome whose decision is still waiting).
   */
  async function earlier(decided: InboxDecisionFile, request: DecisionRequest): Promise<DecisionResponse | undefined> {
    // A refusal answers the same request again; other words are a retry.
    if (decided.status === "refused") return sameRequest(decided, request) ? replyOf(decided) : undefined;
    if (decided.status === "superseded")
      throw conflict(
        "SUPERSEDED",
        `This decision was replaced${decided.supersededBy ? ` by ${decided.supersededBy}` : ""}: the material changed. Look again.`,
        { decision: decided },
      );
    if (decided.status === "unknown") {
      // Without evidence in the chain, look again: still waiting runs again, gone answers 409 (stale or superseded).
      if (!appliedEvidence(rootDir, decided, decided.answer!, primaryAlias(decided))) return undefined;
      const reconciled: InboxDecisionFile = {
        ...decided,
        status: "applied",
        result: { ...decided.result!, metadata: { ...decided.result!.metadata, reconciled: true } },
      };
      writeInbox(rootDir, reconciled);
      journal(reconciled, undefined);
      decided = reconciled;
    }
    if (!sameRequest(decided, request))
      throw conflict(
        "ALREADY_DECIDED",
        `This decision was already decided (${decided.choice ?? decided.kind}, ${decided.status}): it does not run twice. Reload and look again.`,
        { decision: decided },
      );
    if (decided.status === "partial") return retryFollowUps(decided, request);
    return replyOf(decided);
  }

  /**
   * A decision the user starts (WP9): a rating or a frame comment. No pending decision stands behind it; its id is
   * derived from the client's `requestId` (or, without one, from what it says), so a retry returns the first outcome
   * instead of rating twice or reopening the build twice. A refused one runs again; an unknown one (timeout) is
   * reconciled with the project's files first. The CLI checks the file or render against `expect` itself. Recording
   * after the CLI applied is best-effort: the journal event and the reply never depend on the inbox write.
   */
  async function decideUserInput(
    project: string,
    request: DecisionRequest & { kind: UserInputKind },
    options: DecideOptions,
  ): Promise<DecisionResponse> {
    const plan = planUserInput(
      project,
      request,
      request.kind === "policy"
        ? { route: routeOf(rootDir, project), storeCeilingUsd: storeCeilingOf(rootDir, project) }
        : undefined,
    );
    const createdAt = now().toISOString();
    const id = userInputId(project, request);
    const base: Decision = {
      v: 1,
      id,
      project,
      ...plan.decision,
      answer: request.answer,
      actor: "user",
      channel: "console",
      status: "pending",
      createdAt,
    };
    const shape = InboxDecisionFileSchema.safeParse({
      ...base,
      status: "applied",
      decidedAt: createdAt,
      argv: pnpmArgv(plan.command),
      result: { ok: true },
    });
    if (!shape.success)
      throw unprocessable(`This decision cannot be recorded as asked: ${shape.error.issues[0]?.message ?? "invalid"}.`);
    if (options.dryRun) return { ok: true, decision: { ...base, argv: pnpmArgv(plan.command) } };

    const previous = readInbox(rootDir, project, id);
    if (previous) {
      if (request.requestId && !sameUserInput(previous, base))
        throw conflict(
          "ALREADY_DECIDED",
          `Request ${request.requestId} was already sent with other content: it does not run twice.`,
          { decision: previous },
        );
      const recent = now().getTime() - Date.parse(previous.decidedAt ?? previous.createdAt) <= USER_INPUT_WINDOW_MS;
      if (request.requestId || recent) {
        if (previous.status === "applied" || previous.status === "partial") return replyOf(previous);
        if (previous.status === "unknown" && userInputEvidence(rootDir, previous)) {
          const reconciled: InboxDecisionFile = {
            ...previous,
            status: "applied",
            result: { ...previous.result!, metadata: { ...previous.result!.metadata, reconciled: true } },
          };
          recordBestEffort(reconciled);
          journal(reconciled, undefined);
          return replyOf(reconciled);
        }
      }
      // A refusal, an unknown outcome without evidence, or (without a request id) the same words long after: run again,
      // keeping the earlier record beside it.
      if (previous.status === "refused" || previous.status === "unknown") archiveRefused(rootDir, project, id);
      else
        recordBestEffort({ ...previous, id: `${request.kind}-${ulid(Date.parse(previous.decidedAt ?? createdAt))}` });
    }
    const ran = await run(project, plan.command);
    const followUps: FollowUp[] = [];
    if (ran.envelope.ok)
      for (const command of plan.followUps ?? []) followUps.push(followUpOf(await run(project, command)));
    const status: InboxDecisionFile["status"] = ran.envelope.ok
      ? followUps.every((item) => item.ok)
        ? "applied"
        : "partial"
      : isAmbiguous(ran.envelope)
        ? "unknown"
        : "refused";
    const decided: InboxDecisionFile = {
      ...base,
      argv: ran.argv,
      status,
      decidedAt: now().toISOString(),
      result: resultOf(ran.envelope, followUps, undefined),
    };
    recordBestEffort(decided);
    journal(decided, undefined);
    return replyOf(decided);
  }

  /** Writes the record; on failure a trimmed one; never throws (the command already ran). */
  function recordBestEffort(decided: InboxDecisionFile): void {
    try {
      writeInbox(rootDir, decided);
      return;
    } catch {
      // too large or unwritable: try the short form
    }
    try {
      const result = decided.result;
      writeInbox(rootDir, {
        ...decided,
        ...(result
          ? {
              result: {
                ok: result.ok,
                ...(result.error ? { error: String(result.error).slice(0, 64) } : {}),
                ...(result.message ? { message: result.message.slice(0, 2048) } : {}),
              },
            }
          : {}),
      });
    } catch {
      // the journal event still says what happened
    }
  }

  async function decideLocked(
    project: string,
    request: DecisionRequest,
    options: DecideOptions,
  ): Promise<DecisionResponse> {
    if (isUserInput(request)) return decideUserInput(project, request, options);
    if (request.kind && KIND_NOT_HERE[request.kind] && !request.decisionId)
      throw new HttpError(501, "NOT_IMPLEMENTED", KIND_NOT_HERE[request.kind]!);
    let waiting: Decision[] | undefined;
    const derive = async () => (waiting ??= await deps.deriveWaiting(rootDir, project));

    if (request.decisionId && !options.dryRun) {
      const decided = readInbox(rootDir, project, request.decisionId);
      if (decided) {
        const reply = await earlier(decided, request);
        if (reply) return reply;
      }
    }
    const pending = findPending(await derive(), request);
    if (!pending) {
      const replaced =
        request.decisionId && request.kind
          ? waiting!.find((decision) => decision.kind === request.kind && decision.step === request.step)
          : undefined;
      if (replaced && request.decisionId && !options.dryRun && !readInbox(rootDir, project, request.decisionId)) {
        writeInbox(rootDir, {
          ...replaced,
          id: request.decisionId,
          status: "superseded",
          supersededBy: replaced.id,
          answer: request.answer,
          actor: "user",
          channel: "console",
          decidedAt: now().toISOString(),
          options: undefined,
          choice: undefined,
          argv: undefined,
          result: undefined,
        });
      }
      if (replaced)
        throw conflict("SUPERSEDED", `This decision was replaced by ${replaced.id}: the material changed. Look again.`);
      // Decision ids hash every bound file and the round (WP3), not the quote (a quote whose money alone changed keeps
      // its id and is refused by `expect` below): an id that is no longer derived means its material changed or it
      // was decided outside the console.
      throw conflict(
        request.decisionId ? "STALE" : "NOT_WAITING",
        request.decisionId
          ? `Decision ${request.decisionId} is no longer waiting: its material changed or it was decided elsewhere. Reload and look again.`
          : `No ${request.kind} decision is waiting${request.step ? ` at ${request.step}` : ""}.`,
      );
    }
    if (pending.project !== project) throw conflict("SUPERSEDED", "That decision belongs to another project.");
    if (!request.decisionId && !options.dryRun) {
      const decided = readInbox(rootDir, project, pending.id);
      if (decided) {
        const reply = await earlier(decided, request);
        if (reply) return reply;
      }
    }
    // `expect` is what the user reviewed: the hash over every bound file and the quote (expect.ts), exactly.
    const expect = pending.expect ?? decisionExpect(pending);
    if (request.expect === undefined && (EXPECT_REQUIRED.has(pending.kind) || !request.decisionId))
      throw unprocessable("Send `expect`, the decision's hash of what you reviewed: it is approved only unchanged.");
    if (request.expect !== undefined && request.expect !== expect)
      throw conflict("STALE", "What you saw has changed since: reload and look again before deciding.");

    const route = routeOf(rootDir, project);
    // The CLI re-checks the same snapshot: the outputs hash derived with the bindings the user saw.
    const approveExpect = derivedApproveExpect(pending);
    const feedbackExpect =
      approveExpect ??
      (route === "film" && pending.step ? stepExpects(rootDir, project, pending.step)?.feedback : undefined);
    const plan = planDecision({
      project,
      route,
      decision: pending,
      request,
      expects: {
        ...(approveExpect ? { approve: approveExpect } : {}),
        ...(feedbackExpect ? { feedback: feedbackExpect } : {}),
      },
    });
    const implicit =
      plan.choice && !pending.options?.some((option) => option.id === plan.choice)
        ? {
            id: plan.choice,
            label: plan.choice === "changes" ? "Ask for changes" : "One more round",
            argv: withPlaceholder(pnpmArgv(plan.commands[0]!), request.answer),
          }
        : undefined;
    const base: Decision = {
      ...pending,
      ...(implicit ? { options: [...(pending.options ?? []).slice(0, 23), implicit] } : {}),
      answer: request.answer,
      ...(plan.choice ? { choice: plan.choice } : {}),
      ...(request.verdict ? { verdict: request.verdict } : {}),
      ...(request.frameComments?.length ? { frameComments: request.frameComments } : {}),
      actor: "user",
      channel: "console",
    };
    // The record must be writable before anything runs: a decision that cannot be recorded is not applied.
    const shape = InboxDecisionFileSchema.safeParse({
      ...base,
      status: "applied",
      decidedAt: now().toISOString(),
      argv: pnpmArgv(plan.commands[0]!),
      result: { ok: true },
    });
    if (!shape.success)
      throw unprocessable(`This decision cannot be recorded as asked: ${shape.error.issues[0]?.message ?? "invalid"}.`);
    if (options.dryRun)
      return {
        ok: true,
        decision: {
          ...base,
          status: "pending" as const,
          argv: pnpmArgv(plan.commands[0]!),
        },
      };
    const previous = readInbox(rootDir, project, pending.id);
    if (previous?.status === "refused" && refusedAttempts(rootDir, project, pending.id) >= MAX_REFUSED_ATTEMPTS - 1)
      throw new HttpError(
        429,
        "TOO_MANY_ATTEMPTS",
        `This decision was refused ${MAX_REFUSED_ATTEMPTS} times: ask the agent what the command needs.`,
      );

    const [primary, ...rest] = plan.commands;
    // A command that records an approval itself runs only with the server's intent on disk (intent.ts, D15): written
    // here, under the project's lock, for exactly the argv about to be spawned, and removed when the child exits.
    const intent = needsIntent(primary!.alias) && !primary!.attachments?.length;
    if (intent) {
      try {
        writeIntent(rootDir, {
          project,
          decisionId: pending.id,
          alias: primary!.alias,
          args: primary!.args,
          now: now(),
        });
      } catch (error) {
        throw unprocessable(`The console could not record its intent for this decision: ${(error as Error).message}`);
      }
    }
    let first: Ran;
    try {
      first = await run(project, primary!);
    } finally {
      if (intent) removeIntent(rootDir, project, pending.id);
    }
    let status: InboxDecisionFile["status"];
    let extra: Record<string, unknown> = {};
    const followUps: FollowUp[] = [];
    if (first.envelope.ok) {
      for (const command of rest) followUps.push(followUpOf(await run(project, command)));
      status = followUps.every((item) => item.ok) ? "applied" : "partial";
    } else if (isAmbiguous(first.envelope)) {
      // The command may have applied (timeout, crash): read the chain again instead of claiming a refusal.
      if (!appliedEvidence(rootDir, pending, request.answer, primary!.alias)) status = "unknown";
      else {
        status = rest.length ? "partial" : "applied";
        extra = { reconciled: true };
      }
    } else status = "refused";
    const result = resultOf(
      first.envelope,
      status === "partial" && !first.envelope.ok
        ? rest.map((command) => ({ argv: pnpmArgv(command), ok: false, error: "NOT_RUN", message: "Not run yet." }))
        : followUps,
      status === "applied" || status === "partial" ? plan.hint : undefined,
      extra,
    );
    // An earlier refusal of this decision stays in the history beside the new outcome.
    if (previous?.status === "refused" || previous?.status === "unknown") archiveRefused(rootDir, project, pending.id);
    let decided: InboxDecisionFile = { ...base, argv: first.argv, status, decidedAt: now().toISOString(), result };
    try {
      writeInbox(rootDir, decided);
    } catch {
      // The command ran: keep its outcome even when the full envelope does not fit the record.
      decided = {
        ...decided,
        result: {
          ok: result.ok,
          ...(result.error ? { error: String(result.error).slice(0, 64) } : {}),
          ...(result.message ? { message: result.message.slice(0, 2048) } : {}),
        },
      };
      writeInbox(rootDir, decided);
    }
    journal(decided, plan);
    return replyOf(decided);
  }

  return {
    /** POST …/decisions. With `dryRun`, nothing runs: the reply's decision is pending with the first command's argv. */
    decide(project: string, request: DecisionRequest, options: DecideOptions = {}): Promise<DecisionResponse> {
      return serialised(project, () => decideLocked(project, request, options));
    },
    saveDocument(project: string, request: ConsoleDocumentSave) {
      return serialised(project, async () => saveStrategyDocument(rootDir, project, request));
    },
  };
}

/** The server's actions with the real decision applier; control (WP8) and cards (WP11) stay as given. */
export function consoleActionsWith(
  rootDir: string,
  others: ConsoleActions,
  deps: Partial<ActionsDeps> & Pick<ActionsDeps, "deriveWaiting">,
): ConsoleActions {
  const decisions = createDecisionActions(rootDir, deps);
  return { ...others, ...decisions };
}
