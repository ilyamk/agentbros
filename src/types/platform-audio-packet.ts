import { z } from "zod";
import { DeliveryManifestSchema } from "./delivery";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const packetName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((v) => !v.includes("..") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v));
export const PacketFileSchema = z
  .object({
    file: packetName,
    sha256: hash,
    bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
  })
  .strict();
export const PlatformAudioPacketSchema = z
  .object({
    version: z.literal(1),
    id: hash,
    projectId: z
      .string()
      .max(160)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    state: z.literal("draft-needs-review"),
    productionReady: z.literal(false),
    status: z.literal("pending-manual"),
    basisSha256: hash,
    checkReport: z
      .object({
        file: z
          .string()
          .min(1)
          .max(240)
          .refine(
            (v) => !v.startsWith("/") && !v.includes("\\") && !v.split("/").some((p) => ["", ".", ".."].includes(p)),
          ),
        sha256: hash,
      })
      .strict(),
    manifest: DeliveryManifestSchema,
    files: z.array(PacketFileSchema).min(1).max(26),
    provenance: z.literal(
      "Local correspondence only; supplied reviews are declarations; platform placement, account access and legal permission remain unverified",
    ),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.id !== v.basisSha256 ||
      v.manifest.projectId !== v.projectId ||
      v.manifest.state !== "draft-needs-review" ||
      v.manifest.findings.some((x) => x.severity === "error") ||
      v.manifest.platformAudioPlacement?.localStatus !== "ready-for-manual-placement"
    )
      c.addIssue({ code: "custom", message: "Packet must bind a blocker-free native draft" });
    if (
      new Set(v.files.map((f) => f.file.toLowerCase())).size !== v.files.length ||
      v.files.some((f) => ["handoff.json", "checksums.json"].includes(f.file.toLowerCase()))
    )
      c.addIssue({ code: "custom", message: "Ambiguous/reserved packet filenames" });
  });
export type PlatformAudioPacket = z.infer<typeof PlatformAudioPacketSchema>;
