import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DependencyLicenceReviewsSchema,
  type DependencyLicenceReviews,
  type PackageLicenceReview,
} from "../../types/dependency-licences";
import { parseYaml } from "./yaml";

export const LICENCE_REVIEW_FILE = "contrib/licence-reviews.json";
export const LICENCE_REVIEW_REPORT = "docs/dependency-licence-review.md";
export type LicenceScope = "package-policy" | "repository-source";
export const licenceHash = (text: string) => createHash("sha256").update(text).digest("hex");

export function readLicenceReviews(root: string): DependencyLicenceReviews | undefined {
  const file = path.join(root, LICENCE_REVIEW_FILE);
  if (!existsSync(file)) return undefined;
  if (!lstatSync(file).isFile()) throw new Error("Licence review ledger must be a regular file");
  const ledger = DependencyLicenceReviewsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  for (const [sha256, text] of Object.entries(ledger.texts))
    if (!text.trim() || licenceHash(text) !== sha256) throw new Error("Corrupt licence review text dictionary");
  if (ledger.packages.length < ledger.baselinePackages) throw new Error("Licence review ledger lost baseline packages");
  const identities = new Set<string>();
  for (const item of ledger.packages) {
    const key = `${item.name}@${item.version}`;
    if (identities.has(key)) throw new Error(`Duplicate licence review: ${key}`);
    identities.add(key);
    for (const ref of [...item.references, ...item.metadata.files]) {
      const text = ledger.texts[ref.sha256];
      if (!text?.trim() || licenceHash(text) !== ref.sha256)
        throw new Error(`Missing or corrupt review evidence: ${key}`);
    }
  }
  if (
    ledger.baselinePackages !== ledger.baselineIdentities.length ||
    new Set(ledger.baselineIdentities).size !== ledger.baselinePackages ||
    ledger.baselineIdentities.some((key) => !identities.has(key))
  )
    throw new Error("Licence review ledger lost a baseline identity");
  return ledger;
}

export function matchingLicenceReview(
  ledger: DependencyLicenceReviews | undefined,
  item: { name: string; version: string; lockHash: string; integrity?: string },
  declaration?: string | null,
  observedEvidenceSha256?: string,
  packageJsonSha256?: string,
): PackageLicenceReview | undefined {
  const review = ledger?.packages.find((review) => review.name === item.name && review.version === item.version);
  if (!review) return undefined;
  if (
    review.lockHash !== item.lockHash ||
    item.integrity !== review.integrity ||
    (declaration !== undefined && declaration !== review.declaration) ||
    (observedEvidenceSha256 !== undefined && observedEvidenceSha256 !== review.observedEvidenceSha256) ||
    (packageJsonSha256 !== undefined && packageJsonSha256 !== review.packageJsonSha256)
  )
    throw new Error(`Licence review is stale for ${item.name}@${item.version}; review the changed artefact`);
  return review;
}

export function assertRepositorySourceScope(root: string): void {
  const result = spawnSync("git", ["ls-files", "-z", "--", "node_modules"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || result.error) throw new Error("Cannot verify repository source distribution scope");
  if (result.stdout.trim()) throw new Error("Repository-source licence review does not cover vendored node_modules");
  for (const file of ["package.json", "pnpm-workspace.yaml"]) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, "utf8");
    const config = (file.endsWith(".json") ? JSON.parse(text) : parseYaml(text)) as {
      patchedDependencies?: unknown;
      pnpm?: { patchedDependencies?: unknown };
    } | null;
    const patches = config?.patchedDependencies ?? config?.pnpm?.patchedDependencies;
    if (
      patches !== undefined &&
      (!patches || typeof patches !== "object" || Array.isArray(patches) || Object.keys(patches).length)
    )
      throw new Error("Repository-source review requires a separate assessment for patched dependencies");
  }
}

export function licenceReviewDocument(ledger: DependencyLicenceReviews): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
  const evidenceHref = (file: string) =>
    /^[a-z][\w+.-]*:/i.test(file) ? file : path.posix.relative(path.posix.dirname(LICENCE_REVIEW_REPORT), file);
  return [
    "# Dependency licence review",
    "",
    "Generated from `contrib/licence-reviews.json` by `pnpm deps:licences --write`. Do not edit by hand.",
    "",
    `Reviewed ${ledger.packages.length} exact package/version identities from the ${ledger.baselinePackages} original findings on ${ledger.reviewedAt}. Archives were verified against the lockfile integrity; source evidence is retained with SHA-256 hashes.`,
    "",
    "Scope: this repository's own source, manifests and collected notices, distributed under the Business Source License 1.1 (BUSL-1.1) and the Licensor's commercial licence. The verdicts are an evidence-based technical review, not a rightsholder waiver, a lawyer's opinion or a licence for downstream distributions.",
    "",
    "## Scope and remaining obligations",
    "",
    ...ledger.limitations.map((text) => `- ${text}`),
    "",
    ...(ledger.packages.some((item) => item.runtimeAuthorisation)
      ? [
          "Runtime authorisations are separate, explicit owner decisions on the exact archive-bound package record. They apply only to the stated unmodified integration and selected licence; source-only technical reviews do not grant runtime or redistribution approval.",
          "",
        ]
      : []),
    "## Exact-version decisions",
    "",
    "| Package | Declared licence | Reviewed terms | Decision | Rationale and obligations | Evidence |",
    "|---|---|---|---|---|---|",
    ...ledger.packages.map(
      (item) =>
        `| ${cell(`${item.name}@${item.version}`)} | ${cell(item.declaration ?? "Not declared")} | ${cell(item.selectedLicence)} | ${item.decision} | ${cell(item.rationale)} ${cell(item.obligations.join(" "))}${item.runtimeAuthorisation ? ` Owner runtime authorisation: ${cell(item.runtimeAuthorisation.selectedLicence)}, ${cell(item.runtimeAuthorisation.integration)}; [evidence](${evidenceHref(item.runtimeAuthorisation.evidence)}).` : ""} | ${item.references.map((ref, i) => `[${i + 1}](${ref.url})`).join(", ")} |`,
    ),
    "",
  ].join("\n");
}
