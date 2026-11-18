/**
 * refs:pack --action prepare (RFC 0003 §6.5, §7, AC13): spec → measured attachments → compiled, validated request →
 * spec.json, board.html, visual-review-template.json, request.json and receipt.json (last). Immutable: the same id and
 * spec return the stored pack; a changed spec under the same id is FILE_EXISTS.
 *
 * Hashes: receipt.requestSha256 = sha256(canonical {provider, endpoint, input}), the request without its context;
 * packSha256 = sha256(canonical receipt); request.json = that request + context.referencePack {id, sha256: packSha256}.
 */
import path from "node:path";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { CliErrorObject, ensureFfprobe } from "../../cli";
import { hashFile, readAssetRegistry } from "../../assets/registry";
import { resolveImportedReferences } from "../../assets/provider-references";
import { buildFalOperation } from "../../providers/fal-operations";
import type { FalOperationPlan } from "../../../types/generation";
import {
  ReferencePackReceiptSchema,
  ReferencePackSpecSchema,
  type Modality,
  type ReferencePackReceipt,
  type ReferencePackSpec,
} from "../../../types/references";
import type { ReferenceProfile } from "../../../types/reference-profiles";
import { compilePack, type MediaFacts } from "../compile";
import { profileByFamily, profileForEndpoint } from "../profiles";
import { packBoard } from "./board";
import { checkPackConsent } from "./consent";
import { resolveAttachmentMedia, type ResolvedAttachmentMedia } from "./media";
import { pinPackSpeechScript, verifyPackSpeech } from "./speech";
import {
  immutablePackJson,
  immutablePackText,
  packDigest,
  packDirectory,
  readPack,
  requestDigest,
  type PackRequest,
  type StoredPack,
} from "./storage";

/** Inline limit for the offline validation pass (the same bound model:prepare uses for prepared originals). */
const VALIDATION_INLINE_BYTES = 256 * 1024 * 1024;

const invalid = (message: string, details?: Record<string, unknown>) =>
  new CliErrorObject({ code: "VALIDATION", message, ...(details ? { details } : {}) });

