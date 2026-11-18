/**
 * generate:model's reference-pack gate (RFC 0003 D8, §6.5, §9, AC14; WP6).
 *
 * With `context.referencePack`: the pack is read and checked (files and attachments unchanged), the binding hash is
 * the pack's, the request is the pack's request.json (provider, endpoint and input digest equal the receipt's
 * requestSha256; the whole parsed request equals request.json's), and approval.json binds this pack (and its rights
 * when required). Without a pack, on a profiled endpoint whose input fills a reference slot: a warning ("warn"), a
 * VALIDATION refusal ("enforce") or nothing ("off") (enforcement.ts). Genjutsu requests (genjutsuMode endpoints only) with
 * `context.modelPreparation` keep their own gate, and resumes of submitted durable jobs (jobSubmitted) keep their pack.
 */
import { CliErrorObject } from "../../cli";
import { canonicalJson } from "../../providers/fal-openapi";
import { genjutsuMode } from "../../model-preparation/profiles";
import { FalEndpointRequestSchema } from "../../../types/generation";
import type { ProviderId } from "../../../types/fal-catalog";
import type { ReferencePackSpec } from "../../../types/references";
import { checkPack, packState } from "./check";
import { noPackWarning } from "./enforcement";
import { readPack, requestDigest } from "./storage";

export {
  NO_PACK_WARNING,
  REFERENCE_PACK_ENFORCEMENT,
  REFERENCE_PACKS_ENV,
  filledReferenceSlots,
  jobSubmitted,
  noPackWarning,
  referencePackEnforcement,
  type ReferencePackEnforcement,
} from "./enforcement";

export type ReferencePackGate = {
  referencePack?: { id: string; sha256: string; status: "approved" | "prepared" };
  speech?: { audioPolicy: ReferencePackSpec["audioPolicy"]; lineIds: string[]; reviewRequired: true };
  warnings: string[];
  /** False when the bound pack is not approved (dry-run only; execution refuses). */
  executable: boolean;
  reasons: string[];
};

const invalid = (message: string, details?: Record<string, unknown>) =>
  new CliErrorObject({ code: "VALIDATION", message, ...(details ? { details } : {}) });

/**
 * The gate. `raw` is the request exactly as supplied (before routing rewrites it); `provider`, `endpoint` and
 * `input` are the planned operation's. `resuming` is true when the operation ID names an existing durable job.
 */
