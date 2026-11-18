import { z } from "zod";
import type { HiggsfieldClient } from "../providers/higgsfield/client";
import { CliErrorObject } from "../cli";
import type { JobProvider } from "./runner";

export const HiggsfieldCustomReferenceSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
    status: z.enum(["not_ready", "queued", "in_progress", "completed", "failed"]),
    fail_reason: z.string().nullable().optional(),
  })
  .passthrough();
/** Soul ID uses custom references, not the media queue; ambiguous submits cannot be retried safely. */
export function createHiggsfieldTrainingProvider(
  client: Pick<HiggsfieldClient, "createCustomReference" | "customReference">,
): JobProvider {
  const checkEndpoint = (endpoint: string) => {
    if (endpoint !== "v1/custom-references")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Soul ID training requires v1/custom-references." });
  };
  return {
    // https://docs.higgsfield.ai/docs/models/soul-id/create-character.md: no documented idempotency header.
    idempotentSubmit: false,
    async submit(endpoint, input) {
      checkEndpoint(endpoint);
      const reference = HiggsfieldCustomReferenceSchema.parse(await client.createCustomReference(input));
      return { requestId: reference.id };
    },
    async inspect(endpoint, requestId) {
      checkEndpoint(endpoint);
      const reference = HiggsfieldCustomReferenceSchema.parse(await client.customReference(requestId));
      if (reference.id !== requestId)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Soul ID status belongs to a different custom reference.",
        });
      if (reference.status === "not_ready" || reference.status === "queued") return { state: "queued" };
      if (reference.status === "in_progress") return { state: "running" };
      if (reference.status === "completed") return { state: "completed", result: reference };
      // Training docs do not promise a refund on failure: retain liability for reconciliation.
      return { state: "failed", message: "Soul ID training failed; reconcile the custom reference and billing." };
    },
  };
}
