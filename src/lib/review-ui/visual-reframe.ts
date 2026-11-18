import { z } from "zod";
import path from "node:path";
import { realpathSync } from "node:fs";
import { ReframePositionSchema, type EditCommand } from "../../types/timeline";
import { ProjectConfigSchema } from "../../types/video";
import { AssetRegistrySchema } from "../../types/assets";
import { readWorkflowEvidence } from "../workflows/local-evidence";
import { parseTimelineEditDocument, RevisionConflict } from "../timeline-ir/store";
import { applyEdit } from "../timeline-ir/commands";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { compare, div, fraction } from "../timeline-ir/rational";
import { createHash } from "node:crypto";
import { assertSplitOriginal } from "./split-original";
import { inspectSlipOriginal } from "./slip-original";
export const VisualReframeProposalSchema = z
  .object({
    expectedRevision: z.number().int().safe().nonnegative(),
    trackId: z.string().min(1).max(200),
    clipId: z.string().min(1).max(200),
    format: z.enum(["vertical", "square", "landscape"]),
    position: ReframePositionSchema.nullable(),
  })
  .strict();
/** Preparation observations are bounded and final-rechecked; Apply remains journal CAS, not an FS transaction. */
export function prepareVisualReframe(rootDir: string, projectId: string, raw: unknown) {
  const input = VisualReframeProposalSchema.parse(raw),
    project = path.join(rootDir, "public/projects", projectId);
  const journalFile = path.join(project, "pipeline/timeline-edit.json"),
    configFile = path.join(project, "project.json"),
    registryFile = path.join(project, "pipeline/asset-registry.json");
  const journal = readWorkflowEvidence(journalFile, project, 4 * 1024 * 1024),
    document = parseTimelineEditDocument(JSON.parse(journal.text));
  if (document.timeline.projectId !== projectId) throw Error("Journal belongs to another project");
  if (document.revision !== input.expectedRevision)
    throw new RevisionConflict(input.expectedRevision, document.revision);
  const clip = document.timeline.tracks
    .find((t) => t.id === input.trackId && t.kind === "visual")
    ?.clips.find((c) => c.id === input.clipId);
  if (!clip) throw Error("Reframe supports existing visual clips only");
  const configRead = readWorkflowEvidence(configFile, project, 1024 * 1024),
    registryRead = readWorkflowEvidence(registryFile, project, 4 * 1024 * 1024);
  const config = ProjectConfigSchema.parse(JSON.parse(configRead.text)),
    registry = AssetRegistrySchema.parse(JSON.parse(registryRead.text));
  if (config.talkingHead?.enabled) throw Error("Reframe does not support talking-head layouts");
  if (!config.formats.includes(input.format)) throw Error("Reframe format is not configured for this project");
  const command: EditCommand = {
    type: "reframe-visual",
    trackId: input.trackId,
    clipId: input.clipId,
    format: input.format,
    position: input.position,
  };
  const candidate = applyEdit(document.timeline, command); // Pure ownership refusal before physical inspection.
  const asset = registry.assets.find((a) => a.id === clip.assetId);
  if (
    !asset ||
    !["image", "video"].includes(asset.kind) ||
    !asset.files.original.startsWith("projects/" + projectId + "/assets/imported/") ||
    asset.files.original.includes("..") ||
    asset.files.original.includes("\\")
  )
    throw Error("Reframe requires registered imported plain image/video");
  if (clip.payload?.originalHash !== undefined && clip.payload.originalHash !== asset.hash)
    throw Error("Reframe original metadata checksum mismatch");
  const file = path.resolve(rootDir, "public", asset.files.original);
  // Scope every ancestor, including project root: no supplied aliases may masquerade as imported originals.
  const noAliases = () => {
    for (let current = file; ; current = path.dirname(current)) {
      if (realpathSync(current) !== current) throw Error("Reframe original must not use symlink aliases");
      if (current === project) break;
      if (!current.startsWith(project + path.sep)) throw Error("Reframe original escapes project");
    }
  };
  noAliases();
  if (asset.kind === "video") {
    const physical = inspectSlipOriginal(file, asset.hash);
    if (
      compare(clip.source.start, fraction(0)) < 0 ||
      compare(div(clip.source.end, clip.source.timebase), physical.physicalDuration) > 0
    )
      throw Error("Reframe source exceeds physical original duration");
  } else assertSplitOriginal(file, asset.hash, "image");
  const snapshot = compileTimelineIR(candidate);
  for (const [file, pin, bound] of [
    [configFile, configRead, 1024 * 1024],
    [registryFile, registryRead, 4 * 1024 * 1024],
    [journalFile, journal, 4 * 1024 * 1024],
  ] as const) {
    const now = readWorkflowEvidence(file, project, bound);
    if (now.sha256 !== pin.sha256) {
      if (file === journalFile) {
        const current = parseTimelineEditDocument(JSON.parse(now.text));
        if (current.revision !== input.expectedRevision)
          throw new RevisionConflict(input.expectedRevision, current.revision);
      }
      throw Error("Reframe preparation inputs changed");
    }
  }
  noAliases();
  assertSplitOriginal(file, asset.hash, asset.kind as "image" | "video");
  noAliases();
  return {
    command,
    revision: document.revision,
    timelineHash: createHash("sha256").update(JSON.stringify(candidate)).digest("hex"),
    snapshot,
    originalSha256: asset.hash,
    format: input.format,
  };
}
