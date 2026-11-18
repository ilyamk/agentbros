/**
 * Kept film renders. The chain renders to one fixed path (out/<id>/film.mp4), so each render replaces the last.
 * Every project render is also kept as out/<id>/versions/<sha256 prefix>.mp4 with a small index, so an earlier,
 * better version can be found and restored. The copy is a copy-on-write clone where the filesystem has one
 * (APFS, Btrfs), else a plain copy; never a hardlink, because ffmpeg and the renderer rewrite film.mp4 in place.
 */
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { CritiqueSchema, type Critique } from "../../types/creative";
import { FilmMeasureSchema, FilmVersionsIndexSchema, type FilmVersion, type FilmVersionsIndex } from "../../types/film";

/** What the helpers need of a film project (a FilmProject fits). */
export type FilmVersionProject = { id: string; rootDir: string; projectDir: string };
export type FilmVersionMeasure = NonNullable<FilmVersion["measure"]>;
export type RankedFilmVersion = FilmVersion & {
  /** The copy is still on disk. */
  exists: boolean;
  /** The measure verdict for this sha: the current film-measure.json when it measured this sha, else the one kept at render time. */
  measurePassed: boolean;
  /** The highest critic total among critiques of this exact render, and its round. */
  criticTotal?: number;
  criticRound?: number;
};

/** Hex characters of the sha256 in a kept file's name. */
export const VERSION_PREFIX_LENGTH = 16;

/** The critic's total score for a round: the same sum the chain's no-progress rule compares. */
export function critiqueTotal(critique: Pick<Critique, "scores">): number {
  return Object.values(critique.scores).reduce((sum, score) => sum + (score?.score ?? 0), 0);
}

