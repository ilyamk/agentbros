/**
 * The campaign review core, shared by `review:ui`'s campaign server (review-ui.ts) and the studio console's campaign
 * view (src/lib/console/review/campaign.ts, RFC 0004 WP13e): the state the page shows, the strict selection body, the
 * save with its conflict outcomes, and the receipt-pinned MP4 lookup behind `/file`.
 */
import { closeSync, constants, existsSync, fstatSync, openSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CampaignFileSchema } from "../../../types/campaign-production";
import { fileHashAsync, jsonFile, productionDirectory, refuse, scopedFile } from "./files";
import { appendSelection, readSelection, type CampaignPin, type Selection } from "./selection";
import { campaignStatus } from "./service";
import { loadCampaign } from "./store";

/** The body of a saved review draft (one member). */
export const CampaignSelectionSchema = z
  .object({
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRevision: z.number().int().nonnegative(),
    memberId: z.string(),
    choice: z.enum(["keep", "fix", "reject"]),
    note: z.string().max(2000),
    outputs: z.array(CampaignFileSchema).max(16),
  })
  .strict();
export type CampaignSelectionInput = z.infer<typeof CampaignSelectionSchema>;

export interface CampaignReviewMember {
  id: string;
  heldForPilot: boolean;
  excluded: boolean;
  /** The last saved choice for this plan, if any. */
  choice: string | undefined;
  productId: string | undefined;
  language: string;
  factors: Record<string, unknown>;
  tasks: { id: string; state: string }[];
  /** MP4 outputs of the member's complete render tasks; stale outputs are not listed. */
  outputs: CampaignPin[];
}

export interface CampaignReviewState {
  campaignId: string;
  planHash: string;
  selection: Selection;
  members: CampaignReviewMember[];
}

/** What the campaign review page shows (RU-CP02, RU-CP04). Read-only. */
export function campaignReviewState(root: string, id: string): CampaignReviewState {
  const plan = loadCampaign(root, id),
    status = campaignStatus(root, id),
    selection = readSelection(root, id, plan.planHash);
  const members = plan.members.map((member) => ({
    id: member.id,
    heldForPilot: status.heldMemberIds.includes(member.id),
    excluded: Boolean(member.excluded),
    choice: [...selection.choices]
      .reverse()
      .find((choice) => choice.memberId === member.id && choice.planHash === plan.planHash)?.choice as
      string | undefined,
    productId: member.productId,
    language: member.language,
    factors: member.factors as Record<string, unknown>,
    tasks: status.tasks
      .filter((task) => plan.tasks.find((item) => item.id === task.id)?.memberId === member.id)
      .map((task) => ({ id: task.id, state: task.state })),
    outputs: plan.tasks
      .filter((task) => task.kind === "render" && task.memberId === member.id)
      .flatMap((task) => {
        const result = status.tasks.find((item) => item.id === task.id);
        return result?.state === "complete" ? result.receipt.outputs.filter((pin) => pin.path.endsWith(".mp4")) : [];
      }),
  }));
  return { campaignId: id, planHash: plan.planHash, selection, members };
}

export const CAMPAIGN_REVIEW_CHANGED = "Campaign review changed; refresh";
export const CAMPAIGN_OUTPUTS_CHANGED = "Campaign outputs or selection changed; refresh and review the current videos";

/**
 * Saves one review draft (RU-CP05). `conflict` when the plan, the revision or the member's outputs moved since the
 * page looked (the caller answers 409); an unknown member is refused (400).
 */
export function saveCampaignSelection(
  root: string,
  id: string,
  input: CampaignSelectionInput,
): { saved: Selection } | { conflict: string } {
  const current = loadCampaign(root, id),
    selection = readSelection(root, id, current.planHash);
  if (input.planHash !== current.planHash || input.expectedRevision !== selection.revision)
    return { conflict: CAMPAIGN_REVIEW_CHANGED };
  if (!current.members.some((member) => member.id === input.memberId)) refuse("Review member is outside campaign");
  const saved = appendSelection(root, id, { planHash: input.planHash, revision: input.expectedRevision }, [
    { memberId: input.memberId, choice: input.choice, note: input.note, outputs: input.outputs },
  ]);
  return saved ? { saved } : { conflict: CAMPAIGN_OUTPUTS_CHANGED };
}

/** The receipt of `taskId` under the current plan as written (no verification), or undefined. */
function receiptOutputs(root: string, id: string, planHash: string, taskId: string): CampaignPin[] | undefined {
  const file = path.join(productionDirectory(root, id), "receipts", planHash, `${taskId}.json`);
  if (!existsSync(file)) return undefined;
  const outputs = (jsonFile(file) as { outputs?: unknown }).outputs;
  return Array.isArray(outputs)
    ? outputs.filter(
        (pin): pin is CampaignPin =>
          typeof pin === "object" &&
          pin !== null &&
          typeof (pin as CampaignPin).path === "string" &&
          /^[a-f0-9]{64}$/.test(String((pin as CampaignPin).sha256)),
      )
    : undefined;
}

/**
 * The pin of a requested `/file` path: an `.mp4` output listed by a render task's receipt under the current plan
 * (RU-CP04, security item 19). Only the requested file is then verified ({@link openCampaignPin}); the receipt's other
 * pins and inputs are not re-hashed per request (the state route applies the full currency check and hides stale
 * outputs). Anything else is refused.
 */
export function campaignReviewPin(root: string, id: string, requested: string | null): CampaignPin {
  const plan = loadCampaign(root, id);
  for (const task of plan.tasks) {
    if (task.kind !== "render") continue;
    const pin = receiptOutputs(root, id, plan.planHash, task.id)?.find(
      (pin) => pin.path === requested && pin.path.endsWith(".mp4"),
    );
    if (pin) return pin;
  }
  refuse("File is outside the exact campaign render set");
}

/**
 * Hashes every pinned output of the current plan's receipts asynchronously (streamed, off the event loop's hot path)
 * into the campaign hash memo, so the synchronous state that follows re-verifies them with a stat each. Unreadable or
 * changed files are skipped: the state then reports them as it always did.
 */
export async function warmCampaignReview(root: string, id: string): Promise<void> {
  const plan = loadCampaign(root, id);
  const seen = new Set<string>();
  for (const task of plan.tasks)
    for (const pin of receiptOutputs(root, id, plan.planHash, task.id) ?? []) {
      if (seen.has(pin.path)) continue;
      seen.add(pin.path);
      let fd: number | undefined;
      try {
        const file = scopedFile(root, pin.path);
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        await fileHashAsync(file, fd, pin.path);
      } catch {
        // left to the synchronous check
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
}

/**
 * Opens a pinned output for streaming: no symlinks (path or leaf), a regular file, and the open descriptor's content
 * hash equal to the pin — streamed asynchronously, or taken from the memo when the file's identity (size, mtime,
 * inode) is unchanged — so the bytes served are the ones verified. The caller owns `fd`.
 */
export async function openCampaignPin(root: string, pin: CampaignPin): Promise<{ fd: number; size: number }> {
  const file = scopedFile(root, pin.path);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuse(`Campaign file is not readable: ${pin.path}`);
  }
  try {
    if ((await fileHashAsync(file, fd, pin.path)) !== pin.sha256) refuse(`Stale campaign input: ${pin.path}`);
    return { fd, size: fstatSync(fd).size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
