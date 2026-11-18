import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { assertPathWithin, CliErrorObject } from "../cli";
import { hashFile, readAssetRegistry } from "../assets/registry";
import type { AssetRecord } from "../../types/assets";
import { probeVideo } from "../vision/media";
import {
  PreparationResultSchema,
  PreparationResultReviewSchema,
  PreparationRightsSchema,
  type ModelPreparationBinding,
} from "../../types/model-preparation";
import {
  immutablePreparationJson,
  preparationFile,
  preparationProject,
  projectMediaFile,
  readPreparation,
} from "./storage";
import { preparationAdmission, validatePreparation } from "./approval";
import { runPreparationFfmpeg } from "./prepare";

type PreparationUse = {
  commercial: boolean;
  placements: readonly string[];
  usage: { advertising?: boolean; endorsement?: boolean; standaloneResale?: boolean };
};
function assertPreparationPublicationRights(
  rights: import("../../types/model-preparation").PreparationRights,
  binding: ModelPreparationBinding,
  use: PreparationUse,
): void {
  if (
    rights.preparationSha256 !== binding.sha256 ||
    rights.status === "study-only" ||
    (use.commercial && !rights.commercialAllowed) ||
    !use.placements.every((placement) => rights.placements.includes(placement)) ||
    (["advertising", "endorsement", "standaloneResale"] as const).some((key) => use.usage[key] && !rights.usage[key])
  )
    throw new Error("Genjutsu source-use rights do not cover this publication.");
}

export function recordPreparationResult(
  projectId: string,
  binding: ModelPreparationBinding,
  operationId: string,
  output: string,
  assetId: string,
  rootDir = process.cwd(),
) {
  const record = PreparationResultSchema.parse({
    schemaVersion: 1,
    preparationSha256: binding.sha256,
    operationId,
    outputSha256: hashFile(output),
    assetId,
    path: path.relative(rootDir, output),
  });
  immutablePreparationJson(
    preparationFile(projectId, binding.id, `results/${record.outputSha256}.json`, rootDir),
    record,
  );
  return record;
}
export function preparationResultBoard(projectId: string, id: string, output: string, rootDir = process.cwd()) {
  const data = readPreparation(projectId, id, rootDir),
    project = preparationProject(projectId, rootDir);
  const file = path.resolve(rootDir, output);
  // Results may be a project asset or the project's renderer output, never another project or arbitrary local file.
  try {
    assertPathWithin(project, file);
  } catch {
    assertPathWithin(path.resolve(rootDir, "out", projectId), file);
  }
  const outputSha256 = hashFile(file);
  const result = PreparationResultSchema.parse(
    JSON.parse(readFileSync(preparationFile(projectId, id, `results/${outputSha256}.json`, rootDir), "utf8")),
  );
  if (result.preparationSha256 !== data.sha256 || result.outputSha256 !== outputSha256)
    throw new CliErrorObject({ code: "VALIDATION", message: "Result does not belong to this preparation." });
  const info = probeVideo(file),
    directory = preparationFile(projectId, id, `results/${outputSha256}`, rootDir);
  for (const [index, fraction] of [0, 0.5, 0.9].entries()) {
    const frame = path.join(directory, `result-${index + 1}.png`);
    if (!existsSync(frame)) {
      // The JSON writer safely creates the result directory before FFmpeg writes its fixed filenames.
      immutablePreparationJson(path.join(directory, "measurements.json"), info);
      runPreparationFfmpeg([
        "-ss",
        String(Math.min(info.durationSec - 1 / info.fps, info.durationSec * fraction)),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:480:force_original_aspect_ratio=decrease",
        "-threads",
        "1",
        frame,
      ]);
    }
  }
  const assessmentFile = path.join(directory, "review-template.json");
  immutablePreparationJson(assessmentFile, {
    schemaVersion: 1,
    preparationSha256: data.sha256,
    outputSha256,
    reviewer: "FILL",
    evidence: "FILL after reviewing the full source/result and sampled images",
    identity: "FILL",
    motion: "FILL",
    preservedElements: "FILL",
    otherSubjects: "FILL",
    temporalConsistency: "FILL",
    audio: "FILL",
    verdict: "FILL",
  });
  return {
    result,
    measurements: info,
    sourceBoard: preparationFile(projectId, id, "board.html", rootDir),
    frames: [1, 2, 3].map((n) => path.join(directory, `result-${n}.png`)),
    assessmentFile,
    reviewCommands: [
      {
        command: "vision:pack",
        argv: [
          "--input",
          projectMediaFile(projectId, data.receipt.preparedSource.original, rootDir),
          "--output",
          path.join(directory, "source-motion"),
          "--profile",
          "motion",
        ],
      },
      {
        command: "vision:pack",
        argv: ["--input", file, "--output", path.join(directory, "result-motion"), "--profile", "motion"],
      },
    ],
  };
}
export function reviewPreparationResult(projectId: string, id: string, input: unknown, rootDir = process.cwd()) {
  const data = readPreparation(projectId, id, rootDir),
    review = PreparationResultReviewSchema.parse(input);
  if (review.preparationSha256 !== data.sha256)
    throw new CliErrorObject({ code: "VALIDATION", message: "Result review refers to another preparation." });
  const result = PreparationResultSchema.parse(
    JSON.parse(readFileSync(preparationFile(projectId, id, `results/${review.outputSha256}.json`, rootDir), "utf8")),
  );
  assertPathWithin(path.resolve(rootDir), path.resolve(rootDir, result.path));
  if (result.preparationSha256 !== data.sha256 || hashFile(path.resolve(rootDir, result.path)) !== review.outputSha256)
    throw new CliErrorObject({ code: "VALIDATION", message: "Reviewed result bytes changed." });
  if (data.receipt.references.some((ref) => ref.kind === "character") && review.identity === "not-applicable")
    throw new CliErrorObject({ code: "VALIDATION", message: "Character identity must be reviewed." });
  if (data.receipt.spec.target.otherSubjects.length && review.otherSubjects === "not-applicable")
    throw new CliErrorObject({ code: "VALIDATION", message: "Declared other subjects must be reviewed." });
  if (review.audio === "replace-in-edit" && data.receipt.spec.audioPolicy !== "replace-in-edit")
    throw new CliErrorObject({ code: "VALIDATION", message: "Audio handoff differs from the approved audio policy." });
  const file = preparationFile(projectId, id, `results/${review.outputSha256}.review.json`, rootDir);
  immutablePreparationJson(file, review);
  return { file, review };
}
export function preparationDeliveryReview(
  projectId: string,
  binding: ModelPreparationBinding,
  outputSha256: string,
  use: PreparationUse,
  rootDir = process.cwd(),
) {
  const prepared = validatePreparation(projectId, binding, rootDir);
  const admission = preparationAdmission(projectId, binding, prepared.receipt.endpoint, prepared.plan.input, rootDir);
  if (!admission.ready) throw new Error(admission.blockers.join(" "));
  const rights = PreparationRightsSchema.parse(
    JSON.parse(readFileSync(preparationFile(projectId, binding.id, "rights.json", rootDir), "utf8")),
  );
  const review = PreparationResultReviewSchema.parse(
    JSON.parse(
      readFileSync(preparationFile(projectId, binding.id, `results/${outputSha256}.review.json`, rootDir), "utf8"),
    ),
  );
  const result = PreparationResultSchema.parse(
    JSON.parse(readFileSync(preparationFile(projectId, binding.id, `results/${outputSha256}.json`, rootDir), "utf8")),
  );
  assertPreparationPublicationRights(rights, binding, use);
  if (
    result.preparationSha256 !== binding.sha256 ||
    result.outputSha256 !== outputSha256 ||
    review.preparationSha256 !== binding.sha256 ||
    review.outputSha256 !== outputSha256 ||
    review.verdict !== "pass"
  )
    throw new Error("Genjutsu needs a passing review for these exact result bytes.");
  return {
    allowed: true,
    rights,
    review,
    requiresAudioReplacement: prepared.receipt.spec.audioPolicy === "replace-in-edit",
  };
}

