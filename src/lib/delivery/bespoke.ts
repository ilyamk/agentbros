import { vizHash } from "../viz/compile";
import { captureVizDependencies } from "../viz/usage";
import {
  captureLocalProvenance,
  localAssetReferences,
  readLocalImportProvenance,
  receiptForLocalAsset,
} from "../apple/provenance";
import { captureVorkProvenance, readVorkImportProvenance, vorkAssetReferences } from "../vork/provenance";
import {
  captureIconResources,
  iconImportedCopies,
  iconManagedFiles,
  assertBespokeIconUsage,
} from "../icon-resources/usage";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertPathWithin, isBespokeBrief } from "../cli";
import { hashFile, readAssetRegistry } from "../assets/registry";
import { generationInputHash } from "../jobs/runner";
import { RenderIdentitySchema, type RenderIdentity } from "../../types/delivery";
import { FORMAT_CONFIGS, type VideoFormat } from "../../types/video";
import { assertProductionReferences } from "../campaigns/production/guard";

// The bespoke delivery route: a film made by the film chain and rendered by film:render, with no project.json.
// docs/delivery.md, "Bespoke films".

/** vision/composition's DEFAULT_ENTRY, kept apart so delivery does not load the bundler (tests/delivery-bespoke.test.ts holds them equal). */
export const DEFAULT_FILM_ENTRY = "src/index.ts";
/** film:render's default output, the one bespoke delivery reads. */
export const bespokeOutput = (root: string, projectId: string) => path.join(root, "out", projectId, "film.mp4");
/** A bespoke film's type is in its picture: there is no clean variant, so its one output is the captioned one. */
export const BESPOKE_VARIANT = "captioned" as const;
/** The film's authored inputs. Files written after a render (film-render.json, film-measure.json, delivery/) are left out, or the render would change its own snapshot. */
export const BESPOKE_PIPELINE_FILES = [
  "brief",
  "motion-plan",
  "cue-sheet",
  "cue-placements",
  "build",
  "music-decision",
  "sound-cues",
  "replica-spec",
] as const;
/** Sounds sfx:synth makes from a seed in this repository's code: identity, not third-party media. */
const SYNTH_PACK = "shared/sfx/synth/";