export function parsePackSpec(input: unknown): ReferencePackSpec {
  const parsed = ReferencePackSpecSchema.safeParse(input);
  if (!parsed.success)
    throw invalid(
      `Pack spec is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

/** The spec's profile, by family, and the check that the exact endpoint (at that profile's provider) belongs to it. */
export function packProfile(spec: Pick<ReferencePackSpec, "profileFamily" | "endpoint">): ReferenceProfile {
  const profile = profileByFamily(spec.profileFamily);
  if (!profile)
    throw invalid(`No reference profile named ${spec.profileFamily}; see pnpm refs:profiles --action list.`);
  const owner = profileForEndpoint(spec.endpoint, profile.provider);
  if (owner?.family !== profile.family)
    throw invalid(
      `Endpoint ${spec.endpoint} at ${profile.provider} belongs to ${owner ? `profile ${owner.family}` : "no profile"}, not ${profile.family}.`,
    );
  return profile;
}

/** Offline validation of a compiled input exactly as generate:model plans it: inline imported media, schema, guards. */
export function planPackRequest(
  projectId: string,
  request: Pick<PackRequest, "provider" | "endpoint" | "input">,
  rootDir = process.cwd(),
): FalOperationPlan {
  const resolved = resolveImportedReferences(
    { provider: request.provider, endpoint: request.endpoint, input: structuredClone(request.input) },
    projectId,
    rootDir,
    VALIDATION_INLINE_BYTES,
  ).request;
  return buildFalOperation(resolved);
}

/**
 * The unverified-dialect warning (RFC 0003 D3), only when the compiled prompt names attachments by marker: a pack whose
 * attachments are all positional (an empty marker map, e.g. kling-v2.6 motion control) has no dialect to verify.
 */
export function dialectWarnings(profile: ReferenceProfile, markerMap: Record<string, string>): string[] {
  return profile.dialect.evidence.tier === "unverified" && Object.keys(markerMap).length > 0
    ? [`${profile.family}'s marker dialect is unverified (RFC 0003 D3); record the first live result in memory.`]
    : [];
}
const REVIEW_WARNING =
  "The board and the visual review are review evidence, not automated creative, consent or legal verification.";

export type PreparedPack = StoredPack & { reused: boolean; files: string[] };

export type PreparePackOptions = {
  /** Called with the compiled request before anything is written (and on a reused pack); throw to leave no pack. */
  verify?: (compiled: { input: Record<string, unknown>; compiledPrompt: string }) => void;
};

export function preparePack(
  projectId: string,
  input: unknown,
  rootDir = process.cwd(),
  options: PreparePackOptions = {},
): PreparedPack {
  const spec = pinPackSpeechScript(projectId, parsePackSpec(input), rootDir);
  verifyPackSpeech(projectId, spec, rootDir);
  const directory = packDirectory(projectId, spec.id, rootDir);
  const files = ["spec.json", "board.html", "visual-review-template.json", "request.json", "receipt.json"].map((name) =>
    path.join(directory, name),
  );
  if (existsSync(path.join(directory, "receipt.json"))) {
    const stored = readPack(projectId, spec.id, rootDir);
    if (packDigest(stored.spec) !== packDigest(spec))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: `Pack ${spec.id} is immutable and holds another spec; use a new pack id for changed inputs.`,
      });
    options.verify?.({ input: stored.request.input, compiledPrompt: stored.receipt.compiledPrompt });
    return { ...stored, reused: true, files };
  }
  const profile = packProfile(spec);
  ensureFfprobe();
  const registry = readAssetRegistry(projectId, rootDir).assets;

  // 1. Resolve and measure every attachment once (one asset may serve two slots).
  const slots = new Map(profile.slots.map((slot) => [slot.id, slot]));
  const modalities: Record<string, Modality> = {};
  const resolved = new Map<string, ResolvedAttachmentMedia>();
  for (const attachment of spec.attachments) {
    const slot = slots.get(attachment.slot);
    if (!slot)
      throw invalid(
        `Attachment ${attachment.requirementKey} names unknown slot ${attachment.slot}; ${profile.family} has ${[...slots.keys()].join(", ")}.`,
      );
    modalities[attachment.requirementKey] = slot.modality;
    const media = resolveAttachmentMedia(projectId, attachment.source.assetId, slot.modality, registry, rootDir);
    resolved.set(attachment.source.assetId, media);
  }
  const media: Record<string, MediaFacts> = Object.fromEntries(
    [...resolved].map(([assetId, item]) => [assetId, item.facts]),
  );

  // 2. Consent (D11, §11) before anything is written.
  const consent = checkPackConsent(projectId, spec, profile, modalities, registry, rootDir);

  // 3. Compile; the guard hook validates the input as generate:model will (schema, guards, schema again).
  let plan: FalOperationPlan | undefined;
  const compiled = compilePack({
    spec,
    profile,
    media,
    guard: (compiledInput, warnings) => {
      plan = planPackRequest(
        projectId,
        { provider: profile.provider, endpoint: spec.endpoint, input: compiledInput },
        rootDir,
      );
      warnings.push(...plan.warnings);
    },
  });
  if (!plan) throw invalid("The compiled request was not validated.");
  options.verify?.({ input: compiled.input, compiledPrompt: compiled.compiledPrompt });
  const request = { provider: profile.provider, endpoint: spec.endpoint, input: compiled.input };
  const warnings = [
    ...new Set([
      ...compiled.warnings,
      ...consent.warnings,
      ...dialectWarnings(profile, compiled.markerMap),
      REVIEW_WARNING,
    ]),
  ];
  const byKey = new Map(spec.attachments.map((a) => [a.requirementKey, a]));
  const attachments = compiled.attachments.map((a) => {
    const item = resolved.get(byKey.get(a.requirementKey)!.source.assetId)!;
    return {
      requirementKey: a.requirementKey,
      marker: a.marker,
      pointer: a.pointer,
      media: item.pin,
      provenanceSha256: packDigest(item.asset.provenance),
    };
  });

  // 4. Write: spec, board, then the receipt's hash into the template and request, then the receipt.
  mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, ".preparing.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new CliErrorObject({
      code: "TIMEOUT",
      message: `Pack ${spec.id} is being prepared by another run; inspect it before retrying.`,
    });
  }
  try {
    immutablePackJson(files[0]!, spec, "Pack spec");
    const board = packBoard({
      id: spec.id,
      shotId: spec.shotId,
      endpoint: spec.endpoint,
      provider: profile.provider,
      family: profile.family,
      audioPolicy: spec.audioPolicy,
      attachments: attachments.map((a) => {
        const source = byKey.get(a.requirementKey)!;
        return {
          ...a,
          slot: source.slot,
          order: source.order,
          roleSentence: source.roleSentence,
          ...(source.element ? { element: source.element } : {}),
          ...(consent.characters[a.requirementKey] ? { characters: consent.characters[a.requirementKey] } : {}),
        };
      }),
      compiledPrompt: compiled.compiledPrompt,
      input: compiled.input,
      warnings,
      boardDir: directory,
      publicDir: path.resolve(rootDir, "public"),
    });
    immutablePackText(files[1]!, board, "Pack board");
    const receipt: ReferencePackReceipt = ReferencePackReceiptSchema.parse({
      schemaVersion: 1,
      projectId,
      id: spec.id,
      createdAt: new Date().toISOString(),
      spec,
      profileSha256: packDigest(profile),
      endpoint: spec.endpoint,
      schemaSha256: plan.schemaSha256,
      requestSha256: requestDigest(request),
      attachments,
      compiledPrompt: compiled.compiledPrompt,
      markerMap: compiled.markerMap,
      warnings,
      reviewFiles: [{ path: "board.html", sha256: hashFile(files[1]!) }],
    });
    const packSha256 = packDigest(receipt);
    // Files that name the pack hash and were left by a run that never wrote its receipt are not committed.
    for (const file of [files[2]!, files[3]!]) if (existsSync(file)) unlinkSync(file);
    immutablePackJson(files[2]!, {
      packSha256,
      reviewer: "FILL",
      evidence: "FILL after inspecting board.html and every attachment at full size",
      markersVerified: null,
      promptReviewed: null,
      attachments: attachments.map((a) => ({
        sha256: a.media.sha256,
        requirementKey: a.requirementKey,
        suitable: null,
        evidence: "FILL",
      })),
    });
    const fullRequest: PackRequest = { ...request, context: { referencePack: { id: spec.id, sha256: packSha256 } } };
    immutablePackJson(files[3]!, fullRequest, "Pack request");
    immutablePackJson(files[4]!, receipt, "Pack receipt");
    return { ...readPack(projectId, spec.id, rootDir), reused: false, files };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
