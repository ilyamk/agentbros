/**
 * Reference requirements per shot (RFC 0003 §6.3, §9 `refs:plan`): draft, check, status and board for
 * `pipeline/references.json`, a revisable draft validated on every write. Spends nothing; reads entity cards, the
 * asset registry, derivative receipts and pack status (pack-status.ts), and writes only references.json and its
 * board.
 *
 * Slot assignment (shared by draft and check, since requirements carry no slot): see assignSlots().
 * Chaining rule (AC6, §3.10): see chainingFindings().
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { assertPathWithin, CliErrorObject } from "../cli";
import { readAssetRegistry } from "../assets/registry";
import { getEntityVersion, listEntities, resolveEntityReferences } from "../entities/service";
import { readDerivative } from "./derive/storage";
import { nextState, type MediaState } from "./derive/ops";
import { profileByFamily, profileForEndpoint } from "./profiles";
import { packState, type PackStatus } from "./pack-status";
import type { MediaFacts } from "./compile";
import type { AssetRecord } from "../../types/assets";
import type { EntityKind } from "../../types/entities";
import type { ReferenceProfile, Slot } from "../../types/reference-profiles";
import {
  ReferencesPlanSchema,
  ShotReferencesSchema,
  type DerivationStep,
  type Modality,
  type ReferenceRequirement,
  type ReferenceRole,
  type ReferenceSource,
  type ReferencesPlan,
  type ShotReferences,
} from "../../types/references";

export const REFERENCES_FILE = "pipeline/references.json";
export const REFERENCES_BOARD = "pipeline/references-board.html";
const MATERIAL_FILE = "pipeline/material.json";

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function projectDir(projectId: string, rootDir: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Invalid project id: ${projectId}` });
  const projects = path.join(path.resolve(rootDir), "public/projects");
  const dir = path.join(projects, projectId);
  assertPathWithin(projects, dir);
  if (!existsSync(dir))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
  return dir;
}
export const referencesFile = (projectId: string, rootDir = process.cwd()): string =>
  path.join(projectDir(projectId, rootDir), REFERENCES_FILE);

const issueText = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

/** The stored plan, or undefined when the project has none; VALIDATION when it does not parse. */
export function readReferencesPlan(projectId: string, rootDir = process.cwd()): ReferencesPlan | undefined {
  const file = referencesFile(projectId, rootDir);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliErrorObject({ code: "VALIDATION", message: `${REFERENCES_FILE} is not JSON: ${String(error)}` });
  }
  const parsed = ReferencesPlanSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${REFERENCES_FILE} is invalid: ${issueText(parsed.error.issues)}. Run pnpm refs:plan --project ${projectId} --action check.`,
    });
  return parsed.data;
}

/** Validates, then writes atomically (temp file, fsync, rename). Returns the file path. */
export function writeReferencesPlan(projectId: string, plan: unknown, rootDir = process.cwd()): string {
  const parsed = ReferencesPlanSchema.safeParse(plan);
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `References plan is invalid: ${issueText(parsed.error.issues)}`,
    });
  const file = referencesFile(projectId, rootDir);
  atomicText(file, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return file;
}

function atomicText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o644);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The plan with `shot` added, or replacing the shot of the same id. */
export function mergeShot(plan: ReferencesPlan | undefined, shot: ShotReferences): ReferencesPlan {
  const shots = (plan?.shots ?? []).filter((item) => item.shotId !== shot.shotId);
  const index = plan?.shots.findIndex((item) => item.shotId === shot.shotId) ?? -1;
  shots.splice(index >= 0 ? index : shots.length, 0, shot);
  return { schemaVersion: 1, shots };
}

// ---------------------------------------------------------------------------
// Targets and media facts
// ---------------------------------------------------------------------------

export type Target = { family?: string; endpoint?: string };
/** The profile of a target: by exact endpoint (fal, then higgsfield) or by family; an error when unknown or mismatched. */
export function resolveTarget(target: Target): { profile?: ReferenceProfile; error?: string } {
  if (target.endpoint) {
    const profile = profileForEndpoint(target.endpoint, "fal") ?? profileForEndpoint(target.endpoint, "higgsfield");
    if (!profile)
      return { error: `Endpoint ${target.endpoint} has no reference profile (pnpm refs:profiles --action list).` };
    if (target.family && target.family !== profile.family)
      return { error: `Endpoint ${target.endpoint} belongs to ${profile.family}, not ${target.family}.` };
    return { profile };
  }
  if (!target.family) return { error: "A target needs a family or an endpoint." };
  const profile = profileByFamily(target.family);
  return profile
    ? { profile }
    : { error: `No reference profile family ${target.family} (pnpm refs:profiles --action list).` };
}

type Registry = Map<string, AssetRecord>;
function registryOf(projectId: string, rootDir: string): Registry {
  try {
    return new Map(readAssetRegistry(projectId, rootDir).assets.map((asset) => [asset.id, asset]));
  } catch (error) {
    if (error instanceof CliErrorObject && error.code === "PROJECT_NOT_FOUND") throw error;
    return new Map();
  }
}
/** Measured facts as the asset registry records them (frameRate "30/1" → 30; hasAlpha "unknown" → absent). */
export function assetFacts(asset: AssetRecord): MediaFacts {
  const [numerator, denominator = 1] = (asset.media.frameRate ?? "").split("/").map(Number);
  const fps = numerator && denominator ? numerator / denominator : undefined;
  return {
    bytes: asset.files.bytes,
    contentType: asset.files.mime,
    ...(asset.media.width ? { width: asset.media.width } : {}),
    ...(asset.media.height ? { height: asset.media.height } : {}),
    ...(asset.media.durationSec !== undefined ? { durationSec: asset.media.durationSec } : {}),
    ...(fps && Number.isFinite(fps) ? { fps } : {}),
    ...(asset.media.hasAlpha === true ? { hasAlpha: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Slot assignment (shared by draft and check)
// ---------------------------------------------------------------------------

/** What assignment needs of a requirement: its role, modality and, for entity views, the entity and view role. */
export type SlotCandidate = {
  key: string;
  role: ReferenceRole;
  modality: Modality;
  entityKey?: string;
  viewRole?: string;
  required?: boolean;
};
export type SlotAssignment = {
  slots: Map<string, string>;
  findings: PlanFinding[];
  /** Elements built (one per entity group in a frontal element slot, plus video elements). */
  elements: number;
};

const templated = (slot: Slot) => slot.pointer.includes("{n}");
const arrayPointer = (slot: Slot) => /s$/.test(slot.pointer.split("/").pop() ?? "");
const accepts = (slot: Slot, c: SlotCandidate) => slot.modality === c.modality && slot.roles.includes(c.role);

/**
 * Assigns each requirement to one profile slot, in four passes:
 * 1. a non-element slot with `min ≥ 1` (Kling motion-control's character image) takes its best candidate first
 *    (required before optional, a `front` view before other views);
 * 2. identity views of one entity form a Kling-style element when the profile has an element frontal slot and an
 *    element reference slot and two or more of the entity's views are left: `front` (else `face-closeup`, else the
 *    first view) goes to the frontal slot, the next views (up to the reference slot's max) to the reference slot;
 * 3. every other requirement goes to the non-element slot accepting its role and modality with the most room,
 *    the requirements with the fewest possible slots first;
 * 4. totals: `totals.max` counts top-level references plus one per element; `totals.withVideoMaxImages`, when any
 *    video is attached, counts top-level images plus one per element (profiles.ts pointer conventions).
 * Element video slots are not filled from requirements (a character video is a top-level video requirement).
 */
export function assignSlots(profile: ReferenceProfile, candidates: SlotCandidate[], shotId?: string): SlotAssignment {
  const findings: PlanFinding[] = [];
  const slots = new Map<string, string>();
  const used = new Map<string, number>();
  const room = (slot: Slot) => slot.max - (used.get(slot.id) ?? 0);
  const put = (c: SlotCandidate, slot: Slot) => {
    slots.set(c.key, slot.id);
    used.set(slot.id, (used.get(slot.id) ?? 0) + 1);
  };
  const plain = profile.slots.filter((slot) => !templated(slot));
  const unplaceable = new Set<string>();
  for (const c of candidates) {
    if (!profile.slots.some((slot) => slot.modality === c.modality)) {
      findings.push(
        finding("over-limit", "error", `${profile.family} takes no ${c.modality} references.`, shotId, c.key, {
          modality: c.modality,
        }),
      );
      unplaceable.add(c.key);
    } else if (!profile.slots.some((slot) => accepts(slot, c))) {
      const roles = [
        ...new Set(profile.slots.filter((slot) => slot.modality === c.modality).flatMap((slot) => slot.roles)),
      ];
      findings.push(
        finding(
          "role-not-accepted-by-slot",
          "error",
          `No ${c.modality} slot of ${profile.family} accepts role ${c.role} (accepted: ${roles.join(", ")}).`,
          shotId,
          c.key,
        ),
      );
      unplaceable.add(c.key);
    }
  }
  const open = () => candidates.filter((c) => !slots.has(c.key) && !unplaceable.has(c.key));
  const rank = (c: SlotCandidate) => (c.required === false ? 2 : 0) + (c.viewRole === "front" ? 0 : 1);

  // 1. Mandatory plain slots.
  for (const slot of plain.filter((item) => item.min > 0)) {
    for (let n = 0; n < slot.min && room(slot) > 0; n++) {
      const pick = open()
        .filter((c) => accepts(slot, c))
        .sort((x, y) => rank(x) - rank(y))[0];
      if (pick) put(pick, slot);
    }
  }

  // 2. Elements.
  let elements = 0;
  const frontal = profile.slots.find((slot) => templated(slot) && !arrayPointer(slot) && slot.modality === "image");
  const references = profile.slots.find((slot) => templated(slot) && arrayPointer(slot) && slot.modality === "image");
  if (frontal && references) {
    const groups = new Map<string, SlotCandidate[]>();
    for (const c of open())
      if (c.entityKey && c.role === "identity" && c.modality === "image")
        groups.set(c.entityKey, [...(groups.get(c.entityKey) ?? []), c]);
    for (const views of groups.values()) {
      if (views.length < 2 || room(frontal) <= 0 || !accepts(frontal, views[0]!)) continue;
      const head =
        views.find((c) => c.viewRole === "front") ?? views.find((c) => c.viewRole === "face-closeup") ?? views[0]!;
      const rest = views.filter((c) => c !== head && accepts(references, c)).slice(0, references.max);
      if (rest.length < Math.max(1, references.min)) continue;
      put(head, frontal);
      for (const c of rest) {
        slots.set(c.key, references.id);
        used.set(references.id, (used.get(references.id) ?? 0) + 1);
      }
      elements++;
    }
  }

  // 3. The rest, most constrained first.
  const order = open()
    .map((c) => ({ c, options: plain.filter((slot) => accepts(slot, c)) }))
    .sort((x, y) => x.options.length - y.options.length || rank(x.c) - rank(y.c));
  for (const { c, options } of order) {
    const best = options.filter((slot) => room(slot) > 0).sort((x, y) => room(y) - room(x))[0];
    if (best) put(c, best);
    else {
      const capacity = options.reduce((sum, slot) => sum + slot.max, 0);
      findings.push(
        finding(
          "over-limit",
          "error",
          options.length
            ? `${c.modality} references with role ${c.role} exceed ${profile.family}'s slots (${options.map((slot) => `${slot.id} max ${slot.max}`).join(", ")}; ${capacity} in all).`
            : `Requirement ${c.key} (${c.role}) fits only an element slot of ${profile.family}; give the entity two or more views or drop it.`,
          shotId,
          c.key,
          { modality: c.modality },
        ),
      );
    }
  }
  for (const slot of plain)
    if ((used.get(slot.id) ?? 0) < slot.min)
      findings.push(
        finding(
          "slot-min-unmet",
          "error",
          `Slot ${slot.id} of ${profile.family} needs at least ${slot.min} ${slot.modality} reference(s) (${slot.roles.join("|")}).`,
          shotId,
        ),
      );

  // 4. Totals.
  const top = (modality?: Modality) =>
    candidates.filter((c) => {
      const slot = profile.slots.find((item) => item.id === slots.get(c.key));
      return slot && !templated(slot) && (!modality || slot.modality === modality);
    }).length;
  const total = top() + elements;
  if (profile.totals.max !== undefined && total > profile.totals.max)
    findings.push(
      finding(
        "over-limit",
        "error",
        `The shot has ${total} references (elements count once); ${profile.family} allows ${profile.totals.max}.`,
        shotId,
        undefined,
        { modality: "total" },
      ),
    );
  const withVideo = top("video") > 0;
  const images = top("image") + elements;
  if (withVideo && profile.totals.withVideoMaxImages !== undefined && images > profile.totals.withVideoMaxImages)
    findings.push(
      finding(
        "over-limit",
        "error",
        `With a video reference ${profile.family} allows ${profile.totals.withVideoMaxImages} images (elements count once); the shot has ${images}.`,
        shotId,
        undefined,
        { modality: "total" },
      ),
    );
  return { slots, findings, elements };
}

