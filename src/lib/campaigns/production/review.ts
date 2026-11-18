import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CampaignReviewPackageSchema,
  type CampaignProductionPlan,
  type CampaignReviewPackage,
} from "../../../types/campaign-production";
import { DeliveryRequestSchema, DeliverySnapshotSchema } from "../../../types/delivery";
import { approveStep, deriveChain, openFilmProject, stepState } from "../../film/state";
import { stepById } from "../../film/chain";
import { reviewLocalization, assertLocalizationReady } from "../localization";
import { isBespokeDelivery } from "../../delivery/bespoke";
import { taskReceipt, campaignReadScope } from "./queue";
import { campaignInputIdentity, canonicalCampaignAlignment } from "./execute";
import { assertCampaignActive } from "./store";
import {
  atomicJson,
  digest,
  immutableJson,
  jsonFile,
  pinFile,
  productionDirectory,
  projectDirectory,
  refuse,
  scopedFile,
  verifyPin,
  acquireLock,
} from "./files";

const IntentSchema = z
  .object({
    version: z.literal(1),
    package: CampaignReviewPackageSchema,
    answer: z.string().min(1),
    reviewedBy: z.string().min(1),
    at: z.string().datetime(),
    applied: z.record(z.string(), z.array(z.object({ path: z.string(), sha256: z.string() }).strict())),
    complete: z.boolean(),
  })
  .strict();
