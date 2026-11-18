import { z } from "zod";
import releaseJson from "../../../contrib/release.json";
import {
  TIER_LIMITS,
  ReleaseRouteSchema,
  TrustTierSchema,
  type CategoriesFile,
  type ChangeEntry,
  type PrBlock,
  type Size,
  type TrustTier,
} from "../../types/contrib";
import { categoriesForPaths, DEFAULT_CATEGORIES, DEFAULT_PROTECTED, matchesPath } from "./categories";
import { parseChangeEntry } from "./changes";
import { parsePrBlock } from "./pr-block";

export type ChangedFile = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  status: string;
  content?: string;
  previousContent?: string;
  previousPath?: string;
  patch?: string;
};
export type Finding = { gate: "G0" | "G1"; rule: string; severity: "block" | "warn"; message: string };
export type IntakeInput = {
  prBody: string;
  changedFiles: ChangedFile[];
  authorTier: TrustTier;
  cla: boolean;
  openPrCount: number;
  labels: string[];
  release?: { authorLogin: string; headBranch: string; headRepo: string; baseRepo: string; config?: unknown };
};
export const IntakeContextSchema = z
  .object({
    cla: z.boolean().default(false),
    openPrCount: z.number().int().nonnegative().default(1),
    labels: z.array(z.string()).default([]),
    tier: TrustTierSchema.default(0),
  })
  .strict();
export const sizeClass = (lines: number): Size => (lines <= 300 ? "S" : lines <= 1000 ? "M" : "L");
const sizes: Size[] = ["S", "M", "L"];
const generated = ["docs/library/catalogue.json", "docs/film-types.md", "CREDITS.md"];
/** Generated files, plus the per-type pages `film:route --write-doc` writes beside docs/film-types.md. */
const isGenerated = (file: string): boolean => generated.includes(file) || /^docs\/film-types\/[a-z-]+\.md$/.test(file);
const media =
  /\.(?:png|jpe?g|gif|webp|avif|heic|ico|tiff?|bmp|mp4|mov|mkv|webm|avi|m4v|mp3|wav|aac|flac|ogg|m4a|aiff?|woff2?|ttf|otf|glb|gltf|blend|fbx|obj|hdr|exr|pdf|zip)$/i;
const dependenciesSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

const releaseConfig = ReleaseRouteSchema.parse(releaseJson);
function completePatch(file: ChangedFile): boolean {
  if (file.patch === undefined) return false;
  const lines = file.patch.split("\n");
  return (
    lines.filter((line) => line.startsWith("+")).length === file.additions &&
    lines.filter((line) => line.startsWith("-")).length === file.deletions
  );
}
function generatedReadme(source: string): string | undefined {
  let result = source;
  for (const name of ["metrics", "showcases"]) {
    const start = `<!-- ${name}:start -->`,
      end = `<!-- ${name}:end -->`;
    if (!result.includes(start) && !result.includes(end)) continue;
    if (
      result.split(start).length !== 2 ||
      result.split(end).length !== 2 ||
      result.indexOf(end) < result.indexOf(start)
    )
      return undefined;
    result = result.slice(0, result.indexOf(start) + start.length) + result.slice(result.indexOf(end));
  }
  return result;
}
export function isReleaseRoute(input: IntakeInput): boolean {
  const identity = input.release;
  if (!identity) return false;
  const parsed = ReleaseRouteSchema.safeParse(identity.config ?? releaseConfig);
  if (!parsed.success) return false;
  const config = parsed.data;
  if (
    !config.botLogins.includes(identity.authorLogin) ||
    identity.headBranch !== config.headBranch ||
    !identity.headRepo ||
    identity.headRepo !== identity.baseRepo ||
    !input.changedFiles.length
  )
    return false;
  return input.changedFiles.every((file) => {
    if (file.binary || file.previousPath || !["A", "M", "D"].includes(file.status)) return false;
    if (/^\.changes\/[^/]+\.md$/.test(file.path) && file.path !== ".changes/README.md") return file.status === "D";
    if (file.status === "D" || !completePatch(file)) return false;
    if (file.path === "CHANGELOG.md" || file.path === "docs/api/surface.json") return true;
    if (file.path === "package.json") {
      const changes = file.patch!.split("\n").filter((line) => /^[+-]/.test(line));
      if (
        file.status !== "M" ||
        file.additions !== 1 ||
        file.deletions !== 1 ||
        changes.some((line) => !/^[+-]\s*"version": "\d+\.\d+\.\d+",?$/.test(line))
      )
        return false;
      if (file.content === undefined || file.previousContent === undefined) return false;
      const strip = (text: string) => text.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, "$1VERSION$2");
      return strip(file.content) === strip(file.previousContent);
    }
    if (
      file.path === "README.md" &&
      file.status === "M" &&
      file.content !== undefined &&
      file.previousContent !== undefined
    ) {
      const before = generatedReadme(file.previousContent),
        after = generatedReadme(file.content);
      return before !== undefined && before === after;
    }
    return false;
  });
}

