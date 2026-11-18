import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { CliErrorObject } from "../cli";
import { canonicalRequestBody, generationRequestBody } from "./request-body";
import { OperationStore } from "./store";
import type { GenerationJob } from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const canonicalInputIdentity = (
  input: Record<string, unknown>,
): NonNullable<GenerationJob["canonicalInput"]> => ({ version: 2, sha256: digest(canonicalRequestBody(input)) });
function frozenLegacyInput(job: GenerationJob, input: Record<string, unknown>): boolean {
  return (
    job.requestBody !== undefined &&
    digest(job.requestBody) === job.inputHash &&
    canonicalRequestBody(JSON.parse(job.requestBody)) === canonicalRequestBody(input)
  );
}

/** New jobs add V2 identity; resumes retain their original pricing/provenance hash. */
export function paidInputIdentity(
  input: Record<string, unknown>,
  previous?: GenerationJob,
): Pick<GenerationJob, "inputHash" | "canonicalInput"> {
  const canonicalInput = canonicalInputIdentity(input);
  if (previous?.canonicalInput) {
    if (previous.canonicalInput.sha256 !== canonicalInput.sha256)
      throw new CliErrorObject({ code: "VALIDATION", message: "Operation ID is already bound to different inputs." });
    return { inputHash: previous.inputHash, canonicalInput: previous.canonicalInput };
  }
  const inputHash = digest(generationRequestBody(input));
  if (previous && inputHash !== previous.inputHash && !frozenLegacyInput(previous, input))
    throw new CliErrorObject({
      code: "VALIDATION",
      message:
        "Legacy operation has different inputs or an unverifiable original locale; reconcile its original operation ID before submitting again.",
    });
  return {
    inputHash: previous?.inputHash ?? inputHash,
    canonicalInput: previous
      ? undefined
      : { ...canonicalInput, legacyLocale: new Intl.Collator().resolvedOptions().locale },
  };
}

/** Read-only discovery shared by planning and execution, before uploads, estimates or admission. */
export function resolveOperationIdentity(options: {
  input: Record<string, unknown>;
  idInput?: Record<string, unknown>;
  projectId?: string;
  store?: OperationStore;
  operationId?: string;
  endpoint: string;
  provider: string;
  assetId: string;
  id: (hash: string) => string;
}) {
  const canonical = canonicalInputIdentity(options.idInput ?? options.input);
  canonicalInputIdentity(options.input);
  const currentId = options.id(`v2:${canonical.sha256}`);
  const legacyId = options.id(digest(generationRequestBody(options.idInput ?? options.input)));
  const store = options.store ?? (options.projectId ? new OperationStore(options.projectId) : undefined);
  const jobs = store && existsSync(store.file) ? store.snapshot().jobs : {};
  const find = (id: string) => (Object.hasOwn(jobs, id) ? jobs[id] : undefined);
  if (!options.operationId && currentId !== legacyId && find(currentId) && find(legacyId))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Both legacy and V2 operations exist; select the original --operation-id explicitly.",
    });
  const peers = Object.values(jobs).filter(
    (job) =>
      !job.canonicalInput &&
      job.endpoint === options.endpoint &&
      job.provider === options.provider &&
      job.assetId === options.assetId,
  );
  const frozen =
    !options.operationId && !find(currentId) && !find(legacyId)
      ? peers.filter((job) => frozenLegacyInput(job, options.input))
      : [];
  if (frozen.length > 1)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Multiple frozen legacy operations match; select the original --operation-id explicitly.",
    });
  const operationId =
    options.operationId ??
    (find(currentId) ? currentId : find(legacyId) ? legacyId : (frozen[0]?.operationId ?? currentId));
  const existing = find(operationId);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(operationId))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid operation ID." });
  if (
    !existing &&
    !options.operationId &&
    peers.some((job) => (job.paidAttempts > 0 || job.state === "reserved") && !job.receipt && !job.release)
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message:
        "An unmatched legacy operation owns this destination; reconcile it or select an explicit --operation-id before creating a new attempt.",
    });
  return { operationId, existing, ...paidInputIdentity(options.input, existing) };
}
