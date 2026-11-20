import { assertTutorialKit, bindTutorialKit } from "../../experiments/series";
import { readExperiments } from "../../experiments/project";
import { filmStyleFile, readFilmStyle, writeFilmStyle } from "../../film-styles/binding";
import { filmStyleKey, selectFilmStyle } from "../../film-styles/catalogue";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { AssetProvenanceSchema, AssetRightsSchema } from "../../../types/assets";
import { ProjectConfigSchema, FORMAT_CONFIGS, type VideoFormat } from "../../../types/video";
import {
  CampaignDecisionSchema,
  type CampaignMember,
  type CampaignProductionPlan,
  type CampaignTask,
} from "../../../types/campaign-production";
import { DeliveryRequestSchema, DeliverySnapshotSchema, RenderReceiptSchema } from "../../../types/delivery";
import { importAsset, readAssetRegistry } from "../../assets/registry";
import { materializeRecipe } from "../../templates/materialize";
import { buildRecipe } from "../../templates/recipes";
import { runWorkflow } from "../../workflows/dispatch";
import { createLocalizedProject, assertLocalizationReady } from "../localization";
import { scaffoldFilmProject } from "../../film/project";
import { deriveChain, openFilmProject } from "../../film/state";
import { writeProjectPlaybook } from "../../playbooks/project";
import { compileTimeline } from "../../timeline";
import { mediaProbe } from "../../audio/analysis";
import { TimelineEditStore } from "../../timeline-ir/store";
import { planProjectRender } from "../../render-plan";
import { pausedControl } from "../../console/control";
import { captureRenderIdentity } from "../../delivery/identity";
import { captureBespokeIdentity, isBespokeDelivery } from "../../delivery/bespoke";
import { captureDeliverySnapshot, checkDelivery } from "../../delivery/service";
import { pickModel } from "../../models/model-slots";
import { OperationStore } from "../../jobs/store";
import { bindCampaignChild } from "./store";
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
} from "./files";
import { campaignCommand } from "./command";
import { assertPathWithin } from "../../cli";
import { packageApproved } from "./review";
import { validateCampaignMember } from "./assurance";
import { taskReceipt, synchronousCampaignRead, type CampaignExecutor, type CampaignInputIdentity } from "./queue";

const materialFile = (root: string, plan: CampaignProductionPlan, id: string) =>
  path.join(productionDirectory(root, plan.request.id), "materials", plan.planHash, `${id}.json`);
const materialRecord = (root: string, plan: CampaignProductionPlan, id: string) =>
  jsonFile(scopedFile(root, materialFile(root, plan, id))) as {
    ownerProjectId: string;
    assetId: string;
    original: string;
    sha256: string;
    operationId?: string;
  };
function retainedMaterial(
  root: string,
  plan: CampaignProductionPlan,
  id: string,
  sourceHash: string,
  operationId: string,
  ownerProjectId: string,
) {
  const directory = productionDirectory(root, plan.request.id),
    materials = path.join(directory, "materials");
  if (!existsSync(materials)) return null;
  for (const revision of readdirSync(materials).filter((name) => /^[a-f0-9]{64}$/.test(name))) {
    const file = path.join(materials, revision, `${id}.json`),
      receiptFile = path.join(directory, "receipts", revision, `material-${id}.json`);
    if (!existsSync(file) || !existsSync(receiptFile)) continue;
    const record = jsonFile(scopedFile(root, file)) as {
      sourceHash?: string;
      operationId?: string;
      ownerProjectId?: string;
      sha256: string;
      original: string;
    };
    if (
      record.sourceHash !== sourceHash ||
      record.operationId !== operationId ||
      record.ownerProjectId !== ownerProjectId
    )
      continue;
    const receipt = jsonFile(scopedFile(root, receiptFile)) as { outputs: { path: string; sha256: string }[] },
      pin = receipt.outputs.find((pin) => path.resolve(root, pin.path) === file);
    if (!pin) refuse("Retained material lacks its original task receipt");
    verifyPin(root, pin);
    verifyPin(root, { path: path.join("public", record.original), sha256: record.sha256 });
    return record;
  }
  return null;
}
const memberOf = (plan: CampaignProductionPlan, task: CampaignTask) =>
  plan.members.find((member) => member.id === task.memberId)!;
const memberPipeline = (root: string, member: CampaignMember) =>
  path.join(projectDirectory(root, member.projectId), "pipeline");
