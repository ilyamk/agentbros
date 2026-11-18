/**
 * `pnpm feedback` on a campaign: the user watched one variant's render. An item about the variant reopens that member;
 * an item about a shared material (a `materialId`, or the material aspect) reopens every member that uses it, through
 * the materials' dependencies. Reopening is the campaign's own review-draft mechanism: a `fix` choice in
 * selection.json carrying the user's verbatim words, which campaign:next turns into the campaign-producer's
 * review-repair, a revised plan and a fresh plan decision. The record lives in the campaign container's
 * pipeline/feedback/.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FeedbackInputSchema, FeedbackSchema, type Aspect, type Feedback } from "../../types/feedback";
import type { CampaignProductionPlan } from "../../types/campaign-production";
import { userWordsProblem } from "../cli/user-words";
import {
  appendSelection,
  memberRenderOutputs,
  readSelection,
  selectionFile,
  type SelectionChoice,
} from "../campaigns/production/selection";
import { projectDirectory } from "../campaigns/production/files";
import { loadCampaign } from "../campaigns/production/store";
import { feedbackFile, nextFeedbackId, writeJson } from "./store";

export class CampaignFeedbackRefusal extends Error {}

/** Aspects that are about something every variant shares when the user names it: a material. Others are the variant's. */
export const CAMPAIGN_DEPENDENCY_ASPECTS: readonly Aspect[] = ["material"];

export type CampaignFeedbackPlan = {
  projectDir: string;
  planHash: string;
  selectionRevision: number;
  record: Feedback;
  choices: SelectionChoice[];
  reopens: { step: string; owner: string; because: string }[];
  ask: { itemId: string; aspect: Aspect; quote: string; why: string }[];
  warnings: string[];
};

