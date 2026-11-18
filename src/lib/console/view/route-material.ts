/**
 * Step material of the replica, recipe and campaign routes for their console panels (RFC 0004 WP15, US23). Read-only
 * and advisory like the film material: each reader returns undefined when its files are absent, pushes an advisory
 * when one is malformed, and never throws. Strings are bounded to the contract's limits here, so the view parses.
 *
 * - Replica: `pipeline/replica-rights.json` (the user's own words, as written), `replica-spec.json` (+ `.md`),
 *   `replica-check.json` and `replica-compare.json` (the CLIs' envelopes).
 * - Recipe: `pipeline/recipe.json` (written by `video:recipe`) and the scenes of `project.json`.
 * - Campaign: the campaign review state (`campaignReviewState`), counted per member.
 */
import path from "node:path";
import {
  CampaignMaterialSchema,
  RecipeMaterialSchema,
  ReplicaMaterialSchema,
  FORMATS,
  type CampaignMaterial,
  type MediaRef,
  type RecipeMaterial,
  type ReplicaMaterial,
} from "../../../types/console";
import { ReplicaRightsSchema, ReplicaSpecSchema } from "../../../types/reference-replica";
import { campaignReviewState } from "../../campaigns/production/review-service";
import { locate, mediaKind, readJsonObject, statOf, text, type ProjectPaths } from "./files";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");
const strings = (value: unknown, count: number, max: number): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => text(typeof item === "string" ? item : isObject(item) ? JSON.stringify(item) : undefined, max))
        .filter((item): item is string => !!item)
        .slice(0, count)
    : [];
const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

/** A JSON object of the project's pipeline, or undefined; a corrupt file adds an advisory. */
function pipelineJson(paths: ProjectPaths, name: string, advisories: string[]): Json | undefined {
  const value = readJsonObject(path.join(paths.projectDir, "pipeline", name));
  if (value === "corrupt") {
    advisories.push(`${name.replace(/\.json$/, "")}: pipeline/${name} is not valid JSON.`);
    return undefined;
  }
  return value;
}

/** A project file as a MediaRef when it exists. */
function projectMedia(paths: ProjectPaths, file: string, label?: string): MediaRef | undefined {
  const where = locate(paths, file);
  const kind = mediaKind(file);
  if (!where || !kind) return undefined;
  const absolute = path.join(where.root === "out" ? paths.outDir : paths.projectDir, where.path);
  if (!statOf(absolute)?.isFile()) return undefined;
  return { ...where, kind, ...(label ? { label: label.slice(0, 160) } : {}) };
}

/** Validates a section against its schema; a failure drops it with an advisory (the view must always parse). */
function checked<T>(
  name: string,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
  advisories: string[],
): T | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  advisories.push(`${name}: the material did not validate and is not shown.`);
  return undefined;
}

// --- Replica ---

const MEASURES = 32;

export function readReplicaMaterial(paths: ProjectPaths, advisories: string[]): ReplicaMaterial | undefined {
  const material: ReplicaMaterial = {};
  const rightsRaw = pipelineJson(paths, "replica-rights.json", advisories);
  if (rightsRaw) {
    const rights = ReplicaRightsSchema.safeParse(rightsRaw);
    if (rights.success)
      material.rights = {
        status: rights.data.status,
        userStatement: rights.data.userStatement.slice(0, 2000),
        askedAt: rights.data.askedAt.slice(0, 64),
      };
    else advisories.push("replica: pipeline/replica-rights.json does not match its schema.");
  }
  const specRaw = pipelineJson(paths, "replica-spec.json", advisories);
  if (specRaw) {
    const spec = ReplicaSpecSchema.safeParse(specRaw);
    if (spec.success) {
      const doc = projectMedia(paths, path.join(paths.projectDir, "pipeline", "replica-spec.md"), "replica-spec.md");
      material.spec = {
        reference: spec.data.reference.slice(0, 128),
        fps: spec.data.fps,
        format: spec.data.format,
        shots: spec.data.shots.slice(0, 200).map((shot) => {
          const transition =
            typeof shot.transitionIn === "string" ? shot.transitionIn : (shot.transitionIn?.kind ?? undefined);
          return {
            id: shot.id.slice(0, 64),
            referenceShot: shot.referenceShot.slice(0, 64),
            startFrame: shot.startFrame,
            durationFrames: shot.durationFrames,
            content: shot.content.slice(0, 500),
            confidence: shot.confidence,
            ...(shot.camera?.kind?.length ? { camera: shot.camera.kind.join(" + ").slice(0, 64) } : {}),
            ...(transition ? { transitionIn: String(transition).slice(0, 64) } : {}),
            blocks: strings(shot.blocks, 16, 128),
            ...(shot.unreachable
              ? { unreachable: `${shot.unreachable.nearest}: ${shot.unreachable.residual}`.slice(0, 500) }
              : {}),
          };
        }),
        swaps: spec.data.swaps.slice(0, 64).map((swap) => ({
          what: swap.what.slice(0, 500),
          from: swap.from.slice(0, 500),
          to: swap.to.slice(0, 500),
          why: swap.why.slice(0, 1000),
          ...(swap.shots ? { shots: strings(swap.shots, 200, 64) } : {}),
        })),
        rounds: spec.data.rounds.slice(-32).map((round) => ({
          round: round.round,
          fixed: strings(round.fixed, 32, 500),
          remains: strings(round.remains, 32, 500),
        })),
        ...(doc ? { doc } : {}),
      };
    } else advisories.push("replica: pipeline/replica-spec.json does not match its schema.");
  }
  const check = pipelineJson(paths, "replica-check.json", advisories);
  if (check && typeof check.ok === "boolean") {
    const metadata = isObject(check.metadata) ? check.metadata : {};
    material.check = {
      ok: check.ok,
      ...(typeof metadata.passed === "boolean" ? { passed: metadata.passed } : {}),
      issues: strings(metadata.issues, 20, 1000),
      ...(text(check.message, 2000) ? { message: text(check.message, 2000) } : {}),
    };
  }
  const compare = pipelineJson(paths, "replica-compare.json", advisories);
  if (compare && typeof compare.ok === "boolean") {
    const summary = isObject(compare.metadata) && isObject(compare.metadata.summary) ? compare.metadata.summary : {};
    const within = isObject(summary.withinTolerance) ? summary.withinTolerance : {};
    material.compare = {
      ok: compare.ok,
      ...(text(compare.message, 2000) ? { message: text(compare.message, 2000) } : {}),
      measures: Object.entries(within)
        .filter(([measure, value]) => !!text(measure, 64) && isObject(value))
        .slice(0, MEASURES)
        .map(([measure, value]) => {
          const tally = value as Json;
          return {
            measure: measure.slice(0, 64),
            held: count(tally.held),
            failed: count(tally.failed),
            notMeasured: count(tally.notMeasured),
            exempt: count(tally.exempt),
          };
        }),
    };
  }
  if (!Object.keys(material).length) return undefined;
  return checked("replica", ReplicaMaterialSchema, material, advisories);
}