// ---------------------------------------------------------------------------
// Media limits (mirrors compile.ts checkMedia, without throwing) and the derivation steps that fix them
// ---------------------------------------------------------------------------

export type MediaProblem = { problem: string; step?: DerivationStep };
const even = (value: number) => Math.max(2, 2 * Math.round(value / 2));

/** What keeps `facts` out of `slot`, each with the derivation step that fixes it when one exists. */
export function mediaProblems(slot: Slot, facts: MediaFacts, options: { skipBytes?: boolean } = {}): MediaProblem[] {
  const problems: MediaProblem[] = [];
  const modality = slot.modality;
  if (slot.formats && !slot.formats.includes(facts.contentType))
    problems.push({ problem: `${facts.contentType} is not an accepted format (${slot.formats.join(", ")})` });
  if (modality !== "image") {
    const d = slot.durationSec;
    if (d && facts.durationSec !== undefined) {
      if (facts.durationSec < d.min)
        problems.push({ problem: `duration ${facts.durationSec} s is below ${d.min} s; choose a longer source` });
      if (facts.durationSec > d.max)
        problems.push({
          problem: `duration ${facts.durationSec} s exceeds ${d.max} s`,
          step:
            modality === "audio"
              ? { op: "audio-trim", startSec: 0, durationSec: d.max }
              : { op: "trim", startSec: 0, durationSec: d.max },
        });
    }
    if (
      modality === "video" &&
      slot.fps &&
      facts.fps !== undefined &&
      (facts.fps < slot.fps[0] || facts.fps > slot.fps[1])
    )
      problems.push({
        problem: `${facts.fps} fps is outside ${slot.fps[0]}–${slot.fps[1]} fps`,
        step: { op: "fps", fps: Math.min(slot.fps[1], Math.max(slot.fps[0], 30)) },
      });
  }
  if (modality !== "audio" && slot.pixels && facts.width && facts.height) {
    let { width: w, height: h } = facts;
    const p = slot.pixels;
    if (p.aspect && (w / h < p.aspect[0] - 1e-9 || w / h > p.aspect[1] + 1e-9)) {
      const target = w / h > p.aspect[1] ? p.aspect[1] : p.aspect[0];
      const cw = w / h > target ? even(Math.floor(h * target)) : w;
      const ch = w / h > target ? h : even(Math.floor(w / target));
      problems.push({
        problem: `aspect ${(w / h).toFixed(3)} is outside ${p.aspect[0]}–${p.aspect[1]}`,
        step: { op: "crop", x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2), width: cw, height: ch },
      });
      [w, h] = [cw, ch];
    }
    const short = Math.min(w, h),
      long = Math.max(w, h);
    const factor =
      p.minEdge !== undefined && short < p.minEdge
        ? p.minEdge / short
        : p.maxEdge !== undefined && long > p.maxEdge
          ? p.maxEdge / long
          : undefined;
    if (factor !== undefined) {
      const sw = factor > 1 ? Math.ceil(w * factor) : Math.floor(w * factor);
      const sh = factor > 1 ? Math.ceil(h * factor) : Math.floor(h * factor);
      const [width, height] = modality === "video" ? [even(sw), even(sh)] : [sw, sh];
      problems.push({
        problem:
          factor > 1
            ? `short edge ${short} px is below ${p.minEdge} px`
            : `long edge ${long} px exceeds ${p.maxEdge} px`,
        step: { op: "scale", width, height, fit: "exact" },
      });
      [w, h] = [width, height];
    }
    if (p.multipleOf !== undefined && (w % p.multipleOf || h % p.multipleOf))
      problems.push({
        problem: `${w}×${h} is not a multiple of ${p.multipleOf}`,
        step: { op: "snap", multipleOf: p.multipleOf },
      });
  }
  if (!options.skipBytes && slot.maxBytes !== undefined && facts.bytes > slot.maxBytes)
    problems.push({
      problem: `${facts.bytes} bytes exceed ${slot.maxBytes}; scale or shorten the source until it fits`,
    });
  if (facts.hasAlpha && modality === "image" && slot.alpha === "flatten")
    problems.push({
      problem: "it has transparency, which this slot does not accept",
      step: { op: "flatten", background: "#ffffff" },
    });
  return problems;
}

