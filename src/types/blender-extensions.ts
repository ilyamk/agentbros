import { z } from "zod";

export const ExtensionIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const text = z.string().trim().min(1);
const date = z.string().date();
const consent = z.object({ by: text, date, note: text, allowNetworkAccount: z.boolean().optional() }).strict();
export const ExtensionEntrySchema = z
  .object({
    id: ExtensionIdSchema,
    name: text,
    repo: z.enum(["blender_org", "github", "local"]),
    version,
    blenderMin: version,
    blenderMax: version.nullable(),
    archive: z
      .object({
        url: z.string().url().nullable(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z
          .number()
          .int()
          .positive()
          .max(512 * 1024 * 1024),
      })
      .strict(),
    licence: z.string().regex(/^[A-Za-z0-9.+-]+(?: (?:AND|OR) [A-Za-z0-9.+-]+)*$/),
    licenceUrl: z.string().url().nullable(),
    maintainer: text,
    permissions: z.record(z.string(), text),
    platforms: z.array(text).default([]),
    wheels: z.array(text),
    nativeCode: z.boolean(),
    needsAccount: z.boolean(),
    headless: z.object({ status: z.enum(["yes", "partial", "no"]), note: text }).strict(),
    deterministic: text,
    purpose: text,
    useWith: z.array(text),
    status: z.enum(["proposed", "approved", "rejected"]),
    consent: consent.optional(),
    downloadConsent: consent.optional(),
    evaluation: z.string().regex(/^docs\/blender-arsenal\/[A-Za-z][A-Za-z0-9_-]*\.md$/),
    usage: z.enum(["authoring", "render"]).optional(),
    recommendation: z.enum(["adopt", "maybe", "reject"]).optional(),
    notes: text.optional(),
    addedBy: text,
    verified: date.nullable(),
    reason: text.optional(),
    capabilities: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.status === "approved" && !entry.consent)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Approved extensions need consent" });
    if (entry.status === "rejected" && !entry.reason)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Rejected extensions need a reason" });
    if (
      entry.status === "approved" &&
      ("network" in entry.permissions || entry.needsAccount) &&
      !entry.consent?.allowNetworkAccount
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Network/account extensions need explicit approval" });
  });
export const ExtensionsManifestSchema = z
  .object({ note: text, extensions: z.array(ExtensionEntrySchema) })
  .strict()
  .superRefine((manifest, ctx) => {
    if (new Set(manifest.extensions.map((entry) => entry.id)).size !== manifest.extensions.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate extension ids" });
  });
export type ExtensionEntry = z.infer<typeof ExtensionEntrySchema>;
export const InstalledExtensionsSchema = z
  .object({
    extensions: z.array(
      z
        .object({
          id: ExtensionIdSchema,
          version,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          treeSha256: z.string().regex(/^[a-f0-9]{64}$/),
          installedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();
export const ExtensionInspectionSchema = z
  .object({
    id: ExtensionIdSchema,
    name: text,
    version,
    maintainer: text,
    licence: z.array(z.string().regex(/^SPDX:[A-Za-z0-9.+-]+$/)).min(1),
    blenderMin: version,
    blenderMax: version.nullable(),
    permissions: z.record(z.string(), text),
    wheels: z.array(text),
    platforms: z.array(text),
    nativeCode: z.boolean(),
    risks: z.array(text),
  })
  .strict();
export type ExtensionInspection = z.infer<typeof ExtensionInspectionSchema>;

export const ExtensionTrialSmokeSchema = z
  .object({
    enableOk: z.literal(true),
    enabled: z.array(z.object({ id: ExtensionIdSchema, version, enableMs: z.number().nonnegative() }).strict()),
    operators: z.array(text),
    nodeGroups: z.array(text),
  })
  .strict();

export const ExtensionDownloadReceiptSchema = z
  .object({
    by: text,
    date,
    note: text,
    id: ExtensionIdSchema,
    url: z.string().url(),
  })
  .strict();
