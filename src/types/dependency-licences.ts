import { z } from "zod";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Reference = z
  .object({
    url: z.string().url().startsWith("https://"),
    sha256: Sha256,
    role: z.enum(["licence", "notice", "documentation"]),
  })
  .strict();
export const PackageLicenceReviewSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    lockHash: Sha256,
    integrity: z.string().regex(/^(?:sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$/),
    tarballUrl: z.string().url().startsWith("https://registry.npmjs.org/"),
    archiveBytes: z.number().int().positive(),
    packageJsonSha256: Sha256,
    observedEvidenceSha256: Sha256,
    declaration: z.string().nullable(),
    selectedLicence: z.string().min(1),
    runtimeAuthorisation: z
      .object({
        source: z.literal("owner-explicit-session"),
        integration: z.literal("unmodified-separate-package"),
        selectedLicence: z.string().min(1),
        evidence: z.string().min(1),
      })
      .strict()
      .optional(),
    decision: z.enum(["supported", "conditional", "blocked"]),
    rationale: z.string().min(20),
    obligations: z.array(z.string().min(1)).min(1),
    references: z.array(Reference).min(1),
    metadata: z
      .object({
        repository: z.unknown(),
        author: z.unknown(),
        scripts: z.record(z.string(), z.string()),
        files: z.array(z.object({ file: z.string().min(1), sha256: Sha256 }).strict()),
      })
      .strict(),
  })
  .strict();

export const DependencyLicenceReviewsSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal("repository-source"),
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reviewer: z.literal("Codex: user-requested technical review"),
    baselineCommit: z.string().regex(/^[a-f0-9]{40}$/),
    baselineInventorySha256: Sha256,
    baselinePackages: z.number().int().positive(),
    baselineIdentities: z.array(z.string().min(1)).min(1),
    limitations: z.array(z.string().min(1)).min(1),
    texts: z.record(Sha256, z.string().min(1)),
    packages: z.array(PackageLicenceReviewSchema),
  })
  .strict();

export type PackageLicenceReview = z.infer<typeof PackageLicenceReviewSchema>;
export type DependencyLicenceReviews = z.infer<typeof DependencyLicenceReviewsSchema>;