export function campaignTimeline(root: string, member: CampaignMember) {
  return member.delivery?.timeline ?? existsSync(path.join(memberPipeline(root, member), "timeline-edit.json"));
}
export const campaignRenderOptions = (root: string, member: CampaignMember) => ({
  timeline: campaignTimeline(root, member),
  audioMaster: member.delivery?.audioMaster,
  fontContext: member.fontContext?.path ?? member.delivery?.fontContext,
});
function reuseRender(root: string, output: string, identify: () => ReturnType<typeof captureRenderIdentity>) {
  output = path.resolve(root, output);
  if (!existsSync(output) || !existsSync(`${output}.receipt.json`)) return null;
  const current = identify();
  try {
    const binding = RenderReceiptSchema.parse(jsonFile(scopedFile(root, `${output}.receipt.json`)));
    if (
      binding.evidence !== "renderer" ||
      binding.partial ||
      binding.format !== current.format ||
      binding.captions !== current.captions ||
      binding.sourceSnapshotHash !== current.sourceSnapshotHash ||
      binding.propsHash !== current.propsHash ||
      digest(binding.sources) !== digest(current.sources)
    )
      return null;
    verifyPin(root, { path: path.relative(root, output), sha256: binding.outputSha256 });
    return {
      outputs: [output, `${output}.receipt.json`],
      metadata: { output: path.relative(root, output), reusedExactRender: true },
    };
  } catch {
    return null;
  }
}
export const campaignInputIdentity: CampaignInputIdentity = (task, plan, root) => {
  if (!task.memberId || ["prepare", "anchors", "agent"].includes(task.kind)) return null;
  const member = memberOf(plan, task);
  if (!existsSync(projectDirectory(root, member.projectId))) return null;
  if (task.kind === "validate")
    return pinFile(root, path.join(projectDirectory(root, member.projectId), "project.json"));
  if (member.adapter.kind === "localise") {
    try {
      assertLocalizationReady(projectDirectory(root, member.projectId));
    } catch {
      return {
        localisation: "pending-review",
        project: pinFile(root, path.join(projectDirectory(root, member.projectId), "project.json")),
      };
    }
  }
  const format = (task.payload.format ?? member.formats[0]) as VideoFormat,
    captions = task.payload.variant === "clean" ? ("off" as const) : ("on" as const);
  return synchronousCampaignRead(JSON.stringify([root, plan.planHash, member.projectId, format, captions]), () => {
    if (isBespokeDelivery(root, member.projectId))
      return captureBespokeIdentity(member.projectId, format, {
        rootDir: root,
        audioMaster: member.delivery?.audioMaster,
      }).sourceSnapshotHash;
    return captureRenderIdentity(member.projectId, format, {
      rootDir: root,
      ...campaignRenderOptions(root, member),
      captions,
    }).sourceSnapshotHash;
  });
};
function replaceMaterialRefs(value: unknown, refs: Record<string, string>): unknown {
  if (typeof value === "string") {
    if (value.startsWith("material://")) {
      const key = value.slice("material://".length);
      if (!Object.hasOwn(refs, key)) refuse(`Undeclared material reference: ${key}`);
      return refs[key];
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceMaterialRefs(item, refs));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceMaterialRefs(item, refs)]));
  return value;
}
async function prepareMember(root: string, plan: CampaignProductionPlan, member: CampaignMember) {
  const directory = projectDirectory(root, member.projectId),
    adapter = member.adapter;
  const record = path.join(directory, "pipeline/campaign-preparation.json");
  const tutorial =
    plan.request.scenario === "content-series" && adapter.kind === "film" && adapter.playbook === "product-tutorial";
  const kit = tutorial
    ? readExperiments(projectDirectory(root, plan.request.id)).find(({ id }) => id === "tutorial-series-kit@1")?.kit
    : undefined;
  const materialsHash = digest(member.materials.map((id) => materialRecord(root, plan, id)));
  let updating = false;
  if (existsSync(record)) {
    const before = jsonFile(record) as {
      allocationHash: string;
      adapterHash: string;
      materialsHash?: string;
      files: { path: string; sha256: string }[];
    };
    if (kit) assertTutorialKit(directory);
    if (before.allocationHash !== plan.allocationHash) refuse("Child allocation changed");
    if (before.adapterHash === digest(adapter) && before.materialsHash === materialsHash && !member.expectedProject) {
      const stylePin = before.files.find((pin) => path.resolve(root, pin.path) === filmStyleFile(directory));
      if (stylePin) verifyPin(root, stylePin);
      try {
        if (!["existing", "film"].includes(adapter.kind)) before.files.forEach((pin) => verifyPin(root, pin));
      } catch {
        const derived = jsonFile(path.join(directory, "pipeline/campaign-anchors.json")) as {
          adapterHash?: string;
          project: { path: string; sha256: string };
        };
        if (derived.adapterHash !== digest(adapter)) refuse("Child preparation source changed");
        verifyPin(root, derived.project);
      }
      return { outputs: [record] };
    }
    if (
      !member.expectedProject ||
      !["template", "recipe"].includes(adapter.kind) ||
      path.resolve(root, member.expectedProject.path) !== path.join(directory, "project.json")
    )
      refuse("Changed child adapter requires an expectedProject pin and a reviewed template edit, or a new project");
    verifyPin(root, member.expectedProject);
    updating = true;
    immutableJson(path.join(directory, "pipeline/campaign-preparation-history", `${digest(before)}.json`), before);
  }
  if (existsSync(directory) && adapter.kind !== "existing" && !updating)
    refuse(`Child destination exists without a matching preparation receipt: ${member.projectId}`);
  const refs = Object.fromEntries(
    member.materials.map((id) => {
      const material = materialRecord(root, plan, id);
      verifyPin(root, { path: path.join("public", material.original), sha256: material.sha256 });
      return [id, material.original];
    }),
  );
  const effective = replaceMaterialRefs(adapter, refs) as CampaignMember["adapter"];
  if (effective.kind === "recipe") {
    if (updating) {
      const selected = readFilmStyle(directory);
      if ((selected ? filmStyleKey(selected.style) : undefined) !== effective.request.styleCard)
        refuse("A revised recipe style needs a new campaign member project");
      atomicJson(path.join(directory, "project.json"), buildRecipe(effective.request).project);
    } else materializeRecipe(effective.request, root);
  } else if (effective.kind === "template") {
    if (updating) atomicJson(path.join(directory, "project.json"), effective.project);
    else {
      mkdirSync(directory);
      immutableJson(path.join(directory, "project.json"), effective.project);
    }
  } else if (effective.kind === "workflow")
    await runWorkflow(effective.scenario, effective.request, { action: "create", rootDir: root, scopeRoot: root });
  else if (effective.kind === "localise")
    createLocalizedProject(effective.translation, root, {
      sceneDurationFrames: Object.fromEntries(
        member.speech.map((speech) => [
          speech.sceneId,
          Math.max(30, Math.ceil(Number(mediaProbe(verifyPin(root, speech.audio)).format.duration) * 30)),
        ]),
      ),
    });
  else if (effective.kind === "film") {
    const style = effective.styleCard ? selectFilmStyle(effective.styleCard) : undefined;
    mkdirSync(directory);
    scaffoldFilmProject(directory, member.projectId, effective.product ? [verifyPin(root, effective.product)] : [], {
      filmType: effective.filmType,
    });
    const brief = path.join(directory, "pipeline/brief.json");
    atomicJson(brief, { ...(jsonFile(brief) as object), format: member.formats[0] });
    writeProjectPlaybook(directory, effective.playbook, "agent");
    if (style) writeFilmStyle(directory, style);
  } else if (!existsSync(path.join(directory, "project.json")) && !isBespokeDelivery(root, member.projectId))
    refuse("Existing child is not a video project");
  const kitFile = kit ? bindTutorialKit(root, plan.request.id, directory) : undefined;
  bindCampaignChild(root, plan, member.projectId);
  const copies: Record<string, string> = {};
  for (const id of member.materials) {
    const material = materialRecord(root, plan, id),
      owner = readAssetRegistry(material.ownerProjectId, root).assets.find((asset) => asset.id === material.assetId);
    if (!owner) refuse("Shared asset registry entry is missing");
    const result = importAsset({
      projectId: member.projectId,
      rootDir: root,
      nonMedia: true,
      sourceFile: verifyPin(root, { path: path.join("public", material.original), sha256: material.sha256 }),
      provenance: { ...owner.provenance, referenceAssetIds: [] },
      rights: owner.rights,
    });
    copies[material.original] = result.asset.files.original;
    immutableJson(path.join(directory, "pipeline/campaign-assets", `${id}-${material.sha256}.json`), {
      version: 1,
      campaignId: plan.request.id,
      materialId: id,
      owner: material,
      consumerAssetId: result.asset.id,
      originalProvenance: owner.provenance,
      file: pinFile(root, path.join("public", result.asset.files.original)),
    });
  }
  if (["template", "recipe"].includes(effective.kind) && Object.keys(copies).length) {
    const rewrite = (value: unknown): unknown =>
      typeof value === "string"
        ? (copies[value] ?? value)
        : Array.isArray(value)
          ? value.map(rewrite)
          : value !== null && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]))
            : value;
    atomicJson(path.join(directory, "project.json"), rewrite(jsonFile(path.join(directory, "project.json"))));
  }
  const files = [
    ...(kitFile ? [pinFile(root, kitFile)] : []),
    ...(existsSync(filmStyleFile(directory)) ? [pinFile(root, filmStyleFile(directory))] : []),
    pinFile(
      root,
      path.join(directory, isBespokeDelivery(root, member.projectId) ? "pipeline/brief.json" : "project.json"),
    ),
  ];
  atomicJson(record, { allocationHash: plan.allocationHash, adapterHash: digest(adapter), materialsHash, files });
  return { outputs: [record], metadata: { projectId: member.projectId, productionReady: false } };
}
const WordSchema = z
  .object({ text: z.string().min(1), start: z.number().finite().nonnegative(), end: z.number().finite().positive() })
  .passthrough();