const kindOf = (facts: MediaFacts): MediaState["kind"] =>
  facts.contentType.startsWith("image/") ? "image" : facts.contentType.startsWith("audio/") ? "audio" : "video";

/** Facts predicted after `prepare` (derive/ops nextState), or the refusal of the first step that cannot apply. */
export function factsAfter(facts: MediaFacts, prepare: DerivationStep[]): { facts?: MediaFacts; error?: string } {
  if (!prepare.length) return { facts };
  let state: MediaState = {
    kind: kindOf(facts),
    ...(facts.width ? { width: facts.width } : {}),
    ...(facts.height ? { height: facts.height } : {}),
    ...(facts.fps ? { fps: facts.fps } : {}),
    ...(facts.durationSec !== undefined ? { durationSec: facts.durationSec } : {}),
    hasAudio: kindOf(facts) === "audio",
    hasAlpha: facts.hasAlpha === true,
  };
  try {
    prepare.forEach((step, index) => (state = nextState(index, step, state)));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const contentType =
    state.kind === kindOf(facts)
      ? facts.contentType
      : state.kind === "image"
        ? "image/png"
        : state.kind === "audio"
          ? "audio/wav"
          : "video/mp4";
  return {
    facts: {
      bytes: facts.bytes,
      contentType,
      ...(state.width ? { width: state.width } : {}),
      ...(state.height ? { height: state.height } : {}),
      ...(state.durationSec !== undefined ? { durationSec: state.durationSec } : {}),
      ...(state.fps ? { fps: state.fps } : {}),
      ...(state.hasAlpha ? { hasAlpha: true } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

export type Resolution =
  | { state: "resolved"; assetId: string; facts: MediaFacts; original: string }
  | { state: "unapproved"; message: string; command: string }
  | { state: "pending"; message: string; command: string }
  | { state: "unresolvable"; message: string; command: string };

type Context = {
  projectId: string;
  rootDir: string;
  registry: Registry;
  plan?: ReferencesPlan;
  cache: Map<string, Resolution>;
};
const contextFor = (projectId: string, rootDir: string, plan?: ReferencesPlan): Context => ({
  projectId,
  rootDir,
  registry: registryOf(projectId, rootDir),
  ...(plan ? { plan } : {}),
  cache: new Map(),
});

const cardCommand = (
  c: Context,
  kind: string,
  id: string,
  action: "create" | "revise" | "approve",
  revision?: number,
) =>
  action === "approve"
    ? `pnpm entity:card --project ${c.projectId} --action approve --kind ${kind} --id ${id} --revision ${revision} (the user's own approval)`
    : `pnpm entity:card --project ${c.projectId} --action ${action} --input <card.json>${action === "revise" ? " --expected-revision <n>" : ""}`;
const importCommand = (c: Context) => `pnpm asset:import --project ${c.projectId} --input <file> --origin <origin>`;

function fromAsset(c: Context, assetId: string): Resolution {
  const asset = c.registry.get(assetId);
  if (!asset)
    return {
      state: "unresolvable",
      message: `asset ${assetId} is not in the asset registry`,
      command: importCommand(c),
    };
  return { state: "resolved", assetId, facts: assetFacts(asset), original: asset.files.original };
}

export function resolveSource(c: Context, source: ReferenceSource, shotId?: string): Resolution {
  const cacheKey = JSON.stringify(source);
  const cached = c.cache.get(cacheKey);
  if (cached && source.kind !== "shot-output") return cached;
  let result: Resolution;
  switch (source.kind) {
    case "asset":
      result = fromAsset(c, source.assetId);
      break;
    case "derivative":
      try {
        const derivative = readDerivative(c.projectId, source.derivativeId, c.rootDir);
        const resolved = fromAsset(c, derivative.receipt.output.assetId);
        result =
          resolved.state === "resolved"
            ? resolved
            : {
                state: "unresolvable",
                message: `derivative ${source.derivativeId}'s output is not in the asset registry`,
                command: `pnpm refs:derive --project ${c.projectId} --action show --id ${source.derivativeId}`,
              };
      } catch (error) {
        const code = error instanceof CliErrorObject ? error.code : undefined;
        result =
          code === "STAGE_INCOMPLETE"
            ? {
                state: "pending",
                message: `derivative ${source.derivativeId} has not run`,
                command: `pnpm refs:derive --project ${c.projectId} --action run --spec <spec.json>`,
              }
            : {
                state: "unresolvable",
                message: `derivative ${source.derivativeId}: ${error instanceof Error ? error.message : String(error)}`,
                command: `pnpm refs:derive --project ${c.projectId} --action plan --spec <spec.json>`,
              };
      }
      break;
    case "shot-output": {
      const exists = c.plan?.shots.some((shot) => shot.shotId === source.shotId);
      result =
        !exists || source.shotId === shotId
          ? {
              state: "unresolvable",
              message: `shot ${source.shotId} is ${source.shotId === shotId ? "this shot itself" : "not in references.json"}`,
              command: `pnpm refs:plan --project ${c.projectId} --action draft --shot ${source.shotId} ...`,
            }
          : {
              state: "pending",
              message: `the ${source.frame} frame of shot ${source.shotId} does not exist until that shot is generated`,
              command: `generate shot ${source.shotId}, then pnpm refs:derive --project ${c.projectId} --action run --spec <extract-frame ${source.frame} spec.json> and use the derivative as the source`,
            };
      break;
    }
    case "entity": {
      const { entityId, kind, revision } = source.entity;
      try {
        const view = getEntityVersion(c.projectId, kind, entityId, { revision, rootDir: c.rootDir });
        const snapshot = view.version.referenceSnapshots.find((item) => item.role === source.viewRole);
        if (!snapshot)
          result = {
            state: "unresolvable",
            message: `${kind} ${entityId}@${revision} has no ${source.viewRole} view`,
            command: cardCommand(c, kind, entityId, "revise"),
          };
        else if (view.status !== "approved")
          result = {
            state: "unapproved",
            message: `${kind} ${entityId}@${revision} is not approved`,
            command: cardCommand(c, kind, entityId, "approve", revision),
          };
        else {
          resolveEntityReferences(c.projectId, source.entity, c.rootDir);
          result = fromAsset(c, snapshot.assetId);
        }
      } catch (error) {
        result = {
          state: "unresolvable",
          message: `${kind} ${entityId}@${revision}: ${error instanceof Error ? error.message : String(error)}`,
          command: cardCommand(c, kind, entityId, "create"),
        };
      }
      break;
    }
  }
  c.cache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Check (AC6)
// ---------------------------------------------------------------------------

export type PlanFindingCode =
  | "schema-invalid"
  | "duplicate-shot-id"
  | "ready-without-source"
  | "unknown-target"
  | "over-limit"
  | "role-not-accepted-by-slot"
  | "slot-min-unmet"
  | "unresolvable-source"
  | "media-outside-limits"
  | "chaining-without-anchor"
  | "real-face-policy";
export type PlanFinding = {
  code: PlanFindingCode;
  severity: "error" | "warning";
  shotId?: string;
  requirementKey?: string;
  message: string;
  /** over-limit: the modality ("image", "video", "audio") or "total". */
  modality?: string;
  /** media-outside-limits: the derivation step that fixes it, when one exists. */
  fix?: DerivationStep;
  command?: string;
};
function finding(
  code: PlanFindingCode,
  severity: PlanFinding["severity"],
  message: string,
  shotId?: string,
  requirementKey?: string,
  extra: Partial<PlanFinding> = {},
): PlanFinding {
  return {
    code,
    severity,
    message,
    ...(shotId ? { shotId } : {}),
    ...(requirementKey ? { requirementKey } : {}),
    ...extra,
  };
}
export type PlanCheck = { ok: boolean; errors: number; warnings: number; shots: number; findings: PlanFinding[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const candidateOf = (requirement: ReferenceRequirement): SlotCandidate => ({
  key: requirement.key,
  role: requirement.role,
  modality: requirement.modality,
  required: requirement.required,
  ...(requirement.source?.kind === "entity"
    ? {
        entityKey: `${requirement.source.entity.kind}/${requirement.source.entity.entityId}`,
        viewRole: requirement.source.viewRole,
      }
    : {}),
});

/**
 * Chaining (§3.10: last-frame chaining drifts unless the originals are re-attached). Under
 * `first-from-previous-last`, and equally under `anchor-reinject`, the shot must carry at least one identity
 * requirement, and every identity requirement must be anchored: its source is an entity view, an imported asset or
 * a derivative, never a shot output and never absent. Any identity requirement sourced from a shot output is
 * reported whatever the chaining mode.
 */
export function chainingFindings(shot: ShotReferences): PlanFinding[] {
  const identity = shot.requirements.filter((requirement) => requirement.role === "identity");
  const fromOutput = identity.filter((requirement) => requirement.source?.kind === "shot-output");
  const out = fromOutput.map((requirement) =>
    finding(
      "chaining-without-anchor",
      "error",
      `Identity requirement ${requirement.key} takes the face from another shot's output; re-attach the card's view (entity source) instead.`,
      shot.shotId,
      requirement.key,
    ),
  );
  if (shot.chaining === "none") return out;
  const unanchored = identity.filter((requirement) => !requirement.source);
  if (!identity.length || unanchored.length)
    out.push(
      finding(
        "chaining-without-anchor",
        "error",
        !identity.length
          ? `Shot ${shot.shotId} chains (${shot.chaining}) with no identity requirement: re-attach the original identity references in every chained shot.`
          : `Shot ${shot.shotId} chains (${shot.chaining}) but ${unanchored.map((r) => r.key).join(", ")} have no anchored source.`,
        shot.shotId,
      ),
    );
  return out;
}

/** Validates a references plan (raw JSON) and reports every finding; never throws on plan content. */
export function checkReferencesPlan(projectId: string, input: unknown, rootDir = process.cwd()): PlanCheck {
  const findings: PlanFinding[] = [];
  // Pre-pass: turn the schema's own refinements into findings, then check a cleaned copy.
  const copy: unknown = structuredClone(input);
  if (isRecord(copy) && Array.isArray(copy["shots"])) {
    const seen = new Set<unknown>();
    copy["shots"] = (copy["shots"] as unknown[]).filter((shot) => {
      if (!isRecord(shot)) return true;
      if (seen.has(shot["shotId"])) {
        findings.push(
          finding(
            "duplicate-shot-id",
            "error",
            `Shot ${String(shot["shotId"])} appears more than once.`,
            String(shot["shotId"]),
          ),
        );
        return false;
      }
      seen.add(shot["shotId"]);
      if (Array.isArray(shot["requirements"]))
        for (const requirement of shot["requirements"] as unknown[])
          if (isRecord(requirement) && requirement["status"] === "ready" && requirement["source"] === undefined) {
            findings.push(
              finding(
                "ready-without-source",
                "error",
                `Requirement ${String(requirement["key"])} is ready but has no source.`,
                String(shot["shotId"]),
                String(requirement["key"]),
              ),
            );
            requirement["status"] = "missing";
          }
      return true;
    });
  }
  const parsed = ReferencesPlanSchema.safeParse(copy);
  let plan: ReferencesPlan;
  if (parsed.success) plan = parsed.data;
  else {
    const shots: ShotReferences[] = [];
    const rawShots = isRecord(copy) && Array.isArray(copy["shots"]) ? (copy["shots"] as unknown[]) : [];
    for (const issue of parsed.error.issues)
      if (!(issue.path[0] === "shots" && typeof issue.path[1] === "number"))
        findings.push(finding("schema-invalid", "error", issueText([issue])));
    rawShots.forEach((raw, index) => {
      const shot = ShotReferencesSchema.safeParse(raw);
      if (shot.success) shots.push(shot.data);
      else
        findings.push(
          finding(
            "schema-invalid",
            "error",
            `shots.${index}: ${issueText(shot.error.issues)}`,
            isRecord(raw) ? String(raw["shotId"]) : undefined,
          ),
        );
    });
    plan = { schemaVersion: 1, shots };
  }
  const context = contextFor(projectId, rootDir, plan);
  for (const shot of plan.shots) findings.push(...checkShot(context, shot));
  const errors = findings.filter((item) => item.severity === "error").length;
  return { ok: errors === 0, errors, warnings: findings.length - errors, shots: plan.shots.length, findings };
}

function checkShot(c: Context, shot: ShotReferences): PlanFinding[] {
  const out: PlanFinding[] = [...chainingFindings(shot)];
  const target = resolveTarget(shot.target);
  for (const requirement of shot.requirements)
    if (requirement.source) {
      const resolution = resolveSource(c, requirement.source, shot.shotId);
      if (resolution.state === "unresolvable")
        out.push(
          finding(
            "unresolvable-source",
            "error",
            `${requirement.key}: ${resolution.message}.`,
            shot.shotId,
            requirement.key,
            {
              command: resolution.command,
            },
          ),
        );
      else if (requirement.status === "ready" && resolution.state !== "resolved")
        out.push(
          finding(
            "unresolvable-source",
            "error",
            `${requirement.key} is ready but ${resolution.message}.`,
            shot.shotId,
            requirement.key,
            {
              command: resolution.command,
            },
          ),
        );
    }
  if (!target.profile) {
    out.push(finding("unknown-target", "error", target.error!, shot.shotId));
    return out;
  }
  const profile = target.profile;
  const assignment = assignSlots(profile, shot.requirements.map(candidateOf), shot.shotId);
  out.push(...assignment.findings);
  for (const requirement of shot.requirements) {
    const slot = profile.slots.find((item) => item.id === assignment.slots.get(requirement.key));
    if (!slot || !requirement.source) continue;
    const resolution = resolveSource(c, requirement.source, shot.shotId);
    if (resolution.state !== "resolved") continue;
    const after = factsAfter(resolution.facts, requirement.prepare);
    const severity = requirement.status === "ready" ? "error" : "warning";
    if (after.error) {
      out.push(
        finding(
          "media-outside-limits",
          "error",
          `${requirement.key}: its prepare steps cannot apply: ${after.error}`,
          shot.shotId,
          requirement.key,
        ),
      );
      continue;
    }
    for (const problem of mediaProblems(slot, after.facts!, { skipBytes: requirement.prepare.length > 0 }))
      out.push(
        finding(
          "media-outside-limits",
          severity,
          `${requirement.key} (slot ${slot.id}): ${problem.problem}${problem.step ? `; fix with a "${problem.step.op}" derivative` : ""}.`,
          shot.shotId,
          requirement.key,
          {
            ...(problem.step ? { fix: problem.step } : {}),
            command: `pnpm refs:derive --project ${c.projectId} --action plan --spec <spec.json>`,
          },
        ),
      );
  }
  if (profile.policies.realFaces === "rejected")
    for (const requirement of shot.requirements) {
      const source = requirement.source;
      if (source?.kind !== "entity" || source.entity.kind !== "character") continue;
      try {
        const card = getEntityVersion(c.projectId, "character", source.entity.entityId, {
          revision: source.entity.revision,
          rootDir: c.rootDir,
        }).version.card;
        if (card.kind === "character" && card.likenessConsent?.status === "documented")
          out.push(
            finding(
              "real-face-policy",
              "error",
              `${requirement.key}: ${card.name} is a real person with documented likeness consent, and ${profile.family} rejects real faces (D11). Choose a profile that permits real faces, or stop and ask the user.`,
              shot.shotId,
              requirement.key,
            ),
          );
      } catch {
        // Unresolvable sources are reported above.
      }
    }
  return out;
}

// ---------------------------------------------------------------------------
// Draft (AC5)
// ---------------------------------------------------------------------------

export type EntityPick = { kind: EntityKind; entityId: string; revision?: number };
export type AssetPick = { role: ReferenceRole; assetId: string };
export type DraftArgs = {
  projectId: string;
  shotId: string;
  materialItemId: string;
  intent: ShotReferences["intent"];
  family?: string;
  endpoint?: string;
  entities?: EntityPick[];
  /** Imported assets by role: first-frame, last-frame, motion, source-video, voice, music… */
  assets?: AssetPick[];
  /** This shot opens on the last frame of that shot (chaining "anchor-reinject"). */
  chainFrom?: string;
  rootDir?: string;
};
export type DraftResult = {
  shot: ShotReferences;
  profile: string;
  dropped: { key: string; reason: string }[];
  notes: string[];
  findings: PlanFinding[];
};

/** "character:mara", "character:mara@2"; also accepts a comma-separated list. */
export function parseEntityPicks(values: string[]): EntityPick[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const match = /^(character|object|location|style|scene):([A-Za-z0-9][A-Za-z0-9_-]*)(?:@(\d+))?$/.exec(value);
      if (!match)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `--entity takes kind:id[@revision], not "${value}".`,
        });
      return { kind: match[1] as EntityKind, entityId: match[2]!, ...(match[3] ? { revision: Number(match[3]) } : {}) };
    });
}
/** "first-frame:sha256:<hex>"; also accepts a comma-separated list. */
export function parseAssetPicks(values: string[]): AssetPick[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const match = /^([a-z-]+):(sha256:[a-f0-9]{64})$/.exec(value);
      if (!match)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `--asset takes role:sha256:<hex>, not "${value}".`,
        });
      return { role: match[1] as ReferenceRole, assetId: match[2]! };
    });
}

