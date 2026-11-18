/**
 * What an autonomous policy may pass without asking, and on what basis. Allowlist only:
 *  - class (a) `autoPass`: concept and script after their blind review closed on the exact current pool, replica-spec
 *    after ref:replica-check passed on the exact current spec, material when the plan spends nothing (material-free) or,
 *    under `spendUsd`, when its pending generated items' bounds fit the user's autonomous spend and the durable budget;
 *  - class (b) `preAnswers`: intake (filmType, formats), strategy (proposition), music (silence with its reason, or the
 *    user's own track by its shortlist id), replica-spec (swaps, once ref:replica-check passed) when the artefact
 *    matches the user's pre-answer exactly; footage's captionStyle and shorts live in src/lib/footage/policy.ts;
 *  - everything else asks: the human verdict, rights, the animatic, a critic's ask, paid material past spendUsd or
 *    the budget (and every recording), every other gate.
 * A decision the user revoked (film:revert) is never taken again on the same artefacts: that gate asks.
 * Reads only; state.ts calls it from decideAction, film:approve --policy from the CLI.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { currentPolicy, isAutonomous } from "../autonomy/policy";
import { OperationDatabaseSchema } from "../jobs/types";
import { committedSpendUsd } from "../jobs/store";
import { normSwap } from "../autonomy/pre-answers";
import type { PolicyRevision, PreAnswers } from "../../types/policy";
import {
  BRIEF,
  CONCEPT,
  DECISION,
  IDEA_POOL,
  MATERIAL,
  REPLICA_CHECK,
  REPLICA_SPEC,
  SCRIPT_POOL,
  STRATEGY,
} from "./chain";
import { readDecisions, revokedDecisionIds } from "./decisions";
import { reviewRounds } from "./studio";

/** The answer a policy writes where the user would answer (music-decision.json): approved only under the policy. */
export const POLICY_ANSWER_PREFIX = "policy (pre-answer): ";
/** The question a policy's music record answers: the one the user answered when they granted the policy. */
export const POLICY_QUESTION = "Music, pre-answered in the policy the user granted (film:policy)";

/** Steps no policy ever passes: the user's verdict on the film and the rights to copy one. */
export const POLICY_NEVER = ["human", "rights"] as const;

export type PolicyBasis = {
  step: string;
  kind: "preAnswer" | "judge" | "spend";
  /** The pre-answer key, or the judge. */
  evidence: Record<string, string>;
  judgeVerdict: string;
  /** The hash film:approve --policy --expect must find again. */
  expect: string;
  alternatives?: string[];
  /** kind spend: the USD this approval authorises (the pending generated items' bounds). */
  amountUsd?: number;
};

export type AutonomyContext = {
  projectDir: string;
  rootDir: string;
  tokens: Record<string, string | undefined>;
  /** The step's state as deriveChain sees it. */
  steps: readonly { id: string; status: string; outputs: Record<string, string>; critic?: { action: string } }[];
};

const fillDir = (template: string, tokens: AutonomyContext["tokens"]) =>
  template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => tokens[name] ?? `{${name}}`);

