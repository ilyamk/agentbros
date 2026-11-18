/**
 * A prepared Genjutsu input as a reference pack (RFC 0003 D1, WP9): `model:prepare --action as-pack` materialises
 * pipeline/reference-packs/genjutsu-<prepId>/ through the packs module, so the work can be listed, checked and
 * reviewed with refs:pack. Optional and review-only: the preparation keeps its own approval, rights and request, and
 * nothing is copied into the pack. The pack must compile to the preparation's exact input and prompt.
 */
import { readFileSync } from "node:fs";
import { CliErrorObject } from "../cli";
import { ReferencePackIdSchema } from "../../types/reference-pack-binding";
import { packSpecFromPreparation } from "../references/compile";
import { profileForEndpoint } from "../references/profiles";
import { preparePack, type PreparedPack } from "../references/packs";
import { preparationFile, readPreparation } from "./storage";

export const preparationPackId = (preparationId: string): string => `genjutsu-${preparationId}`;

export type PreparationAsPack = { pack: PreparedPack; preparation: { id: string; sha256: string } };

export function preparationAsPack(
  projectId: string,
  preparationId: string,
  rootDir = process.cwd(),
): PreparationAsPack {
  const { receipt, sha256 } = readPreparation(projectId, preparationId, rootDir);
  const packId = preparationPackId(preparationId);
  if (!ReferencePackIdSchema.safeParse(packId).success)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Pack id ${packId} is longer than 80 characters; prepare with a shorter preparation id.`,
    });
  if (!receipt.spec.useMarkers)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "A preparation without markers (useMarkers false) has no pack equivalent: packs compile with the profile's marker dialect. Keep using its model:prepare request.",
    });
  if (receipt.spec.remoteSource)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "A preparation of a remote original has no pack equivalent: the pack would bind the imported asset instead of the checked provider URL. Keep using its model:prepare request.",
    });
  const profile = profileForEndpoint(receipt.endpoint, "higgsfield");
  if (!profile)
    throw new CliErrorObject({ code: "VALIDATION", message: `No reference profile for ${receipt.endpoint}.` });
  const { spec } = packSpecFromPreparation(receipt.spec, profile, {
    sourceAssetId: receipt.preparedSource.assetId,
    referenceAssetIds: receipt.references.map((ref) => ref.media.assetId),
  });
  const request = JSON.parse(
    readFileSync(preparationFile(projectId, preparationId, "request.json", rootDir), "utf8"),
  ) as {
    input: Record<string, unknown>;
  };
  // Parity before any write: a pack that does not compile to the preparation's exact request is never left behind.
  const pack = preparePack(projectId, { ...spec, id: packId }, rootDir, {
    verify: (compiled) => {
      if (
        JSON.stringify(compiled.input) !== JSON.stringify(request.input) ||
        compiled.compiledPrompt !== request.input.prompt
      )
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `Pack ${packId} does not compile to the preparation's exact request; do not use it for ${preparationId}.`,
        });
    },
  });
  return { pack, preparation: { id: preparationId, sha256 } };
}