export function isModelsRefreshRoute(input: IntakeInput): boolean {
  const identity = input.release;
  if (!identity) return false;
  const parsed = ReleaseRouteSchema.safeParse(identity.config ?? releaseConfig);
  if (!parsed.success) return false;
  const config = parsed.data;
  if (
    !config.modelsRefreshHeadBranch ||
    identity.headBranch !== config.modelsRefreshHeadBranch ||
    !config.botLogins.includes(identity.authorLogin) ||
    !identity.headRepo ||
    identity.headRepo !== identity.baseRepo ||
    !input.changedFiles.length
  )
    return false;
  const allowed =
    /^(?:src\/lib\/models\/[A-Za-z0-9._/-]+\.json|src\/lib\/providers\/schemas\/[A-Za-z0-9._/-]+\.json|docs\/model-slots\.md)$/;
  return input.changedFiles.every(
    (file) =>
      allowed.test(file.path) &&
      !file.path.split("/").some((part) => [".", "..", ""].includes(part)) &&
      !file.binary &&
      ![file.patch, file.content, file.previousContent].some((text) => text?.includes("\0")) &&
      !file.previousPath &&
      ["A", "M", "D"].includes(file.status) &&
      completePatch(file),
  );
}

export const DEPENDABOT_LOGIN = "dependabot[bot]";
const dependabotPaths = /^(?:package\.json|pnpm-lock\.yaml|\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)$/;
/** Same-repository Dependabot updates to manifests, the lockfile or workflow pins: no CLA, PR block or change entry, always human review. */
export function isDependabotRoute(input: IntakeInput): boolean {
  const identity = input.release;
  if (
    !identity ||
    identity.authorLogin !== DEPENDABOT_LOGIN ||
    !identity.headBranch.startsWith("dependabot/") ||
    !identity.headRepo ||
    identity.headRepo !== identity.baseRepo ||
    !input.changedFiles.length
  )
    return false;
  return input.changedFiles.every(
    (file) =>
      dependabotPaths.test(file.path) && !file.binary && !file.previousPath && ["A", "M", "D"].includes(file.status),
  );
}

