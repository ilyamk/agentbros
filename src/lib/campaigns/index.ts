import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CampaignManifestSchema, CampaignBindingSchema, OutcomeSchema } from "../../types/campaigns";
import { getEntityVersion, resolveEntityReferences } from "../entities/service";
import { hashFile } from "../assets/registry";
import { validatePublicAsset } from "../render-plan";
import { buildRecipe } from "../templates/recipes";
import { stableHash } from "../longform/plans";
import { OperationStore } from "../jobs/store";
import { assertProductionReferences } from "./production/guard";
const micros = (usd: number) => Math.ceil(usd * 1_000_000 - 1e-7);
const write = (file: string, data: unknown) =>
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
export function planCampaign(raw: unknown, rootDir = process.cwd()) {
  const manifest = CampaignManifestSchema.parse(raw);
  if (
    new Set(manifest.episodes.map((e) => e.id)).size !== manifest.episodes.length ||
    new Set(manifest.episodes.map((e) => e.projectId)).size !== manifest.episodes.length
  )
    throw new Error("Duplicate episode/project ID");
  const allocatedMicros = manifest.episodes.reduce((sum, e) => sum + micros(e.quotaUsd), 0);
  if (allocatedMicros > Math.floor(manifest.capUsd * 1_000_000 + 1e-7))
    throw new Error("Episode allocations exceed campaign cap");
  const pins = manifest.world.pins.map((pin) => {
    resolveEntityReferences(
      pin.sourceProjectId,
      { kind: pin.kind, entityId: pin.entityId, revision: pin.revision },
      rootDir,
    );
    const view = getEntityVersion(pin.sourceProjectId, pin.kind, pin.entityId, {
      rootDir,
      revision: pin.revision,
      requireApproved: true,
    });
    if (view.version.contentHash !== pin.contentHash) throw new Error("Pinned entity hash mismatch");
    for (const ref of view.version.referenceSnapshots) {
      validatePublicAsset(ref.original, rootDir);
      if (hashFile(path.join(rootDir, "public", ref.original)) !== ref.hash)
        throw new Error("Pinned original has changed");
    }
    return { pin, version: view.version, approval: view.approval };
  });
  const manifestHash = stableHash(manifest);
  const episodes = manifest.episodes.map((episode) => {
    if (episode.recipe.projectId !== episode.projectId)
      throw new Error("Recipe project ID differs from episode project ID");
    for (const media of episode.recipe.media) validatePublicAsset(media.source, rootDir);
    const draft = buildRecipe(episode.recipe);
    draft.project.voice = episode.voice;
    draft.project.colors = manifest.brand.palette;
    return {
      ...episode,
      project: draft.project,
      findings: draft.findings,
      binding: CampaignBindingSchema.parse({
        version: 1,
        campaignId: manifest.id,
        projectId: episode.projectId,
        episodeId: episode.id,
        manifestHash,
        quotaUsd: episode.quotaUsd,
      }),
    };
  });
  return {
    version: 1,
    manifest,
    manifestHash,
    allocatedUsd: allocatedMicros / 1_000_000,
    unallocatedUsd: (Math.floor(manifest.capUsd * 1_000_000 + 1e-7) - allocatedMicros) / 1_000_000,
    pins,
    episodes,
    generationRequests: 0,
  };
}
/** Whole batch is staged locally and rolled back if any target exists or publication fails. */
export function createCampaignProjects(raw: unknown, rootDir = process.cwd()) {
  const plan = planCampaign(raw, rootDir);
  const projects = path.join(rootDir, "public/projects");
  mkdirSync(projects, { recursive: true });
  const staged: { temporary: string; target: string }[] = [],
    published: string[] = [];
  try {
    for (const episode of plan.episodes) {
      const target = path.join(projects, episode.projectId);
      if (existsSync(target)) throw new Error(`Project already exists: ${episode.projectId}`);
      const temporary = path.join(projects, `.campaign-${randomUUID()}`);
      staged.push({ temporary, target });
      mkdirSync(path.join(temporary, "pipeline"), { recursive: true });
      write(path.join(temporary, "project.json"), episode.project);
      write(path.join(temporary, "pipeline/campaign-binding.json"), episode.binding);
      write(path.join(temporary, "pipeline/campaign-snapshot.json"), {
        manifest: plan.manifest,
        manifestHash: plan.manifestHash,
        pins: plan.pins,
        episode: {
          id: episode.id,
          language: episode.language,
          voice: episode.voice,
          recipe: episode.recipe,
        },
        productionReady: false,
        generationRequests: 0,
      });
      new OperationStore(episode.projectId, {
        directory: path.join(temporary, "pipeline"),
      }).configure(
        { ceilingUsd: episode.quotaUsd, maxJobUsd: episode.quotaUsd },
        { by: "campaign", source: `campaign episode ${episode.id} quota USD ${episode.quotaUsd}` },
      );
    }
    for (const item of staged) {
      if (existsSync(item.target)) throw new Error("Project appeared during batch creation");
      mkdirSync(item.target); // Exclusive reservation also refuses an existing empty directory.
      published.push(item.target);
      renameSync(path.join(item.temporary, "pipeline"), path.join(item.target, "pipeline"));
      renameSync(path.join(item.temporary, "project.json"), path.join(item.target, "project.json"));
    }
  } catch (error) {
    for (const target of published) rmSync(target, { recursive: true });
    throw error;
  } finally {
    for (const item of staged) rmSync(item.temporary, { recursive: true, force: true });
  }
  return {
    outputs: published.map((dir) => path.join(dir, "project.json")),
    plan,
  };
}
export function campaignCostReport(raw: unknown, rootDir = process.cwd()) {
  const manifest = CampaignManifestSchema.parse(raw);
  const episodes = manifest.episodes.map((episode) => {
    const directory = path.join(rootDir, "public/projects", episode.projectId, "pipeline");
    const binding = CampaignBindingSchema.parse(
      JSON.parse(readFileSync(path.join(directory, "campaign-binding.json"), "utf8")),
    );
    if (binding.manifestHash !== stableHash(manifest) || binding.episodeId !== episode.id)
      throw new Error("Campaign binding mismatch");
    const db = new OperationStore(episode.projectId, { directory }).snapshot();
    const jobs = Object.values(db.jobs);
    const actualUsd = jobs.reduce(
      (sum, job) =>
        sum + (job.receipt?.actualUsd ?? 0) - job.refunds.reduce((total, refund) => total + refund.refundUsd, 0),
      0,
    );
    return {
      episodeId: episode.id,
      allocatedUsd: binding.quotaUsd,
      actualUsd,
      reservedUsd: jobs.reduce((sum, job) => sum + job.reservedMicros / 1_000_000, 0),
      receipts: jobs.flatMap((job) => (job.receipt ? [{ operationId: job.operationId, ...job.receipt }] : [])),
      paidAttempts: jobs.reduce((sum, job) => sum + job.paidAttempts, 0),
    };
  });
  return {
    campaignId: manifest.id,
    capUsd: manifest.capUsd,
    allocationIsSpend: false,
    episodes,
    actualUsd: episodes.reduce((sum, e) => sum + e.actualUsd, 0),
  };
}
export function storeOutcome(raw: unknown, file: string) {
  const outcome = OutcomeSchema.parse(raw);
  mkdirSync(path.dirname(file), { recursive: true });
  write(file, {
    ...outcome,
    evidenceHash: stableHash(outcome),
    causalAttribution: "not-inferred",
  });
  return outcome;
}