export function canonicalCampaignAlignment(raw: unknown) {
  const words = z.array(WordSchema).parse(Array.isArray(raw) ? raw : (raw as { words?: unknown }).words);
  if (
    !words.length ||
    words.some((word, index) => word.end <= word.start || (index > 0 && word.start < words[index - 1].end))
  )
    refuse("Invalid or overlapping speech word alignment");
  return Array.isArray(raw) ? { words } : { ...(raw as Record<string, unknown>), words };
}
function alignedWords(file: string) {
  return canonicalCampaignAlignment(jsonFile(file)).words;
}
export function resolveCampaignAnchors(root: string, plan: CampaignProductionPlan, member: CampaignMember) {
  const directory = projectDirectory(root, member.projectId),
    file = path.join(directory, "pipeline/campaign-anchors.json");
  if (isBespokeDelivery(root, member.projectId)) {
    if (member.speech.length || member.anchors.length)
      refuse("Bespoke speech and anchors must be mounted by its film agent in the build inputs");
    atomicJson(file, { planHash: plan.planHash, anchors: [] });
    return { outputs: [file] };
  }
  const projectFile = path.join(directory, "project.json"),
    project = ProjectConfigSchema.parse(jsonFile(projectFile));
  for (const supplied of member.speech) {
    const scene = project.scenes.find((scene) => scene.id === supplied.sceneId);
    if (!scene) refuse("Speech scene is absent");
    const words = alignedWords(verifyPin(root, supplied.alignment)),
      audio = verifyPin(root, supplied.audio),
      measured = mediaProbe(audio);
    if (!measured.streams.some((stream) => stream.codec_type === "audio"))
      refuse("Speech replacement contains no audio");
    const duration = Number(measured.format.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      refuse("Speech replacement needs a measured finite audio duration");
    if (
      words.at(-1)!.end > duration + 1 / 30 ||
      words
        .map((word) => word.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim() !== scene.text.replace(/\s+/g, " ").trim()
    )
      refuse("Alignment does not reproduce the scene speech or duration");
    if (!audio.toLowerCase().endsWith(".mp3"))
      refuse("Supply MP3 scene voiceover; use the existing audio conversion tools first");
    mkdirSync(path.join(directory, "voiceover"), { recursive: true });
    const audioTarget = scopedFile(root, path.join(directory, "voiceover", `${supplied.sceneId}.mp3`)),
      wordsTarget = scopedFile(root, path.join(directory, "voiceover", `${supplied.sceneId}.words.json`));
    assertPathWithin(directory, audioTarget);
    assertPathWithin(directory, wordsTarget);
    copyFileSync(audio, audioTarget);
    atomicJson(wordsTarget, canonicalCampaignAlignment(jsonFile(verifyPin(root, supplied.alignment))));
    scene.durationInFrames = Math.max(30, Math.ceil(duration * 30));
  }
  if (member.speech.length) atomicJson(projectFile, project);
  const timing = compileTimeline(project.scenes),
    updates: {
      type: "update-overlay";
      overlayId: string;
      start: { num: number; den: number };
      end: { num: number; den: number };
    }[] = [];
  const anchors = member.anchors.map((anchor) => {
    const entry = timing.entries.find((entry) => entry.scene.id === anchor.sceneId);
    if (!entry) refuse("Anchor scene is absent");
    const words = alignedWords(verifyPin(root, anchor.alignment));
    let seconds = anchor.at === "start" ? words[0].start : words.at(-1)!.end;
    if (anchor.at === "word") {
      const matches = words.filter(
        (word) => word.text.normalize("NFKC").toLowerCase() === anchor.word!.normalize("NFKC").toLowerCase(),
      );
      if (!matches.length || (!anchor.occurrence && matches.length !== 1) || (anchor.occurrence ?? 1) > matches.length)
        refuse(`Ambiguous or missing word anchor: ${anchor.id}`);
      seconds = matches[(anchor.occurrence ?? 1) - 1].start;
    }
    const frame = entry.startFrame + Math.round(seconds * 30) + anchor.offsetFrames;
    if (frame < 0 || frame >= timing.durationInFrames) refuse("Anchor exceeds delivery timeline");
    if (anchor.overlayId) {
      if (!anchor.durationFrames || frame + anchor.durationFrames > timing.durationInFrames)
        refuse("An overlay anchor needs an in-range duration");
      updates.push({
        type: "update-overlay",
        overlayId: anchor.overlayId,
        start: { num: frame, den: 1 },
        end: { num: frame + anchor.durationFrames, den: 1 },
      });
    }
    return { id: anchor.id, frame, alignment: anchor.alignment };
  });
  if (updates.length) {
    const store = new TimelineEditStore(path.join(directory, "pipeline/timeline-edit.json")),
      before = store.read();
    store.apply({ type: "batch", commands: updates }, before.revision);
  }
  atomicJson(file, {
    planHash: plan.planHash,
    adapterHash: digest(member.adapter),
    anchors,
    project: pinFile(root, projectFile),
  });
  return {
    outputs: [
      file,
      projectFile,
      ...member.speech.flatMap((speech) => [
        path.join(directory, "voiceover", `${speech.sceneId}.mp3`),
        path.join(directory, "voiceover", `${speech.sceneId}.words.json`),
      ]),
      ...(updates.length ? [path.join(directory, "pipeline/timeline-edit.json")] : []),
    ],
    metadata: { anchors, speechReflow: member.speech.length, alignmentFormat: "words-object-v1" },
  };
}

/**
 * The pause (RFC 0004 D12) per child: a campaign run is one command, so runScript judges only the campaign's own
 * project. Each child project the user paused or stopped in the console is skipped with a PAUSED note; the others go on.
 */
export function pausedChild(root: string, projectId: string) {
  const control = pausedControl(projectDirectory(root, projectId));
  return control
    ? {
        outputs: [] as string[],
        blocked: true,
        reasonCode: "PAUSED",
        message: `PAUSED: project ${projectId} is ${control.state} by the user since ${control.at}; its campaign tasks wait until the user resumes it in the console. Do not retry; tell the user.`,
      }
    : undefined;
}

export const executeCampaignTask: CampaignExecutor = async (task, context) => {
  const { root, plan } = context;
  if (!packageApproved(root, plan, "creative-plan"))
    return { outputs: [], blocked: true, message: "The concrete campaign plan needs user approval" };
  const member = task.memberId ? memberOf(plan, task) : undefined;
  const memberPaused = member && pausedChild(root, member.projectId);
  if (memberPaused) return memberPaused;
  if (task.kind === "agent") {
    const file = path.join(productionDirectory(root, plan.request.id), "decisions", plan.planHash, `${task.id}.json`);
    if (!existsSync(file)) return { outputs: [], blocked: true, message: `Agent decision required: ${task.id}` };
    const decision = CampaignDecisionSchema.parse(jsonFile(file));
    if (
      decision.inputHash !== context.inputHash ||
      decision.planHash !== plan.planHash ||
      decision.taskId !== task.id ||
      decision.agent !== (task.payload.agentTask as { agent: string }).agent
    )
      refuse("Agent decision does not match this exact task");
    [...decision.evidence, ...decision.outputs].forEach((pin) => verifyPin(root, pin));
    if (decision.verdict !== "accept")
      return { outputs: [], blocked: true, message: `${decision.verdict}: ${decision.rationale}` };
    return {
      outputs: [file, ...decision.outputs.map((pin) => pin.path)],
      metadata: { agent: decision.agent, verdict: decision.verdict },
    };
  }
  if (task.kind === "material") {
    const material = plan.request.materials.find((item) => item.id === task.payload.materialId)!;
    const ownerProjectId =
      material.owner === "shared"
        ? plan.request.id
        : plan.members.find((member) => member.id === material.owner)!.projectId;
    const ownerPaused = pausedChild(root, ownerProjectId);
    if (ownerPaused) return ownerPaused;
    if (ownerProjectId !== plan.request.id && !existsSync(projectDirectory(root, ownerProjectId)))
      return {
        outputs: [],
        blocked: true,
        message: "Use a shared material owner for assets needed before child creation",
      };
    bindCampaignChild(root, plan, ownerProjectId);
    let source: string,
      provenance: z.input<typeof AssetProvenanceSchema>,
      rights: z.input<typeof AssetRightsSchema> | undefined,
      operationId: string | undefined;
    if (material.source.kind === "supplied") {
      source = verifyPin(root, material.source.file);
      provenance = AssetProvenanceSchema.parse(material.source.provenance);
      rights = material.source.rights && AssetRightsSchema.parse(material.source.rights);
    } else {
      const requestFile = verifyPin(root, material.source.request),
        request = jsonFile(requestFile) as { endpoint?: string; provider?: string };
      assertPathWithin(projectDirectory(root, ownerProjectId), scopedFile(root, material.source.output));
      if (!request.endpoint || (request.provider && !["fal", "higgsfield"].includes(request.provider)))
        refuse("Generation request must name a supported provider and exact endpoint");
      operationId = `campaign.${plan.request.id}.${material.id}.${digest(material.source).slice(0, 16)}`;
      const store = new OperationStore(ownerProjectId, {
          directory: path.join(projectDirectory(root, ownerProjectId), "pipeline"),
        }),
        existing = store.snapshot().jobs[operationId];
      const retained =
        existing?.state === "published"
          ? retainedMaterial(root, plan, material.id, digest(material.source), operationId, ownerProjectId)
          : null;
      if (existing?.state === "published" && retained) {
        const publication = z
          .object({ outputs: z.array(z.string()), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)) })
          .passthrough()
          .parse(existing.result?.published);
        const target = scopedFile(root, material.source.output),
          index = publication.outputs.findIndex((file) => path.resolve(root, file) === target);
        const providerMatches =
          request.provider === "higgsfield"
            ? existing.provider === "higgsfield"
            : ["fal", "fal.ai"].includes(existing.provider);
        if (
          index < 0 ||
          publication.hashes[index] !== retained.sha256 ||
          existing.endpoint !== request.endpoint ||
          !providerMatches
        )
          refuse("Published operation does not own the exact requested material output");
        verifyPin(root, { path: publication.outputs[index], sha256: publication.hashes[index] });
      } else {
        const selection = pickModel({
          useCase: material.source.useCase,
          model: request.endpoint,
          provider: request.provider === "higgsfield" ? "higgsfield" : "fal",
        });
        const planned = path.join(
          productionDirectory(root, plan.request.id),
          "model-plans",
          `${plan.planHash}-${material.id}.json`,
        );
        immutableJson(planned, {
          useCase: material.source.useCase,
          selection,
          request: material.source.request,
          reason: material.source.reason,
        });
        if (!selection.pick)
          return {
            outputs: [planned],
            blocked: true,
            reasonCode: "MODEL_UNAVAILABLE",
            message: "The exact model request failed the selected use-case capability checks; inspect its model plan",
          };
        if (!context.paid || plan.request.spend === "forbid")
          return {
            outputs: [],
            blocked: true,
            reasonCode: "GENERATION_AUTHORITY_REQUIRED",
            message: "Paid generation is pending; campaign spending is forbidden in local mode",
          };
        if (!packageApproved(root, plan, "generation-requests"))
          return {
            outputs: [],
            blocked: true,
            reasonCode: "GENERATION_REVIEW_REQUIRED",
            message: "Exact generation request package needs user approval",
          };
        const args = [
          "--project",
          ownerProjectId,
          "--request",
          requestFile,
          "--output",
          scopedFile(root, material.source.output),
          "--operation-id",
          operationId,
          ...(material.source.maxCostUsd ? ["--max-cost-usd", String(material.source.maxCostUsd)] : []),
        ];
        try {
          await campaignCommand(root, "generate-model.ts", args);
        } catch (error) {
          const job = store.snapshot().jobs[operationId];
          if (job && !["published", "failed", "cancelled"].includes(job.state))
            return {
              outputs: [],
              pending: true,
              reasonCode: "PROVIDER_OPERATION_PENDING",
              retryAfterMs: 30000,
              message: `Retained generation ${operationId}: ${job.state}; reconcile or resume the same operation`,
            };
          throw error;
        }
        const job = store.snapshot().jobs[operationId];
        if (job?.state !== "published")
          return { outputs: [], pending: true, message: `Generation ${job?.state ?? "pending"}` };
      }
      source = scopedFile(root, material.source.output);
      provenance = {
        origin: "provider",
        tool: "generate:model",
        model: request.endpoint ?? "unknown",
        generationJobId: operationId,
      };
    }
    const imported = importAsset({
      projectId: ownerProjectId,
      rootDir: root,
      sourceFile: source,
      provenance,
      rights,
      nonMedia: true,
    });
    const file = materialFile(root, plan, material.id);
    immutableJson(file, {
      ownerProjectId,
      assetId: imported.asset.id,
      original: imported.asset.files.original,
      sha256: imported.asset.hash,
      sourceHash: digest(material.source),
      ...(operationId ? { operationId } : {}),
    });
    return {
      outputs: [file, path.join("public", imported.asset.files.original)],
      metadata: { ownerProjectId, assetId: imported.asset.id, paidOperationId: operationId ?? null },
    };
  }
  if (task.kind === "prepare") return prepareMember(root, plan, member!);
  if (task.kind === "anchors") return resolveCampaignAnchors(root, plan, member!);
  const pipeline = memberPipeline(root, member!);
  if (task.kind === "validate") {
    const report = validateCampaignMember(root, plan, member!);
    const file = path.join(
      productionDirectory(root, plan.request.id),
      "validation",
      plan.planHash,
      `${task.id}-${context.inputHash}.json`,
    );
    immutableJson(file, report);
    return report.passed
      ? { outputs: [file], metadata: report }
      : {
          outputs: [file],
          blocked: true,
          reasonCode: "SCENARIO_INPUT_REQUIRED",
          message: report.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => `${issue.code}: ${issue.message}`)
            .join("; "),
        };
  }
  if (member?.adapter.kind === "localise") {
    try {
      assertLocalizationReady(projectDirectory(root, member.projectId));
    } catch {
      return {
        outputs: [],
        blocked: true,
        reasonCode: "LANGUAGE_REVIEW_REQUIRED",
        message: "The exact localised project and replacement speech need their existing review",
      };
    }
  }
  if (task.kind === "snapshot") {
    const request = DeliveryRequestSchema.parse({
      ...member!.delivery,
      fontContext: member!.fontContext?.path ?? member!.delivery?.fontContext,
    });
    const snapshot = captureDeliverySnapshot(request, { rootDir: root }),
      requestFile = path.join(pipeline, "campaign-delivery-requests", `${plan.planHash}.json`);
    immutableJson(requestFile, request);
    const file = path.join(pipeline, "campaign-delivery.json");
    atomicJson(file, { snapshot: path.relative(root, snapshot.file), request: path.relative(root, requestFile) });
    return { outputs: [file, snapshot.file, requestFile] };
  }
  if (task.kind === "render") {
    assertTutorialKit(projectDirectory(root, member!.projectId));
    let output: string;
    if (isBespokeDelivery(root, member!.projectId)) {
      const film = openFilmProject(projectDirectory(root, member!.projectId), { rootDir: root }),
        chain = deriveChain(film);
      const incomplete = chain.steps.find(
        (step) => ["build", "sound"].includes(step.id) && !["done", "skipped"].includes(step.status),
      );
      if (incomplete)
        return { outputs: [], blocked: true, message: `Continue film:next for ${member!.projectId}: ${incomplete.id}` };
      const build = jsonFile(path.join(pipeline, "build.json")) as { composition: string; entry?: string };
      if (task.payload.variant !== "captioned") refuse("Bespoke films expose their existing captioned render only");
      const master = path.join(projectDirectory(root, member!.projectId), "audio/master.wav");
      output = path.join(root, "out", member!.projectId, "film.mp4");
      const reused = reuseRender(root, output, () =>
        captureBespokeIdentity(member!.projectId, task.payload.format as VideoFormat, {
          rootDir: root,
          ...(existsSync(master) ? { audioMaster: master } : {}),
        }),
      );
      if (reused) return reused;
      await campaignCommand(root, "film-render.ts", [
        "--project",
        member!.projectId,
        "--composition",
        build.composition,
        ...(build.entry ? ["--entry", build.entry] : []),
        ...(existsSync(master) ? ["--audio", master] : []),
      ]);
      output = path.join(root, "out", member!.projectId, "film.mp4");
    } else {
      const options = campaignRenderOptions(root, member!);
      const args = [
        "--project",
        member!.projectId,
        "--format",
        String(task.payload.format),
        "--captions",
        task.payload.variant === "clean" ? "off" : "on",
        ...(options.timeline ? ["--timeline"] : []),
        ...(options.audioMaster ? ["--audio-master", scopedFile(root, options.audioMaster)] : []),
        ...(options.fontContext ? ["--font-context", scopedFile(root, options.fontContext)] : []),
      ];
      const job = planProjectRender(member!.projectId, task.payload.format as VideoFormat, root, {
        ...options,
        captions: task.payload.variant === "clean" ? "off" : "on",
      }).jobs[0];
      const reused = reuseRender(root, job.outputFile, () =>
        captureRenderIdentity(member!.projectId, task.payload.format as VideoFormat, {
          rootDir: root,
          ...options,
          captions: task.payload.variant === "clean" ? "off" : "on",
        }),
      );
      if (reused) return reused;
      await campaignCommand(root, "render-project.ts", args);
      output = job.outputFile;
    }
    return {
      outputs: [output, `${output}.receipt.json`],
      metadata: { output: path.relative(root, path.resolve(root, output)) },
    };
  }
  if (task.kind === "qa") {
    const render = plan.tasks.find((item) => item.id === task.payload.renderTaskId)!;
    const receipt = taskReceipt(root, plan, render, campaignInputIdentity);
    if (!receipt) refuse("QA requires an exact completed render");
    const pin = receipt.outputs.find((pin) => pin.path.endsWith(".mp4"))!,
      file = verifyPin(root, pin),
      binding = RenderReceiptSchema.parse(jsonFile(`${file}.receipt.json`));
    if (binding.outputSha256 !== pin.sha256 || binding.partial) refuse("Render receipt does not match a full output");
    const probe = mediaProbe(file),
      video = probe.streams.find((stream) => stream.codec_type === "video");
    if (!video) refuse("Rendered output has no video stream");
    const dimensions = FORMAT_CONFIGS[render.payload.format as VideoFormat];
    const [numerator, denominator] = String(video.avg_frame_rate).split("/").map(Number);
    if (video.width !== dimensions.width || video.height !== dimensions.height || numerator / denominator !== 30)
      refuse("Rendered dimensions or frame rate differ from the requested format");
    if (!isBespokeDelivery(root, member!.projectId)) {
      const expected = planProjectRender(member!.projectId, render.payload.format as VideoFormat, root, {
        ...campaignRenderOptions(root, member!),
        captions: render.payload.variant === "clean" ? "off" : "on",
      }).jobs[0];
      if (Math.abs(Number(probe.format.duration) - expected.durationInFrames / 30) > 1 / 30 + 0.001)
        refuse("Rendered duration differs from the compiled timeline");
    }
    const decoded = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-f", "null", "-"], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    if (decoded.status !== 0) refuse("Rendered video failed full decode");
    const report = path.join(pipeline, "campaign-qa", `${plan.planHash}-${task.id}-${context.inputHash}.json`);
    immutableJson(report, {
      version: 1,
      output: pin,
      receipt: pinFile(root, `${file}.receipt.json`),
      probe,
      fullDecode: true,
      creativeAcceptance: "pending-independent-critic",
      liveModelAcceptance: "unverified",
    });
    return { outputs: [report], metadata: { technicalCheck: "passed", productionReady: false } };
  }
  const approved = path.join(pipeline, "campaign-approved-delivery.json");
  if (isBespokeDelivery(root, member!.projectId)) {
    const open = deriveChain(openFilmProject(projectDirectory(root, member!.projectId), { rootDir: root })).steps.find(
      (step) => !["done", "skipped"].includes(step.status),
    );
    if (open)
      return { outputs: [], blocked: true, message: `Existing film gate remains open: ${open.id}; continue film:next` };
  }
  if (!existsSync(approved))
    return {
      outputs: [],
      blocked: true,
      reasonCode: "FINAL_REVIEW_REQUIRED",
      message: "User review of the exact final output package is required",
    };
  const selection = jsonFile(approved) as { request: string; planHash: string };
  if (selection.planHash !== plan.planHash) refuse("Approved delivery belongs to an earlier campaign plan");
  const request = DeliveryRequestSchema.parse(jsonFile(scopedFile(root, selection.request))),
    binding = jsonFile(path.join(pipeline, "campaign-delivery.json")) as { snapshot: string };
  const result = checkDelivery(request, DeliverySnapshotSchema.parse(jsonFile(scopedFile(root, binding.snapshot))), {
    rootDir: root,
  });
  const file = path.join(pipeline, "campaign-delivery-result.json");
  atomicJson(file, result);
  if (!result.productionReady)
    return {
      outputs: [file, result.report],
      blocked: true,
      reasonCode: "DELIVERY_REQUIREMENTS",
      message: result.blockers
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")
        .slice(0, 2000),
    };
  return { outputs: [file], metadata: { productionReady: true } };
};
