/**
 * The campaign's review drafts (`pipeline/campaign-production/selection.json`): keep, fix or reject per member, bound to
 * the plan and to the member's exact render outputs. review:ui and `pnpm feedback` both append here, under the writer
 * lock and with a revision check; campaign:next turns current fix/reject drafts into the review-repair handoff.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { CampaignProductionPlan } from "../../../types/campaign-production";
import { campaignInputIdentity } from "./execute";
import { atomicJson, digest, jsonFile, locked, productionDirectory } from "./files";
import { taskReceipt } from "./queue";
import { loadCampaign } from "./store";

export type CampaignPin = { path: string; sha256: string };
export type Selection = { revision: number; planHash: string; choices: Record<string, unknown>[] };
export type SelectionChoice = {
  memberId: string;
  choice: "keep" | "fix" | "reject";
  note: string;
  /** The outputs the reviewer saw: the draft is refused when the member's render outputs differ now. */
  outputs: CampaignPin[];
  /** Extra fields kept on the draft (feedback id, quote, kind). */
  extra?: Record<string, unknown>;
};

export const selectionFile = (root: string, id: string) => path.join(productionDirectory(root, id), "selection.json");

export function readSelection(root: string, id: string, planHash: string): Selection {
  const file = selectionFile(root, id);
  return existsSync(file) ? (jsonFile(file) as Selection) : { revision: 0, planHash, choices: [] };
}

/** The member's current render outputs (MP4 pins from its render task receipts). */
export function memberRenderOutputs(root: string, plan: CampaignProductionPlan, memberId: string): CampaignPin[] {
  return plan.tasks
    .filter((task) => task.kind === "render" && task.memberId === memberId)
    .flatMap(
      (task) =>
        taskReceipt(root, plan, task, campaignInputIdentity)?.outputs.filter((pin) => pin.path.endsWith(".mp4")) ?? [],
    );
}

/**
 * Appends the choices as one new revision. Null when the plan, the revision or a member's outputs moved since the
 * caller looked (the caller refreshes and shows the current videos).
 */
export function appendSelection(
  root: string,
  id: string,
  expected: { planHash: string; revision: number },
  choices: SelectionChoice[],
  at: string = new Date().toISOString(),
): Selection | null {
  return locked(`${selectionFile(root, id)}.lock`, () => {
    const plan = loadCampaign(root, id),
      latest = readSelection(root, id, plan.planHash);
    if (latest.revision !== expected.revision || plan.planHash !== expected.planHash) return null;
    const entries: Record<string, unknown>[] = [];
    for (const choice of choices) {
      const outputs = memberRenderOutputs(root, plan, choice.memberId);
      if (digest(outputs) !== digest(choice.outputs)) return null;
      entries.push({
        planHash: expected.planHash,
        expectedRevision: expected.revision,
        memberId: choice.memberId,
        choice: choice.choice,
        note: choice.note,
        ...choice.extra,
        outputs,
        kind: (choice.extra?.["kind"] as string | undefined) ?? "review-draft",
        at,
      });
    }
    const saved = {
      revision: expected.revision + 1,
      planHash: expected.planHash,
      choices: [...latest.choices, ...entries],
    };
    atomicJson(selectionFile(root, id), saved);
    return saved;
  });
}
