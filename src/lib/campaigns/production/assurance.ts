import { existsSync } from "node:fs";
import path from "node:path";
import { ProjectConfigSchema } from "../../../types/video";
import { ReferenceBlueprintSchema } from "../../../types/reference";
import type { CampaignMember, CampaignProductionPlan } from "../../../types/campaign-production";
import { jsonFile, verifyPin, digest, projectDirectory } from "./files";

export function validateCampaignMember(root: string, plan: CampaignProductionPlan, member: CampaignMember) {
  const issues: { code: string; severity: "error" | "warning"; message: string; sceneId?: string }[] = [];
  const strict = plan.request.policy?.quality === "strict";
  const issue = (code: string, message: string, sceneId?: string) =>
    issues.push({ code, severity: strict ? "error" : "warning", message, ...(sceneId ? { sceneId } : {}) });
  const file = path.join(projectDirectory(root, member.projectId), "project.json");
  const raw = existsSync(file)
    ? jsonFile(file)
    : member.adapter.kind === "template"
      ? member.adapter.project
      : undefined;
  const project = raw ? ProjectConfigSchema.parse(raw) : undefined;
  const scenes = project?.scenes ?? [],
    text = scenes.map((scene) => [scene.text, scene.headline, scene.subtext].filter(Boolean).join(" ")).join("\n");
  const assurance = member.assurance;
  for (const fact of assurance?.facts ?? []) {
    try {
      const source = verifyPin(root, fact.source);
      if (fact.jsonPointer) {
        const value = fact.jsonPointer
          .slice(1)
          .split("/")
          .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"))
          .reduce<unknown>(
            (value, key) =>
              value && typeof value === "object" && Object.hasOwn(value, key)
                ? (value as Record<string, unknown>)[key]
                : undefined,
            jsonFile(source),
          );
        if (String(value) !== fact.value)
          issue("FACT_VALUE_MISMATCH", `Declared value differs from its exact source field: ${fact.key}`);
      }
    } catch {
      issue("FACT_SOURCE_CHANGED", `Source changed for ${fact.key}`);
    }
    if (!text.includes(fact.value))
      issue("FACT_NOT_PRESENT", `Required fact ${fact.key} is absent from the authored text`);
  }
  for (const value of assurance?.requiredText ?? [])
    if (!text.includes(value)) issue("REQUIRED_TEXT_MISSING", `Required text is absent: ${value}`);
  for (const value of assurance?.forbiddenText ?? [])
    if (text.includes(value)) issue("FORBIDDEN_TEXT", `Forbidden text appears: ${value}`);
  if (!project)
    issue(
      "AUTHORED_PROJECT_UNAVAILABLE",
      "Inspect the bespoke source with its existing specialist; this automated check cannot certify it",
    );
  if (plan.request.scenario === "catalogue-videos") {
    if (!member.productId) issue("PRODUCT_ID_MISSING", "Catalogue members require their original product ID");
    if (!assurance?.facts.length) issue("PRODUCT_FACTS_UNBOUND", "Bind the product facts and exact source files");
    if (!assurance?.facts.some((fact) => fact.key === "productId" && fact.value === member.productId))
      issue("PRODUCT_ID_UNBOUND", "Bind the original product ID to its exact source field and authored text");
    for (const other of plan.members.filter((item) => item.id !== member.id && item.productId !== member.productId)) {
      for (const fact of other.assurance?.facts.filter((fact) => fact.key === "productId") ?? [])
        if (new Set<string>(text.match(/[\p{L}\p{N}_-]+/gu) ?? []).has(fact.value))
          issue("OTHER_PRODUCT_PRESENT", `Authored text contains another product ID: ${other.productId}`);
    }
  }
  if (plan.request.scenario === "ad-experiments") {
    const control = plan.members.find((item) => item.id === plan.request.policy?.controlMemberId);
    if (!control) issue("CONTROL_MISSING", "Name the control member for the experiment");
    if (!member.hypothesis) issue("HYPOTHESIS_MISSING", "Each experiment needs an explicit hypothesis");
    if (control && control.id !== member.id) {
      if (member.productId !== control.productId && !plan.request.policy?.variableFactors?.includes("product"))
        issue("CONTROL_PRODUCT_CHANGED", "Hook experiments must preserve the control product");
      const controlFile = path.join(projectDirectory(root, control.projectId), "project.json");
      const source = existsSync(controlFile)
        ? ProjectConfigSchema.parse(jsonFile(controlFile))
        : control.adapter.kind === "template"
          ? control.adapter.project
          : undefined;
      if (
        source &&
        project &&
        source.productName !== project.productName &&
        !plan.request.policy?.variableFactors?.includes("product")
      )
        issue("CONTROL_PRODUCT_CHANGED", "Authored product name differs from the control");
      if (plan.request.policy?.variableSceneIds && !source)
        issue("CONTROL_SOURCE_UNAVAILABLE", "The authored control project is required for preservation checks");
      for (const scene of plan.request.policy?.variableSceneIds ? (source?.scenes ?? []) : []) {
        if (plan.request.policy?.variableSceneIds?.includes(scene.id)) continue;
        const actual = scenes.find((item) => item.id === scene.id);
        if (!actual) issue("PRESERVED_SCENE_MISSING", "A protected proof or disclosure scene was removed", scene.id);
        if (
          actual &&
          digest([actual.text, actual.headline, actual.subtext, actual.imageUrl, actual.leftPanel]) !==
            digest([scene.text, scene.headline, scene.subtext, scene.imageUrl, scene.leftPanel])
        )
          issue("PRESERVED_SCENE_CHANGED", "A protected scene differs from the control", scene.id);
      }
      const changed = [...new Set([...Object.keys(control.factors), ...Object.keys(member.factors)])].filter(
        (key) => control.factors[key] !== member.factors[key],
      );
      if (!changed.length) issue("DUPLICATE_EXPERIMENT", "The declared factors do not differ from the control");
      if (changed.some((key) => !plan.request.policy?.variableFactors?.includes(key)))
        issue("UNDECLARED_FACTOR_CHANGE", "The variant changes a factor outside the declared experiment");
    }
  }
  if (plan.request.scenario === "reference-family" && plan.request.reference) {
    const blueprint = ReferenceBlueprintSchema.parse(jsonFile(verifyPin(root, plan.request.reference)));
    for (const slot of blueprint.slots) {
      const mapping = assurance?.referenceSlots.find((item) => item.slotId === slot.id);
      if (!mapping || !scenes.some((scene) => scene.id === mapping.sceneId))
        issue("REFERENCE_SLOT_UNMAPPED", `Reference slot ${slot.id} has no authored scene`);
    }
    if (!assurance?.facts.length)
      issue("PRODUCT_FACTS_UNBOUND", "Bind new product facts independently of the reference");
  }
  if (plan.request.scenario === "localise-campaign") {
    if (member.adapter.kind !== "localise")
      issue(
        "LOCALISATION_ROUTE_MISSING",
        "Use the localisation adapter with a pinned source and explicit translations",
      );
    else {
      if (member.adapter.translation.targetLanguage !== member.language)
        issue("LANGUAGE_MISMATCH", "Member and translation languages differ");
      for (const scene of scenes)
        if (!member.speech.some((item) => item.sceneId === scene.id))
          issue("SPEECH_MISSING", "A localised scene has no replacement speech and alignment", scene.id);
    }
    if (!member.fontContext) issue("LANGUAGE_FONT_UNBOUND", "Bind a checked font context for the target language");
    const sourceText =
      member.adapter.kind === "localise"
        ? ProjectConfigSchema.parse(
            jsonFile(path.join(projectDirectory(root, member.adapter.translation.sourceProjectId), "project.json")),
          )
            .scenes.map((scene) => [scene.text, scene.headline, scene.subtext].join(" "))
            .join(" ")
        : text;
    for (const [source, translated] of Object.entries(plan.request.policy?.terminology ?? {}))
      if (sourceText.includes(source) && !text.includes(translated))
        issue("TERMINOLOGY_MISSING", `Expected target terminology: ${translated}`);
  }
  if (plan.request.scenario === "content-series") {
    if (!plan.request.entityPins.length) issue("IDENTITY_UNBOUND", "Pin approved recurring identity versions");
    if (
      !member.scheduledFor ||
      !Number.isFinite(Date.parse(`${member.scheduledFor}T00:00:00Z`)) ||
      new Date(`${member.scheduledFor}T00:00:00Z`).toISOString().slice(0, 10) !== member.scheduledFor
    )
      issue("EPISODE_DATE_INVALID", "Supply a real episode date");
    for (const other of plan.members.filter((item) => !item.excluded && item.id !== member.id)) {
      const otherFile = path.join(projectDirectory(root, other.projectId), "project.json");
      const otherProject = existsSync(otherFile)
        ? ProjectConfigSchema.parse(jsonFile(otherFile))
        : other.adapter.kind === "template"
          ? other.adapter.project
          : undefined;
      if (
        otherProject &&
        digest(scenes.map((scene) => scene.text || scene.headline)) ===
          digest(otherProject.scenes.map((scene) => scene.text || scene.headline))
      )
        issue("DUPLICATE_EPISODE", `Episode content duplicates ${other.id}`);
    }
  }
  return {
    version: 1,
    planHash: plan.planHash,
    memberId: member.id,
    checks: "declared-facts-and-structure",
    creativeQuality: "requires-specialist-review",
    passed: !issues.some((item) => item.severity === "error"),
    issues,
  };
}
