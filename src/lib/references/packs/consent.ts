/**
 * Likeness and voice consent for packs (RFC 0003 D11, §11). An attachment belongs to a character when it, or any
 * asset it was made from (provenance ancestry), is a reference or voice sample of an approved character card
 * revision, or when pipeline/references.json names a character entity as the requirement's source.
 * - Picture of a character whose likeness consent is not "not-applicable" (a real or unconfirmed person) on a profile
 *   with realFaces "rejected": refused; the user chooses another model or confirms a fictional identity.
 * - Unknown likeness consent elsewhere: STAGE_INCOMPLETE, as model:prepare does.
 * - Voice sample: voice.consent must be "documented" or "not-applicable".
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { CliErrorObject } from "../../cli";
import { getEntityVersion, listEntities, resolveEntityReferences } from "../../entities/service";
import { preparationProject } from "../../model-preparation/storage";
import type { AssetRecord } from "../../../types/assets";
import type { EntityCard } from "../../../types/entities";
import type { ReferenceProfile } from "../../../types/reference-profiles";
import { ReferencesPlanSchema, type Modality, type ReferencePackSpec } from "../../../types/references";
import { assetAncestry } from "./media";

type CharacterCard = Extract<EntityCard, { kind: "character" }>;
type Link = { entityId: string; revision: number; card: CharacterCard; as: "likeness" | "voice" };

/** assetId → the approved character card revisions that use it as a picture reference or a voice sample. */
export function characterAssetLinks(projectId: string, rootDir = process.cwd()): Map<string, Link[]> {
  const links = new Map<string, Link[]>();
  const add = (assetId: string, link: Link) => links.set(assetId, [...(links.get(assetId) ?? []), link]);
  for (const manifest of listEntities(projectId, rootDir)) {
    if (manifest.kind !== "character") continue;
    for (let revision = 1; revision <= manifest.latestRevision; revision++) {
      const view = getEntityVersion(projectId, "character", manifest.id, { revision, rootDir });
      if (view.status !== "approved" || view.version.card.kind !== "character") continue;
      const card = view.version.card;
      for (const reference of card.references)
        add(reference.assetId, { entityId: card.id, revision, card, as: "likeness" });
      for (const sample of card.voice?.sampleAssetIds ?? [])
        add(sample, { entityId: card.id, revision, card, as: "voice" });
    }
  }
  return links;
}

/** Character links named by pipeline/references.json for this shot, keyed by requirement key. */
function plannedLinks(projectId: string, spec: ReferencePackSpec, rootDir: string, warnings: string[]) {
  const out = new Map<string, Link>();
  const file = path.join(preparationProject(projectId, rootDir), "pipeline/references.json");
  if (!existsSync(file)) return out;
  let plan;
  try {
    plan = ReferencesPlanSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    warnings.push("pipeline/references.json is invalid; entity sources there were not used for the consent check.");
    return out;
  }
  const shot = plan.shots.find((row) => row.shotId === spec.shotId);
  for (const requirement of shot?.requirements ?? []) {
    const source = requirement.source;
    if (source?.kind !== "entity" || source.entity.kind !== "character") continue;
    const resolved = resolveEntityReferences(projectId, source.entity, rootDir);
    if (resolved.card.kind !== "character") continue;
    out.set(requirement.key, {
      entityId: resolved.card.id,
      revision: source.entity.revision,
      card: resolved.card,
      as: requirement.role === "voice" || requirement.modality === "audio" ? "voice" : "likeness",
    });
  }
  return out;
}

export type ConsentReport = {
  /** requirementKey → character entity ids shown or heard in that attachment. */
  characters: Record<string, string[]>;
  warnings: string[];
};

/** requirementKey → the character links of that attachment (picture links for images and video, voice for audio). */
export function packCharacterLinks(
  projectId: string,
  spec: ReferencePackSpec,
  modalities: Record<string, Modality>,
  registry: AssetRecord[],
  rootDir = process.cwd(),
  warnings: string[] = [],
): Map<string, Link[]> {
  const byAsset = characterAssetLinks(projectId, rootDir);
  const planned = plannedLinks(projectId, spec, rootDir, warnings);
  const out = new Map<string, Link[]>();
  for (const attachment of spec.attachments) {
    const modality = modalities[attachment.requirementKey];
    const found = assetAncestry(attachment.source.assetId, registry).flatMap((asset) => byAsset.get(asset.id) ?? []);
    const fromPlan = planned.get(attachment.requirementKey);
    const linked = [...found, ...(fromPlan ? [fromPlan] : [])].filter((link) =>
      modality === "audio" ? link.as === "voice" : link.as === "likeness",
    );
    if (linked.length) out.set(attachment.requirementKey, linked);
  }
  return out;
}

export function checkPackConsent(
  projectId: string,
  spec: ReferencePackSpec,
  profile: ReferenceProfile,
  modalities: Record<string, Modality>,
  registry: AssetRecord[],
  rootDir = process.cwd(),
): ConsentReport {
  const warnings: string[] = [];
  const characters: Record<string, string[]> = {};
  for (const [requirementKey, linked] of packCharacterLinks(projectId, spec, modalities, registry, rootDir, warnings)) {
    const attachment = { requirementKey };
    characters[requirementKey] = [...new Set(linked.map((link) => link.entityId))].sort();
    for (const link of linked) {
      const who = `${link.entityId}@${link.revision}`;
      if (link.as === "voice") {
        const status = link.card.voice?.consent.status ?? "unknown";
        if (status !== "documented" && status !== "not-applicable")
          throw new CliErrorObject({
            code: "STAGE_INCOMPLETE",
            message: `Attachment ${attachment.requirementKey} carries the voice of ${who}, whose voice consent is ${status}. Record documented voice consent, or not-applicable for a designed voice, on the card first.`,
          });
        continue;
      }
      const status = link.card.likenessConsent?.status ?? "unknown";
      if (status === "not-applicable") continue;
      if (profile.policies.realFaces === "rejected")
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `Attachment ${attachment.requirementKey} shows ${who}, whose likeness consent is ${status} (a real or unconfirmed person); ${profile.family} rejects real faces (RFC 0003 D11). Choose a profile that permits real faces, or ask the user; never send a real face "to try".`,
          details: { requirementKey: attachment.requirementKey, entityId: link.entityId, realFaces: "rejected" },
        });
      if (status === "unknown")
        throw new CliErrorObject({
          code: "STAGE_INCOMPLETE",
          message: `Record likeness consent for ${who}, or not-applicable for a fictional identity, before packing ${attachment.requirementKey}.`,
        });
      if (profile.policies.realFaces === "unknown")
        warnings.push(
          `${attachment.requirementKey} shows ${who}, a consented real person; ${profile.family}'s real-face policy is unknown, so the provider may refuse it.`,
        );
    }
  }
  return { characters, warnings: [...new Set(warnings)] };
}
