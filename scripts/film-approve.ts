/**
 * Records the user's approval of a step's artefact against its hash. Refused unless that step's gate is open.
 * --proxy benchmark records a stand-in decision for a benchmark run: the chain advances, but it never counts as the
 * user's approval: the human verdict refuses it, and on material it never authorises spending.
 * --policy passes the gate under the autonomous policy the user granted (pipeline/policy.json), only on a basis the
 * code finds itself (src/lib/film/autonomy.ts), and records the decision in pipeline/decisions.jsonl.
 * --expect with --answer refuses an approval of artefacts that changed since the user saw them (RFC 0004 FR3).
 * --choice <idea id> on step concept records which idea the user picked as concept.json's selectedId before approving.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm, refusals } from "../src/lib/film/cli";
import { autonomousPolicy, policyBasis } from "../src/lib/film/autonomy";
import { appendDecision, nextDecisionId, readDecisions } from "../src/lib/film/decisions";
import { guardEvent } from "../src/lib/film/guard-cli";
import { stepById } from "../src/lib/film/chain";
import { requireUserWords } from "../src/lib/cli/user-words";
import { artefactsExpect } from "../src/lib/film/expect";
import {
  approvalHints,
  approveStep,
  ChainRefusal,
  deriveChain,
  sealStep,
  stepState,
  type FilmProject,
  type ProxyKind,
} from "../src/lib/film/state";
import { chooseIdea, StudioRefusal } from "../src/lib/film/studio";
import { noteApproval } from "../src/lib/memory/capture";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    { name: "step", required: true, description: "Step id, as in film:status" },
    { name: "answer", description: "The user's own words; required unless --proxy or --policy" },
    {
      name: "proxy",
      choices: ["benchmark"],
      description:
        "Benchmark runs only: record a proxy decision, never the user's. Refused on step human; on material it never authorises spending",
    },
    { name: "reason", description: "With --proxy: why the benchmark goes on without the user" },
    {
      name: "policy",
      type: "boolean",
      description:
        "Pass the gate under the user's autonomous policy (film:policy), on the basis film:next named; recorded in pipeline/decisions.jsonl. Refused on human and rights",
    },
    {
      name: "expect",
      description:
        "With --policy: the judged artefact's sha256 film:next named. With --answer: the hash of the step's artefacts the user saw (src/lib/film/expect.ts). Refused when it changed since",
    },
    {
      name: "choice",
      description:
        "Step concept, with --answer: the id of the idea the user chose; it becomes concept.json's selectedId (the step is sealed again) before the approval",
    },
  ] as const);
  if (args.choice !== undefined && args.policy)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--choice is the user's pick: it goes with --answer, not --policy.",
    });
  if (args.policy && (args.proxy || args.answer))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--policy carries no user's words and is not a benchmark proxy: drop --answer and --proxy.",
    });
  if (!args.policy && !args.proxy && !args.answer)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--answer needs the user's words." });
  if (args.proxy && !args.reason?.trim())
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--proxy needs --reason." });
  if (args.proxy && args.answer)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "A proxy decision carries no user's words: drop --answer.",
    });
  const project = openExistingFilm(args.project!);
  if (!args.policy && !args.proxy) {
    const step = stepById(args.step!);
    requireUserWords(args.answer, "--answer", { hints: step ? approvalHints(step) : [] });
  }
  const wasDone = (() => {
    try {
      return stepState(project, args.step!).status === "done";
    } catch {
      return false;
    }
  })();

  if (args.policy) {
    const at = new Date().toISOString();
    const policy = autonomousPolicy(project.projectDir);
    const chain = deriveChain(project);
    const { basis, refused } = policyBasis(
      { projectDir: project.projectDir, rootDir: project.rootDir, tokens: chain.tokens, steps: chain.steps },
      args.step!,
      policy,
    );
    if (!basis) throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: refused! });
    if (args.expect && args.expect !== basis.expect)
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: `The judged artefact changed since film:next (${args.expect.slice(0, 12)} named, ${basis.expect.slice(0, 12)} now): run film:next again.`,
      });
    const id = nextDecisionId(readDecisions(project.projectDir));
    const reason = `${basis.kind}: ${basis.judgeVerdict}`;
    const event = refusals(() =>
      approveStep(
        project,
        args.step!,
        `policy (decision ${id}): ${basis.judgeVerdict}`,
        at,
        { kind: "policy", reason, ...(args.expect ? { expect: args.expect } : {}) },
        undefined,
        id,
      ),
    );
    const decision = appendDecision(project.projectDir, {
      step: args.step!,
      kind: basis.kind,
      artefactHashes: event.artefacts,
      evidence: basis.evidence,
      judgeVerdict: basis.judgeVerdict,
      ...(basis.amountUsd !== undefined ? { amountUsd: basis.amountUsd } : {}),
      ...(basis.alternatives ? { alternatives: basis.alternatives } : {}),
      policyRevision: policy!.revision,
      at,
    });
    if (decision.id !== id)
      throw new ChainRefusal(`The ledger moved under this approval (${id} became ${decision.id}).`);
    guardEvent(project, "approval", args.step!, "film:approve --policy", at);
    return {
      metadata: {
        projectId: project.id,
        step: args.step,
        approval: event,
        decision,
        countsAsUserApproval: false,
        revert: `pnpm film:revert --project ${project.id} --decision ${decision.id} --answer "<the user's words>"`,
      },
    };
  }

  if (args.expect !== undefined) {
    if (args.proxy)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--expect goes with --answer or --policy." });
    const now = refusals(() => artefactsExpect(Object.values(stepState(project, args.step!).outputs)));
    if (now !== args.expect)
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: `Step ${args.step}'s artefacts changed since the user saw them (${args.expect.slice(0, 12)} seen, ${now.slice(0, 12)} now): show them the current version and ask again.`,
        details: { stale: true, expect: args.expect, current: now },
      });
  }
  const proxy = args.proxy ? { kind: args.proxy as ProxyKind, reason: args.reason! } : undefined;
  const answer = proxy ? `proxy (${proxy.kind}): ${proxy.reason}` : args.answer!;
  const chosen = args.choice !== undefined ? choose(project, args.step!, args.choice) : undefined;
  let event: ReturnType<typeof approveStep>;
  try {
    event = refusals(() => approveStep(project, args.step!, answer, undefined, proxy));
  } catch (error) {
    chosen?.restore();
    throw error;
  }
  guardEvent(project, "approval", args.step!, proxy ? "film:approve --proxy" : "film:approve");
  const memoryWarning = wasDone
    ? undefined
    : noteApproval(project.id, args.step!, { proxy: Boolean(proxy) }, project.rootDir);
  if (memoryWarning) emitProgress(memoryWarning);
  return {
    metadata: {
      projectId: project.id,
      step: args.step,
      approval: event,
      ...(chosen ? { selectedId: args.choice } : {}),
      ...(proxy ? { countsAsUserApproval: false } : {}),
      ...(memoryWarning ? { memoryWarning } : {}),
    },
  };
});

/**
 * `--choice`: the idea the user picked becomes concept.json's selectedId and the step is sealed again on it, only while
 * the concept waits for the user. Returns how to put concept.json and its receipt back if the approval is refused.
 */
