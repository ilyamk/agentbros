import { z } from "zod";

export const KEY_EDITOR_PATH = "/settings/api-keys";
export const CREDENTIALS_HEADER = "x-console-credentials";
export const CredentialNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const CredentialValueSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[!-~]+$/);
export const CredentialsRevisionSchema = z.uuid().nullable();

export const CredentialListSchema = z.strictObject({
  ok: z.literal(true),
  editable: z.boolean(),
  revision: CredentialsRevisionSchema,
  keys: z.array(
    z.strictObject({
      name: CredentialNameSchema,
      service: z.string(),
      signup: z.url({ protocol: /^https$/ }),
      state: z.enum(["set", "unset", "malformed", "incomplete"]),
    }),
  ),
});

export const CredentialRevealSchema = z.strictObject({
  name: CredentialNameSchema,
  revision: CredentialsRevisionSchema,
});
export const CredentialValueReplySchema = z.strictObject({ ok: z.literal(true), value: z.string().nullable() });

export const CredentialSaveSchema = z.strictObject({
  revision: CredentialsRevisionSchema,
  changes: z
    .record(CredentialNameSchema, CredentialValueSchema.nullable())
    .refine((changes) => Object.keys(changes).length > 0),
});

export type CredentialList = z.infer<typeof CredentialListSchema>;
export type CredentialSave = z.infer<typeof CredentialSaveSchema>;