/** Every material a member uses, with what those materials are made from, transitively. */
function materialsOf(plan: CampaignProductionPlan, memberId: string): Set<string> {
  const byId = new Map(plan.request.materials.map((material) => [material.id, material]));
  const seen = new Set<string>();
  const queue = [...(plan.members.find((member) => member.id === memberId)?.materials ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return seen;
}

const bounded = (text: string, max = 1900) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function planCampaignFeedback(
  root: string,
  id: string,
  raw: unknown,
  at: string = new Date().toISOString(),
): CampaignFeedbackPlan {
  const kind = (raw as { source?: { kind?: unknown } } | undefined)?.source?.kind;
  if (kind !== undefined && kind !== "user")
    throw new CampaignFeedbackRefusal("Feedback is the user's own words: a proxy, critic or agent source is refused.");
  const parsed = FeedbackInputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CampaignFeedbackRefusal(
      `The feedback file is not valid: ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}. Every item needs the user's words verbatim in "quote", an "aspect" and, with several variants, the "memberId" they watched.`,
    );
  }
  const input = parsed.data;
  for (const [index, item] of input.items.entries()) {
    const problem = userWordsProblem(item.quote);
    if (problem) throw new CampaignFeedbackRefusal(`items.${index}.quote is not the user's words: ${problem}.`);
  }
  const plan = loadCampaign(root, id);
  const active = plan.members.filter((member) => !member.excluded);
  const projectDir = projectDirectory(root, id);
  const ask: CampaignFeedbackPlan["ask"] = [];
  /** member id → the items that reopen it, and why. */
  const reopened = new Map<string, { lines: string[]; because: Set<string>; feedback: string[] }>();
  const recordId = nextFeedbackId(projectDir);

  // The render the user watched names the variant: from "watched", else the one member the items name, else the only one.
  const outputsOf = new Map(active.map((member) => [member.id, memberRenderOutputs(root, plan, member.id)]));
  const named = [...new Set(input.items.flatMap((item) => (item.memberId ? [item.memberId] : [])))];
  let watchedPath = input.watched?.path;
  if (!watchedPath) {
    const only = named.length === 1 ? named[0] : named.length === 0 && active.length === 1 ? active[0]!.id : undefined;
    if (!only)
      throw new CampaignFeedbackRefusal(
        `The campaign has ${active.length} variants: name the render the user watched in "watched": {"path": ...} (or one "memberId" for every item).`,
      );
    watchedPath = outputsOf.get(only)?.[0]?.path;
    if (!watchedPath)
      throw new CampaignFeedbackRefusal(
        `No render of ${only} exists: feedback is bound to the exact video the user watched.`,
      );
  }
  const watchedFile = path.resolve(root, watchedPath);
  if (!existsSync(watchedFile))
    throw new CampaignFeedbackRefusal(
      `${watchedPath} does not exist: feedback is bound to the exact video the user watched.`,
    );
  const watchedSha = createHash("sha256").update(readFileSync(watchedFile)).digest("hex");
  if (input.watched?.sha256 && input.watched.sha256 !== watchedSha)
    throw new CampaignFeedbackRefusal(
      `${watchedPath} changed since the user watched it: show them the current video first.`,
    );
  const watchedMember = [...outputsOf].find(([, pins]) =>
    pins.some((pin) => path.resolve(root, pin.path) === watchedFile && pin.sha256 === watchedSha),
  )?.[0];
  if (!watchedMember)
    throw new CampaignFeedbackRefusal(
      `${watchedPath} is not a current render of this campaign's variants: feedback is bound to a video of the current plan.`,
    );

  const items = input.items.map((item, index) => {
    const itemId = `i${index + 1}`;
    const quote = item.quote.trim();
    const base = {
      id: itemId,
      quote,
      aspect: item.aspect,
      ...(item.at ? { at: item.at } : {}),
      ...(item.shotId ? { shotId: item.shotId } : {}),
      severity: item.severity,
      status: "open" as const,
    };
    const asked = (why: string) => {
      ask.push({ itemId, aspect: item.aspect, quote, why });
      return {
        ...base,
        ...(item.memberId ? { memberId: item.memberId } : {}),
        ...(item.materialId ? { materialId: item.materialId } : {}),
        routedTo: "ask",
      };
    };
    if (item.aspect === "unclear")
      return asked("the user's words do not say what should change: ask them which part of the video they mean");
    const memberId = item.memberId ?? watchedMember;
    const member = plan.members.find((candidate) => candidate.id === memberId);
    if (!member) return asked(`no variant ${memberId} in the current plan: ask which one the user watched`);
    if (member.excluded)
      return asked(
        `variant ${memberId} is rejected in the current plan: ask whether to bring it back (review:ui keep)`,
      );
    const used = materialsOf(plan, memberId);
    const dependency = item.materialId !== undefined || CAMPAIGN_DEPENDENCY_ASPECTS.includes(item.aspect);
    const where = item.at ? `, ${item.at.fromSec}-${item.at.toSec}s` : "";
    if (!dependency) {
      const entry = reopened.get(memberId) ?? { lines: [], because: new Set<string>(), feedback: [] };
      entry.lines.push(`${recordId} ${itemId} (${item.aspect}, ${item.severity}${where}): "${quote}"`);
      entry.because.add("the user's feedback on this variant");
      entry.feedback.push(itemId);
      reopened.set(memberId, entry);
      return { ...base, memberId, routedTo: "variant" };
    }
    const materialId = item.materialId ?? (member.materials.length === 1 ? member.materials[0] : undefined);
    if (!materialId)
      return asked(
        `${memberId} uses ${member.materials.length ? member.materials.join(", ") : "no declared material"}: ask which shared material the user means and set "materialId"`,
      );
    if (!plan.request.materials.some((material) => material.id === materialId))
      return asked(`no material ${materialId} in the plan: ask which material the user means`);
    if (!used.has(materialId))
      return asked(`${memberId} does not use material ${materialId}: ask which material the user means`);
    for (const consumer of active.filter((candidate) => materialsOf(plan, candidate.id).has(materialId))) {
      const entry = reopened.get(consumer.id) ?? { lines: [], because: new Set<string>(), feedback: [] };
      entry.lines.push(
        `${recordId} ${itemId} (${item.aspect}, ${item.severity}, material ${materialId}, watched in ${memberId}${where}): "${quote}"`,
      );
      entry.because.add(consumer.id === memberId ? "the user's feedback" : `uses material ${materialId}`);
      entry.feedback.push(itemId);
      reopened.set(consumer.id, entry);
    }
    return { ...base, memberId, materialId, routedTo: "dependency" };
  });

  const record = FeedbackSchema.parse({
    schemaVersion: 1,
    id: recordId,
    route: "campaign",
    watched: { path: path.relative(root, watchedFile), sha256: watchedSha },
    source: { kind: "user", at },
    verdict: input.verdict,
    items,
  });
  const warnings: string[] = [];
  const choices: SelectionChoice[] = [];
  if (record.verdict === "revise")
    for (const [memberId, entry] of reopened)
      choices.push({
        memberId,
        choice: "fix",
        note: bounded(`The user's feedback, verbatim:\n${entry.lines.join("\n")}`),
        outputs: outputsOf.get(memberId) ?? [],
        extra: { kind: "user-feedback", feedbackId: record.id, itemIds: entry.feedback },
      });
  else
    warnings.push(
      "The verdict is accept: the items are recorded and no variant reopens; approvals stay with campaign:approve.",
    );
  if (choices.length)
    warnings.push(
      "Each reopened variant gets a fix draft: campaign:next dispatches the campaign-producer's review-repair, a revised plan, and asks the user to approve that plan again. Nothing is generated or spent before then.",
    );
  return {
    projectDir,
    planHash: plan.planHash,
    selectionRevision: readSelection(root, id, plan.planHash).revision,
    record,
    choices,
    reopens: choices.map((choice) => ({
      step: choice.memberId,
      owner: "campaign-producer",
      because: [...reopened.get(choice.memberId)!.because].join("; "),
    })),
    ask,
    warnings,
  };
}

/** Appends the fix drafts (refused when the plan or the drafts moved since the preview), then writes the record. */
export function writeCampaignFeedback(root: string, id: string, plan: CampaignFeedbackPlan): string[] {
  const written: string[] = [];
  if (plan.choices.length) {
    const saved = appendSelection(
      root,
      id,
      { planHash: plan.planHash, revision: plan.selectionRevision },
      plan.choices,
      plan.record.source.at,
    );
    if (!saved)
      throw new CampaignFeedbackRefusal(
        "The campaign's plan, review drafts or a variant's render changed since the preview: preview the feedback again.",
      );
    written.push(selectionFile(root, id));
  }
  const file = feedbackFile(plan.projectDir, plan.record.id);
  writeJson(file, plan.record);
  written.unshift(file);
  return written.map((item) => path.relative(root, item));
}
