import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { parseChangeEntry } from "../contrib/changes";
import { DEFAULT_CATEGORIES } from "../contrib/categories";
import type { CategoriesFile, ChangeEntry } from "../../types/contrib";
import type { ApiSurface, SurfaceComparison } from "../api-surface";
import { addedFiles, git, lastRelease } from "./git";
import releasePolicy from "../../../contrib/release.json";

export type Bump = ChangeEntry["bump"];
export type ReleaseEntry = ChangeEntry & { file: string };
const ranks: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

export function versionParts(version: string): [number, number, number] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error(`Expected a stable semantic version: ${version}`);
  const parts = version.split(".").map(Number) as [number, number, number];
  if (!parts.every(Number.isSafeInteger)) throw new Error("Version components must be safe integers");
  return parts;
}

export function bumpVersion(version: string, bump: Bump): string {
  const [major, minor, patch] = versionParts(version);
  if (bump === "major" && major > 0) return `${major + 1}.0.0`;
  if (bump !== "patch") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function releaseDecision(
  version: string,
  entries: ReleaseEntry[],
  comparison?: SurfaceComparison,
  lastDate?: string,
  now = new Date(),
) {
  if (!Number.isFinite(now.getTime()) || (lastDate !== undefined && !Number.isFinite(Date.parse(lastDate))))
    throw new Error("Invalid release date");
  const surfaceBump: Bump =
    comparison?.classification === "breaking" ? "major" : (comparison?.classification ?? "patch");
  const declared = (entry: ChangeEntry): Bump => (entry.breaking ? "major" : entry.bump);
  const bump = entries.reduce<Bump>(
    (highest, entry) => (ranks[declared(entry)] > ranks[highest] ? declared(entry) : highest),
    surfaceBump,
  );
  const reasons = [
    ...(entries.length >= 15 ? ["entries"] : []),
    ...(entries.some((entry) => entry.breaking || entry.bump === "major") || comparison?.classification === "breaking"
      ? ["breaking"]
      : []),
    ...(entries.some((entry) => entry.category === "security") ? ["security"] : []),
    ...(entries.length > 0 && lastDate !== undefined && now.getTime() - Date.parse(lastDate) >= 14 * 86_400_000
      ? ["time"]
      : []),
  ];
  return {
    bump: versionParts(version)[0] === 0 && bump === "major" ? ("minor" as const) : bump,
    version: bumpVersion(version, bump),
    ready: reasons.length > 0,
    reasons,
    underDeclared: comparison
      ? entries.filter((entry) => ranks[declared(entry)] < ranks[surfaceBump]).map((entry) => entry.file)
      : [],
  };
}

export function readEntries(root: string): ReleaseEntry[] {
  const directory = path.join(root, ".changes");
  if (!existsSync(directory)) return [];
  if (!lstatSync(directory).isDirectory()) throw new Error(".changes must be a real directory");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((name) => {
      const file = `.changes/${name}`;
      if (!lstatSync(path.join(root, file)).isFile()) throw new Error(`Expected a regular change entry: ${file}`);
      return { ...parseChangeEntry(readFileSync(path.join(root, file), "utf8"), file), file };
    });
}

export async function planRelease(root: string, options: { since?: string; now?: Date; surface?: ApiSurface } = {}) {
  const entries = readEntries(root);
  const currentVersion = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string })
    .version;
  versionParts(currentVersion);
  const last = lastRelease(root, options.since);
  let comparison: SurfaceComparison | undefined;
  if (last && git(root, ["ls-tree", "--name-only", last.commit, "--", "docs/api/surface.json"])) {
    const { buildSurface, compareSurfaces } = await import("../api-surface");
    comparison = compareSurfaces(
      JSON.parse(git(root, ["show", `${last.commit}:docs/api/surface.json`])) as ApiSurface,
      options.surface ?? (await buildSurface(root)),
    );
  }
  const decision = releaseDecision(currentVersion, entries, comparison, last?.date, options.now);
  return {
    ...decision,
    version: last ? decision.version : currentVersion,
    initial: !comparison,
    currentVersion,
    lastRelease: last ?? null,
    entries,
    comparison: comparison ?? null,
  };
}

export function newShowcases(root: string, since?: string): string[] {
  if (!existsSync(path.join(root, "showcases"))) return [];
  return addedFiles(root, lastRelease(root, since)?.commit)
    .filter((file) => /^showcases\/[^/]+\/showcase\.json$/.test(file))
    .sort();
}

export interface NotesOptions {
  categories?: CategoriesFile;
  metrics?: Record<string, number>;
  context?: { id: string; bytes: number; estimatedTokens: number }[];
  showcases?: string[];
  /** Bot logins left out of the contributors section (default: `contrib/release.json` botLogins). */
  botLogins?: string[];
}

