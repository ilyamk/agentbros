import { filmStyleFile, readFilmStyle } from "../../film-styles/binding";
import { filmStyleKey } from "../../film-styles/catalogue";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  ProductionBindingSchema,
  CampaignAllocationSchema,
  CampaignProductionPlanSchema,
} from "../../../types/campaign-production";
import {
  digest,
  isCampaignOwner,
  jsonFile,
  productionDirectory,
  projectDirectory,
  refuse,
  scopedFile,
  verifyPin,
} from "./files";
import { verifyPlan } from "./plan";

export function assertProductionAllocation(projectDir: string) {
  const file = path.join(projectDir, "pipeline/campaign-binding.json");
  if (!existsSync(file)) return;
  const raw = jsonFile(file) as { version?: unknown };
  if (raw.version !== 2) return;
  const binding = ProductionBindingSchema.parse(raw),
    root = path.resolve(projectDir, "../../..");
  if (binding.projectId !== path.basename(projectDir) || binding.campaignId !== binding.ownerProjectId)
    refuse("Campaign owner binding differs");
  const owner = projectDirectory(root, binding.ownerProjectId);
  if (!isCampaignOwner(owner)) refuse("Campaign owner is missing");
  const allocation = CampaignAllocationSchema.parse(
    jsonFile(scopedFile(root, path.join(productionDirectory(root, binding.ownerProjectId), "allocation.json"))),
  );
  const assignment = allocation.owners.find(
    (item) => item.projectId === binding.projectId && item.episodeId === binding.episodeId,
  );
  if (
    digest(allocation) !== binding.manifestHash ||
    !assignment ||
    assignment.quotaUsd !== binding.quotaUsd ||
    allocation.campaignId !== binding.campaignId
  )
    refuse("Frozen campaign allocation differs");
  if (
    allocation.owners.reduce((sum, owner) => sum + Math.ceil(owner.quotaUsd * 1e6 - 1e-7), 0) >
    Math.floor(allocation.capUsd * 1e6 + 1e-7)
  )
    refuse("Campaign allocations exceed ceiling");
  return { binding, root };
}
export function assertProductionReferences(projectDir: string) {
  const checked = assertProductionAllocation(projectDir);
  if (!checked) return;
  const { binding, root } = checked,
    directory = productionDirectory(root, binding.ownerProjectId);
  if (existsSync(path.join(directory, "archive.json")))
    refuse("Campaign is archived; retained media is not an active production");
  const current = jsonFile(scopedFile(root, path.join(directory, "current.json"))) as { planHash: string };
  if (!/^[a-f0-9]{64}$/.test(current.planHash)) refuse("Invalid campaign revision");
  const plan = CampaignProductionPlanSchema.parse(
    jsonFile(scopedFile(root, path.join(directory, "plans", `${current.planHash}.json`))),
  );
  if (plan.planHash !== current.planHash || plan.allocationHash !== binding.manifestHash)
    refuse("Campaign plan or allocation differs");
  verifyPlan(plan, root);
  const adapter = plan.members.find(({ projectId }) => projectId === binding.projectId)?.adapter;
  const styleKey =
    adapter?.kind === "film" ? adapter.styleCard : adapter?.kind === "recipe" ? adapter.request.styleCard : undefined;
  if (styleKey) {
    const style = readFilmStyle(projectDir);
    if (!style || filmStyleKey(style.style) !== styleKey)
      refuse("The campaign member's style differs from the approved plan");
    const preparation = jsonFile(scopedFile(root, path.join(projectDir, "pipeline/campaign-preparation.json"))) as {
      files: { path: string; sha256: string }[];
    };
    const pin = preparation.files.find((item) => path.resolve(root, item.path) === filmStyleFile(projectDir));
    if (!pin) refuse("The campaign member lacks its style preparation pin");
    verifyPin(root, pin);
  }
  // pipeline/campaign-stage-approvals/ receipts belonged to the removed template stage approvals: ignored, as nothing can renew them.
  const assets = path.join(projectDir, "pipeline/campaign-assets");
  if (existsSync(assets))
    for (const entry of readdirSync(assets).filter((file) => file.endsWith(".json"))) {
      const record = jsonFile(scopedFile(root, path.join(assets, entry))) as {
        owner: { original: string; sha256: string };
        file: { path: string; sha256: string };
      };
      verifyPin(root, record.file);
      verifyPin(root, { path: path.join("public", record.owner.original), sha256: record.owner.sha256 });
    }
}

export function assertProductionSpend(projectDir: string) {
  const checked = assertProductionAllocation(projectDir);
  if (!checked) return;
  const directory = productionDirectory(checked.root, checked.binding.ownerProjectId);
  if (existsSync(path.join(directory, "archive.json")))
    refuse("Paid operations are forbidden for an archived campaign");
  const current = jsonFile(scopedFile(checked.root, path.join(directory, "current.json"))) as { planHash: string };
  if (!/^[a-f0-9]{64}$/.test(current.planHash)) refuse("Invalid campaign revision");
  const plan = CampaignProductionPlanSchema.parse(
    jsonFile(scopedFile(checked.root, path.join(directory, "plans", `${current.planHash}.json`))),
  );
  const { planHash, ...content } = plan;
  if (
    planHash !== current.planHash ||
    digest(content) !== planHash ||
    plan.allocationHash !== checked.binding.manifestHash
  )
    refuse("Campaign spending policy or allocation identity changed");
  if (plan.request.spend === "forbid") refuse("Paid operations are forbidden by the owning campaign");
}