export function referencePackGate(options: {
  projectId?: string;
  raw: unknown;
  provider: ProviderId;
  endpoint: string;
  input: Record<string, unknown>;
  resuming: boolean;
  dryRun: boolean;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}): ReferencePackGate {
  const rootDir = options.rootDir ?? process.cwd();
  const raw = (options.raw && typeof options.raw === "object" ? options.raw : {}) as Record<string, unknown>;
  const context = (raw.context && typeof raw.context === "object" ? raw.context : {}) as Record<string, unknown>;
  const warnings: string[] = [];
  if (!context.referencePack) {
    // Only a real Genjutsu request keeps its own preparation gate; a modelPreparation on another endpoint exempts nothing.
    if (options.resuming || (context.modelPreparation && genjutsuMode(options.endpoint, options.provider)))
      return { warnings, executable: true, reasons: [] };
    const message = noPackWarning(options);
    return { warnings: message ? [message] : [], executable: true, reasons: [] };
  }

  if (!options.projectId)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "A reference-pack request needs --project." });
  if (!("endpoint" in raw))
    throw invalid("A reference-pack request is the endpoint-form request.json that refs:pack --action request emits.");
  const parsed = FalEndpointRequestSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.context?.referencePack)
    throw invalid("The reference-pack request is not a valid endpoint request.");
  const request = parsed.data;
  const binding = request.context!.referencePack!;
  // A submitted job keeps the pack it was admitted with (execution trusts publication.referencePack): a pack deleted,
  // re-prepared or changed after submit only warns, so the paid job is never stranded.
  if (options.resuming) {
    try {
      verifyBinding(options.projectId, request, binding, options, rootDir);
    } catch (error) {
      const state = packState(options.projectId, binding.id, rootDir, { verify: false });
      return {
        referencePack: {
          id: binding.id,
          sha256: binding.sha256,
          status: state.status === "approved" && state.packSha256 === binding.sha256 ? "approved" : "prepared",
        },
        warnings: [
          `Pack ${binding.id} changed since this job was submitted (${error instanceof Error ? error.message : String(error)}); resuming the existing job with its original binding.`,
        ],
        executable: true,
        reasons: [],
      };
    }
  }
  const pack = verifyBinding(options.projectId, request, binding, options, rootDir);
  // (a) files, attachments, board, profile and schema unchanged. A resumed job keeps its identity: warn only.
  let approved: boolean;
  let problems: string[];
  try {
    const checked = checkPack(options.projectId, binding.id, rootDir);
    approved = checked.approvalStatus.approved;
    problems = checked.approvalStatus.problems;
  } catch (error) {
    if (!options.resuming) throw error;
    warnings.push(
      `Pack ${binding.id} no longer checks (${error instanceof Error ? error.message : String(error)}); resuming the existing job only.`,
    );
    approved = Boolean(pack.approval && pack.approval.packSha256 === pack.packSha256);
    problems = approved ? [] : ["No approval for this pack hash."];
  }
  const referencePack = {
    id: binding.id,
    sha256: pack.packSha256,
    status: approved ? "approved" : "prepared",
  } as const;
  const lineIds = [
    ...(pack.spec.nativeSpeech ?? []),
    ...pack.spec.attachments.flatMap(({ speech }) => (speech?.kind === "performed-lines" ? speech.lines : [])),
  ].map((line) => line.lineId);
  const speech = lineIds.length
    ? { speech: { audioPolicy: pack.spec.audioPolicy, lineIds, reviewRequired: true as const } }
    : {};
  // (d) approval binds this pack and its rights.
  if (!approved) {
    if (!options.dryRun && !options.resuming)
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: `Pack ${binding.id} is not approved: ${problems.join(" ")}`,
        details: { nextAction: `pnpm refs:pack --project ${options.projectId} --action approve --id ${binding.id}` },
      });
    warnings.push(`Pack ${binding.id} is not approved: ${problems.join(" ")}`);
    return { referencePack, ...speech, warnings, executable: options.resuming, reasons: ["pack not approved"] };
  }
  return { referencePack, ...speech, warnings, executable: true, reasons: [] };
}

type ParsedRequest = ReturnType<typeof FalEndpointRequestSchema.parse>;
/** (b) and (c): the binding names this pack revision and the request is the pack's request.json. Throws VALIDATION. */
function verifyBinding(
  projectId: string,
  request: ParsedRequest,
  binding: { id: string; sha256: string },
  options: { provider: ProviderId; endpoint: string },
  rootDir: string,
) {
  const pack = readPack(projectId, binding.id, rootDir);
  // (c) the binding names this pack revision.
  if (binding.sha256 !== pack.packSha256)
    throw invalid(`Pack ${binding.id}: the request binds sha256 ${binding.sha256}, the pack is ${pack.packSha256}.`);
  // (b) the request is the pack's request: digest of {provider, endpoint, input}, then the whole parsed request.
  if (
    !request.provider ||
    requestDigest({ provider: request.provider, endpoint: request.endpoint, input: request.input }) !==
      pack.receipt.requestSha256 ||
    canonicalJson(request) !== canonicalJson(FalEndpointRequestSchema.parse(pack.request))
  )
    throw invalid(
      `Pack ${binding.id}: the request differs from the pack's request.json (tampered input, provider, endpoint or context); use refs:pack --action request --id ${binding.id}.`,
    );
  if (pack.receipt.endpoint !== options.endpoint || request.provider !== options.provider)
    throw invalid(`Pack ${binding.id}: compiled for ${pack.receipt.endpoint}, routed to ${options.endpoint}.`);
  return pack;
}