/** Editing or restyling a result cannot remove the source-use restrictions of an earlier preparation. */
export function preparationLineageReview(
  projectId: string,
  assetId: string,
  use: PreparationUse,
  rootDir = process.cwd(),
  assets = readAssetRegistry(projectId, rootDir).assets,
) {
  const registry = new Map(assets.map((asset) => [asset.id, asset])),
    visited = new Set<string>(),
    active = new Set<string>();
  const reviews: (ReturnType<typeof preparationDeliveryReview> & { assetId: string })[] = [];
  const visit = (id: string): void => {
    if (active.has(id)) throw new Error("Cyclic imported asset provenance.");
    if (visited.has(id)) return;
    const asset = registry.get(id);
    if (!asset) throw new Error(`Missing upstream original: ${id}`);
    active.add(id);
    if (asset.provenance.modelPreparation)
      reviews.push({
        ...preparationDeliveryReview(projectId, asset.provenance.modelPreparation, asset.hash, use, rootDir),
        assetId: id,
      });
    for (const source of asset.provenance.referenceAssetIds) visit(source);
    active.delete(id);
    visited.add(id);
  };
  visit(assetId);
  return reviews;
}

/** Bespoke identities also bind originals retained only as preparation evidence. */
export function preparationInputCoverage(
  projectId: string,
  asset: AssetRecord,
  use: PreparationUse,
  rootDir = process.cwd(),
) {
  const project = preparationProject(projectId, rootDir),
    directory = path.join(project, "pipeline/model-preparations");
  assertPathWithin(project, directory);
  if (!existsSync(directory)) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const file = preparationFile(projectId, entry.name, "receipt.json", rootDir);
    if (!existsSync(file)) continue;
    const data = readPreparation(projectId, entry.name, rootDir);
    if (
      ![data.receipt.source, data.receipt.preparedSource, ...data.receipt.references.map((ref) => ref.media)].some(
        (media) => media.assetId === asset.id && media.sha256 === asset.hash,
      )
    )
      continue;
    const binding = { id: entry.name, sha256: data.sha256 };
    try {
      const prepared = validatePreparation(projectId, binding, rootDir),
        admission = preparationAdmission(projectId, binding, prepared.receipt.endpoint, prepared.plan.input, rootDir);
      if (!admission.ready || !admission.rights) continue;
      assertPreparationPublicationRights(admission.rights, binding, use);
      return { rights: admission.rights, binding };
    } catch {
      /* Another current preparation may cover these same input bytes. */
    }
  }
  return undefined;
}