/** Placeholder and bot authors are not people to credit: `unknown`, configured bot logins and any `[bot]` account. */
export function creditedHandle(handle: string, botLogins: string[] = releasePolicy.botLogins): boolean {
  const name = handle.replace(/^@/, "").toLowerCase();
  const bots = botLogins.map((login) => login.toLowerCase());
  return name !== "unknown" && !name.endsWith("[bot]") && !bots.includes(name) && !bots.includes(`${name}[bot]`);
}

export function releaseNotes(version: string, entries: ReleaseEntry[], options: NotesOptions = {}): string {
  versionParts(version);
  const categories = options.categories ?? DEFAULT_CATEGORIES;
  for (const entry of entries)
    if (!categories.categories.some((category) => category.id === entry.category))
      throw new Error(`Unknown change category: ${entry.category}`);
  const lines = [`## ${version}`, ""];
  const render = (entry: ReleaseEntry) => {
    const body = entry.body
      .trim()
      .split(/\r?\n/)
      .map((line, index) => (index && line ? `  ${line}` : line))
      .join("\n");
    lines.push(
      `- ${body}${entry.pr ? ` ([#${entry.pr}](https://github.com/ilyamk/agentbros/pull/${entry.pr}))` : ""}`,
      "",
    );
  };
  const breaking = entries.filter((entry) => entry.breaking || entry.bump === "major");
  if (breaking.length) {
    lines.push("### Breaking changes", "");
    breaking.forEach(render);
  }
  for (const category of categories.categories) {
    const group = entries.filter((entry) => entry.category === category.id && !breaking.includes(entry));
    if (group.length) {
      lines.push(`### ${category.title}`, "");
      group.forEach(render);
    }
  }
  const section = (title: string, body: string[]) => {
    if (body.length) lines.push(`### ${title}`, "", ...body, "");
  };
  const contributors: string[] = [];
  for (const category of categories.categories) {
    const handles = [
      ...new Set(
        entries
          .filter((entry) => entry.category === category.id)
          .flatMap((entry) => entry.authors)
          .filter((handle) => creditedHandle(handle, options.botLogins))
          .map((handle) => handle.replace(/^@/, "")),
      ),
    ].sort();
    if (handles.some((handle) => !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(handle)))
      throw new Error("Contributor must be a GitHub handle");
    if (handles.length)
      contributors.push(
        `- ${category.title}: ${handles.map((handle) => `[@${handle}](https://github.com/${handle})`).join(", ")}`,
      );
  }
  section("Contributors", contributors);
  // Sections without data are omitted rather than printed as "not supplied" or "none".
  section(
    "Metrics delta",
    Object.entries(options.metrics ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `- ${key}: ${value > 0 ? "+" : ""}${value}`),
  );
  section(
    "Context delta",
    (options.context ?? [])
      .filter((row) => row.bytes || row.estimatedTokens)
      .map(
        (row) =>
          `- ${row.id}: ${row.bytes > 0 ? "+" : ""}${row.bytes} bytes, ${row.estimatedTokens > 0 ? "+" : ""}${row.estimatedTokens} estimated tokens`,
      ),
  );
  section(
    "New showcases",
    (options.showcases ?? []).map((file) => `- [${file.split("/")[1]}](${file})`),
  );
  return lines.join("\n");
}

export function applyRelease(
  root: string,
  version: string,
  notes: string,
  entries = readEntries(root),
): { tag: string; outputs: string[] } {
  const parts = versionParts(version);
  if (!entries.length) throw new Error("A release needs at least one change entry");
  const packageFile = path.join(root, "package.json");
  const changelog = path.join(root, "CHANGELOG.md");
  for (const file of [packageFile, changelog]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error(`Expected a regular file: ${file}`);
  }
  const source = readFileSync(packageFile, "utf8");
  const pkg = JSON.parse(source) as { version: string };
  const old = versionParts(pkg.version);
  const firstDifference = parts.findIndex((value, index) => value !== old[index]);
  if (firstDifference >= 0 && parts[firstDifference]! < old[firstDifference]!)
    throw new Error("Release version cannot go backwards");
  const previous = existsSync(changelog) ? readFileSync(changelog, "utf8") : "# Changelog\n";
  if (previous.split("\n").includes(`## ${version}`)) throw new Error(`Release ${version} already exists`);
  if (!notes.startsWith(`## ${version}\n`)) throw new Error("Release notes do not match the requested version");
  const currentEntries = new Map(readEntries(root).map((entry) => [entry.file, entry]));
  for (const entry of entries) {
    const current = currentEntries.get(entry.file);
    if (JSON.stringify(current) !== JSON.stringify(entry))
      throw new CliErrorObject({ code: "VALIDATION", message: `Change entry changed during release: ${entry.file}` });
  }
  const next = source.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, `$1${version}$2`);
  const body = previous.replace(/^# Changelog\s*/, "").trim();
  writeFileSync(packageFile, next);
  writeFileSync(changelog, `# Changelog\n\n${notes.trim()}\n${body ? `\n${body}\n` : ""}`);
  entries.forEach((entry) => unlinkSync(path.join(root, entry.file)));
  return { tag: `v${version}`, outputs: ["package.json", "CHANGELOG.md"] };
}
