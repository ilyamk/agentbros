import { z } from "zod";
import { RealtimeDeriveSchema } from "./editor";
export const LocalChannelIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const seq = z.number().int().min(0).max(255);
const base = {
  version: z.literal(1),
  localSessionId: LocalChannelIdSchema,
  editorId: LocalChannelIdSchema,
  messageId: LocalChannelIdSchema,
  expectedSequence: seq,
};
const revisionId = LocalChannelIdSchema;
export const LocalEditorMessageSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("status") }).strict(),
  z.object({ ...base, action: z.literal("derive"), patch: RealtimeDeriveSchema }).strict(),
  z.object({ ...base, action: z.literal("queue"), revisionId }).strict(),
  z.object({ ...base, action: z.literal("handoff") }).strict(),
  z.object({ ...base, action: z.literal("cancel") }).strict(),
  z.object({ ...base, action: z.literal("recover") }).strict(),
  z.object({ ...base, action: z.literal("complete"), revisionId, manifest: z.string().min(1).max(1024) }).strict(),
  z.object({ ...base, action: z.literal("select"), revisionId }).strict(),
  z
    .object({
      ...base,
      action: z.literal("reconcile"),
      targetLocalSessionId: LocalChannelIdSchema.optional(),
      pendingMessageId: LocalChannelIdSchema,
      intentSha256: hash,
      currentStateSha256: hash,
      acknowledge: z.literal("unknown-local-outcome-no-replay"),
    })
    .strict(),
]);
export type LocalEditorMessage = z.infer<typeof LocalEditorMessageSchema>;
export const LocalEditorLimitsSchema = z
  .object({
    maxCommands: z.number().int().min(1).max(64),
    maxMessageBytes: z.number().int().min(1).max(16384),
    maxReplyBytes: z.number().int().min(1024).max(65536),
    maxSidecarBytes: z
      .number()
      .int()
      .min(131072)
      .max(8 * 1024 * 1024),
    maxReceivedBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
    totalMs: z.number().int().min(50).max(120000),
    idleMs: z.number().int().min(10).max(15000),
    settleMs: z.number().int().min(10).max(2000),
  })
  .strict();
export const DEFAULT_LOCAL_EDITOR_LIMITS = Object.freeze({
  maxCommands: 64,
  maxMessageBytes: 16384,
  maxReplyBytes: 65536,
  maxSidecarBytes: 8 * 1024 * 1024,
  maxReceivedBytes: 1024 * 1024,
  totalMs: 120000,
  idleMs: 15000,
  settleMs: 2000,
});
export const ChannelFilePinSchema = z
  .object({
    path: z.string().min(1).max(2048),
    sha256: hash,
    byteLength: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
  })
  .strict();
const summary = z
  .object({
    sequence: seq,
    stateSha256: hash,
    committedPlanningUsd: z.number().finite().nonnegative(),
    ceilingUsd: z.number().finite().positive(),
    queued: revisionId.optional(),
    inFlight: revisionId.optional(),
    selected: revisionId.optional(),
  })
  .strict();
export const LocalEditorReplySchema = z
  .object({
    version: z.literal(1),
    localSessionId: LocalChannelIdSchema,
    editorId: LocalChannelIdSchema,
    messageId: LocalChannelIdSchema.optional(),
    messageSha256: hash.optional(),
    action: z.string().max(32).optional(),
    outcome: z.enum(["ok", "conflict", "refused", "uncertain"]),
    reason: z.string().max(512).optional(),
    expectedSequence: seq.optional(),
    resultingSequence: seq.optional(),
    stateSha256: hash.optional(),
    current: summary,
    unresolvedCount: z.number().int().min(0).max(2048).optional(),
    unresolvedTruncated: z.boolean().optional(),
    unresolved: z
      .array(
        z
          .object({
            localSessionId: LocalChannelIdSchema.optional(),
            messageId: LocalChannelIdSchema,
            intentSha256: hash,
          })
          .strict(),
      )
      .max(64),
    association: z
      .object({
        revisionId,
        requestSha256: hash,
        inputHash: hash,
        sessionId: LocalChannelIdSchema,
        manifestSha256: hash.optional(),
      })
      .strict()
      .optional(),
    historical: z.boolean(),
    providerAck: z.literal(false),
    providerPersistent: z.literal(false),
    liveVerified: z.literal(false),
  })
  .strict();
export type LocalEditorReply = z.infer<typeof LocalEditorReplySchema>;
