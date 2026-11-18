import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CliErrorObject } from "../cli";
import {
  addedPackages,
  installedPackageFile,
  licenceStatus,
  lockfilePackages,
  type LicencePolicy,
} from "./dependencies";
import {
  assertRepositorySourceScope,
  licenceHash,
  licenceReviewDocument,
  LICENCE_REVIEW_FILE,
  LICENCE_REVIEW_REPORT,
  matchingLicenceReview,
  readLicenceReviews,
  type LicenceScope,
} from "./licence-review";
import type { PackageLicenceReview } from "../../types/dependency-licences";

const SNAPSHOT = "DEPENDENCY_LICENCES.json";
const DOCUMENT = "DEPENDENCY_LICENCES.md";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const serialise = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
type Evidence = { file: string; sha256: string };
type PackageEvidence = {
  declaration: string | null;
  repository: unknown;
  author: unknown;
  files: Evidence[];
};
type PackageRecord = {
  name: string;
  version: string;
  lockHash: string;
  evidence: PackageEvidence | null;
  status: string;
  evidenceOrigin?: "reviewed-archive";
  review?: Pick<PackageLicenceReview, "decision" | "selectedLicence" | "rationale" | "obligations" | "references">;
};
type Source = Evidence & { kind: "credit" | "notice" | "provenance"; content: string };
type Inventory = {
  version: 1;
  scope: string;
  lockfileSha256: string;
  policySha256: string;
  packages: PackageRecord[];
  sources: Source[];
  texts: Record<string, string>;
  reviewSha256?: string;
  reviewScope?: "repository-source";
};

function collectPackage(file: string, texts: Record<string, string>): PackageEvidence {
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { license?: unknown; repository?: unknown; author?: unknown };
  const root = path.dirname(file);
  const files: Evidence[] = [];
  const read = (relative: string) => {
    const text = readFileSync(path.join(root, relative), "utf8");
    const sha256 = digest(text);
    texts[sha256] = text;
    files.push({ file: relative, sha256 });
  };
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isFile() && /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(entry.name)) read(entry.name);
    if (entry.isDirectory() && /^(licen[cs]es?|legal)$/i.test(entry.name)) {
      for (const child of readdirSync(path.join(root, entry.name), { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      )) {
        if (child.isFile()) read(`${entry.name}/${child.name}`);
      }
    }
  }
  return {
    declaration: typeof pkg.license === "string" ? pkg.license : null,
    repository: pkg.repository ?? null,
    author: pkg.author ?? null,
    files,
  };
}

function sourceFiles(root: string): string[] {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0 || result.error) throw new Error("Cannot enumerate licence evidence from git");
  return result.stdout
    .split("\0")
    .filter(
      (file) =>
        /^credits\/[^/]+\.json$/.test(file) ||
        file.startsWith("tests/fixtures/hyperframes-engine/notices/") ||
        ["NOTICE.md", "COMMERCIAL-LICENSE.md", "skills-lock.json", ".agents/skills/THIRD_PARTY.md"].includes(file) ||
        (/^(vendor\/|\.agents\/skills\/|docs\/reference\/|tests\/fixtures\/hyperframes-engine\/notices\/)/.test(file) &&
          /(^|\/)(licen[cs]e|copying|notice|copyright|provenance)([._/-]|$)/i.test(file)),
    )
    .sort();
}