type Proposal = {
  key: string;
  role: ReferenceRole;
  modality: Modality;
  required: boolean;
  source?: ReferenceSource;
  roleSentence: string;
  speech?: ReferenceRequirement["speech"];
  prepare?: DerivationStep[];
  notes?: string;
  entityKey?: string;
  viewRole?: string;
  /** Status forced by the draft (missing entity, pending chain). */
  status?: ReferenceRequirement["status"];
};

const slugKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "ref";
const cap = (text: string) => (text.length > 400 ? `${text.slice(0, 397)}...` : text);
const ANGLES: string[][] = [
  ["front"],
  ["three-quarter-left", "three-quarter-right"],
  ["profile-left", "profile-right"],
  ["face-closeup"],
  ["back"],
  ["full-body"],
];
const VIDEO_ROLES = new Set<ReferenceRole>([
  "motion",
  "performance",
  "camera",
  "source-video",
  "depth",
  "pose",
  "edge",
  "mask",
]);
const AUDIO_ROLES = new Set<ReferenceRole>(["voice", "sound", "music"]);
const modalityOfRole = (role: ReferenceRole): Modality =>
  AUDIO_ROLES.has(role) ? "audio" : VIDEO_ROLES.has(role) ? "video" : "image";

/** The first role of `prefer` that a slot of `modality` accepts. */
const pickRole = (profile: ReferenceProfile, modality: Modality, prefer: ReferenceRole[]) =>
  prefer.find((role) => profile.slots.some((slot) => slot.modality === modality && slot.roles.includes(role)));