function choose(project: FilmProject, step: string, id: string): { restore: () => void } {
  if (step !== "concept")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--choice applies to step concept (the user's idea)." });
  if (!id.trim()) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--choice needs the idea's id." });
  const state = refusals(() => stepState(project, step));
  if (state.status !== "awaiting-gate")
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `Step concept is ${state.status}, not waiting for the user's choice: ${state.reasons.join(" ")}`,
    });
  let picked: ReturnType<typeof chooseIdea>;
  try {
    picked = chooseIdea(project.projectDir, id);
  } catch (error) {
    if (error instanceof StudioRefusal) throw new CliErrorObject({ code: "INVALID_INPUT", message: error.message });
    throw error;
  }
  const receipt = path.join(project.projectDir, "pipeline", "chain", "concept.json");
  const receiptBefore = existsSync(receipt) ? readFileSync(receipt, "utf8") : undefined;
  const restore = () => {
    if (!picked.changed) return;
    writeFileSync(picked.file, picked.previous);
    if (receiptBefore !== undefined) writeFileSync(receipt, receiptBefore);
  };
  if (picked.changed) {
    try {
      refusals(() => sealStep(project, step));
    } catch (error) {
      restore();
      throw error;
    }
    emitProgress(`concept.json: idea ${id} selected; step concept sealed again.`);
  }
  return { restore };
}