export function buildLicenceInventory(root: string, refresh: boolean): Inventory {
  const docs = lstatSync(path.join(root, "docs"), { throwIfNoEntry: false });
  if (docs && !docs.isDirectory()) throw new Error("Licence review report directory must be a real directory");
  for (const file of [SNAPSHOT, DOCUMENT, LICENCE_REVIEW_REPORT]) {
    const stat = lstatSync(path.join(root, file), { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error(`${file} must be a regular file`);
  }
  const previous = existsSync(path.join(root, SNAPSHOT))
    ? (JSON.parse(readFileSync(path.join(root, SNAPSHOT), "utf8")) as Inventory)
    : undefined;
  if (previous && previous.version !== 1) throw new Error("Unsupported dependency licence inventory version");
  const old = new Map(previous?.packages.map((item) => [`${item.name}@${item.version}`, item]) ?? []);
  const texts: Record<string, string> = {};
  const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  const entries = lockfilePackages(lock);
  const policyText = readFileSync(path.join(root, "contrib/licence-allowlist.json"), "utf8");
  const policy = JSON.parse(policyText) as LicencePolicy;
  const ledger = readLicenceReviews(root);
  const store = path.join(root, "node_modules/.pnpm");
  const dirs = existsSync(store) ? readdirSync(store).sort() : [];
  const packages = addedPackages("", lock)
    .map((item) => {
      const key = `${item.name}@${item.version}`;
      const lockEntry = Object.entries(entries).find(([name]) => name.replace(/^\//, "").split("(")[0] === key);
      const lockHash = digest(serialise(lockEntry?.[1]));
      const integrity = (lockEntry?.[1] as { resolution?: { integrity?: string } } | undefined)?.resolution?.integrity;
      const review = matchingLicenceReview(ledger, { ...item, lockHash, integrity });
      const saved = old.get(key);
      const reusable = saved?.lockHash === lockHash ? saved.evidence : null;
      const file = installedPackageFile(root, item, dirs);
      let evidence = reusable ?? null;
      let evidenceOrigin = saved?.evidenceOrigin;
      if (file && (refresh || reusable || review)) {
        const actual = collectPackage(file, texts);
        if (!refresh && reusable && serialise(actual) !== serialise(reusable))
          throw new Error(`Installed licence evidence changed for ${key}; run pnpm deps:licences --write and review`);
        evidence = actual;
      }
      if (!evidence && review) {
        evidence = {
          declaration: review.declaration,
          repository: review.metadata.repository,
          author: review.metadata.author,
          files: review.metadata.files,
        };
        evidenceOrigin = "reviewed-archive";
      }
      if (review && evidence)
        matchingLicenceReview(
          ledger,
          { ...item, lockHash, integrity },
          evidence.declaration,
          licenceHash(serialise(evidence)),
          file ? licenceHash(readFileSync(file, "utf8")) : undefined,
        );
      if (evidence)
        for (const notice of evidence.files) {
          const text = texts[notice.sha256] ?? previous?.texts[notice.sha256] ?? ledger?.texts[notice.sha256];
          if (text === undefined || digest(text) !== notice.sha256)
            throw new Error(`Missing or corrupt licence text for ${key}: ${notice.file}`);
          texts[notice.sha256] = text;
        }
      if (review) for (const ref of review.references) texts[ref.sha256] = ledger!.texts[ref.sha256]!;
      return {
        ...item,
        lockHash,
        evidence,
        status: evidence ? licenceStatus(evidence.declaration, policy) : "missing",
        ...(evidenceOrigin ? { evidenceOrigin } : {}),
        ...(review
          ? {
              review: {
                decision: review.decision,
                selectedLicence: review.selectedLicence,
                rationale: review.rationale,
                obligations: review.obligations,
                references: review.references,
                ...(review.runtimeAuthorisation ? { runtimeAuthorisation: review.runtimeAuthorisation } : {}),
              },
            }
          : {}),
      };
    })
    .sort((a, b) => (`${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1));
  const sources = sourceFiles(root).map((file) => {
    if (!lstatSync(path.join(root, file)).isFile()) throw new Error(`Licence evidence must be a regular file: ${file}`);
    const content = readFileSync(path.join(root, file), "utf8");
    return {
      file,
      sha256: digest(content),
      kind: file.startsWith("credits/")
        ? ("credit" as const)
        : file.endsWith("provenance.json")
          ? ("provenance" as const)
          : ("notice" as const),
      content,
    };
  });
  return {
    version: 1,
    scope:
      "All pnpm lockfile identities (production, development, optional and package manager); declared external integrations and vendored notices. Policy status is not legal clearance.",
    lockfileSha256: digest(lock),
    policySha256: digest(policyText),
    packages,
    sources,
    texts: Object.fromEntries(Object.entries(texts).sort(([a], [b]) => (a < b ? -1 : 1))),
    ...(ledger
      ? {
          reviewSha256: licenceHash(readFileSync(path.join(root, LICENCE_REVIEW_FILE), "utf8")),
          reviewScope: ledger.scope,
        }
      : {}),
  };
}

function markdown(inventory: Inventory): string {
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
  const rows = inventory.packages.map(
    (pkg) =>
      `| ${cell(pkg.name)} | ${cell(pkg.version)} | ${cell(pkg.evidence?.declaration ?? "Unknown")} | ${pkg.status} | ${pkg.evidence?.files.length ?? 0} | ${pkg.review?.decision ?? "Automatic policy"} |`,
  );
  const credits = inventory.sources
    .filter((source) => source.kind === "credit")
    .map((source) => {
      const record = JSON.parse(source.content) as Record<string, string>;
      return `| ${cell(record.source ?? record.tool ?? record.asset ?? record.reference ?? source.file)} | ${cell(record.licence ?? record.rights ?? "See source record; terms not normalised")} | ${cell(record.whatWeTook ?? record.role ?? record.analysedFor ?? "See source record")} | [Record](${source.file}) |`;
    });
  return [
    "# Dependency licences",
    "",
    "Generated by `pnpm deps:licences --write`. Do not edit by hand.",
    "",
    "[Machine-readable inventory](DEPENDENCY_LICENCES.json) contains exact versions, lock-entry fingerprints, declared licences, authors, repositories, collected licence/notice texts (deduplicated by SHA-256), and existing integration evidence.",
    "",
    "`allowed` means the configured package policy accepts a licence option. It does not certify compatibility, fulfil notice/source obligations, or grant any right in a dependency. `review`, `refused`, `missing` and zero notice files need investigation. External records below are declarations, not approvals. See [the review procedure](docs/dependency-licences.md).",
    "",
    "## Locked packages",
    "",
    "Includes production, development, optional/platform packages and the package manager. Missing platform metadata is recorded explicitly; no licence is inferred from a sibling package.",
    "",
    ...(inventory.reviewSha256
      ? [
          "[Exact-version review](docs/dependency-licence-review.md) assesses the original 205 findings for repository-source distribution. It retains original declarations, conditions and exclusions; it does not approve binary or browser-bundle redistribution.",
          "",
        ]
      : []),
    "| Package | Version | Declared licence | Policy | Notice files | Source review |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Declared integrations, repositories, tools and assets",
    "",
    "Imported from `credits/*.json`, including inspiration and assets. Model weights, application licences and service terms may differ from the code licence. These records require review of their stated usage; Python/application dependencies are not automatically resolved by the pnpm scan.",
    "",
    "| Source | Declared terms | Usage | Evidence |",
    "|---|---|---|---|",
    ...credits,
    "",
    "## Vendored notices and provenance",
    "",
    ...inventory.sources
      .filter((source) => source.kind !== "credit")
      .map((source) => `- [${source.file}](${source.file}) — SHA-256 \`${source.sha256}\``),
    "",
  ].join("\n");
}

export function writeLicenceInventory(
  root: string,
  check: boolean,
  strict = false,
  scope: LicenceScope = "package-policy",
) {
  const inventory = buildLicenceInventory(root, !check);
  const ledger = readLicenceReviews(root);
  if (scope === "repository-source") {
    if (!ledger) throw new Error("Repository-source scope requires a licence review ledger");
    assertRepositorySourceScope(root);
  }
  const outputs: Record<string, string> = {
    [SNAPSHOT]: serialise(inventory),
    [DOCUMENT]: markdown(inventory),
    ...(ledger ? { [LICENCE_REVIEW_REPORT]: licenceReviewDocument(ledger) } : {}),
  };
  for (const [file, content] of Object.entries(outputs)) {
    if (check) {
      if (!existsSync(path.join(root, file)) || readFileSync(path.join(root, file), "utf8") !== content)
        throw new Error(`${file} is stale; run pnpm deps:licences --write and review the diff`);
    } else {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    }
  }
  const unresolved = inventory.packages
    .filter((pkg) => {
      if (scope === "repository-source" && pkg.review) return pkg.review.decision === "blocked";
      return pkg.status !== "allowed" || !pkg.evidence?.files.some((file) => inventory.texts[file.sha256]?.trim());
    })
    .map((pkg) => `${pkg.name}@${pkg.version}`);
  const metadata = {
    packages: inventory.packages.length,
    evidenceSources: inventory.sources.length,
    texts: Object.keys(inventory.texts).length,
    unresolvedPackages: unresolved.length,
    reviewedPackages: inventory.packages.filter((pkg) => pkg.review).length,
    scope,
    checked: check,
    legalClearance: false,
  };
  if (strict && unresolved.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Package licence review is incomplete; inventory generation does not approve dependencies.",
      details: { ...metadata, unresolved },
    });
  return metadata;
}
