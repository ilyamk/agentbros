import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CliErrorObject } from "../cli";
import { parseYaml } from "./yaml";
import { assertRepositorySourceScope, licenceHash, matchingLicenceReview, readLicenceReviews } from "./licence-review";

export function lockfilePackages(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const document of text.split(/^---[ \t]*$/m).filter((part) => part.trim())) {
    const value = (parseYaml(document) as { packages?: Record<string, unknown> } | null)?.packages ?? {};
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid lockfile packages");
    for (const [key, metadata] of Object.entries(value)) {
      if (Object.hasOwn(result, key)) throw new Error(`Duplicate lockfile package identity: ${key}`);
      result[key] = metadata;
    }
  }
  return result;
}
export function addedPackages(before: string, after: string): { name: string; version: string }[] {
  const old = lockfilePackages(before);
  return Object.keys(lockfilePackages(after))
    .filter((key) => !Object.hasOwn(old, key))
    .map((key) => {
      const match = /^\/?(@[^/]+\/[^@]+|[^/@]+)@([^()]+)(?:\(.*\))?$/.exec(key);
      if (!match) throw new Error(`Unsupported lockfile package identity: ${key}`);
      return { name: match[1]!, version: match[2]! };
    });
}
export type DependencyCheck = {
  name: string;
  version: string;
  licence: string | null;
  status: "allowed" | "review" | "refused" | "missing";
  scripts: Record<string, string>;
  review?: { scope: "repository-source"; decision: string; selectedLicence: string; obligations: string[] };
  metadataSource?: "reviewed-archive";
};
export type LicencePolicy = { allowed: string[]; review: string[] };

/** Evaluate the policy's SPDX subset; exceptions and non-SPDX declarations fail closed. */
export function licenceStatus(licence: string | null, policy: LicencePolicy): DependencyCheck["status"] {
  if (!licence) return "refused";
  if (policy.allowed.includes(licence)) return "allowed";
  if (policy.review.includes(licence)) return "review";
  const tokens = licence.match(/[A-Za-z0-9.+-]+|[()]/g) ?? [];
  if (tokens.join("") !== licence.replace(/\s/g, "")) return "refused";
  let position = 0;
  type Status = DependencyCheck["status"];
  const rank: Record<Status, number> = { allowed: 0, review: 1, refused: 2, missing: 3 };
  const atom = (): Status => {
    const token = tokens[position++];
    if (token === "(") {
      const result = expression();
      if (tokens[position++] !== ")") throw new Error("Unclosed licence expression");
      return result;
    }
    if (!token || ["AND", "OR", "WITH", ")"].includes(token)) throw new Error("Invalid licence expression");
    return policy.allowed.includes(token) ? "allowed" : policy.review.includes(token) ? "review" : "refused";
  };
  const conjunction = (): Status => {
    let result = atom();
    while (tokens[position] === "AND") {
      position++;
      const next = atom();
      if (rank[next] > rank[result]) result = next;
    }
    return result;
  };
  const expression = (): Status => {
    let result = conjunction();
    while (tokens[position] === "OR") {
      position++;
      const next = conjunction();
      if (rank[next] < rank[result]) result = next;
    }
    return result;
  };
  try {
    const result = expression();
    return position === tokens.length ? result : "refused";
  } catch {
    return "refused";
  }
}

