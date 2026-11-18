/**
 * footage:policy-apply: answers one footage:next question from the user's autonomous policy, then appends the decision
 * to the source project's pipeline/decisions.jsonl (the film chain's ledger and helpers). Both re-derive the basis and
 * refuse when the file footage:next judged changed since (`expect`):
 *  - captionStyle: writes the pre-answered caption profile into pipeline/footage-goals.json;
 *  - shorts: writes the recut's pipeline/shorts-series-request.json from the top ranked proposals, approved by the
 *    policy (`approvedBy` is the policy prefix and the user's granting words, never presented as a fresh answer).
 * film:revert undoes the first (it drops the goals' style when unchanged) and reopens the second (footage:next asks
 * again; episode projects already created stay until removed).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendDecision } from "../film/decisions";
import { POLICY_ANSWER_PREFIX } from "../film/autonomy";
import { approvedSelections, buildSeriesRequest } from "../shorts/request";
import { FootageGoalsSchema } from "../../types/footage-goals";
import type { DecisionEntry } from "../../types/policy";
import { GOALS_FILE, mergeGoals, readFootageState } from "./next";
import {
  captionStyleUnderPolicy,
  fileSha256,
  FOOTAGE_CAPTIONS_STEP,
  FOOTAGE_SHORTS_STEP,
  readFootagePolicy,
  shortsUnderPolicy,
} from "./policy";

export class PolicyApplyRefusal extends Error {}

export type PolicyApplyResult = { decision: DecisionEntry; outputs: string[] };

const rel = (rootDir: string, file: string) => path.relative(rootDir, path.resolve(rootDir, file));

function checkExpect(expect: string, now: string | null, what: string) {
  if ((now ?? "none") !== expect)
    throw new PolicyApplyRefusal(
      `${what} changed since footage:next (${expect.slice(0, 12)} named, ${(now ?? "none").slice(0, 12)} now): run footage:next again.`,
    );
}

export function applyFootagePolicy(
  projectId: string,
  apply: "captionStyle" | "shorts",
  expect: string,
  options: { rootDir?: string; at?: string } = {},
): PolicyApplyResult {
  const state = readFootageState(projectId, { save: false, ...(options.rootDir ? { rootDir: options.rootDir } : {}) });
  const { rootDir } = state;
  const projectDir = path.join(rootDir, "public/projects", state.projectId);
  const at = options.at ?? new Date().toISOString();
  // The state carries the view once the recording is readable; the goals alone are enough for the caption style.
  const view = state.policy ?? readFootagePolicy(projectDir, rootDir, { goals: path.join(projectDir, GOALS_FILE) });
  if (!view)
    throw new PolicyApplyRefusal(`Project ${state.projectId} has no autonomous policy: footage:next asks the user.`);

  if (apply === "captionStyle") {
    const goalsPath = path.join(projectDir, GOALS_FILE);
    if (!state.goals?.goals.includes("captions"))
      throw new PolicyApplyRefusal("Captions are not a goal of this recording.");
    if (state.goals.captionStyle)
      throw new PolicyApplyRefusal(`The goals already choose ${state.goals.captionStyle}: nothing to pre-answer.`);
    const { style, warning } = captionStyleUnderPolicy(view);
    if (!style) throw new PolicyApplyRefusal(warning ?? "The policy pre-answers no caption style.");
    checkExpect(expect, view.goalsSha256, GOALS_FILE);
    const goals = FootageGoalsSchema.parse(mergeGoals(state.goals, { captionStyle: style as never }));
    writeFileSync(goalsPath, `${JSON.stringify(goals, null, 2)}\n`);
    const decision = appendDecision(projectDir, {
      step: FOOTAGE_CAPTIONS_STEP,
      kind: "preAnswer",
      artefactHashes: { [rel(rootDir, goalsPath)]: fileSha256(goalsPath)! },
      evidence: { preAnswer: `captionStyle=${style}`, captionStyle: style },
      judgeVerdict: "the user's pre-answered caption style",
      policyRevision: view.revision,
      at,
    });
    return { decision, outputs: [rel(rootDir, goalsPath)] };
  }

  const recut = state.recut;
  const proposals = state.shorts?.proposals;
  if (!recut || !proposals || !proposals.fresh || proposals.projectId !== recut.projectId)
    throw new PolicyApplyRefusal("No fresh ranked proposals on the recut: run footage:next.");
  if (state.series && !view.seriesRevokedBy)
    throw new PolicyApplyRefusal(`${state.series.file} already holds an approved series.`);
  const { ids, basis, warning } = shortsUnderPolicy(view, proposals.proposed);
  if (!ids) throw new PolicyApplyRefusal(warning ?? "The policy pre-answers no shorts.");
  checkExpect(expect, view.proposalsSha256, proposals.file);
  const proposalsPath = path.resolve(rootDir, proposals.file);
  const selections = approvedSelections(JSON.parse(readFileSync(proposalsPath, "utf8")), recut.projectId, {
    ids,
    approvedBy: `${POLICY_ANSWER_PREFIX}${view.grantedBy}`,
    approvedAt: at,
  });
  const { request } = buildSeriesRequest(selections, {
    rootDir,
    projectId: recut.projectId,
    seriesId: `${recut.projectId}-shorts`,
    formats: ["vertical"],
    chapterFile: "pipeline/chapters.json",
  });
  const output = path.join(rootDir, "public/projects", recut.projectId, "pipeline/shorts-series-request.json");
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(request, null, 2)}\n`);
  const decision = appendDecision(projectDir, {
    step: FOOTAGE_SHORTS_STEP,
    kind: basis === "preAnswer" ? "preAnswer" : "judge",
    artefactHashes: {
      [rel(rootDir, proposalsPath)]: view.proposalsSha256!,
      [rel(rootDir, output)]: fileSha256(output)!,
    },
    evidence:
      basis === "preAnswer"
        ? { preAnswer: `shorts=${ids.length}`, ids: ids.join(",") }
        : { autoPass: "shorts", judge: rel(rootDir, proposalsPath), ids: ids.join(",") },
    judgeVerdict:
      basis === "preAnswer" ? `the top ${ids.length} ranked clips, as pre-answered` : "every clip shorts:rank proposed",
    alternatives: [...proposals.proposed, ...proposals.others].filter((id) => !ids.includes(id)),
    policyRevision: view.revision,
    at,
  });
  return { decision, outputs: [rel(rootDir, output)] };
}

/**
 * film:revert on a footage decision: a caption style the policy wrote is dropped from the goals while they still hold
 * it, so footage:next asks; a series request stays on disk but footage:next asks again (episodes already created stay).
 */
export function undoFootageDecision(projectDir: string, entry: DecisionEntry): string | undefined {
  if (entry.kind === "revoked") return undefined;
  if (entry.step === FOOTAGE_CAPTIONS_STEP) {
    const goalsPath = path.join(projectDir, GOALS_FILE);
    let goals;
    try {
      goals = FootageGoalsSchema.parse(JSON.parse(readFileSync(goalsPath, "utf8")));
    } catch {
      return undefined;
    }
    if (goals.captionStyle !== entry.evidence.captionStyle)
      return `The goals no longer hold ${entry.evidence.captionStyle}; left as they are.`;
    const { captionStyle: _dropped, ...rest } = goals;
    writeFileSync(goalsPath, `${JSON.stringify(rest, null, 2)}\n`);
    return `Dropped captionStyle ${entry.evidence.captionStyle} from ${GOALS_FILE}: footage:next asks the user.`;
  }
  if (entry.step === FOOTAGE_SHORTS_STEP)
    return "footage:next asks the user which clips to approve; episode projects already created stay until removed (pnpm project:remove).";
  return undefined;
}