/** Proposes a ShotReferences for one shot from its intent, target profile, linked cards and imported assets. */
export function draftShotReferences(args: DraftArgs): DraftResult {
  const rootDir = args.rootDir ?? process.cwd();
  const target = resolveTarget({ family: args.family, endpoint: args.endpoint });
  if (!target.profile) throw new CliErrorObject({ code: "INVALID_INPUT", message: target.error! });
  const profile = target.profile;
  const existing = readReferencesPlan(args.projectId, rootDir);
  const c = contextFor(args.projectId, rootDir, existing);
  const notes: string[] = [];
  const dropped: DraftResult["dropped"] = [];
  const assets = [...(args.assets ?? [])];
  const takeAsset = (roles: ReferenceRole[]) => {
    const index = assets.findIndex((asset) => roles.includes(asset.role));
    return index >= 0 ? assets.splice(index, 1)[0] : undefined;
  };
  const primary: Proposal[] = [];
  const subjects: Proposal[] = [];
  const extras: Proposal[][] = [];
  const optional: Proposal[] = [];

  /** An intent's media input: the role the profile accepts, an imported asset when given, else missing. */
  const media = (
    key: string,
    modality: Modality,
    prefer: ReferenceRole[],
    roleSentence: string,
    required: boolean,
    into: Proposal[],
    extra: Partial<Proposal> = {},
  ) => {
    const role = pickRole(profile, modality, prefer);
    if (!role) {
      if (required)
        notes.push(`${profile.family} has no ${modality} slot for ${prefer.join("/")}: the ${key} input is left out.`);
      else dropped.push({ key, reason: `${profile.family} has no ${modality} slot for ${prefer.join("/")}` });
      return;
    }
    const asset = takeAsset(prefer);
    into.push({
      key,
      role,
      modality,
      required,
      roleSentence,
      ...(asset ? { source: { kind: "asset", assetId: asset.assetId } } : {}),
      ...extra,
    });
  };

  // Intent inputs.
  const firstFrame = (required: boolean) => {
    if (args.chainFrom) {
      const role = pickRole(profile, "image", ["first-frame", "keyframe"]);
      if (role)
        primary.push({
          key: "first-frame",
          role,
          modality: "image",
          required,
          roleSentence: `the opening frame, continuing the last frame of shot ${args.chainFrom}`,
          source: { kind: "shot-output", shotId: args.chainFrom, frame: "last" },
        });
      else notes.push(`${profile.family} has no first-frame slot; shot ${args.chainFrom} cannot be chained here.`);
    } else
      media(
        "first-frame",
        "image",
        ["first-frame", "keyframe"],
        "the opening frame of the shot: composition, subject and light",
        required,
        primary,
      );
  };
  switch (args.intent) {
    case "image-to-video":
      firstFrame(true);
      media("last-frame", "image", ["last-frame"], "the closing frame the shot moves towards", false, optional);
      break;
    case "motion-transfer":
      media(
        "motion",
        "video",
        ["motion", "performance", "source-video"],
        "the movement and timing of the performer, not their look or setting",
        true,
        primary,
      );
      break;
    case "character-replace":
    case "video-edit":
      media(
        "source-video",
        "video",
        ["source-video", "motion", "performance"],
        "the source video to change; everything not named stays as it is",
        true,
        primary,
      );
      break;
    case "extend":
      media("source-video", "video", ["source-video", "motion"], "the shot to continue", true, primary);
      break;
    case "control-to-video": {
      const role = pickRole(profile, "video", ["pose", "depth", "edge"]);
      if (role) media("control", "video", [role], `the ${role} sequence that drives the movement`, true, primary);
      else {
        notes.push(
          `${profile.family} has no pose, depth or edge slot: the control video is carried as motion, prepared with a pose-video derivative.`,
        );
        media(
          "control",
          "video",
          ["motion", "performance"],
          "the pose sequence that drives the movement, not the look of its performer",
          true,
          primary,
          {
            prepare: [{ op: "pose-video", engine: "local" }],
          },
        );
      }
      break;
    }
    case "lip-sync":
      media("voice", "audio", ["voice", "sound"], "the spoken line, with its timing", true, primary);
      if (profile.slots.some((slot) => slot.modality === "video"))
        media(
          "source-video",
          "video",
          ["source-video", "performance"],
          "the face and performance to sync",
          true,
          primary,
        );
      else firstFrame(true);
      break;
    case "voice":
      media("voice", "audio", ["voice", "sound"], "the voice to speak with", true, primary);
      break;
    case "reference-to-video":
    case "keyframe-image":
      if (args.chainFrom) firstFrame(true);
      break;
  }
  if (args.chainFrom && !["image-to-video", "lip-sync", "reference-to-video", "keyframe-image"].includes(args.intent))
    firstFrame(true);

  // Linked cards.
  const voiceIntent = ["reference-to-video", "lip-sync", "voice"].includes(args.intent);
  for (const pick of args.entities ?? []) {
    let revision = pick.revision;
    if (revision === undefined) {
      const manifest = safeList(args.projectId, rootDir).find(
        (item) => item.kind === pick.kind && item.id === pick.entityId,
      );
      revision = manifest?.canonicalRevision ?? manifest?.latestRevision;
    }
    const base = slugKey(pick.entityId);
    let card;
    try {
      if (revision === undefined) throw new Error("not found");
      card = getEntityVersion(args.projectId, pick.kind, pick.entityId, { revision, rootDir }).version;
    } catch {
      const role: ReferenceRole =
        pick.kind === "location"
          ? "location"
          : pick.kind === "style"
            ? "style"
            : pick.kind === "object"
              ? "product"
              : "identity";
      subjects.push({
        key: `${base}-${role}`,
        role,
        modality: "image",
        required: true,
        status: "missing",
        roleSentence: `${pick.kind} ${pick.entityId}`,
        notes: `No ${pick.kind} card ${pick.entityId}: ${cardCommand(c, pick.kind, pick.entityId, "create")}.`,
      });
      continue;
    }
    const ref = { entityId: pick.entityId, kind: pick.kind, revision: revision! };
    const name = card.card.name;
    const fixed = card.card.fixedSentence ? ` ${card.card.fixedSentence}` : "";
    const views = card.referenceSnapshots.map((item) => item.role);
    const entityKey = `${pick.kind}/${pick.entityId}`;
    const view = (viewRole: string, role: ReferenceRole, sentence: string, required: boolean): Proposal => ({
      key: slugKey(`${pick.entityId}-${viewRole}`),
      role,
      modality: "image",
      required,
      source: { kind: "entity", entity: ref, viewRole },
      roleSentence: cap(`${sentence}${fixed}`),
      entityKey,
      viewRole,
    });
    if (pick.kind === "character") {
      const role = pickRole(profile, "image", ["identity"]);
      const chosen = ANGLES.map((group) => group.find((angle) => views.includes(angle))).filter(
        (angle): angle is string => !!angle,
      );
      if (!chosen.length && views.length) chosen.push(views[0]!);
      if (role && chosen.length) {
        const [head, ...rest] = chosen;
        subjects.push(view(head!, role, `the face, hair and build of ${name} (${head} view).`, true));
        extras.push(
          rest.map((angle) => view(angle, role, `the face, hair and build of ${name} (${angle} view).`, false)),
        );
      } else if (role)
        subjects.push({
          key: `${base}-identity`,
          role,
          modality: "image",
          required: true,
          status: "missing",
          roleSentence: cap(`the face, hair and build of ${name}.${fixed}`),
          notes: `${name}'s card has no reference views: ${cardCommand(c, pick.kind, pick.entityId, "revise")}.`,
        });
      else if (args.intent !== "voice")
        notes.push(`${profile.family} takes no identity images; ${name} is described in the prompt only.`);
      const samples = card.card.kind === "character" ? (card.card.voice?.sampleAssetIds ?? []) : [];
      const voiceRole = pickRole(profile, "audio", ["voice"]);
      if (
        voiceIntent &&
        profile.speechInput !== "drive" &&
        args.intent !== "lip-sync" &&
        voiceRole &&
        samples.length &&
        !primary.some((item) => item.role === "voice" && item.source)
      )
        (args.intent === "reference-to-video" ? subjects : primary).push({
          key: `${base}-voice`,
          role: voiceRole,
          modality: "audio",
          required: args.intent !== "reference-to-video",
          source: { kind: "asset", assetId: samples[0]! },
          speech: { kind: "voice-sample" },
          roleSentence: cap(`the voice of ${name}: timbre and delivery, not the words of the sample.`),
        });
    } else if (pick.kind === "location") {
      const plate =
        ["plate-wide", "plate-medium", "plate-reverse"].find((item) => views.includes(item)) ??
        views.find((item) => item.startsWith("plate:"));
      const role = pickRole(profile, "image", ["location"]);
      if (role && plate) subjects.push(view(plate, role, `the place and light of ${name}, without its people.`, true));
      else if (role)
        subjects.push({
          key: `${base}-plate`,
          role,
          modality: "image",
          required: true,
          status: "missing",
          roleSentence: cap(`the place and light of ${name}, without its people.${fixed}`),
          notes: `${name}'s card has no plate view: ${cardCommand(c, pick.kind, pick.entityId, "revise")}.`,
        });
      else dropped.push({ key: `${base}-plate`, reason: `${profile.family} takes no location images` });
    } else if (pick.kind === "style") {
      const board = ["style-board", "palette"].find((item) => views.includes(item));
      const role = pickRole(profile, "image", ["style"]);
      if (role && board)
        optional.push(view(board, role, `the look of ${name}: palette, texture and light, not its subjects.`, false));
      else
        dropped.push({
          key: `${base}-style`,
          reason: role ? `${name}'s card has no style board` : `${profile.family} takes no style images`,
        });
    } else if (pick.kind === "object") {
      const role = pickRole(profile, "image", ["product", "prop"]);
      const shot = ["packshot-front", "packshot-three-quarter", "label-detail"].filter((item) => views.includes(item));
      if (role && shot.length) {
        subjects.push(view(shot[0]!, role, `the shape, label and materials of ${name}.`, true));
        extras.push(
          shot.slice(1).map((item) => view(item, role, `the shape, label and materials of ${name} (${item}).`, false)),
        );
      } else
        dropped.push({
          key: `${base}-product`,
          reason: role ? `${name}'s card has no packshot` : `${profile.family} takes no product images`,
        });
    } else notes.push(`Scene card ${pick.entityId} carries action and blocking for the prompt, not a reference input.`);
  }
  // Remaining imported assets keep their own role.
  for (const asset of assets) {
    const registered = c.registry.get(asset.assetId);
    const modality =
      registered && ["image", "video", "audio"].includes(registered.kind)
        ? (registered.kind as Modality)
        : modalityOfRole(asset.role);
    optional.push({
      key: slugKey(`${asset.role}-${asset.assetId.slice(7, 15)}`),
      role: asset.role,
      modality,
      required: false,
      source: { kind: "asset", assetId: asset.assetId },
      roleSentence: `the ${asset.role} reference`,
    });
  }

  // Extra views round-robin across subjects, so every character gets a second angle before any gets a third.
  const rounds: Proposal[] = [];
  for (let round = 0; extras.some((list) => list.length > round); round++)
    for (const list of extras) if (list[round]) rounds.push(list[round]!);
  const ordered = [...primary, ...subjects, ...rounds, ...optional];
  const required = ordered.filter((item) => item.required);
  const rest = ordered.filter((item) => !item.required);

  // Accept required first, then optional, each only while the profile still fits.
  const accepted: Proposal[] = [];
  const fits = (list: Proposal[]) =>
    !assignSlots(profile, list.map(toCandidate)).findings.some(
      (item) => item.code === "over-limit" || item.code === "role-not-accepted-by-slot",
    );
  for (const proposal of [...required, ...rest]) {
    if (accepted.some((item) => item.key === proposal.key)) {
      dropped.push({ key: proposal.key, reason: "duplicate key" });
      continue;
    }
    if (fits([...accepted, proposal])) accepted.push(proposal);
    else dropped.push({ key: proposal.key, reason: `${profile.family}'s slots or totals are full` });
  }
  // Views that fit only together (an element needs a frontal image and at least one reference): retry each
  // entity's dropped views as a group, largest first.
  for (const entityKey of new Set(rest.map((item) => item.entityKey).filter((key): key is string => !!key))) {
    const views = rest.filter((item) => item.entityKey === entityKey && dropped.some((d) => d.key === item.key));
    for (let size = views.length; size >= 2; size--) {
      const group = views.slice(0, size);
      if (!fits([...accepted, ...group])) continue;
      accepted.push(...group);
      for (const item of group)
        dropped.splice(
          dropped.findIndex((d) => d.key === item.key),
          1,
        );
      break;
    }
  }
  if (!accepted.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `No reference requirement fits ${profile.family} for a ${args.intent} shot. Use referencePlan {mode: "none", reason} on the material item if the shot needs none.`,
      details: { dropped, notes },
    });
  const assignment = assignSlots(profile, accepted.map(toCandidate), args.shotId);
  const requirements: ReferenceRequirement[] = accepted.map((proposal) => {
    const slot = profile.slots.find((item) => item.id === assignment.slots.get(proposal.key));
    return requirementOf(c, proposal, slot, args.shotId);
  });
  const shot = ShotReferencesSchema.parse({
    shotId: args.shotId,
    materialItemId: args.materialItemId,
    intent: args.intent,
    target: { family: profile.family, ...(args.endpoint ? { endpoint: args.endpoint } : {}) },
    requirements,
    chaining: args.chainFrom ? "anchor-reinject" : "none",
  });
  const plan = mergeShot(existing, shot);
  const check = checkReferencesPlan(args.projectId, plan, rootDir);
  return {
    shot,
    profile: profile.family,
    dropped,
    notes,
    findings: check.findings.filter((item) => item.shotId === shot.shotId),
  };
}