// --- Recipe ---

const FORMAT_SET = new Set<string>(FORMATS);

export function readRecipeMaterial(paths: ProjectPaths, advisories: string[]): RecipeMaterial | undefined {
  const recipe = pipelineJson(paths, "recipe.json", advisories);
  if (!recipe) return undefined;
  const request = isObject(recipe.request) ? recipe.request : {};
  const recipeId = text(request.recipeId, 64);
  if (!recipeId) {
    advisories.push("recipe: pipeline/recipe.json names no recipe.");
    return undefined;
  }
  const config = readJsonObject(path.join(paths.projectDir, "project.json"));
  const scenes = config && config !== "corrupt" && Array.isArray(config.scenes) ? config.scenes.filter(isObject) : [];
  const purposes = isObject(recipe.beatPurposes) ? recipe.beatPurposes : {};
  const placeholders = new Set(strings(recipe.placeholders, 64, 1024));
  const ids = scenes.length
    ? scenes.map((scene) => text(scene.id, 64)).filter((id): id is string => !!id)
    : Object.keys(purposes);
  const beats = ids.slice(0, 64).map((id) => {
    const scene = scenes.find((item) => item.id === id) ?? {};
    const image = text(scene.imageUrl, 1024);
    const visual = image && !/^https?:/i.test(image) ? projectMedia(paths, image) : undefined;
    const duration = count(scene.durationInFrames);
    return {
      id,
      ...(text(purposes[id], 500) ? { purpose: text(purposes[id], 500) } : {}),
      ...(text(scene.headline, 500) ? { headline: text(scene.headline, 500) } : {}),
      ...(text(scene.text, 2000) ? { text: text(scene.text, 2000) } : {}),
      ...(duration ? { durationInFrames: duration } : {}),
      ...(text(scene.transitionToNext, 64) ? { transitionToNext: text(scene.transitionToNext, 64) } : {}),
      ...(visual ? { visual } : {}),
      ...(image && placeholders.has(image) ? { placeholder: true } : {}),
    };
  });
  const formats = (Array.isArray(request.formats) ? request.formats : []).filter(
    (format): format is RecipeMaterial["formats"][number] => FORMAT_SET.has(String(format)),
  );
  const durationInFrames = count(recipe.durationInFrames);
  const material: RecipeMaterial = {
    recipeId,
    topic: bounded(request.topic, 500),
    formats: [...new Set(formats)].slice(0, 3),
    ...(durationInFrames ? { durationInFrames } : {}),
    productionReady: recipe.productionReady === true,
    findings: strings(recipe.findings, 32, 1000),
    ...(text(recipe.nextAction, 1000) ? { nextAction: text(recipe.nextAction, 1000) } : {}),
    beats,
  };
  return checked("recipe", RecipeMaterialSchema, material, advisories);
}

// --- Campaign ---

export function readCampaignMaterial(paths: ProjectPaths, advisories: string[]): CampaignMaterial | undefined {
  let state: ReturnType<typeof campaignReviewState>;
  try {
    state = campaignReviewState(paths.rootDir, paths.id);
  } catch (error) {
    advisories.push(`campaign: ${(error as Error)?.message ?? String(error)}`.slice(0, 2000));
    return undefined;
  }
  const material: CampaignMaterial = {
    campaignId: state.campaignId.slice(0, 128),
    planHash: state.planHash.slice(0, 128),
    reviewRevision: count(state.selection.revision),
    members: state.members.slice(0, 500).map((member) => {
      const tally = new Map<string, number>();
      for (const task of member.tasks) tally.set(task.state, (tally.get(task.state) ?? 0) + 1);
      return {
        id: member.id.slice(0, 128),
        language: (text(member.language, 32) ?? "und").slice(0, 32),
        ...(text(member.productId, 128) ? { productId: text(member.productId, 128) } : {}),
        heldForPilot: member.heldForPilot,
        excluded: member.excluded,
        ...(text(member.choice, 32) ? { choice: text(member.choice, 32) } : {}),
        tasks: [...tally]
          .slice(0, 16)
          .map(([taskState, n]) => ({ state: taskState.slice(0, 32) || "unknown", count: n })),
        outputs: member.outputs.length,
      };
    }),
  };
  return checked("campaign", CampaignMaterialSchema, material, advisories);
}