export function installedPackageFile(
  root: string,
  item: { name: string; version: string },
  dirs?: string[],
): string | undefined {
  const store = path.join(root, "node_modules/.pnpm");
  const candidates = [
    path.join(root, "node_modules", item.name, "package.json"),
    ...(dirs ?? (existsSync(store) ? readdirSync(store) : [])).map((dir) =>
      path.join(store, dir, "node_modules", item.name, "package.json"),
    ),
  ];
  return candidates.find((file) => {
    if (!existsSync(file)) return false;
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { name: string; version: string };
    return pkg.name === item.name && pkg.version === item.version;
  });
}
export function inspectDependencies(root: string, added: { name: string; version: string }[]): DependencyCheck[] {
  const policy = JSON.parse(readFileSync(path.join(root, "contrib/licence-allowlist.json"), "utf8")) as LicencePolicy;
  const ledger = readLicenceReviews(root);
  if (ledger) assertRepositorySourceScope(root);
  const entries = ledger ? lockfilePackages(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")) : {};
  const store = path.join(root, "node_modules/.pnpm");
  const dirs = existsSync(store) ? readdirSync(store) : [];
  return added.map((item) => {
    const file = installedPackageFile(root, item, dirs);
    const entry = Object.entries(entries).find(
      ([name]) => name.replace(/^\//, "").split("(")[0] === `${item.name}@${item.version}`,
    )?.[1];
    const identity = {
      ...item,
      lockHash: licenceHash(`${JSON.stringify(entry, null, 2)}\n`),
      integrity: (entry as { resolution?: { integrity?: string } } | undefined)?.resolution?.integrity,
    };
    const review = matchingLicenceReview(ledger, identity);
    const reviewed = review
      ? {
          scope: "repository-source" as const,
          decision: review.decision,
          selectedLicence: review.selectedLicence,
          obligations: review.obligations,
          ...(review.runtimeAuthorisation ? { runtimeAuthorisation: review.runtimeAuthorisation } : {}),
        }
      : undefined;
    if (file) {
      const raw = readFileSync(file, "utf8");
      const pkg = JSON.parse(raw) as {
        name: string;
        version: string;
        license?: unknown;
        scripts?: Record<string, string>;
      };
      const licence = typeof pkg.license === "string" ? pkg.license : null;
      if (review) matchingLicenceReview(ledger, identity, licence, undefined, licenceHash(raw));
      const status = review ? (review.decision === "blocked" ? "review" : "allowed") : licenceStatus(licence, policy);
      return {
        ...item,
        licence,
        status,
        scripts: Object.fromEntries(
          Object.entries(pkg.scripts ?? {}).filter(([name]) =>
            ["preinstall", "install", "postinstall", "prepare"].includes(name),
          ),
        ),
        ...(reviewed ? { review: reviewed } : {}),
      };
    }
    if (review)
      return {
        ...item,
        licence: review.declaration,
        status: review.decision === "blocked" ? "review" : "allowed",
        scripts: review.metadata.scripts,
        review: reviewed,
        metadataSource: "reviewed-archive",
      };
    return { ...item, licence: null, status: "missing", scripts: {} };
  });
}
export function checkDependencies(
  root: string,
  base: string,
  run: (bin: string, args: string[]) => { status: number | null; stdout: string; error?: Error } = (
    bin: string,
    args: string[],
  ) => spawnSync(bin, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
) {
  const git = (args: string[]) => {
    const result = run("git", args);
    if (result.status !== 0 || result.error) throw new Error("Cannot read dependency diff from git");
    return result.stdout;
  };
  const ref = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
  const changed = git(["diff", "--name-only", ref, "--", "package.json", "pnpm-lock.yaml"]).trim();
  if (!changed) return { changed: false, packages: [], audit: "not-needed" };
  const before = git(["show", `${ref}:pnpm-lock.yaml`]);
  const packages = inspectDependencies(
    root,
    addedPackages(before, readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")),
  );
  const audit = run("pnpm", ["audit", "--prod", "--audit-level", "high"]);
  const report = { changed: true, packages, audit: audit.status === 0 && !audit.error ? "passed" : "failed" };
  if (report.audit !== "passed" || packages.some((pkg) => pkg.status !== "allowed"))
    throw new CliErrorObject({
      code: "VALIDATION",
      message:
        "Dependency gate failed: high vulnerabilities, unapproved licences or missing installed metadata require review.",
      details: report,
    });
  return report;
}