const memberFile = (root: string, id: string, file: string) => path.join(projectDirectory(root, id), "pipeline", file);
export function reviewPackage(
  root: string,
  plan: CampaignProductionPlan,
  purpose: CampaignReviewPackage["purpose"],
  selection?: string[],
) {
  return campaignReadScope(() => reviewPackageRead(root, plan, purpose, selection));
}
function reviewPackageRead(
  root: string,
  plan: CampaignProductionPlan,
  purpose: CampaignReviewPackage["purpose"],
  selection?: string[],
) {
  const members: CampaignReviewPackage["members"] = [],
    selected = plan.members.filter(
      (member) =>
        !member.excluded &&
        (purpose !== "pilot-outputs" || plan.request.policy?.pilotMemberIds?.includes(member.id)) &&
        (!selection || selection.includes(member.id)),
    );
  if (selection && (selected.length !== selection.length || new Set(selection).size !== selection.length))
    refuse("Review selection names missing or duplicate members");
  if (purpose === "creative-plan") {
    const pin = pinFile(root, path.join(productionDirectory(root, plan.request.id), "plans", `${plan.planHash}.json`));
    members.push({
      id: plan.request.id,
      projectId: plan.request.id,
      kind: "plan",
      artefacts: { plan: pin.sha256 },
      files: [pin],
    });
  } else if (purpose === "generation-requests") {
    for (const material of plan.request.materials.filter((item) => item.source.kind === "generate")) {
      if (material.source.kind !== "generate") continue;
      const pin = material.source.request;
      members.push({
        id: material.id,
        projectId:
          material.owner === "shared"
            ? plan.request.id
            : plan.members.find((member) => member.id === material.owner)!.projectId,
        kind: "plan",
        artefacts: { request: pin.sha256 },
        files: [pin],
      });
    }
  } else
    for (const member of selected) {
      const directory = projectDirectory(root, member.projectId);
      if (purpose === "child-gates") {
        if (isBespokeDelivery(root, member.projectId)) {
          const film = openFilmProject(directory, { rootDir: root }),
            step = deriveChain(film).steps.find(
              (item) =>
                item.status === "awaiting-gate" &&
                !item.firstAsk &&
                (stepById(item.id)?.gate === "user" || item.critic?.action === "ask"),
            );
          if (step)
            members.push({
              id: member.id,
              projectId: member.projectId,
              kind: "film",
              stage: step.id,
              artefacts: step.outputs,
              files: Object.keys(step.outputs).map((file) => pinFile(root, file)),
            });
        } else if (existsSync(memberFile(root, member.projectId, "localization.json"))) {
          const state = jsonFile(memberFile(root, member.projectId, "localization.json")) as {
            sourceHash: string;
            productionReady?: boolean;
          };
          let ready = false;
          try {
            assertLocalizationReady(directory);
            ready = true;
          } catch {
            /* The exact current project needs a fresh language review. */
          }
          if (!ready) {
            const files = [
              pinFile(root, path.join(directory, "project.json")),
              ...member.speech.flatMap((speech) => [
                pinFile(root, path.join(directory, "voiceover", `${speech.sceneId}.mp3`)),
                pinFile(root, path.join(directory, "voiceover", `${speech.sceneId}.words.json`)),
              ]),
            ];
            if (!member.speech.length) refuse("Supply replacement localised audio and alignments before review");
            members.push({
              id: member.id,
              projectId: member.projectId,
              kind: "template",
              stage: "localisation",
              artefacts: { source: state.sourceHash },
              files,
            });
          }
        }
      } else {
        const outputs = plan.tasks
          .filter((task) => task.memberId === member.id && task.kind === "render")
          .flatMap((task) => {
            const receipt = taskReceipt(root, plan, task, campaignInputIdentity);
            if (!receipt) refuse("Review requires completed, current render tasks");
            return receipt.outputs;
          });
        const binding = memberFile(root, member.projectId, "campaign-delivery.json");
        const extra = existsSync(binding) ? (jsonFile(binding) as { snapshot: string; request: string }) : undefined;
        members.push({
          id: member.id,
          projectId: member.projectId,
          kind: "outputs",
          artefacts: {},
          files: outputs,
          ...(extra ? { snapshot: pinFile(root, extra.snapshot), request: pinFile(root, extra.request) } : {}),
        });
      }
    }
  if (!members.length) refuse("No concrete review members are ready");
  const content = { version: 1 as const, campaignId: plan.request.id, planHash: plan.planHash, purpose, members };
  const pack = CampaignReviewPackageSchema.parse({ ...content, packageHash: digest(content) });
  verifyPackage(root, plan, pack);
  const file = path.join(productionDirectory(root, plan.request.id), "reviews", `${pack.packageHash}.json`);
  immutableJson(file, pack);
  return { pack, file };
}
export function verifyPackage(root: string, plan: CampaignProductionPlan, pack: CampaignReviewPackage): void {
  return campaignReadScope(() => verifyPackageRead(root, plan, pack));
}
function verifyPackageRead(root: string, plan: CampaignProductionPlan, pack: CampaignReviewPackage) {
  const { packageHash, ...content } = CampaignReviewPackageSchema.parse(pack);
  if (packageHash !== digest(content) || pack.planHash !== plan.planHash || pack.campaignId !== plan.request.id)
    refuse("Stale campaign review package");
  if (new Set(pack.members.map((member) => member.id)).size !== pack.members.length)
    refuse("Duplicate package members");
  if (pack.purpose === "creative-plan") {
    const pin = pinFile(root, path.join(productionDirectory(root, plan.request.id), "plans", `${plan.planHash}.json`));
    if (
      pack.members.length !== 1 ||
      pack.members[0].kind !== "plan" ||
      pack.members[0].id !== plan.request.id ||
      pack.members[0].projectId !== plan.request.id ||
      pack.members[0].artefacts.plan !== pin.sha256 ||
      digest(pack.members[0].files) !== digest([pin])
    )
      refuse("Creative approval must name the exact whole campaign plan");
  }
  if (pack.purpose === "generation-requests") {
    const materials = plan.request.materials.filter((material) => material.source.kind === "generate");
    if (
      pack.members.length !== materials.length ||
      materials.some((material) => {
        const member = pack.members.find((member) => member.id === material.id);
        const owner =
          material.owner === "shared"
            ? plan.request.id
            : plan.members.find((item) => item.id === material.owner)!.projectId;
        return (
          material.source.kind !== "generate" ||
          !member ||
          member.kind !== "plan" ||
          member.projectId !== owner ||
          member.artefacts.request !== material.source.request.sha256 ||
          digest(member.files) !== digest([material.source.request])
        );
      })
    )
      refuse("Generation approval must cover the exact complete request set");
  }
  for (const member of pack.members) {
    if (
      member.kind !== "plan" &&
      !plan.members.some((item) => !item.excluded && item.id === member.id && item.projectId === member.projectId)
    )
      refuse("Review member is outside the selected campaign");
    if (pack.purpose === "child-gates" && !["film", "template"].includes(member.kind))
      refuse("Child gate packages require concrete child approvals");
    if (pack.purpose === "pilot-outputs") {
      const ids = plan.request.policy?.pilotMemberIds;
      if (!ids || digest([...ids].sort()) !== digest(pack.members.map((member) => member.id).sort()))
        refuse("Pilot approval requires the exact selected pilot set");
      for (const member of pack.members) {
        const task = plan.tasks.find((task) => task.id === `critique-${member.id}`)!;
        if (!taskReceipt(root, plan, task, campaignInputIdentity))
          refuse("Pilot approval requires current QA and accepted independent critique");
      }
    }
    if (pack.purpose === "final-outputs" || pack.purpose === "pilot-outputs") {
      if (member.kind !== "outputs") refuse("Final packages require concrete member outputs");
      const outputs = plan.tasks
        .filter((task) => task.memberId === member.id && task.kind === "render")
        .flatMap((task) => {
          const receipt = taskReceipt(root, plan, task, campaignInputIdentity);
          if (!receipt) refuse("Final package render is missing or stale");
          return receipt.outputs;
        });
      if (!outputs.length || digest(outputs) !== digest(member.files))
        refuse("Final package differs from the exact member render set");
      const binding = memberFile(root, member.projectId, "campaign-delivery.json");
      if (existsSync(binding)) {
        const current = jsonFile(binding) as { snapshot: string; request: string };
        if (
          digest(member.snapshot) !== digest(pinFile(root, current.snapshot)) ||
          digest(member.request) !== digest(pinFile(root, current.request))
        )
          refuse("Final package delivery snapshot or request differs");
      } else if (member.snapshot || member.request) refuse("Final package has no matching delivery binding");
    }
    for (const pin of [
      ...member.files,
      ...(member.snapshot ? [member.snapshot] : []),
      ...(member.request ? [member.request] : []),
    ])
      verifyPin(root, pin);
    if (member.kind === "film") {
      const state = stepState(
        openFilmProject(projectDirectory(root, member.projectId), { rootDir: root }),
        member.stage!,
      );
      if (
        digest(state.outputs) !== digest(member.artefacts) ||
        state.firstAsk ||
        !["awaiting-gate", "done"].includes(state.status)
      )
        refuse("Film review gate changed");
      const gate = stepById(member.stage!)?.gate;
      if (gate !== "user" && !(gate === "critic" && state.critic?.action === "ask"))
        refuse("Film step is not a concrete user approval");
    }
    if (member.kind === "template" && member.stage !== "localisation")
      refuse("Template stage approval was removed with the 16-stage pipeline");
    if (member.kind === "template" && member.stage === "localisation") {
      const child = plan.members.find((item) => item.id === member.id)!,
        directory = projectDirectory(root, member.projectId);
      const state = jsonFile(memberFile(root, member.projectId, "localization.json")) as { sourceHash: string };
      const sourcePins = [
        pinFile(root, path.join(directory, "project.json")),
        ...child.speech.flatMap((speech) => [
          pinFile(root, path.join(directory, "voiceover", `${speech.sceneId}.mp3`)),
          pinFile(root, path.join(directory, "voiceover", `${speech.sceneId}.words.json`)),
        ]),
      ];
      if (
        child.speech.some(
          (speech) =>
            pinFile(root, path.join(directory, "voiceover", `${speech.sceneId}.mp3`)).sha256 !== speech.audio.sha256 ||
            digest(jsonFile(path.join(directory, "voiceover", `${speech.sceneId}.words.json`))) !==
              digest(canonicalCampaignAlignment(jsonFile(verifyPin(root, speech.alignment)))),
        )
      )
        refuse("Localised media differs from the requested speech; rerun anchors before review");
      if (
        !child.speech.length ||
        member.artefacts.source !== state.sourceHash ||
        digest(member.files) !== digest(sourcePins)
      )
        refuse("Localisation approval must pin the exact project and replacement speech");
    }
  }
}
export function packageApproved(
  root: string,
  plan: CampaignProductionPlan,
  purpose: CampaignReviewPackage["purpose"],
): boolean {
  return campaignReadScope(() => packageApprovedRead(root, plan, purpose));
}
function packageApprovedRead(root: string, plan: CampaignProductionPlan, purpose: CampaignReviewPackage["purpose"]) {
  const dir = path.join(productionDirectory(root, plan.request.id), "approvals");
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .some((file) => {
      const intent = IntentSchema.parse(jsonFile(scopedFile(root, path.join(dir, file))));
      if (!intent.complete || intent.package.planHash !== plan.planHash || intent.package.purpose !== purpose)
        return false;
      try {
        verifyPackage(root, plan, intent.package);
        return true;
      } catch {
        return false;
      }
    });
}
export async function approveCampaignPackage(
  root: string,
  plan: CampaignProductionPlan,
  raw: unknown,
  expectedHash: string,
  answer: string,
  reviewedBy: string,
) {
  const pack = CampaignReviewPackageSchema.parse(raw);
  if (!answer.trim() || !reviewedBy.trim() || pack.packageHash !== expectedHash)
    refuse("Approval needs the exact package hash, reviewer and user words");
  const directory = productionDirectory(root, plan.request.id),
    file = scopedFile(root, path.join(directory, "approvals", `${pack.packageHash}.json`));
  const release = acquireLock(path.join(directory, "approval.lock"));
  if (!release) refuse("Campaign approval is busy");
  const releaseWriter = acquireLock(path.join(directory, "writer.lock"));
  if (!releaseWriter) {
    release();
    refuse("Campaign execution or revision is busy");
  }
  try {
    assertCampaignActive(root, plan.request.id);
    if ((jsonFile(path.join(directory, "current.json")) as { planHash: string }).planHash !== plan.planHash)
      refuse("Campaign revision changed before approval");
    const existing = existsSync(file) ? IntentSchema.parse(jsonFile(file)) : undefined;
    if (existing && (existing.answer !== answer.trim() || existing.reviewedBy !== reviewedBy.trim()))
      refuse("Conflicting package approval");
    if (existing && digest(existing.package) !== digest(pack))
      refuse("Approval package contents differ from the recorded decision");
    if (!existing || pack.purpose !== "child-gates") verifyPackage(root, plan, pack);
    const intent =
      existing ??
      IntentSchema.parse({
        version: 1,
        package: pack,
        answer: answer.trim(),
        reviewedBy: reviewedBy.trim(),
        at: new Date().toISOString(),
        applied: {},
        complete: false,
      });
    // Validate the entire still-pending set before the first new child mutation.
    for (const member of pack.members) {
      if (member.snapshot) verifyPin(root, member.snapshot);
      if (member.request) verifyPin(root, member.request);
      const applied = intent.applied[member.id];
      if (applied) applied.forEach((pin) => verifyPin(root, pin));
      else {
        // Whole-package membership remains authoritative; pending member checks below use the original set.
        if (!existing) continue;
        member.files.forEach((pin) => verifyPin(root, pin));
        if (member.snapshot) verifyPin(root, member.snapshot);
        if (member.request) verifyPin(root, member.request);
      }
    }
    atomicJson(file, intent);
    for (const member of pack.members) {
      if (intent.applied[member.id]) continue;
      const directory = projectDirectory(root, member.projectId);
      let changed: string[] = [];
      member.files.forEach((pin) => verifyPin(root, pin));
      if (member.kind === "film") {
        approveStep(
          openFilmProject(directory, { rootDir: root }),
          member.stage!,
          intent.answer,
          intent.at,
          undefined,
          member.artefacts,
          `${pack.packageHash}:${member.id}`,
        );
        changed = [memberFile(root, member.projectId, `approvals/${member.stage}.json`)];
      } else if (member.kind === "template") {
        if (member.stage !== "localisation") refuse("Template stage approval was removed with the 16-stage pipeline");
        const supplied = plan.members.find((item) => item.id === member.id)!.speech;
        reviewLocalization(directory, {
          reviewedBy: intent.reviewedBy,
          evidence: intent.answer,
          expectedSourceHash: member.artefacts.source,
          audio: supplied.map((item) => `voiceover/${item.sceneId}.mp3`),
          alignments: supplied.map((item) => `voiceover/${item.sceneId}.words.json`),
        });
        changed = [memberFile(root, member.projectId, "localization.json")];
      } else if (member.kind === "outputs" && pack.purpose === "final-outputs" && member.snapshot && member.request) {
        const snapshot = DeliverySnapshotSchema.parse(jsonFile(verifyPin(root, member.snapshot))),
          request = DeliveryRequestSchema.parse(jsonFile(verifyPin(root, member.request)));
        const human = { reviewedBy: intent.reviewedBy, reviewedAt: intent.at, evidence: intent.answer };
        const value = DeliveryRequestSchema.parse({
          ...request,
          approvalMode: "manual",
          manualApproval: {
            ...human,
            storyHash: snapshot.identities[0].storyHash,
            sourceSnapshotHash: snapshot.id,
          },
          visualReview: {
            ...human,
            sourceSnapshotHash: snapshot.id,
            outputHashes: member.files.filter((pin) => pin.path.endsWith(".mp4")).map((pin) => pin.sha256),
            approved: true,
          },
        });
        const target = memberFile(root, member.projectId, `campaign-reviews/${pack.packageHash}.json`);
        immutableJson(target, value);
        atomicJson(memberFile(root, member.projectId, "campaign-approved-delivery.json"), {
          request: path.relative(root, target),
          packageHash: pack.packageHash,
          planHash: plan.planHash,
        });
        changed = [target];
      }
      intent.applied[member.id] = [
        ...member.files.filter((pin) => !changed.some((file) => path.resolve(root, pin.path) === file)),
        ...changed.map((file) => pinFile(root, file)),
      ];
      atomicJson(file, intent);
    }
    intent.complete = true;
    atomicJson(file, intent);
    return intent;
  } finally {
    releaseWriter();
    release();
  }
}
