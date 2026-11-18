/**
 * The no-pack rule of RFC 0003 D8, shared by generate:model's gate (admission.ts) and every fal paid submission
 * (executeFalOperation): reference inputs on a profiled endpoint without a reference pack warn ("warn", stderr), are
 * refused ("enforce", VALIDATION) or pass ("off"). Leaf module: it imports only profiles and the CLI error type.
 */
import { CliErrorObject } from "../../cli";
import type { ProviderId } from "../../../types/fal-catalog";
import type { Slot } from "../../../types/reference-profiles";
import { profileForEndpoint } from "../profiles";

export type ReferencePackEnforcement = "warn" | "enforce" | "off";
/** Phase 1 of D8. Phase 2 (after WP9) changes this to "enforce". */
export const REFERENCE_PACK_ENFORCEMENT: ReferencePackEnforcement = "warn";
export const REFERENCE_PACKS_ENV = "AGENTBROS_REFERENCE_PACKS";
export const NO_PACK_WARNING = "Reference inputs without a reference pack (RFC 0003 D8): prepare one with refs:pack";

/** The enforcement in effect: AGENTBROS_REFERENCE_PACKS=warn|enforce|off (any case, trimmed), else the default. */
export function referencePackEnforcement(env: NodeJS.ProcessEnv = process.env): ReferencePackEnforcement {
  // A literal process.env read, so the API surface's environment scan lists the variable.
  const configured = env === process.env ? process.env.AGENTBROS_REFERENCE_PACKS : env[REFERENCE_PACKS_ENV];
  const value = configured?.trim().toLowerCase();
  if (!value) return REFERENCE_PACK_ENFORCEMENT;
  if (value === "warn" || value === "enforce" || value === "off") return value;
  throw new CliErrorObject({
    code: "INVALID_INPUT",
    message: `${REFERENCE_PACKS_ENV} must be warn, enforce or off (got ${JSON.stringify(configured)}).`,
  });
}

const present = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  !(typeof value === "string" && value.trim() === "") &&
  !(Array.isArray(value) && value.length === 0);

/** Values at a profile pointer ("/image_urls", "/elements/{n}/frontal_image_url"); `{n}` expands over an array. */
function valuesAt(value: unknown, segments: string[]): unknown[] {
  if (!segments.length) return [value];
  const [head, ...rest] = segments;
  if (head === "{n}") return Array.isArray(value) ? value.flatMap((item) => valuesAt(item, rest)) : [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const key = head!.replace(/~1/g, "/").replace(/~0/g, "~");
  return Object.hasOwn(value, key) ? valuesAt((value as Record<string, unknown>)[key], rest) : [];
}
/** The slot pointers of a profile that this input fills with a non-empty value. */
export function filledReferenceSlots(input: Record<string, unknown>, slots: readonly Slot[]): string[] {
  return slots
    .filter((slot) => valuesAt(input, slot.pointer.split("/").slice(1)).some(present))
    .map((slot) => slot.pointer);
}

/**
 * The no-pack rule for a request without `context.referencePack`: undefined when it does not apply (off, unprofiled
 * endpoint, no filled reference slot), the warning text in "warn", a VALIDATION refusal in "enforce".
 */
export function noPackWarning(options: {
  provider: ProviderId;
  endpoint: string;
  input: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const mode = referencePackEnforcement(options.env);
  if (mode === "off") return undefined;
  const profile = profileForEndpoint(options.endpoint, options.provider);
  const filled = profile ? filledReferenceSlots(options.input, profile.slots) : [];
  if (!filled.length) return undefined;
  const message = `${NO_PACK_WARNING} (${profile!.family}: ${filled.join(", ")}).`;
  if (mode === "enforce")
    throw new CliErrorObject({
      code: "VALIDATION",
      message,
      details: {
        nextAction: `pnpm refs:pack --project PROJECT --action prepare --spec SPEC.json, then --action request --id PACK`,
      },
    });
  return message;
}

/**
 * Whether a durable job may already have reached the provider, so a rerun is a resume that keeps its identity: it has
 * a provider request ID, a billing receipt or a release, or an ambiguous submit (`submitting`/`unknown`) may have reached
 * the provider. A job that is only reserved has spent nothing and goes through the full gate again.
 */
export function jobSubmitted(
  job: { state?: string; providerRequestId?: string; receipt?: unknown; release?: unknown } | undefined,
): boolean {
  if (!job) return false;
  return Boolean(
    job.providerRequestId || job.receipt || job.release || job.state === "submitting" || job.state === "unknown",
  );
}