function hashFile(file: string): string | undefined {
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const norm = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** The policy in force when it is autonomous, else undefined. */
export function autonomousPolicy(projectDir: string): PolicyRevision | undefined {
  try {
    const policy = currentPolicy(projectDir);
    return isAutonomous(policy) ? policy : undefined;
  } catch {
    return undefined;
  }
}

/** The step's outputs were already decided once under the policy and the user revoked it: ask them. */
function revokedOn(projectDir: string, step: string, outputs: Record<string, string>): boolean {
  const entries = readDecisions(projectDir);
  const revoked = revokedDecisionIds(entries);
  return entries.some(
    (entry) =>
      entry.kind !== "revoked" &&
      entry.step === step &&
      revoked.has(entry.id) &&
      JSON.stringify(Object.entries(entry.artefactHashes).sort()) === JSON.stringify(Object.entries(outputs).sort()),
  );
}

function reviewBasis(
  context: AutonomyContext,
  step: "concept" | "script",
): { basis?: Omit<PolicyBasis, "step">; refused?: string } {
  const reviewStep = step === "concept" ? "idea-review" : "script-review";
  const kind = step === "concept" ? "ideas" : "scripts";
  const judge = context.steps.find((state) => state.id === reviewStep);
  if (judge?.status !== "done" || judge.critic?.action !== "closed")
    return { refused: `${reviewStep} has not closed with a passing review.` };
  const latest = reviewRounds(context.projectDir, kind).at(-1);
  if (!latest?.review) return { refused: `${reviewStep} has no readable review.` };
  const pool = path.resolve(context.rootDir, fillDir(step === "concept" ? IDEA_POOL : SCRIPT_POOL, context.tokens));
  const poolHash = hashFile(pool);
  if (!poolHash || latest.review.targetSha256 !== poolHash)
    return { refused: `The latest ${reviewStep} round judged another pool than the current one.` };
  const ranking = latest.review.ranking ?? [];
  const alternatives =
    step === "concept"
      ? ((
          readJson(path.resolve(context.rootDir, fillDir(CONCEPT, context.tokens)))?.candidates as
            { id: string }[] | undefined
        )?.map((candidate) => candidate.id) ?? [])
      : ranking;
  return {
    basis: {
      kind: "judge",
      evidence: {
        judge: path.relative(context.rootDir, latest.file),
        targetSha256: poolHash,
        verdict: "pass",
      },
      judgeVerdict: `${reviewStep} round ${latest.round} passed`,
      expect: poolHash,
      ...(alternatives.length ? { alternatives } : {}),
    },
  };
}

/**
 * replica-spec: ref:replica-check passed on the exact current spec, and, when the user pre-answered the swaps, the
 * spec swaps exactly those (by each swap's `what`). A pre-answer that no longer matches the spec is ignored with a
 * warning and the user is asked, even under auto-pass replica-spec: they named the swaps they accept.
 */
function replicaSpecBasis(
  context: AutonomyContext,
  swaps: readonly string[] | undefined,
): { basis?: Omit<PolicyBasis, "step">; refused?: string; warning?: string } {
  const check = path.resolve(context.rootDir, fillDir(REPLICA_CHECK, context.tokens));
  const specFile = path.resolve(context.rootDir, fillDir(REPLICA_SPEC, context.tokens));
  const spec = hashFile(specFile);
  const envelope = readJson(check) as { ok?: boolean } | undefined;
  if (!spec || envelope?.ok !== true) return { refused: "ref:replica-check has not passed on this spec." };
  if (swaps) {
    const listed = (readJson(specFile) as { swaps?: { what?: unknown }[] } | undefined)?.swaps ?? [];
    const inSpec = listed.map((swap) => (typeof swap.what === "string" ? normSwap(swap.what) : ""));
    const wanted = swaps.map(normSwap);
    const missing = wanted.filter((what) => !inSpec.includes(what));
    const extra = inSpec.filter((what) => !wanted.includes(what));
    if (missing.length || extra.length) {
      const differences = [
        missing.length ? `not in the spec: ${missing.join("; ")}` : "",
        extra.length ? `not pre-answered: ${extra.join("; ") || "(unnamed)"}` : "",
      ].filter(Boolean);
      const refused = `The spec's swaps are not the ones the user pre-answered (${differences.join("; ")}).`;
      return { refused, warning: `The policy's swaps pre-answer was ignored: ${refused} Ask the user.` };
    }
    return {
      basis: {
        kind: "preAnswer",
        evidence: {
          preAnswer: "swaps",
          swaps: swaps.join("; "),
          judge: path.relative(context.rootDir, check),
          targetSha256: spec,
        },
        judgeVerdict: "ref:replica-check passed and the swaps match the user's pre-answer",
        expect: spec,
      },
    };
  }
  return {
    basis: {
      kind: "judge",
      evidence: { judge: path.relative(context.rootDir, check), targetSha256: spec, verdict: "pass" },
      judgeVerdict: "ref:replica-check passed",
      expect: spec,
    },
  };
}

function materialFreeBasis(context: AutonomyContext): { basis?: Omit<PolicyBasis, "step">; refused?: string } {
  const file = path.resolve(context.rootDir, fillDir(MATERIAL, context.tokens));
  const material = readJson(file) as
    { items?: { id: string; route: string; status: string; maxCostUsd?: number }[] } | undefined;
  const items = material?.items ?? [];
  const paid = items.filter(
    (item) =>
      item.route === "generated" ||
      item.route === "recorded" ||
      item.status === "pending" ||
      (item.maxCostUsd ?? 0) > 0,
  );
  if (!material || paid.length)
    return {
      refused: `The material plan is not free (${paid.map((item) => item.id).join(", ") || "unreadable"}): paid or recorded material is the user's yes.`,
    };
  const hash = hashFile(file)!;
  return {
    basis: {
      kind: "judge",
      evidence: { judge: "material-free", targetSha256: hash, verdict: "no paid or recorded item" },
      judgeVerdict: "material plan spends nothing",
      expect: hash,
    },
  };
}

type MaterialItem = { id: string; route: string; status: string; maxCostUsd?: number };

const usd = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Item bounds earlier spend decisions authorised, by item id (the highest per item). Revoked ones count too: a
 * revert withdraws the approval, it does not refund what may already be bought.
 */
export function autonomousSpendByItem(projectDir: string): Map<string, number> {
  const byItem = new Map<string, number>();
  for (const entry of readDecisions(projectDir)) {
    if (entry.kind !== "spend") continue;
    for (const pair of (entry.evidence["items"] ?? "").split(",").filter(Boolean)) {
      const at = pair.lastIndexOf("=");
      const id = pair.slice(0, at);
      const amount = Number(pair.slice(at + 1));
      if (at > 0 && Number.isFinite(amount)) byItem.set(id, Math.max(byItem.get(id) ?? 0, amount));
    }
  }
  return byItem;
}

/** The durable budget (operations.json), read without opening a store: its ceiling, per-job limit and committed spend. */
function durableBudget(
  projectDir: string,
): { ceilingUsd: number; maxJobUsd: number; committedUsd: number } | undefined {
  const parsed = OperationDatabaseSchema.safeParse(readJson(path.join(projectDir, "pipeline", "operations.json")));
  if (!parsed.success) return undefined;
  return {
    ceilingUsd: parsed.data.policy.ceilingUsd,
    maxJobUsd: parsed.data.policy.maxJobUsd,
    committedUsd: committedSpendUsd(parsed.data),
  };
}

/**
 * Paid material under the user's autonomous spend (policy.spendUsd): only generated items still pending, each with
 * its bound (maxCostUsd, the quoted high cost). The sum of every autonomously approved item's bound stays within
 * spendUsd, and this plan's within the durable budget's headroom and per-job limits. A recording, a pending item of
 * another route or a paid item without a bound asks the user. Generation still passes OperationStore admission.
 */
function materialSpendBasis(
  context: AutonomyContext,
  policy: PolicyRevision,
): { basis?: Omit<PolicyBasis, "step">; refused?: string } {
  const file = path.resolve(context.rootDir, fillDir(MATERIAL, context.tokens));
  const material = readJson(file) as { items?: MaterialItem[] } | undefined;
  if (!material?.items) return { refused: "The material plan is unreadable." };
  const cap = policy.spendUsd ?? 0;
  const asks = material.items.filter(
    (item) =>
      item.route === "recorded" ||
      (item.status === "pending" && item.route !== "generated") ||
      // A paid item of another route (a licence) is bought outside OperationStore: only the user says yes to it.
      (item.route !== "generated" && item.status !== "acquired" && (item.maxCostUsd ?? 0) > 0) ||
      (item.route === "generated" && item.status !== "acquired" && !((item.maxCostUsd ?? 0) > 0)),
  );
  if (asks.length)
    return {
      refused: `The material plan has items only the user can decide (${asks.map((item) => item.id).join(", ")}): a recording, a pending or paid item of another route, or a generated item without its bound.`,
    };
  const paid = material.items.filter((item) => item.route === "generated" && item.status !== "acquired");
  const amount = usd(paid.reduce((sum, item) => sum + item.maxCostUsd!, 0));
  const total = autonomousSpendByItem(context.projectDir);
  for (const item of paid) total.set(item.id, Math.max(total.get(item.id) ?? 0, item.maxCostUsd!));
  const cumulative = usd([...total.values()].reduce((sum, value) => sum + value, 0));
  if (cumulative > cap)
    return {
      refused: `Autonomous spend would reach USD ${cumulative} (this plan USD ${amount}), past the USD ${cap} the user granted (film:policy --spend-usd): ask the user.`,
    };
  const budget = durableBudget(context.projectDir);
  if (!budget) return { refused: "The project has no durable budget (pnpm budget): paid material is the user's yes." };
  const ceiling = Math.min(budget.ceilingUsd, policy.budget?.ceilingUsd ?? Infinity);
  const headroom = usd(Math.max(0, ceiling - budget.committedUsd));
  if (amount > headroom)
    return {
      refused: `The plan's paid items need USD ${amount}, the budget has USD ${headroom} left (ceiling USD ${ceiling}): ask the user.`,
    };
  const maxJob = Math.min(budget.maxJobUsd, policy.budget?.maxJobUsd ?? Infinity);
  const tooBig = paid.filter((item) => item.maxCostUsd! > maxJob);
  if (tooBig.length)
    return {
      refused: `${tooBig.map((item) => item.id).join(", ")} exceed the per-job limit USD ${maxJob}: ask the user.`,
    };
  const hash = hashFile(file)!;
  return {
    basis: {
      kind: "spend",
      evidence: {
        judge: "material-spend",
        targetSha256: hash,
        items: paid.map((item) => `${item.id}=${item.maxCostUsd}`).join(","),
        cumulativeUsd: String(cumulative),
        spendUsd: String(cap),
        headroomUsd: String(headroom),
      },
      judgeVerdict: `paid material USD ${amount} within the user's autonomous spend (USD ${cumulative} of ${cap}) and the budget`,
      expect: hash,
      amountUsd: amount,
    },
  };
}

function preAnswerBasis(
  context: AutonomyContext,
  step: string,
  answers: PreAnswers,
): { basis?: Omit<PolicyBasis, "step">; refused?: string } {
  const at = (template: string) => path.resolve(context.rootDir, fillDir(template, context.tokens));
  if (step === "intake") {
    if (!answers.filmType && !answers.formats) return { refused: "No pre-answer covers the brief." };
    const file = at(BRIEF);
    const brief = readJson(file) as { filmType?: string; format?: string; outputFormats?: string[] } | undefined;
    if (answers.filmType && brief?.filmType !== answers.filmType)
      return { refused: `The brief's film type is ${brief?.filmType ?? "unset"}, the pre-answer ${answers.filmType}.` };
    const formats = brief?.outputFormats ?? (brief?.format ? [brief.format] : []);
    if (answers.formats && [...formats].sort().join(",") !== [...answers.formats].sort().join(","))
      return {
        refused: `The brief ships ${formats.join(", ") || "no format"}, the pre-answer ${answers.formats.join(", ")}.`,
      };
    const keys = [
      answers.filmType ? `filmType=${answers.filmType}` : "",
      answers.formats ? `formats=${answers.formats.join("+")}` : "",
    ];
    return {
      basis: {
        kind: "preAnswer",
        evidence: { preAnswer: keys.filter(Boolean).join(" ") },
        judgeVerdict: "matches the user's pre-answer",
        expect: hashFile(file)!,
      },
    };
  }
  if (step === "strategy") {
    if (!answers.proposition) return { refused: "No pre-answer covers the proposition." };
    const file = at(STRATEGY);
    const strategy = readJson(file) as { proposition?: string } | undefined;
    if (!strategy?.proposition || norm(strategy.proposition) !== norm(answers.proposition))
      return { refused: "The strategy's proposition is not the user's pre-answered one." };
    return {
      basis: {
        kind: "preAnswer",
        evidence: { preAnswer: "proposition" },
        judgeVerdict: "matches the user's pre-answer",
        expect: hashFile(file)!,
      },
    };
  }
  if (step === "music") {
    const file = at(DECISION);
    const decision = readJson(file) as
      { route?: string; candidateId?: string; reason?: string; askedUser?: { answer?: string } } | undefined;
    if (!decision?.askedUser?.answer?.startsWith(POLICY_ANSWER_PREFIX))
      return { refused: "The music decision was not recorded from the policy's pre-answer." };
    const silence = answers.musicRoute === "silence" && answers.silenceReason;
    const own = answers.musicRoute === "user-supplied" && answers.musicFile;
    if (silence && decision.route === "silence")
      return {
        basis: {
          kind: "preAnswer",
          evidence: { preAnswer: "musicRoute=silence", silenceReason: answers.silenceReason! },
          judgeVerdict: "matches the user's pre-answer",
          expect: hashFile(file)!,
        },
      };
    if (own && decision.route === "user-supplied" && decision.candidateId === answers.musicFile)
      return {
        basis: {
          kind: "preAnswer",
          evidence: { preAnswer: "musicRoute=user-supplied", musicFile: answers.musicFile! },
          judgeVerdict: "matches the user's pre-answer",
          expect: hashFile(file)!,
        },
      };
    return { refused: "The music decision does not match the user's pre-answer." };
  }
  return { refused: `No pre-answer applies to step ${step}.` };
}

/**
 * Why the policy may pass this step's open gate now, or why not. The step must be awaiting the user's approval on
 * outputs that are sealed; the caller checks that.
 */
export function policyBasis(
  context: AutonomyContext,
  stepId: string,
  policy: PolicyRevision | undefined = autonomousPolicy(context.projectDir),
): { basis?: PolicyBasis; refused?: string; warning?: string } {
  if (!isAutonomous(policy)) return { refused: "The project has no autonomous policy: the user decides." };
  if ((POLICY_NEVER as readonly string[]).includes(stepId))
    return { refused: `No policy passes step ${stepId}: that decision is the user's alone.` };
  const state = context.steps.find((item) => item.id === stepId);
  if (!state) return { refused: `Step ${stepId} is not in this film's route.` };
  if (revokedOn(context.projectDir, stepId, state.outputs))
    return { refused: `The user revoked the policy's decision on this exact ${stepId}: ask them.` };
  let result: { basis?: Omit<PolicyBasis, "step">; refused?: string; warning?: string } | undefined;
  if ((stepId === "concept" || stepId === "script") && policy.autoPass.includes(stepId))
    result = reviewBasis(context, stepId);
  else if (stepId === "replica-spec" && (policy.autoPass.includes("replica-spec") || policy.preAnswers.swaps))
    result = replicaSpecBasis(context, policy.preAnswers.swaps);
  else if (stepId === "material" && (policy.autoPass.includes("material-free") || policy.spendUsd)) {
    const free = materialFreeBasis(context);
    if (free.basis)
      result = policy.autoPass.includes("material-free")
        ? free
        : { refused: "The plan spends nothing and the policy does not auto-pass material-free: the user decides." };
    else result = policy.spendUsd ? materialSpendBasis(context, policy) : free;
  } else if (["intake", "strategy", "music"].includes(stepId))
    result = preAnswerBasis(context, stepId, policy.preAnswers);
  if (!result) return { refused: `The policy does not cover step ${stepId}: the user decides.` };
  return result.basis
    ? { basis: { step: stepId, ...result.basis } }
    : { refused: result.refused!, ...(result.warning ? { warning: result.warning } : {}) };
}

/**
 * The music decision the policy may record before the user is asked: silence with its reason, or the user's own
 * track by its shortlist id once the shortlist names it. A pick by ear (stock, reference) and a paid generation ask.
 */
export function musicRecordCommand(
  projectId: string,
  policy: PolicyRevision | undefined,
  shortlistIds: readonly string[] | undefined,
): string | undefined {
  if (!isAutonomous(policy)) return undefined;
  const answers = policy.preAnswers;
  const say = (text: string) => JSON.stringify(text);
  if (answers.musicRoute === "silence" && answers.silenceReason)
    return `pnpm music --action record --project ${projectId} --route silence --answer ${say(`${POLICY_ANSWER_PREFIX}silence: ${answers.silenceReason}`)} --reason ${say(answers.silenceReason)} --question ${say(POLICY_QUESTION)}`;
  if (answers.musicRoute === "user-supplied" && answers.musicFile && shortlistIds?.includes(answers.musicFile))
    return `pnpm music --action record --project ${projectId} --route user-supplied --candidate ${answers.musicFile} --answer ${say(`${POLICY_ANSWER_PREFIX}the user's own track ${answers.musicFile}`)} --reason ${say("pre-answered in the user's policy")} --question ${say(POLICY_QUESTION)}`;
  return undefined;
}