function safeList(projectId: string, rootDir: string) {
  try {
    return listEntities(projectId, rootDir);
  } catch {
    return [];
  }
}
const toCandidate = (p: Proposal): SlotCandidate => ({
  key: p.key,
  role: p.role,
  modality: p.modality,
  required: p.required,
  ...(p.entityKey ? { entityKey: p.entityKey } : {}),
  ...(p.viewRole ? { viewRole: p.viewRole } : {}),
});

function requirementOf(c: Context, p: Proposal, slot: Slot | undefined, shotId: string): ReferenceRequirement {
  const base = {
    key: p.key,
    role: p.role,
    modality: p.modality,
    required: p.required,
    roleSentence: p.roleSentence,
    ...(p.speech ? { speech: p.speech } : {}),
    ...(p.source ? { source: p.source } : {}),
  };
  const withNotes = (
    status: ReferenceRequirement["status"],
    notes?: string,
    prepare: DerivationStep[] = p.prepare ?? [],
  ) => ({
    ...base,
    prepare,
    status,
    ...(notes || p.notes ? { notes: [p.notes, notes].filter(Boolean).join(" ") } : {}),
  });
  if (p.status) return withNotes(p.status);
  if (!p.source)
    return withNotes(
      "missing",
      `Needs a source: ${p.modality === "image" ? "an approved card view or " : ""}${importCommand(c)}, then refs:plan --action draft --write.`,
    );
  const resolution = resolveSource(c, p.source, shotId);
  if (resolution.state === "unapproved")
    return withNotes("pending-approval", `${resolution.message}: ${resolution.command}.`);
  if (resolution.state === "pending") return withNotes("planned", `${resolution.message}: ${resolution.command}.`);
  if (resolution.state === "unresolvable") return withNotes("missing", `${resolution.message}: ${resolution.command}.`);
  if (!slot) return withNotes("planned");
  const fixes = mediaProblems(slot, resolution.facts);
  const steps = fixes.map((item) => item.step).filter((step): step is DerivationStep => !!step);
  const prepare = [...(p.prepare ?? []), ...steps];
  if (!prepare.length && !fixes.length) return withNotes("ready", undefined, []);
  return withNotes(
    "planned",
    `${fixes.map((item) => item.problem).join("; ") || "Needs preparation"}: make the derivative with pnpm refs:derive --project ${c.projectId} --action plan --spec <spec.json> (steps: ${prepare.map((step) => step.op).join(", ") || "none that fix it"}), then use it as the source.`,
    prepare,
  );
}