/** Re-check shared originals at use time; canonical updates never replace these pins. */
export function assertCampaignReferences(projectDir: string, rootDir = process.cwd()) {
  assertProductionReferences(projectDir);
  const file = path.join(projectDir, "pipeline/campaign-snapshot.json");
  if (!existsSync(file)) return;
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  const manifest = CampaignManifestSchema.parse(snapshot.manifest);
  if (stableHash(manifest) !== snapshot.manifestHash) throw new Error("Campaign snapshot hash mismatch");
  const binding = CampaignBindingSchema.parse(
    JSON.parse(readFileSync(path.join(projectDir, "pipeline/campaign-binding.json"), "utf8")),
  );
  if (binding.manifestHash !== snapshot.manifestHash || binding.projectId !== path.basename(projectDir))
    throw new Error("Campaign project binding mismatch");
  return manifest.world.pins.map((pin) => {
    const resolved = resolveEntityReferences(
      pin.sourceProjectId,
      { kind: pin.kind, entityId: pin.entityId, revision: pin.revision },
      rootDir,
    );
    const view = getEntityVersion(pin.sourceProjectId, pin.kind, pin.entityId, {
      revision: pin.revision,
      requireApproved: true,
      rootDir,
    });
    if (view.version.contentHash !== pin.contentHash) throw new Error("Pinned entity hash mismatch");
    return { pin, ...resolved };
  });
}