export function intake(
  input: IntakeInput,
  categories: CategoriesFile = DEFAULT_CATEGORIES,
  protectedPaths: readonly string[] = DEFAULT_PROTECTED.paths,
) {
  const findings: Finding[] = [];
  const block = (gate: Finding["gate"], rule: string, message: string) =>
    findings.push({ gate, rule, severity: "block", message });
  const limits = TIER_LIMITS[TrustTierSchema.parse(input.authorTier)];
  const paths = input.changedFiles.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]);
  const changedLines = input.changedFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const actualSize = sizeClass(changedLines);
  const protectedPathsTouched = paths.filter((file) => matchesPath(file, protectedPaths));
  const facts = {
    categoriesTouched: categoriesForPaths(paths, categories),
    protectedPathsTouched,
    changedLines,
    size: actualSize,
    releaseRoute: isReleaseRoute(input),
    modelsRefreshRoute: isModelsRefreshRoute(input),
    dependabotRoute: isDependabotRoute(input),
  };
  if (facts.modelsRefreshRoute)
    return {
      findings: (["G0", "G1"] as const).map((gate) => ({
        gate,
        rule: "models-refresh-route",
        severity: "warn" as const,
        message: "Trusted model refresh route passed; human review required.",
      })),
      facts,
    };
  if (facts.dependabotRoute)
    return {
      findings: (["G0", "G1"] as const).map((gate) => ({
        gate,
        rule: "dependabot-route",
        severity: "warn" as const,
        message: "Dependabot update route passed; dependency gate and human review required.",
      })),
      facts,
    };
  if (facts.releaseRoute)
    return {
      findings: (["G0", "G1"] as const).map((gate) => ({
        gate,
        rule: "release-route",
        severity: "warn" as const,
        message: "Trusted release route passed; human review required.",
      })),
      facts,
    };
  if (!input.cla) block("G0", "cla", "The accountable owner must sign the CLA.");
  if (limits.openPrs !== null && input.openPrCount > limits.openPrs)
    block("G0", "open-pr-limit", `Tier ${input.authorTier} allows ${limits.openPrs} open PRs, including this PR.`);
  let pr: PrBlock | undefined;
  try {
    pr = parsePrBlock(input.prBody);
  } catch (error) {
    block("G0", "pr-block", String(error));
  }
  const entries = input.changedFiles.filter(
    (file) => /^\.changes\/[^/]+\.md$/.test(file.path) && file.path !== ".changes/README.md" && file.status === "A",
  );
  if (entries.length !== 1) block("G1", "change-entry", "Exactly one added .changes/<slug>.md entry is required.");
  let entry: ChangeEntry | undefined;
  for (const file of entries) {
    try {
      const parsed = parseChangeEntry(file.content ?? "", file.path);
      if (file.path === pr?.change) entry = parsed;
    } catch (error) {
      block("G1", "change-entry", `${file.path}: ${String(error)}`);
    }
  }
  if (pr) {
    if (!entry) block("G1", "change-entry-reference", "The PR block must name its valid added change entry.");
    if (entry && entry.category !== pr.category)
      block("G1", "one-category", "The PR block and change entry must declare the same category.");
    const category = categories.categories.find(({ id }) => id === pr.category);
    if (!category) block("G1", "category", `Unknown category: ${pr.category}`);
    else {
      const outside = paths.filter(
        (file) =>
          !file.startsWith(".changes/") &&
          !isGenerated(file) &&
          !/(^|\/)AGENTS\.md$/.test(file) &&
          !matchesPath(file, category.paths),
      );
      if (outside.length) block("G1", "category-paths", `Paths outside ${pr.category}: ${outside.join(", ")}`);
    }
    if (limits.forbiddenCategories.includes(pr.category))
      block("G1", "tier-category", `Tier ${input.authorTier} cannot contribute to ${pr.category}.`);
    if (sizes.indexOf(pr.size) < sizes.indexOf(actualSize))
      block("G1", "declared-size", `Declared size ${pr.size} is below actual size ${actualSize}.`);
    if (!limits.sizes.includes(pr.size) || !limits.sizes.includes(actualSize))
      block("G1", "tier-size", `Tier ${input.authorTier} does not allow size ${pr.size}/${actualSize}.`);
    if (
      limits.largeNeedsApproval &&
      (pr.size === "L" || actualSize === "L") &&
      !input.labels.includes("design-approved")
    )
      block("G1", "large-approval", "Tier 1 size L requires design-approved.");
  }
  // Tier 3 is the maintainer who grants design-approved; CODEOWNERS review still applies.
  if (protectedPathsTouched.length && input.authorTier !== 3 && !input.labels.includes("design-approved"))
    block("G1", "protected-paths", `Protected paths require design-approved: ${protectedPathsTouched.join(", ")}`);
  for (const file of input.changedFiles) {
    if (file.status !== "D" && (file.binary || media.test(file.path)))
      block("G1", "media-binary", `Binary or media file is not allowed: ${file.path}`);
    if (file.path !== "package.json" || file.status === "D") continue;
    try {
      if (file.content === undefined || (file.status !== "A" && file.previousContent === undefined))
        throw new Error("Both package.json revisions are required");
      const before = dependenciesSchema.parse(JSON.parse(file.previousContent ?? "{}"));
      const after = dependenciesSchema.parse(JSON.parse(file.content));
      const added = Object.keys(after).flatMap((section) =>
        Object.keys(after[section as keyof typeof after] ?? {}).filter(
          (name) => !Object.hasOwn(before[section as keyof typeof before] ?? {}, name),
        ),
      );
      if (added.length && !entry?.deps)
        block("G1", "dependency-justification", `New dependencies require deps: justification: ${added.join(", ")}`);
    } catch (error) {
      block("G1", "dependency-data", String(error));
    }
  }
  return { findings, facts };
}