// ---------------------------------------------------------------------------
// Status (film:next hints) and the chain's references-ready check
// ---------------------------------------------------------------------------

type MaterialItemLike = {
  id: string;
  kind: string;
  route?: string;
  shots?: string[];
  status?: string;
  referencePack?: { id: string; sha256: string };
  referencePlan?: { mode: "none"; reason: string };
};
const GENERATED = new Set(["generated-image", "generated-video"]);
/**
 * A generated visual item: kind generated-image/-video, or any item on the generated route except audio (reference
 * profiles cover image, video and 3D endpoints only), so an "image" made by a model is not missed.
 */
export const isGeneratedVisual = (item: { kind: string; route?: string }): boolean =>
  GENERATED.has(item.kind) || (item.route === "generated" && item.kind !== "audio");

export type OpenRequirement = {
  key: string;
  status: ReferenceRequirement["status"];
  required: boolean;
  why: string;
  command: string;
};
export type ShotStatus = {
  shotId: string;
  materialItemId: string;
  family: string;
  counts: Record<ReferenceRequirement["status"], number>;
  open: OpenRequirement[];
  pack: { id: string; status: PackStatus; current: boolean; command?: string } | null;
  ready: boolean;
};
export type PlanStatus = {
  file: string;
  exists: boolean;
  shots: ShotStatus[];
  /** Generated material items with neither a shot in references.json nor referencePlan "none". */
  unplanned: { itemId: string; command: string }[];
};

function openRequirement(
  c: Context,
  shot: ShotReferences,
  requirement: ReferenceRequirement,
): OpenRequirement | undefined {
  if (requirement.status === "ready") {
    const resolution = requirement.source ? resolveSource(c, requirement.source, shot.shotId) : undefined;
    if (resolution?.state === "resolved") return undefined;
    return {
      key: requirement.key,
      status: requirement.status,
      required: requirement.required,
      why: `marked ready but ${resolution ? resolution.message : "it has no source"}`,
      command: resolution ? resolution.command : importCommand(c),
    };
  }
  const resolution = requirement.source ? resolveSource(c, requirement.source, shot.shotId) : undefined;
  let why: string, command: string;
  if (!requirement.source) {
    why = "no source yet";
    command = ["identity", "wardrobe", "expression", "location", "style", "product", "prop"].includes(requirement.role)
      ? `${cardCommand(c, "<kind>", "<id>", "create")} (or ${importCommand(c)}), then pnpm refs:plan --project ${c.projectId} --action draft --shot ${shot.shotId} ... --write`
      : `${importCommand(c)}, then pnpm refs:plan --project ${c.projectId} --action draft --shot ${shot.shotId} ... --write`;
  } else if (resolution && resolution.state !== "resolved") {
    why = resolution.message;
    command = resolution.command;
  } else if (requirement.status === "pending-approval") {
    why = "waits for the user's approval";
    command = `pnpm film:approve --project ${c.projectId} --step material --answer "<the user's words>"`;
  } else if (requirement.prepare.length) {
    why = `needs preparation (${requirement.prepare.map((step) => step.op).join(", ")})`;
    command = `pnpm refs:derive --project ${c.projectId} --action plan --spec <spec.json>, then --action run, then set the derivative as the source`;
  } else {
    why = `status ${requirement.status}`;
    command = `pnpm refs:plan --project ${c.projectId} --action check`;
  }
  return { key: requirement.key, status: requirement.status, required: requirement.required, why, command };
}

function readMaterialItems(projectId: string, rootDir: string): MaterialItemLike[] {
  const file = path.join(projectDir(projectId, rootDir), MATERIAL_FILE);
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(raw) && Array.isArray(raw["items"]) ? (raw["items"] as MaterialItemLike[]).filter(isRecord) : [];
  } catch {
    return [];
  }
}

function shotStatus(c: Context, shot: ShotReferences, item: MaterialItemLike | undefined): ShotStatus {
  const counts = { missing: 0, planned: 0, "pending-approval": 0, ready: 0 };
  for (const requirement of shot.requirements) counts[requirement.status]++;
  const open = shot.requirements
    .map((requirement) => openRequirement(c, shot, requirement))
    .filter((value): value is OpenRequirement => !!value);
  const packCommand = `pnpm refs:pack --project ${c.projectId} --action prepare --spec <spec.json>, then bind it as referencePack {id, sha256} on material item ${shot.materialItemId}`;
  let pack: ShotStatus["pack"] = null;
  if (item?.referencePack) {
    const state = packState(c.projectId, item.referencePack.id, c.rootDir);
    const current = state.packSha256 === item.referencePack.sha256;
    const shotMatches = !state.receipt || state.receipt.spec.shotId === shot.shotId;
    pack = {
      id: item.referencePack.id,
      status: state.status,
      current: current && shotMatches,
      ...(state.status === "missing"
        ? { command: packCommand }
        : !current
          ? {
              command: `rebind material item ${shot.materialItemId} to referencePack {id: ${item.referencePack.id}, sha256: ${state.packSha256}} (pnpm refs:pack --project ${c.projectId} --action check --id ${item.referencePack.id})`,
            }
          : !shotMatches
            ? {
                command: `pack ${item.referencePack.id} is for shot ${state.receipt!.spec.shotId}; prepare a pack for shot ${shot.shotId}: ${packCommand}`,
              }
            : state.status === "prepared"
              ? {
                  command: `pnpm refs:pack --project ${c.projectId} --action approve --id ${item.referencePack.id} (the user's own approval)`,
                }
              : {}),
    };
  }
  const requirementsReady =
    open.every((entry) => !entry.required) && shot.requirements.every((r) => r.status === "ready" || !r.required);
  return {
    shotId: shot.shotId,
    materialItemId: shot.materialItemId,
    family: shot.target.family,
    counts,
    open,
    pack,
    ready: requirementsReady && pack?.status === "approved" && pack.current,
  };
}

/** Per shot: requirement counts by status, each open requirement with the command that resolves it, and pack status. */
export function planStatus(projectId: string, rootDir = process.cwd()): PlanStatus {
  const plan = readReferencesPlan(projectId, rootDir);
  const items = readMaterialItems(projectId, rootDir);
  const c = contextFor(projectId, rootDir, plan);
  const shots = (plan?.shots ?? []).map((shot) =>
    shotStatus(
      c,
      shot,
      items.find((item) => item.id === shot.materialItemId),
    ),
  );
  const unplanned = items
    .filter(
      (item) =>
        isGeneratedVisual(item) &&
        item.status !== "acquired" &&
        !item.referencePlan &&
        !plan?.shots.some((shot) => shot.materialItemId === item.id),
    )
    .map((item) => ({
      itemId: item.id,
      command: draftCommand(projectId, item),
    }));
  return { file: REFERENCES_FILE, exists: plan !== undefined, shots, unplanned };
}