export function versionsDir(project: FilmVersionProject): string {
  return path.join(project.rootDir, "out", project.id, "versions");
}
export function versionsIndexPath(project: FilmVersionProject): string {
  return path.join(versionsDir(project), "index.json");
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

export function readFilmVersionsIndex(project: FilmVersionProject): FilmVersionsIndex {
  const file = versionsIndexPath(project);
  if (!existsSync(file)) return { schemaVersion: 1, projectId: project.id, versions: [] };
  return FilmVersionsIndexSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Keep a render under out/<id>/versions/ and record it in the index. Idempotent by sha256: a known render gains
 * the step and, when given, the newer measure verdict; its copy and createdAt stay.
 */
export function snapshotFilmVersion(
  project: FilmVersionProject,
  render: string,
  info: {
    step: string;
    sha256?: string;
    composition?: string;
    draft?: boolean;
    measure?: FilmVersionMeasure;
    now?: Date;
  },
): FilmVersion {
  const source = path.resolve(project.rootDir, render);
  const sha256 = info.sha256 ?? sha256Of(source);
  const directory = versionsDir(project);
  const target = path.join(directory, `${sha256.slice(0, VERSION_PREFIX_LENGTH)}${path.extname(source) || ".mp4"}`);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(target) || statSync(target).size !== statSync(source).size) {
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      // COPYFILE_FICLONE clones where it can and falls back to a full copy where it cannot.
      copyFileSync(source, temporary, constants.COPYFILE_FICLONE);
      if (sha256Of(temporary) !== sha256)
        throw new Error(
          `The render changed while it was kept: ${path.relative(project.rootDir, source)} no longer has sha256 ${sha256}.`,
        );
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const index = readFilmVersionsIndex(project);
  const file = path.relative(project.rootDir, target).split(path.sep).join("/");
  const known = index.versions.find((version) => version.sha256 === sha256);
  const entry: FilmVersion = known
    ? {
        ...known,
        file,
        steps: known.steps.includes(info.step) ? known.steps : [...known.steps, info.step],
        ...(info.measure ? { measure: info.measure } : {}),
        ...(info.composition && !known.composition ? { composition: info.composition } : {}),
      }
    : {
        sha256,
        file,
        sizeBytes: statSync(target).size,
        steps: [info.step],
        createdAt: (info.now ?? new Date()).toISOString(),
        ...(info.composition ? { composition: info.composition } : {}),
        draft: Boolean(info.draft),
        ...(info.measure ? { measure: info.measure } : {}),
      };
  const versions = known
    ? index.versions.map((version) => (version.sha256 === sha256 ? entry : version))
    : [...index.versions, entry];
  writeAtomic(
    versionsIndexPath(project),
    `${JSON.stringify(FilmVersionsIndexSchema.parse({ ...index, versions }), null, 2)}\n`,
  );
  return entry;
}

/**
 * Order kept versions best first. Pure: measure pass on that sha first, then the highest critic total for that
 * renderSha256, then newest. Drafts are never delivered, so they come after every full render; a missing copy
 * comes last.
 */
export function rankFilmVersions(
  versions: readonly (FilmVersion & { exists?: boolean })[],
  critiques: readonly Pick<Critique, "renderSha256" | "round" | "scores">[],
  currentMeasure?: { renderSha256: string; verdict: "pass" | "fail" },
): RankedFilmVersion[] {
  const ranked = versions.map((version): RankedFilmVersion => {
    const verdict = currentMeasure?.renderSha256 === version.sha256 ? currentMeasure.verdict : version.measure?.verdict;
    let best: { total: number; round: number } | undefined;
    for (const critique of critiques) {
      if (critique.renderSha256 !== version.sha256) continue;
      const total = critiqueTotal(critique);
      if (!best || total > best.total || (total === best.total && critique.round > best.round))
        best = { total, round: critique.round };
    }
    return {
      ...version,
      exists: version.exists ?? true,
      measurePassed: verdict === "pass",
      ...(best ? { criticTotal: best.total, criticRound: best.round } : {}),
    };
  });
  const key = (version: RankedFilmVersion) => [
    version.exists ? 1 : 0,
    version.draft ? 0 : 1,
    version.measurePassed ? 1 : 0,
    version.criticTotal ?? -Infinity,
    Date.parse(version.createdAt),
  ];
  return ranked.sort((a, b) => {
    const left = key(a),
      right = key(b);
    for (let index = 0; index < left.length; index++)
      if (left[index] !== right[index]) return right[index] - left[index];
    return 0;
  });
}

function readCritiques(project: FilmVersionProject): Critique[] {
  const directory = path.join(project.projectDir, "pipeline", "critique");
  if (!existsSync(directory)) return [];
  const critiques: Critique[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = CritiqueSchema.safeParse(JSON.parse(readFileSync(path.join(directory, name), "utf8")));
      if (parsed.success) critiques.push(parsed.data);
    } catch {
      // An unreadable critique ranks nothing; the chain reports it elsewhere.
    }
  }
  return critiques;
}

function readCurrentMeasure(
  project: FilmVersionProject,
): { renderSha256: string; verdict: "pass" | "fail" } | undefined {
  const file = path.join(project.projectDir, "pipeline", "film-measure.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = FilmMeasureSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? { renderSha256: parsed.data.renderSha256, verdict: parsed.data.verdict } : undefined;
  } catch {
    return undefined;
  }
}

/** Every kept version, oldest first, with its measure verdict and critic total joined in. */
export function listFilmVersions(project: FilmVersionProject): RankedFilmVersion[] {
  const versions = readFilmVersionsIndex(project).versions.map((version) => ({
    ...version,
    exists: existsSync(path.resolve(project.rootDir, version.file)),
  }));
  const ranked = rankFilmVersions(versions, readCritiques(project), readCurrentMeasure(project));
  const order = new Map(versions.map((version, index) => [version.sha256, index]));
  return ranked.sort((a, b) => order.get(a.sha256)! - order.get(b.sha256)!);
}

/** The best kept version still on disk, by rankFilmVersions; undefined when none is kept. */
export function bestFilmVersion(project: FilmVersionProject): RankedFilmVersion | undefined {
  const versions = readFilmVersionsIndex(project).versions.map((version) => ({
    ...version,
    exists: existsSync(path.resolve(project.rootDir, version.file)),
  }));
  const best = rankFilmVersions(versions, readCritiques(project), readCurrentMeasure(project))[0];
  return best?.exists ? best : undefined;
}

// --- Pruning ---

export type FilmVersionKeepReason = "newest" | "best" | "current" | "approved" | "recorded" | "delivered";
export type FilmVersionPrunePlan = {
  keepNewest: number;
  kept: { sha256: string; file: string; reasons: FilmVersionKeepReason[] }[];
  remove: { sha256: string; file: string; bytes: number; exists: boolean }[];
  bytesFreed: number;
};

/** Every full sha256 named in the matching JSON files under these paths (recursively); schema-agnostic on purpose. */
function hashesIn(roots: readonly string[], match: (name: string) => boolean = (name) => name.endsWith(".json")) {
  const found = new Set<string>();
  const walk = (entry: string, depth: number) => {
    const stat = statSync(entry, { throwIfNoEntry: false });
    if (stat?.isDirectory() && depth < 4) {
      for (const name of readdirSync(entry)) walk(path.join(entry, name), depth + 1);
    } else if (stat?.isFile() && match(path.basename(entry)))
      for (const hash of readFileSync(entry, "utf8").match(/\b[0-9a-f]{64}\b/g) ?? []) found.add(hash);
  };
  for (const root of roots) walk(root, 0);
  return found;
}

/**
 * Which kept versions a prune removes. Kept: the newest `keep` by createdAt, the best (bestFilmVersion), the one equal
 * to the current out/<id>/film.mp4, any sha an approval (approved) or a chain receipt (recorded) names, and any a delivery
 * snapshot, report or render receipt names (delivered). Over-protecting is the safe failure. Deletes nothing.
 */
export function planFilmVersionPrune(
  project: FilmVersionProject,
  options: { keep?: number } = {},
): FilmVersionPrunePlan {
  const keepNewest = options.keep ?? 5;
  if (!Number.isInteger(keepNewest) || keepNewest < 0) throw new Error("keep must be a whole number of 0 or more.");
  const versions = listFilmVersions(project);
  const reasons = new Map(versions.map((version) => [version.sha256, new Set<FilmVersionKeepReason>()]));
  const mark = (sha256: string | undefined, reason: FilmVersionKeepReason) => reasons.get(sha256 ?? "")?.add(reason);
  [...versions]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, keepNewest)
    .forEach((version) => mark(version.sha256, "newest"));
  mark(bestFilmVersion(project)?.sha256, "best");
  const outDir = path.join(project.rootDir, "out", project.id);
  const current = path.join(outDir, "film.mp4");
  if (existsSync(current)) mark(sha256Of(current), "current");
  const pipeline = path.join(project.projectDir, "pipeline");
  for (const hash of hashesIn([path.join(pipeline, "approvals")])) mark(hash, "approved");
  for (const hash of hashesIn([path.join(pipeline, "chain")])) mark(hash, "recorded");
  const receipts = existsSync(outDir)
    ? readdirSync(outDir)
        .filter((name) => name.endsWith(".receipt.json"))
        .map((name) => path.join(outDir, name))
    : [];
  for (const hash of hashesIn([path.join(pipeline, "delivery"), ...receipts])) mark(hash, "delivered");
  const plan: FilmVersionPrunePlan = { keepNewest, kept: [], remove: [], bytesFreed: 0 };
  for (const version of versions) {
    const why = [...reasons.get(version.sha256)!];
    if (why.length) {
      plan.kept.push({ sha256: version.sha256, file: version.file, reasons: why });
      continue;
    }
    const bytes = version.exists ? statSync(path.resolve(project.rootDir, version.file)).size : 0;
    plan.remove.push({ sha256: version.sha256, file: version.file, bytes, exists: version.exists });
    plan.bytesFreed += bytes;
  }
  return plan;
}

/**
 * Delete a plan's copies, then drop their entries from a freshly read index, so a render kept meanwhile survives.
 * Files first: a crash between leaves entries with no copy, which rank last and go on the next prune.
 */
export function applyFilmVersionPrune(
  project: FilmVersionProject,
  plan: Pick<FilmVersionPrunePlan, "remove">,
): string[] {
  const directory = path.resolve(versionsDir(project));
  const targets = plan.remove.map((entry) => {
    const absolute = path.resolve(project.rootDir, entry.file);
    if (path.dirname(absolute) !== directory || path.basename(absolute) === "index.json")
      throw new Error(`Refusing to delete ${entry.file}: it is not a kept version in out/${project.id}/versions/.`);
    return absolute;
  });
  for (const target of targets) rmSync(target, { force: true });
  const removed = new Set(plan.remove.map((entry) => entry.sha256));
  const index = readFilmVersionsIndex(project);
  const versions = index.versions.filter((version) => !removed.has(version.sha256));
  writeAtomic(
    versionsIndexPath(project),
    `${JSON.stringify(FilmVersionsIndexSchema.parse({ ...index, versions }), null, 2)}\n`,
  );
  return plan.remove.map((entry) => entry.file);
}