const stable = (value: unknown) => generationInputHash(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** A film-chain project: brief.renderMode "bespoke" and no template project.json. */
export function isBespokeDelivery(root: string, projectId: string): boolean {
  const project = path.join(root, "public/projects", projectId);
  return !existsSync(path.join(project, "project.json")) && isBespokeBrief(path.join(project, "pipeline/brief.json"));
}

/** The brief's format token, when it names one. */
export function bespokeFormat(root: string, projectId: string): VideoFormat | undefined {
  const format = readJson(path.join(root, "public/projects", projectId, "pipeline/brief.json"))?.format;
  return typeof format === "string" && format in FORMAT_CONFIGS ? (format as VideoFormat) : undefined;
}

/** The format a composition of this size delivers as. */
export const formatOfSize = (width: number, height: number): VideoFormat =>
  width === height ? "square" : height > width ? "vertical" : "landscape";

/** Why a delivery request cannot take this bespoke film, or nothing. */
export function bespokeRequestProblems(
  root: string,
  request: {
    projectId: string;
    formats: readonly string[];
    variants: readonly string[];
    timeline?: boolean;
    subtitles?: readonly string[];
    subtitleTracks?: unknown;
    platformAudioPlacement?: unknown;
    fontContext?: string;
  },
): string[] {
  const problems: string[] = [];
  const format = bespokeFormat(root, request.projectId);
  if (request.formats.length !== 1 || (format && request.formats[0] !== format))
    problems.push(
      `a bespoke film delivers one format, the one it was built in${format ? `: formats ["${format}"]` : ""}`,
    );
  if (request.variants.length !== 1 || request.variants[0] !== BESPOKE_VARIANT)
    problems.push(`its type is in the picture, so there is no clean variant: variants ["${BESPOKE_VARIANT}"]`);
  if (request.timeline) problems.push("it has no editable timeline: timeline false");
  if (request.subtitles?.length || request.subtitleTracks)
    problems.push("it has no aligned caption track to export: no subtitles or subtitleTracks");
  if (request.platformAudioPlacement) problems.push("the native platform-audio handoff is a template-mode route");
  if (request.fontContext)
    problems.push("fontContext is a template-mode render input; a bespoke film loads its own fonts in code");
  return problems;
}

function effectiveBespokeProps(
  root: string,
  projectId: string,
  build: Record<string, unknown> | undefined,
  props?: unknown,
): unknown {
  if (props !== undefined) return props;
  if (typeof build?.props !== "string") return undefined;
  const project = path.join(root, "public/projects", projectId),
    file = path.resolve(root, "public", build.props);
  assertPathWithin(project, file);
  const value = readJson(file);
  if (!value) throw new Error("Build props file is missing");
  if (build.entry === "src/motion/viz/film.tsx" && path.basename(file) !== `film-props-${vizHash(value)}.json`)
    throw new Error("Generated visualisation props differ from their content address");
  return value;
}

export function bespokeLocalAssets(root: string, projectId: string, props?: unknown) {
  const pipeline = path.join(root, "public/projects", projectId, "pipeline");
  const build = readJson(path.join(pipeline, "build.json"));
  const cues = readJson(path.join(pipeline, "sound-cues.json"));
  const references = (value: unknown) => [
    ...new Set([...localAssetReferences(value, root), ...vorkAssetReferences(value, root)]),
  ];
  const declared = references(build?.localAssets);
  if (references(effectiveBespokeProps(root, projectId, build, props)).some((file) => !declared.includes(file)))
    throw new Error("Every native render-prop reference must also be declared in build.localAssets");
  return references([build?.localAssets, cues]);
}

/**
 * The bespoke film's render identity: composition and entry from build.json, length from the motion plan, and the hashes
 * of what can change its pixels or sound: the authored pipeline files, the project's media, the sounds sound-cues.json
 * places, the audio master, the source code and fonts. film:render captures it before and after rendering
 * (publishRenderReceipt); delivery captures it at the snapshot and again at the check.
 */
export function captureBespokeIdentity(
  projectId: string,
  format: VideoFormat,
  options: { rootDir?: string; audioMaster?: string; props?: unknown } = {},
): RenderIdentity {
  assertProductionReferences(path.join(path.resolve(options.rootDir ?? process.cwd()), "public/projects", projectId));
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const project = path.join(rootDir, "public/projects", projectId);
  assertPathWithin(path.join(rootDir, "public/projects"), project);
  const build = readJson(path.join(project, "pipeline/build.json"));
  if (!build || typeof build.composition !== "string")
    throw new Error("A bespoke film needs pipeline/build.json naming its composition (the build step) before delivery");
  const plan = readJson(path.join(project, "pipeline/motion-plan.json")) as
    { fps?: number; shots?: { startFrame: number; durationFrames: number }[] } | undefined;
  const planFrames = Math.max(0, ...(plan?.shots ?? []).map((shot) => shot.startFrame + shot.durationFrames));
  if (
    typeof build.vizMotionPlanHash === "string" &&
    hashFile(path.join(project, "pipeline/motion-plan.json")) !== build.vizMotionPlanHash
  )
    throw new Error("Generated visualisation build belongs to another motion plan");
  if (!plan?.fps || !planFrames)
    throw new Error("A bespoke film needs pipeline/motion-plan.json with its shots before delivery");
  const durationInFrames = Math.round((planFrames * 30) / plan.fps);

  const managedVizImports = new Set(
    build.entry === "src/motion/viz/film.tsx" && build.composition === "VizFilm"
      ? readAssetRegistry(projectId, rootDir)
          .assets.filter((asset) => ["viz-plate", "viz-render"].includes(asset.provenance.tool))
          .map((asset) => path.resolve(rootDir, "public", asset.files.original))
      : [],
  );
  const sources = new Map<string, RenderIdentity["sources"][number]>();
  const importedIcons = iconImportedCopies(rootDir, projectId);
  const managedIcons = iconManagedFiles(rootDir, projectId);
  const add = (file: string, role: RenderIdentity["sources"][number]["role"]) => {
    const absolute = path.resolve(file);
    assertPathWithin(rootDir, absolute);
    if (!existsSync(absolute) || !statSync(absolute).isFile())
      throw new Error(`Delivery source missing: ${path.relative(rootDir, absolute)}`);
    const key = path.relative(rootDir, absolute).split(path.sep).join("/");
    sources.set(key, { path: key, sha256: hashFile(absolute), role });
  };
  const tree = (
    directory: string,
    role: RenderIdentity["sources"][number]["role"],
    skip: (name: string) => boolean = () => false,
  ) => {
    if (!existsSync(directory)) return;
    assertPathWithin(rootDir, directory);
    for (const name of readdirSync(directory).sort()) {
      if (name.startsWith(".") || skip(name)) continue;
      const file = path.join(directory, name);
      if (lstatSync(file).isSymbolicLink()) {
        assertPathWithin(rootDir, file);
        if (statSync(file).isDirectory()) throw new Error("Source directory symlinks are not permitted");
      }
      if (statSync(file).isDirectory()) tree(file, role);
      else if (
        !managedVizImports.has(path.resolve(file)) &&
        !importedIcons.has(path.resolve(file)) &&
        !managedIcons.has(path.resolve(file))
      ) {
        const entityEvidence =
          file.startsWith(path.join(project, "entities") + path.sep) && /\.(?:json|html)$/.test(name);
        if (
          entityEvidence ||
          (file.startsWith(path.join(project, "resources") + path.sep) &&
            /^revision-\d+\.json$/.test(name) &&
            managedIcons.size)
        )
          add(file, "creative");
        else add(file, role);
      }
    }
  };
  for (const stem of BESPOKE_PIPELINE_FILES) {
    const file = path.join(project, "pipeline", `${stem}.json`);
    if (existsSync(file)) add(file, "creative");
  }
  const buildProps = effectiveBespokeProps(rootDir, projectId, build, options.props);
  if (options.props === undefined && typeof build.props === "string")
    add(path.resolve(rootDir, "public", build.props), "creative");
  // The project's own media; pipeline/ holds evidence and reports written after the render.
  tree(project, "asset", (name) => name === "pipeline");
  const nativeInventory = [...sources.values()]
    .filter((row) => row.role === "asset")
    .some(
      (row) =>
        receiptForLocalAsset(row.path) ||
        readLocalImportProvenance(path.resolve(rootDir, row.path), row.sha256) ||
        readVorkImportProvenance(path.resolve(rootDir, row.path), row.sha256, rootDir),
    );
  if (nativeInventory && !Array.isArray(build.localAssets))
    throw new Error(
      "Declare every consumed native asset in build.localAssets; use [] when retained native drafts are unused",
    );
  for (const file of bespokeLocalAssets(rootDir, projectId, buildProps)) {
    add(file, "asset");
    captureLocalProvenance(file, rootDir, add);
    captureVorkProvenance(file, rootDir, add);
  }
  assertBespokeIconUsage(rootDir, projectId, [build, buildProps]);
  captureIconResources(rootDir, projectId, [build, buildProps], add);
  captureVizDependencies(rootDir, projectId, [plan, build, buildProps], add);
  const cues = readJson(path.join(project, "pipeline/sound-cues.json")) as
    { events?: { file?: unknown }[] } | undefined;
  for (const event of cues?.events ?? []) {
    if (typeof event.file !== "string" || /^https?:\/\//.test(event.file)) continue;
    add(path.resolve(rootDir, "public", event.file), event.file.startsWith(SYNTH_PACK) ? "code" : "asset");
  }
  if (options.audioMaster) add(path.resolve(rootDir, options.audioMaster), "asset");
  for (const name of ["package.json", "pnpm-lock.yaml", "remotion.config.ts"]) {
    const file = path.join(rootDir, name);
    if (existsSync(file)) add(file, "code");
  }
  tree(path.join(rootDir, "src"), "code");
  tree(path.join(rootDir, "public/fonts"), "code");
  const sorted = [...sources.values()].sort((a, b) => a.path.localeCompare(b.path));
  const storyHash = stable({ creative: sorted.filter((source) => source.role === "creative") });
  const render = {
    composition: build.composition,
    entry: typeof build.entry === "string" ? build.entry : DEFAULT_FILM_ENTRY,
    props: buildProps ?? null,
  };
  const base = {
    version: 1 as const,
    projectId,
    format,
    captions: "on" as const,
    compositionId: build.composition,
    durationInFrames,
    propsHash: stable(render),
    storyHash,
    editRevision: null,
    sources: sorted,
  };
  return RenderIdentitySchema.parse({ ...base, sourceSnapshotHash: stable(base) });
}
