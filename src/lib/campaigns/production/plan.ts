import { selectFilmStyle } from "../../film-styles/catalogue";
import { csvParse, tsvParse } from "d3-dsv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CampaignId,
  CampaignAllocationSchema,
  CampaignMemberSchema,
  CampaignProductionRequestSchema,
  CampaignProductionPlanSchema,
  type CampaignProductionRequest,
  type CampaignRequest,
  type CampaignMember,
  type CampaignTask,
  type CampaignProductionPlan,
  type CampaignFile,
} from "../../../types/campaign-production";
import { getEntityVersion, resolveEntityReferences } from "../../entities/service";
import { ReferenceBlueprintSchema } from "../../../types/reference";
import { assertPathWithin, isBespokeBrief } from "../../cli";
import {
  digest,
  pinFile,
  projectDirectory,
  productionDirectory,
  jsonFile,
  isCampaignOwner,
  refuse,
  verifyPin,
} from "./files";

function interpolate(value: unknown, bindings: Record<string, string>): unknown {
  if (typeof value === "string")
    return value.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_, key: string) => {
      if (!Object.hasOwn(bindings, key)) refuse(`Missing campaign template binding: ${key}`);
      return bindings[key];
    });
  if (Array.isArray(value)) return value.map((item) => interpolate(item, bindings));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, bindings)]));
  return value;
}
export function catalogueRows(request: NonNullable<CampaignRequest["catalogue"]>, root: string) {
  const text = readFileSync(verifyPin(root, request.file), "utf8").replace(/^\uFEFF/, "");
  const rows: unknown =
    request.format === "json" ? JSON.parse(text) : request.format === "csv" ? csvParse(text) : tsvParse(text);
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) refuse("Catalogue requires 1–1000 rows");
  const ids = new Set<string>();
  return rows.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse(`Invalid catalogue row ${index + 1}`);
    const row = raw as Record<string, unknown>,
      id = String(row[request.idColumn] ?? "").trim();
    if (!id || ids.has(id)) refuse(`Missing or duplicate catalogue ID at row ${index + 1}`);
    ids.add(id);
    const mapped = Object.fromEntries(
      Object.entries(request.columns).map(([binding, column]) => {
        if (
          !Object.hasOwn(row, column) ||
          row[column] === null ||
          typeof row[column] === "object" ||
          String(row[column]).trim() === ""
        )
          refuse(`Missing catalogue column ${column} at row ${index + 1}`);
        return [binding, String(row[column])];
      }),
    );
    return { ...mapped, id };
  });
}
export function expandCampaignMembers(request: CampaignRequest, root: string): CampaignMember[] {
  if (request.catalogue)
    return catalogueRows(request.catalogue, root).map((row) => {
      const memberId =
        CampaignId.safeParse(row.id).success && row.id.length <= 48
          ? row.id
          : `${
              row.id
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 32)
                .replace(/-$/, "") || "product"
            }-${digest(row.id).slice(0, 12)}`;
      const prefix =
        request.id.length <= 40 ? request.id : `${request.id.slice(0, 31)}-${digest(request.id).slice(0, 8)}`;
      return CampaignMemberSchema.parse({
        ...(interpolate(request.catalogue!.memberTemplate, {
          ...row,
          campaign: request.id,
          productId: row.id,
          memberId,
          projectId: `${prefix}-${memberId}`,
        }) as object),
        productId: row.id,
        factors: row,
      });
    });
  if (request.matrix) {
    const matrix = request.matrix,
      seen = new Set<string>(),
      keys = Object.keys(matrix.axes).sort();
    return matrix.combinations.flatMap((combination, index) => {
      if (
        Object.keys(combination).sort().join("|") !== keys.join("|") ||
        keys.some((key) => !matrix.axes[key].includes(combination[key]))
      )
        refuse("Matrix combinations must name exactly the declared axes and values");
      const signature = digest(combination);
      if (seen.has(signature)) refuse("Duplicate campaign combination");
      seen.add(signature);
      if (matrix.exclude.some((rule) => Object.entries(rule).every(([key, value]) => combination[key] === value)))
        return [];
      return [
        CampaignMemberSchema.parse({
          ...(interpolate(matrix.memberTemplate, {
            ...combination,
            campaign: request.id,
            id: `v${index + 1}`,
          }) as object),
          factors: combination,
        }),
      ];
    });
  }
  return request.members;
}
export function validateTaskGraph(tasks: CampaignTask[]) {
  const nodes = new Map(tasks.map((task) => [task.id, task]));
  if (nodes.size !== tasks.length) refuse("Duplicate campaign task ID");
  const done = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    const node = nodes.get(id);
    if (!node) refuse(`Missing campaign dependency: ${id}`);
    if (active.has(id)) refuse(`Cyclic campaign dependency: ${id}`);
    active.add(id);
    for (const dependency of node.dependsOn) visit(dependency);
    active.delete(id);
    done.add(id);
  };
  tasks.forEach((task) => visit(task.id));
}
function adapterPins(member: CampaignMember, root: string): CampaignFile[] {
  const adapter = member.adapter,
    pins = [
      ...member.inputs,
      ...member.anchors.map((anchor) => anchor.alignment),
      ...member.speech.flatMap((item) => [item.audio, item.alignment]),
      ...(member.fontContext ? [member.fontContext] : []),
    ];
  if (adapter.kind === "recipe")
    for (const media of adapter.request.media ?? []) {
      if (!media.source.startsWith("material://")) pins.push(pinFile(root, path.join("public", media.source)));
    }
  if (adapter.kind === "existing")
    pins.push(
      pinFile(
        root,
        path.join(
          "public/projects",
          adapter.projectId,
          existingFilm(root, member) ? "pipeline/brief.json" : "project.json",
        ),
      ),
    );
  if (adapter.kind === "localise")
    pins.push(pinFile(root, path.join("public/projects", adapter.translation.sourceProjectId, "project.json")));
  if (adapter.kind === "film" && adapter.product) pins.push(adapter.product);
  for (const file of [member.delivery?.audioMaster, member.fontContext ? undefined : member.delivery?.fontContext])
    if (file) pins.push(pinFile(root, file));
  if (adapter.kind === "template") {
    for (const scene of adapter.project.scenes)
      if (scene.imageUrl && !/^(?:material:|https?:|data:)/.test(scene.imageUrl))
        pins.push(pinFile(root, path.join("public", scene.imageUrl)));
  }
  return pins;
}
function existingFilm(root: string, member: CampaignMember) {
  const directory = projectDirectory(root, member.projectId);
  return (
    member.adapter.kind === "existing" &&
    !existsSync(path.join(directory, "project.json")) &&
    isBespokeBrief(path.join(directory, "pipeline/brief.json"))
  );
}
export function buildCampaignPlan(raw: CampaignProductionRequest, root = process.cwd()): CampaignProductionPlan {
  const request = CampaignProductionRequestSchema.parse(raw),
    members = expandCampaignMembers(request, root).map((member) =>
      member.adapter.kind === "film" || existingFilm(root, member)
        ? { ...member, variants: ["captioned" as const] }
        : member,
    );
  if (!members.length) refuse("Campaign has no selected variants");
  const ids = new Set(members.map((member) => member.id)),
    projects = new Set(members.map((member) => member.projectId));
  if (ids.size !== members.length || projects.size !== members.length || ids.has("shared") || projects.has(request.id))
    refuse("Campaign and member IDs must be distinct and unique");
  members.forEach((member) => {
    projectDirectory(root, member.projectId);
    const adapter = member.adapter;
    const style =
      adapter.kind === "recipe" ? adapter.request.styleCard : adapter.kind === "film" ? adapter.styleCard : undefined;
    if (style) {
      if (!style.includes("@")) refuse(`Campaign member ${member.id} needs an exact film style revision`);
      selectFilmStyle(style);
    }
    if (
      (member.adapter.kind === "recipe" && member.adapter.request.projectId !== member.projectId) ||
      (member.adapter.kind === "workflow" && member.adapter.request.projectId !== member.projectId) ||
      (member.adapter.kind === "localise" && member.adapter.translation.projectId !== member.projectId) ||
      (member.adapter.kind === "existing" && member.adapter.projectId !== member.projectId)
    )
      refuse(`Adapter project differs from member: ${member.id}`);
    if (member.delivery && member.delivery.projectId !== member.projectId)
      refuse("Delivery project differs from campaign member");
    if (
      member.delivery &&
      (digest([...new Set(member.formats)].sort()) !== digest([...member.delivery.formats].sort()) ||
        digest([...new Set(member.variants)].sort()) !== digest([...member.delivery.variants].sort()))
    )
      refuse("Member and delivery formats/variants must name the same exact output set");
    if (member.delivery && !member.delivery.timeline && member.anchors.some((anchor) => anchor.overlayId))
      refuse("Timeline overlay anchors require delivery.timeline=true");
    if (member.adapter.kind === "existing" && member.speech.length)
      refuse("Changed speech requires a derived template or localise project; keep the existing source immutable");
    if (
      member.anchors.some((anchor) => {
        const speech = member.speech.find((item) => item.sceneId === anchor.sceneId);
        return speech && speech.alignment.sha256 !== anchor.alignment.sha256;
      })
    )
      refuse("Speech anchors must use the exact replacement alignment for their scene");
    if ((member.adapter.kind === "film" || existingFilm(root, member)) && member.formats.length !== 1)
      refuse("A bespoke child has one composition format; create a separate child for another format");
    if (existingFilm(root, member)) {
      const brief = JSON.parse(
        readFileSync(path.join(projectDirectory(root, member.projectId), "pipeline/brief.json"), "utf8"),
      ) as { format?: string };
      if (brief.format && brief.format !== member.formats[0])
        refuse("Existing bespoke member format must match its film brief");
    }
  });
  if (request.scenario === "reference-family" && !request.reference)
    refuse("A reference family requires a pinned reference blueprint");
  if (request.reference)
    ReferenceBlueprintSchema.parse(JSON.parse(readFileSync(verifyPin(root, request.reference), "utf8")));
  if (request.scenario === "catalogue-videos" && members.some((member) => !member.productId))
    refuse("Catalogue members require product IDs");
  let allocation = {
    version: 1 as const,
    campaignId: request.id,
    capUsd: request.capUsd,
    owners: [
      { projectId: request.id, episodeId: "shared", quotaUsd: request.sharedQuotaUsd },
      ...members.map((member) => ({ projectId: member.projectId, episodeId: member.id, quotaUsd: member.quotaUsd })),
    ],
  };
  if (isCampaignOwner(projectDirectory(root, request.id))) {
    const frozen = CampaignAllocationSchema.parse(
      jsonFile(path.join(productionDirectory(root, request.id), "allocation.json")),
    );
    const canonical = (value: typeof allocation) => ({
      ...value,
      owners: [...value.owners].sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)),
    });
    if (digest(canonical(frozen)) === digest(canonical(allocation))) allocation = frozen;
  }
  const allocated = allocation.owners.reduce((sum, owner) => sum + Math.ceil(owner.quotaUsd * 1e6 - 1e-7), 0);
  if (allocated > Math.floor(request.capUsd * 1e6 + 1e-7)) refuse("Shared and member allocations exceed campaign cap");
  const materialIds = new Set(request.materials.map((material) => material.id));
  if (materialIds.size !== request.materials.length) refuse("Duplicate campaign material");
  const pilot = request.policy?.pilotMemberIds;
  if (
    pilot &&
    (new Set(pilot).size !== pilot.length ||
      pilot.some((id) => !members.some((member) => member.id === id && !member.excluded)))
  )
    refuse("Pilot selection must name unique active members");
  if (
    request.policy?.controlMemberId &&
    !members.some((member) => member.id === request.policy!.controlMemberId && !member.excluded)
  )
    refuse("Control member must be selected");
  const excluded = new Set(members.filter((member) => member.excluded).map((member) => member.id));
  const activeMaterials = new Set(members.filter((member) => !member.excluded).flatMap((member) => member.materials));
  const addMaterialDependencies = (id: string) => {
    for (const dependency of request.materials.find((material) => material.id === id)?.dependsOn ?? [])
      if (!activeMaterials.has(dependency)) {
        activeMaterials.add(dependency);
        addMaterialDependencies(dependency);
      }
  };
  [...activeMaterials].forEach(addMaterialDependencies);
  for (const material of request.materials)
    if (
      material.source.kind === "generate" &&
      !activeMaterials.has(material.id) &&
      (excluded.has(material.owner) ||
        members.some((member) => member.excluded && member.materials.includes(material.id)))
    )
      refuse(
        "Remove generation requests used only by excluded variants before revising; reconcile outstanding operations first",
      );
  for (const material of request.materials) {
    if (material.owner !== "shared" && !ids.has(material.owner)) refuse(`Unknown material owner: ${material.owner}`);
    if (
      material.owner !== "shared" &&
      !existsSync(projectDirectory(root, members.find((member) => member.id === material.owner)!.projectId))
    )
      refuse("New child materials must use the shared owner; member ownership requires an existing child project");
    if (material.dependsOn.some((id) => !materialIds.has(id))) refuse("Missing material dependency");
    if (material.source.kind === "generate") {
      const ownerId =
        material.owner === "shared" ? request.id : members.find((member) => member.id === material.owner)!.projectId;
      const output = path.resolve(root, material.source.output);
      if (!output.startsWith(projectDirectory(root, ownerId) + path.sep))
        refuse("Generation output must belong to its allocated owner");
      assertPathWithin(projectDirectory(root, ownerId), output);
    }
  }
  const inputPins = [
    ...(request.reference ? [request.reference] : []),
    ...(request.catalogue ? [request.catalogue.file] : []),
    ...request.materials.map((material) =>
      material.source.kind === "supplied" ? material.source.file : material.source.request,
    ),
    ...request.agentTasks.flatMap((task) => task.inputs),
    ...members.flatMap((member) => [
      ...adapterPins(member, root),
      ...(member.assurance?.facts.map((fact) => fact.source) ?? []),
    ]),
  ];
  for (const pin of inputPins) verifyPin(root, pin);
  for (const pin of request.entityPins) {
    resolveEntityReferences(
      pin.sourceProjectId,
      { kind: pin.kind, entityId: pin.entityId, revision: pin.revision },
      root,
    );
    if (
      getEntityVersion(pin.sourceProjectId, pin.kind, pin.entityId, {
        revision: pin.revision,
        rootDir: root,
        requireApproved: true,
      }).version.contentHash !== pin.contentHash
    )
      refuse("Campaign entity pin differs");
  }
  const tasks: CampaignTask[] = request.materials.map((material) => ({
    id: `material-${material.id}`,
    kind: "material",
    resource: material.source.kind === "generate" ? "generation" : "process",
    dependsOn: material.dependsOn.map((id) => `material-${id}`),
    payload: {
      materialId: material.id,
      ...(material.source.kind === "generate"
        ? {
            provider: String(
              (JSON.parse(readFileSync(verifyPin(root, material.source.request), "utf8")) as { provider?: string })
                .provider ?? "fal",
            ),
            operationId: `campaign.${request.id}.${material.id}.${digest(material.source).slice(0, 16)}`,
          }
        : {}),
    },
  }));
  for (const agent of request.agentTasks) {
    if (agent.id === "review-repair" || agent.id.startsWith("repair-critique-"))
      refuse("Review/critique repair IDs are reserved for source-bound repair handoffs");
    if (agent.memberId && !ids.has(agent.memberId)) refuse("Agent task names an unknown campaign member");
    if (!agent.memberId || !excluded.has(agent.memberId))
      tasks.push({
        id: agent.id,
        kind: "agent",
        resource: "qa",
        memberId: agent.memberId,
        dependsOn: agent.dependsOn,
        payload: { agentTask: agent },
      });
  }
  for (const member of members) {
    if (member.materials.some((id) => !materialIds.has(id))) refuse(`Missing material for ${member.id}`);
    if (member.excluded) continue;
    const agentDeps = request.agentTasks
      .filter((task) => !task.memberId || task.memberId === member.id)
      .map((task) => task.id);
    const prepare = `prepare-${member.id}`,
      anchors = `anchors-${member.id}`,
      snapshot = `snapshot-${member.id}`;
    tasks.push({
      id: prepare,
      kind: "prepare",
      memberId: member.id,
      resource: "process",
      dependsOn: [...member.materials.map((id) => `material-${id}`), ...agentDeps],
      payload: {},
    });
    tasks.push({
      id: anchors,
      kind: "anchors",
      memberId: member.id,
      resource: "process",
      dependsOn: [prepare],
      payload: {},
    });
    const validated = member.assurance || request.policy?.quality === "strict" ? `validate-${member.id}` : anchors;
    if (validated !== anchors)
      tasks.push({
        id: validated,
        kind: "validate",
        memberId: member.id,
        resource: "qa",
        dependsOn: [
          anchors,
          ...(request.policy?.controlMemberId && request.policy.controlMemberId !== member.id
            ? [`prepare-${request.policy.controlMemberId}`]
            : []),
        ],
        payload: {},
      });
    if (member.delivery)
      tasks.push({
        id: snapshot,
        kind: "snapshot",
        memberId: member.id,
        resource: "process",
        dependsOn: [validated],
        payload: {},
      });
    const qa: string[] = [];
    for (const format of new Set(member.formats))
      for (const variant of new Set(member.variants)) {
        const render = `render-${member.id}-${format}-${variant}`,
          check = `qa-${member.id}-${format}-${variant}`;
        tasks.push({
          id: render,
          kind: "render",
          memberId: member.id,
          resource: "render",
          dependsOn: [member.delivery ? snapshot : validated],
          payload: { format, variant },
        });
        tasks.push({
          id: check,
          kind: "qa",
          memberId: member.id,
          resource: "qa",
          dependsOn: [render],
          payload: { renderTaskId: render },
        });
        qa.push(check);
      }
    const critique = `critique-${member.id}`;
    tasks.push({
      id: critique,
      kind: "agent",
      memberId: member.id,
      resource: "qa",
      dependsOn: qa,
      payload: {
        agentTask: {
          id: critique,
          agent: "creative-critic",
          purpose:
            "Independently review this exact rendered variant against the brief, source facts, continuity, captions and supplied audio evidence. Never manufacture human approval.",
          inputs: [],
          outputs: [`public/projects/${member.projectId}/pipeline/campaign-critique.json`],
          memberId: member.id,
        },
      },
    });
    if (member.delivery)
      tasks.push({
        id: `delivery-${member.id}`,
        kind: "delivery",
        memberId: member.id,
        resource: "qa",
        dependsOn: [critique],
        payload: {},
      });
  }
  validateTaskGraph(tasks);
  const reusePlan = members.map((member) => ({
    memberId: member.id,
    projectAction:
      member.adapter.kind === "existing"
        ? ("reuse" as const)
        : member.adapter.kind === "localise"
          ? ("derive" as const)
          : ("create" as const),
    ...(member.adapter.kind === "existing"
      ? { sourceProjectId: member.adapter.projectId }
      : member.adapter.kind === "localise"
        ? { sourceProjectId: member.adapter.translation.sourceProjectId }
        : {}),
    preservedInputs: adapterPins(member, root),
    materials: member.materials.map((id) => {
      const material = request.materials.find((item) => item.id === id)!;
      return {
        id,
        ownerProjectId:
          material.owner === "shared" ? request.id : members.find((item) => item.id === material.owner)!.projectId,
        action: "import-verified-copy" as const,
      };
    }),
    recompute: member.excluded
      ? []
      : [
          ...(member.speech.length
            ? (["speech-timing", "captions", "events"] as const)
            : member.anchors.length
              ? (["events"] as const)
              : []),
          "render" as const,
          "technical-qa" as const,
          "creative-review" as const,
        ],
  }));
  const content = {
    version: 1 as const,
    request,
    members,
    allocation,
    allocationHash: digest(allocation),
    tasks,
    inputPins,
    reusePlan,
  };
  return CampaignProductionPlanSchema.parse({ ...content, planHash: digest(content) });
}
export function verifyPlan(plan: CampaignProductionPlan, root: string) {
  const { planHash, ...content } = CampaignProductionPlanSchema.parse(plan);
  if (digest(content) !== planHash || digest(plan.allocation) !== plan.allocationHash)
    refuse("Campaign plan identity differs");
  for (const pin of plan.inputPins) verifyPin(root, pin);
  for (const pin of plan.request.entityPins) {
    resolveEntityReferences(
      pin.sourceProjectId,
      { kind: pin.kind, entityId: pin.entityId, revision: pin.revision },
      root,
    );
    if (
      getEntityVersion(pin.sourceProjectId, pin.kind, pin.entityId, {
        revision: pin.revision,
        rootDir: root,
        requireApproved: true,
      }).version.contentHash !== pin.contentHash
    )
      refuse("Campaign entity changed");
  }
  validateTaskGraph(plan.tasks);
}
