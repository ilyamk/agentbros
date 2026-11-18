/**
 * `pnpm feedback` for a bespoke film: validates the user's items, routes each aspect to its step (route.ts), and on
 * --confirm writes the record and each step's open file. The open file is a tracked input of its step, so the
 * existing receipt hashes reopen that step and everything downstream; `pnpm next` then returns the earliest one.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { MaterialSchema, MusicDecisionSchema } from "../../types/film";
import {
  FeedbackInputSchema,
  FeedbackSchema,
  OpenFeedbackSchema,
  type Aspect,
  type Feedback,
  type FeedbackInput,
  type OpenFeedback,
} from "../../types/feedback";
import { FILM_CHAIN, stepById } from "../film/chain";
import { appendUserWords } from "../film/spine";
import { ChainRefusal, deriveChain, upstreamOf, type FilmProject } from "../film/state";
import { captureFields } from "../pipeline/route";
import { userWordsProblem } from "../cli/user-words";
import { wordsChannel } from "../cli/channel";
import { aspectAxis, routeAspect, type RouteContext } from "./route";
import { feedbackFile, feedbackWhere, nextFeedbackId, openFeedbackFile, readOpenFeedback, writeJson } from "./store";

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export type Reopen = { step: string; owner: string; because: string };
export type FeedbackPlan = {
  record: Feedback;
  opens: OpenFeedback[];
  reopens: Reopen[];
  ask: { itemId: string; aspect: Aspect; quote: string; why: string }[];
  warnings: string[];
  capture?: { moment: "rejection"; hint: string; commands: string[] };
};

/** The film's type and whether the user chose silence: what decides which steps can take feedback. */
export function routeContext(project: FilmProject): RouteContext & { enabled: Set<string> } {
  const chain = deriveChain(project);
  const decision = MusicDecisionSchema.safeParse(
    readJson(path.join(project.projectDir, "pipeline", "music-decision.json")),
  );
  return {
    type: chain.filmType,
    ...(chain.secondaryFilmType ? { secondary: chain.secondaryFilmType } : {}),
    silence: decision.success && decision.data.route === "silence",
    enabled: new Set(chain.steps.filter((state) => state.status !== "skipped").map((state) => state.id)),
  };
}

/** Targets plus every later step that reads one of their outputs, transitively: what the receipts will reopen. */
export function reopenedSteps(targets: string[], enabled: Set<string>): Reopen[] {
  const reopened = new Map<string, string>();
  for (const step of FILM_CHAIN) {
    if (!enabled.has(step.id)) continue;
    if (targets.includes(step.id)) reopened.set(step.id, "the user's feedback");
    else {
      const from = upstreamOf(step).find((id) => reopened.has(id));
      if (from) reopened.set(step.id, `reads ${from}`);
    }
  }
  return [...reopened].map(([step, because]) => ({ step, owner: stepById(step)!.owner, because }));
}

/** The memory hint for a rejection: per step, the lesson template with --step and the rubric --axis filled; never the quote. */
function captureHint(project: FilmProject, record: Feedback) {
  const pairs = [
    ...new Map(
      record.items
        .filter((item) => item.routedTo !== "ask")
        .map((item) => [
          `${item.routedTo}|${aspectAxis(item.aspect) ?? ""}`,
          { step: item.routedTo, axis: aspectAxis(item.aspect) },
        ]),
    ).values(),
  ];
  const commands = new Set<string>();
  let hint = "";
  for (const pair of pairs.length ? pairs : [{ step: undefined, axis: undefined }]) {
    const capture = captureFields(project.projectDir, "rejection", pair.step).capture;
    if (!capture) continue;
    hint = capture.hint;
    for (const command of capture.commands)
      commands.add(
        pair.axis && command.startsWith("pnpm memory --add --type lesson") ? `${command} --axis ${pair.axis}` : command,
      );
  }
  return hint ? { moment: "rejection" as const, hint, commands: [...commands] } : undefined;
}