const draftCommand = (projectId: string, item: MaterialItemLike) =>
  `pnpm refs:plan --project ${projectId} --action draft --shot ${item.shots?.[0] ?? "<shot>"} --material-item ${item.id} --intent <intent> --family <family> [--entity kind:id] --write, or set referencePlan {mode: "none", reason} on ${item.id}`;

/**
 * The chain's references-ready check (RFC §10.1, AC16), in the two phases of the material step's two approvals.
 * Every generated visual item not yet acquired (isGeneratedVisual) carries referencePlan "none" with a reason, or has
 * at least one shot in references.json (matched by materialItemId).
 * - Before the material approval (`approved` false): those shots have no check error and no required requirement
 *   left `missing`; `planned` and `pending-approval` inputs (a chained first frame from a shot output) and packs wait.
 * - After it: every required requirement is ready (a `shot-output` requirement counts as ready once that shot's
 *   material item is acquired), and the item's referencePack is bound, current and approved.
 * Returns one failure per problem, each naming the requirement and the command that resolves it.
 */
export function referencesReadyFailures(
  projectId: string,
  items: MaterialItemLike[],
  rootDir = process.cwd(),
  options: { approved?: boolean } = {},
): string[] {
  // An acquired item is already made: its reference inputs are moot (material-sourced checks its pack output).
  const generated = items.filter(
    (item) => isGeneratedVisual(item) && !item.referencePlan && item.status !== "acquired",
  );
  if (!generated.length) return [];
  let plan: ReferencesPlan | undefined;
  try {
    plan = readReferencesPlan(projectId, rootDir);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const c = contextFor(projectId, rootDir, plan);
  const failures: string[] = [];
  const check = plan ? checkReferencesPlan(projectId, plan, rootDir) : undefined;
  /** A shot whose material item is acquired: its output exists, so a frame of it can be extracted. */
  const madeShot = (shotId: string) => {
    const shot = plan?.shots.find((value) => value.shotId === shotId);
    const item = shot && items.find((value) => value.id === shot.materialItemId);
    return item?.status === "acquired";
  };
  for (const item of generated) {
    const shots = plan?.shots.filter((shot) => shot.materialItemId === item.id) ?? [];
    if (!shots.length) {
      failures.push(`${item.id} is generated and has no shot in ${REFERENCES_FILE}: ${draftCommand(projectId, item)}`);
      continue;
    }
    for (const shot of shots) {
      for (const found of check?.findings.filter(
        (value) => value.shotId === shot.shotId && value.severity === "error",
      ) ?? [])
        failures.push(
          `${item.id}: shot ${shot.shotId} [${found.code}] ${found.message}${found.command ? ` ${found.command}` : ` Fix it and run pnpm refs:plan --project ${projectId} --action check.`}`,
        );
      const status = shotStatus(c, shot, item);
      const byKey = new Map(shot.requirements.map((requirement) => [requirement.key, requirement]));
      const open = status.open.filter((entry) => {
        if (!entry.required) return false;
        const requirement = byKey.get(entry.key)!;
        if (!options.approved) return requirement.status === "missing";
        const source = requirement.source;
        return !(source?.kind === "shot-output" && madeShot(source.shotId));
      });
      for (const entry of open)
        failures.push(
          `${item.id}: shot ${shot.shotId} requirement ${entry.key} is ${entry.status} (${entry.why}): ${entry.command}`,
        );
      if (!options.approved) continue;
      if (!status.pack)
        failures.push(
          `${item.id}: shot ${shot.shotId} has no reference pack: pnpm refs:pack --project ${projectId} --action prepare --spec <spec.json>, then set referencePack {id, sha256} on ${item.id}`,
        );
      else if (status.pack.status !== "approved" || !status.pack.current)
        failures.push(
          `${item.id}: pack ${status.pack.id} is ${status.pack.current ? status.pack.status : `${status.pack.status} and not the bound one`}: ${status.pack.command}`,
        );
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

function describeSource(source: ReferenceSource | undefined): string {
  if (!source) return "none yet";
  switch (source.kind) {
    case "entity":
      return `${source.entity.kind} ${source.entity.entityId}@${source.entity.revision} · ${source.viewRole}`;
    case "asset":
      return source.assetId;
    case "derivative":
      return `derivative ${source.derivativeId}`;
    case "shot-output":
      return `${source.frame} frame of shot ${source.shotId}`;
  }
}

/** Static HTML of every shot and requirement, with previews of resolved sources. Escaped, no scripts. */
export function referencesBoard(projectId: string, rootDir = process.cwd()): { html: string; file: string } {
  const plan = readReferencesPlan(projectId, rootDir);
  const status = planStatus(projectId, rootDir);
  const c = contextFor(projectId, rootDir, plan);
  const file = path.join(projectDir(projectId, rootDir), REFERENCES_BOARD);
  const publicDir = path.join(path.resolve(rootDir), "public");
  const preview = (original: string, facts: MediaFacts, label: string) => {
    const src = esc(path.relative(path.dirname(file), path.join(publicDir, original)).split(path.sep).join("/"));
    return facts.contentType.startsWith("image/")
      ? `<img src="${src}" alt="${esc(label)}">`
      : facts.contentType.startsWith("video/")
        ? `<video src="${src}" controls muted playsinline preload="metadata"></video>`
        : `<audio src="${src}" controls preload="metadata"></audio>`;
  };
  const shots = (plan?.shots ?? [])
    .map((shot) => {
      const state = status.shots.find((item) => item.shotId === shot.shotId);
      const rows = shot.requirements
        .map((requirement) => {
          const resolution = requirement.source ? resolveSource(c, requirement.source, shot.shotId) : undefined;
          const media =
            resolution?.state === "resolved"
              ? `${preview(resolution.original, resolution.facts, requirement.key)}<br><small>${esc(
                  [
                    resolution.facts.width && resolution.facts.height
                      ? `${resolution.facts.width}x${resolution.facts.height}`
                      : "",
                    resolution.facts.durationSec !== undefined ? `${resolution.facts.durationSec} s` : "",
                    resolution.facts.contentType,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                )}</small>`
              : `<small>${esc(resolution ? resolution.message : "no source")}</small>`;
          const open = state?.open.find((item) => item.key === requirement.key);
          return `<tr><td><b>${esc(requirement.key)}</b><br>${esc(requirement.role)} · ${esc(requirement.modality)}${requirement.required ? "" : " · optional"}</td><td class="s-${esc(requirement.status)}">${esc(requirement.status)}</td><td>${esc(requirement.roleSentence)}<br><small>${esc(describeSource(requirement.source))}</small>${requirement.prepare.length ? `<br><small>prepare: ${esc(requirement.prepare.map((step) => step.op).join(", "))}</small>` : ""}${open ? `<br><small>next: ${esc(open.command)}</small>` : ""}</td><td>${media}</td></tr>`;
        })
        .join("");
      const pack = state?.pack
        ? `pack ${esc(state.pack.id)}: ${esc(state.pack.status)}${state.pack.current ? "" : " (not current)"}`
        : "no pack yet";
      return `<section><h2>${esc(shot.shotId)}</h2><p>${esc(shot.intent)} · ${esc(shot.target.family)}${shot.target.endpoint ? ` · ${esc(shot.target.endpoint)}` : ""} · material ${esc(shot.materialItemId)} · chaining ${esc(shot.chaining)} · ${pack}</p><table><tr><th>Requirement</th><th>Status</th><th>What the model takes</th><th>Source</th></tr>${rows}</table></section>`;
    })
    .join("");
  const unplanned = status.unplanned.map((item) => `<li>${esc(item.itemId)}: ${esc(item.command)}</li>`).join("");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'"><title>References ${esc(projectId)}</title><style>body{font:15px system-ui;background:#16161a;color:#f2f2f2;padding:24px}table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #333;padding:8px;vertical-align:top;text-align:left}img,video{max-width:280px;max-height:200px}audio{width:260px}small{color:#aaa;word-break:break-all}.s-ready{color:#7bd88f}.s-missing{color:#ff6b6b}.s-planned,.s-pending-approval{color:#f5c26b}</style><h1>Reference requirements · ${esc(projectId)}</h1><p>From ${esc(REFERENCES_FILE)}. Markers are compiled by refs:pack, never written here.</p>${shots || "<p>No shots yet: pnpm refs:plan --action draft.</p>"}${unplanned ? `<h2>Generated items without requirements</h2><ul>${unplanned}</ul>` : ""}</html>\n`;
  return { html, file };
}

export function writeReferencesBoard(projectId: string, rootDir = process.cwd()): string {
  const { html, file } = referencesBoard(projectId, rootDir);
  atomicText(file, html);
  return file;
}
