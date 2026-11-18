import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { taskInputHash } from "./queue";
import { campaignInputIdentity } from "./execute";
import { CampaignRepairSchema } from "../../../types/campaign-production";
import { ProjectConfigSchema } from "../../../types/video";
import { currentDecision } from "./decisions";
import {
  acquireLock,
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
} from "./files";
import { assertCampaignActive, loadCampaign } from "./store";
import { packageApproved } from "./review";

const digestFileResult = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value, null, 2) + "\n")
    .digest("hex");

export function repairCampaignMember(root: string, id: string, raw: unknown) {
  assertCampaignActive(root, id);
  const release = acquireLock(path.join(productionDirectory(root, id), "writer.lock"));
  if (!release) refuse("Campaign production or revision is already active");
  try {
    const plan = loadCampaign(root, id),
      request = CampaignRepairSchema.parse(raw),
      member = plan.members.find((member) => member.id === request.memberId);
    if (!member || member.excluded || !["template", "recipe", "localise"].includes(member.adapter.kind))
      refuse(
        "Presentation repair needs a selected template, recipe or localised child; other routes retain their own edit process",
      );
    if (!packageApproved(root, plan, "creative-plan")) refuse("Approve the exact campaign plan before repairs");
    const task = plan.tasks.find((task) => task.id === `critique-${member.id}`)!,
      current = currentDecision(root, plan, task);
    if (
      !current ||
      current.hash !== request.decisionHash ||
      current.decision.verdict !== "revise" ||
      !current.decision.issues?.length ||
      current.decision.issues.some((issue) => !["presentation", "timing"].includes(issue.category))
    )
      refuse(
        "Presentation repair needs exact, structured presentation/timing feedback; business changes require a new plan",
      );
    const directory = projectDirectory(root, member.projectId),
      projectFile = path.join(directory, "project.json");
    if (path.resolve(root, request.expectedProject.path) !== projectFile)
      refuse("Repair expectedProject must name this child project");
    const historyDirectory = scopedFile(root, path.join(productionDirectory(root, id), "repairs", plan.planHash));
    const history = path.join(historyDirectory, `${member.id}-${current.hash}.json`);
    const intent = existsSync(history)
      ? (jsonFile(history) as {
          request: unknown;
          before: unknown;
          after: unknown;
          preparation: { path: string; sha256: string };
          record: { files: { path: string; sha256: string }[] };
        })
      : null;
    if (intent && digest(intent.request) !== digest(request))
      refuse("This feedback already has a different repair; obtain a new critique");
    if (!intent) {
      if (current.decision.inputHash !== taskInputHash(root, plan, task, campaignInputIdentity))
        refuse("Repair critique inputs are stale");
      [...current.decision.evidence, ...(current.decision.issues ?? []).flatMap((issue) => issue.evidence)].forEach(
        (pin) => verifyPin(root, pin),
      );
      const rounds = existsSync(historyDirectory)
        ? readdirSync(historyDirectory).filter(
            (file) => file.startsWith(`${member.id}-`) && /^[a-f0-9]{64}\.json$/.test(file.slice(member.id.length + 1)),
          ).length
        : 0;
      if (rounds >= (plan.request.policy?.maxAgentAttempts ?? 3))
        refuse("Repair round limit reached; revise the plan or provide new direction");
      verifyPin(root, request.expectedProject);
    }
    const before = ProjectConfigSchema.parse(intent ? intent.before : jsonFile(projectFile)),
      after = structuredClone(before),
      seen = new Set<string>();
    for (const change of request.changes) {
      if (seen.has(change.sceneId)) refuse("Duplicate repair scene");
      seen.add(change.sceneId);
      const scene = after.scenes.find((scene) => scene.id === change.sceneId);
      if (!scene || !current.decision.issues.some((issue) => !issue.sceneId || issue.sceneId === change.sceneId))
        refuse("Repair scene is outside the exact critique");
      if (change.durationInFrames !== undefined) {
        if (member.speech.some((item) => item.sceneId === change.sceneId))
          refuse("Speech duration repairs use the speech workflow and a reviewed source revision");
        scene.durationInFrames = change.durationInFrames;
      }
      if (change.transitionToNext !== undefined) scene.transitionToNext = change.transitionToNext;
    }
    const result = ProjectConfigSchema.parse(after);
    if (digest(before) === digest(result)) refuse("Repair made no progress");
    const preparation = scopedFile(root, path.join(directory, "pipeline/campaign-preparation.json")),
      record = jsonFile(preparation) as { files: { path: string; sha256: string }[] };
    const nextRecord = {
      ...record,
      files: record.files.map((pin) =>
        path.resolve(root, pin.path) === projectFile ? { path: pin.path, sha256: digestFileResult(result) } : pin,
      ),
    };
    if (intent) {
      const actual = ProjectConfigSchema.parse(jsonFile(projectFile));
      if (![digest(intent.before), digest(intent.after)].includes(digest(actual)))
        refuse("Repair recovery conflicts with a subsequent project edit");
      if (
        ![
          digest(intent.record),
          digest({
            ...intent.record,
            files: intent.record.files.map((pin) =>
              path.resolve(root, pin.path) === projectFile ? { path: pin.path, sha256: digestFileResult(result) } : pin,
            ),
          }),
        ].includes(digest(record))
      )
        refuse("Repair preparation changed during recovery");
    } else immutableJson(history, { request, before, after: result, preparation: pinFile(root, preparation), record });
    atomicJson(projectFile, result);
    // Refresh the preparation evidence: the existing task DAG invalidates all dependent work.
    atomicJson(preparation, nextRecord);
    return { file: history, project: pinFile(root, projectFile), planHash: plan.planHash, requiresNewCritique: true };
  } finally {
    release();
  }
}