/** Validates and routes; writes nothing. */
export function planFeedback(
  project: FilmProject,
  raw: unknown,
  at: string = new Date().toISOString(),
  options: { routeTo?: string } = {},
): FeedbackPlan {
  if (
    raw &&
    typeof raw === "object" &&
    "source" in raw &&
    (raw as { source?: { kind?: unknown } }).source?.kind !== "user"
  )
    throw new ChainRefusal("Feedback is the user's own words: a proxy, critic or agent source is refused.");
  const parsedInput = FeedbackInputSchema.safeParse(raw);
  if (!parsedInput.success) {
    const issue = parsedInput.error.issues[0];
    throw new ChainRefusal(
      `The feedback file is not valid: ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}. Every item needs the user's words verbatim in "quote" and an "aspect".`,
    );
  }
  const input: FeedbackInput = parsedInput.data;
  for (const [index, item] of input.items.entries()) {
    const problem = userWordsProblem(item.quote);
    if (problem) throw new ChainRefusal(`items.${index}.quote is not the user's words: ${problem}.`);
  }
  const watchedPath = input.watched?.path ?? `out/${project.id}/film.mp4`;
  const watchedFile = path.resolve(project.rootDir, watchedPath);
  if (!existsSync(watchedFile) || !statSync(watchedFile).isFile())
    throw new ChainRefusal(`${watchedPath} does not exist: feedback is bound to the exact film the user watched.`);
  const watchedSha = sha256(watchedFile);
  if (input.watched?.sha256 && input.watched.sha256 !== watchedSha)
    throw new ChainRefusal(
      `${watchedPath} changed since the user watched it (sha256 ${input.watched.sha256.slice(0, 12)}…, now ${watchedSha.slice(0, 12)}…): show them the current film first.`,
    );

  const context = routeContext(project);
  const ask: FeedbackPlan["ask"] = [];
  const items = input.items.map((item, index) => {
    const id = `i${index + 1}`;
    // A step-level rejection (feedback --step --answer) names its revise owner; items otherwise route by aspect.
    const routed = options.routeTo ? { step: options.routeTo } : routeAspect(item.aspect, context);
    if (routed.step === "ask")
      ask.push({ itemId: id, aspect: item.aspect, quote: item.quote, why: (routed as { why: string }).why });
    return {
      id,
      quote: item.quote.trim(),
      aspect: item.aspect,
      ...(item.at ? { at: item.at } : {}),
      ...(item.shotId ? { shotId: item.shotId } : {}),
      ...(item.frame !== undefined ? { frame: item.frame } : {}),
      ...(item.region ? { region: item.region } : {}),
      severity: item.severity,
      routedTo: routed.step,
      status: "open" as const,
    };
  });
  const record = FeedbackSchema.parse({
    schemaVersion: 1,
    id: nextFeedbackId(project.projectDir),
    route: "film",
    watched: { path: path.relative(project.rootDir, watchedFile), sha256: watchedSha },
    source: { kind: "user", at, ...wordsChannel() },
    verdict: input.verdict,
    items,
  });

  const warnings: string[] = [];
  const opens: OpenFeedback[] = [];
  if (record.verdict === "revise") {
    const targets = [...new Set(items.filter((item) => item.routedTo !== "ask").map((item) => item.routedTo))];
    for (const step of targets) {
      const existing = readOpenFeedback(project.projectDir, step);
      const fresh = items
        .filter((item) => item.routedTo === step)
        .map((item) => ({
          feedbackId: record.id,
          itemId: item.id,
          quote: item.quote,
          aspect: item.aspect,
          severity: item.severity,
          ...(item.at ? { at: item.at } : {}),
          ...(item.shotId ? { shotId: item.shotId } : {}),
          ...(item.frame !== undefined ? { frame: item.frame } : {}),
          ...(item.region ? { region: item.region } : {}),
          watched: record.watched.path,
        }));
      opens.push(
        OpenFeedbackSchema.parse({
          schemaVersion: 1,
          step,
          items: [...(existing?.items ?? []), ...fresh],
          clarifications: existing?.clarifications ?? [],
        }),
      );
    }
  } else
    warnings.push(
      "The verdict is accept: the items are recorded and nothing reopens. Record the acceptance itself with film:approve --step human.",
    );
  const reopens = reopenedSteps(
    opens.map((open) => open.step),
    context.enabled,
  );
  if (reopens.some((reopen) => reopen.step === "material")) {
    const material = MaterialSchema.safeParse(readJson(path.join(project.projectDir, "pipeline", "material.json")));
    if (
      material.success &&
      material.data.items.some(
        (item) => item.route === "generated" || (item.costUsd ?? 0) > 0 || item.maxCostUsd !== undefined,
      )
    )
      warnings.push(
        "The material step reopens and it holds paid or generated items: anything new is generated only after the user's yes on its cost at the material gate.",
      );
  }
  if (reopens.some((reopen) => ["ideas", "script-variants"].includes(reopen.step)))
    warnings.push(
      "The change reaches the concept teams or script writers: their pool reopens for a new blind round, a new creative director judges it and the user chooses again at the concept or script gate.",
    );
  const capture = captureHint(project, record);
  return { record, opens, reopens, ask, warnings, ...(capture ? { capture } : {}) };
}

/** Writes the record, each step's open file and the quotes in the spine under their step. Returns the written paths. */
export function writeFeedback(project: FilmProject, plan: FeedbackPlan): string[] {
  const written: string[] = [];
  const recordFile = feedbackFile(project.projectDir, plan.record.id);
  writeJson(recordFile, plan.record);
  written.push(recordFile);
  for (const open of plan.opens) {
    const file = openFeedbackFile(project.projectDir, open.step);
    writeJson(file, open);
    written.push(file);
  }
  for (const item of plan.record.items) {
    const where = feedbackWhere(item);
    appendUserWords(
      project.projectDir,
      item.routedTo === "ask" ? "human" : item.routedTo,
      `Feedback ${plan.record.id} ${item.id} (${item.aspect}, ${item.severity}${where}): "${item.quote}"`,
      plan.record.source.at,
    );
  }
  return written.map((file) => path.relative(project.rootDir, file));
}

/** The user's answer when the same objection came back: recorded on the step's open file, which lets the owner go on. */
export function clarifyFeedback(
  project: Pick<FilmProject, "projectDir" | "rootDir">,
  stepId: string,
  quote: string,
  at: string = new Date().toISOString(),
  options: { spine?: boolean } = {},
): string {
  const open = readOpenFeedback(project.projectDir, stepId);
  if (!open) throw new ChainRefusal(`Step ${stepId} has no open feedback to clarify.`);
  const problem = userWordsProblem(quote);
  if (problem) throw new ChainRefusal(`A clarification is the user's own words, verbatim: ${problem}.`);
  const file = openFeedbackFile(project.projectDir, stepId);
  writeJson(
    file,
    OpenFeedbackSchema.parse({ ...open, clarifications: [...open.clarifications, { quote: quote.trim(), at }] }),
  );
  if (options.spine !== false) appendUserWords(project.projectDir, stepId, `Feedback clarified: "${quote.trim()}"`, at);
  return path.relative(project.rootDir, file);
}
