import { z } from "zod";

/** Leaf module so film.ts and generation.ts can bind a pack without importing the reference schemas (RFC 0003 §6.5). */
export const ReferencePackIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
/** Binds a material item or a provider request to one immutable reference pack by its receipt hash. */
export const ReferencePackBindingSchema = z
  .object({ id: ReferencePackIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type ReferencePackBinding = z.infer<typeof ReferencePackBindingSchema>;
