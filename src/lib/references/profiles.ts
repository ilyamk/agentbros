/**
 * Model reference profiles (RFC 0003 §2 D2, §6.2): loader, queries and the consistency check behind
 * `pnpm refs:profiles`. Data: src/lib/models/reference-profiles.json.
 *
 * Pointer conventions the compiler relies on:
 * - A pointer is a JSON pointer into the request input. `/image_urls` names an array field, `/video_url` a scalar.
 * - `{n}` stands for each item of an array of objects: `/elements/{n}/frontal_image_url`.
 * - `min`/`max` count values at the pointer. For an array leaf they count its items, per `{n}` instance
 *   (`/elements/{n}/reference_image_urls` max 3 is per element). For a scalar leaf under `{n}` they count the
 *   instances that set it (`/elements/{n}/frontal_image_url` max 4 is four elements); a scalar without `{n}` is 0–1.
 *   `min` on a `{n}` pointer applies to each instance and does not require an instance to exist.
 * - `totals.max` is the sum over all slots. `totals.withVideoMaxImages` applies when any video is attached and counts
 *   top-level images plus one per element (its frontal image; element reference images are not counted).
 * - `pixels.aspect` and `fps` are `[min, max]` ranges; aspect is width / height.
 * - A family has one input shape: every endpoint accepts every slot pointer. Profiles key on (provider, endpoint).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  ReferenceProfilesFileSchema,
  type ReferenceProfile,
  type ReferenceProfilesFile,
  type Slot,
} from "../../types/reference-profiles";
import type { ProviderId } from "../../types/fal-catalog";
import { findProviderEntry, resolveProviderSnapshot } from "../models/fal-catalog";
import operationSnapshots from "../providers/schemas/fal-operations.json";
import { listFalGuards, type FalGuardInfo } from "../providers/fal-guards/all";
import { SEEDANCE_25_REFERENCE_LIMITS } from "../providers/fal-guards/seedance";
import { KLING_ELEMENT_LIMITS } from "../providers/fal-guards/kling";
import { NANO_EDIT_LIMITS } from "../providers/fal-guards/nano";
import { FLUX_EDIT_LIMITS } from "../providers/fal-guards/flux";
import { GENJUTSU_SOURCE_LIMITS } from "../providers/fal-guards/higgsfield";

export const REFERENCE_PROFILES_FILE = fileURLToPath(new URL("../models/reference-profiles.json", import.meta.url));

const memo = new Map<string, { file: ReferenceProfilesFile; index: Map<string, ReferenceProfile> }>();
const key = (provider: string, endpoint: string) => `${provider}\0${endpoint}`;

function loaded(file = REFERENCE_PROFILES_FILE) {
  const cached = memo.get(file);
  if (cached) return cached;
  const parsed = ReferenceProfilesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const index = new Map<string, ReferenceProfile>();
  for (const profile of parsed.profiles)
    for (const endpoint of profile.endpoints) index.set(key(profile.provider, endpoint), profile);
  const entry = { file: parsed, index };
  memo.set(file, entry);
  return entry;
}

/** The validated profiles file, cached per path. Throws ZodError when it is invalid. */
export function loadReferenceProfiles(file = REFERENCE_PROFILES_FILE): ReferenceProfilesFile {
  return loaded(file).file;
}
export function resetReferenceProfilesCache(): void {
  memo.clear();
}
export function listProfiles(file = REFERENCE_PROFILES_FILE): readonly ReferenceProfile[] {
  return loaded(file).file.profiles;
}
export function profileByFamily(family: string, file = REFERENCE_PROFILES_FILE): ReferenceProfile | undefined {
  return loaded(file).file.profiles.find((profile) => profile.family === family);
}
/** The profile of an exact endpoint at one provider (default fal); the same id at another provider does not match. */
export function profileForEndpoint(
  endpoint: string,
  provider: ProviderId = "fal",
  file = REFERENCE_PROFILES_FILE,
): ReferenceProfile | undefined {
  return loaded(file).index.get(key(provider, endpoint));
}

// ---------------------------------------------------------------------------
// Consistency check (AC2)
// ---------------------------------------------------------------------------

export type ProfileFindingKind =
  | "schema-invalid"
  | "endpoint-glob"
  | "endpoint-missing"
  | "endpoint-retired"
  | "endpoint-duplicate"
  | "schema-unavailable"
  | "pointer-missing"
  | "pointer-unverified"
  | "limit-exceeds-schema"
  | "guard-disagreement"
  | "guard-limit-missing"
  | "marker-collision"
  | "marker-unused";
export type ProfileFinding = {
  kind: ProfileFindingKind;
  severity: "error" | "warning";
  family?: string;
  endpoint?: string;
  pointer?: string;
  message: string;
};
export type ProfileCheck = {
  ok: boolean;
  profiles: number;
  endpoints: number;
  errors: number;
  warnings: number;
  findings: ProfileFinding[];
};

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

type TrackedSnapshot = {
  endpoint: string;
  family: string;
  variant: string;
  operation: string;
  input: Schema;
  schemas: Record<string, Schema>;
};
const tracked = new Map(
  (operationSnapshots as unknown as TrackedSnapshot[]).map((snapshot) => [snapshot.endpoint, snapshot]),
);

/** The non-null alternatives of a node, with local $ref and allOf resolved. */
function branches(node: unknown, components: Record<string, Schema>, depth = 0): Schema[] {
  if (!isObject(node) || depth > 30) return [];
  if (typeof node.$ref === "string") {
    const target = components[node.$ref.split("/").at(-1)!];
    const { $ref: _ref, ...rest } = node;
    return branches({ ...target, ...rest }, components, depth + 1);
  }
  if (Array.isArray(node.allOf)) {
    const { allOf, ...rest } = node;
    const parts = allOf.flatMap((part) => branches(part, components, depth + 1));
    const properties = Object.assign({}, ...parts.map((part) => part.properties ?? {}), rest.properties ?? {});
    return [Object.assign({}, ...parts, rest, { properties })];
  }
  const union = (node.anyOf ?? node.oneOf) as unknown;
  if (Array.isArray(union)) {
    const { anyOf: _a, oneOf: _o, ...rest } = node;
    return union
      .flatMap((item) => branches(item, components, depth + 1))
      .filter((item) => item.type !== "null")
      .map((item) => ({ ...rest, ...item }));
  }
  return node.type === "null" ? [] : [node];
}
/** The schema nodes a pointer reaches; empty when the pointer does not exist. */
function walk(input: Schema, components: Record<string, Schema>, pointer: string): Schema[] {
  let nodes = branches(input, components);
  for (const segment of pointer.split("/").slice(1)) {
    nodes = nodes.flatMap((node) => {
      if (segment === "{n}") return node.items ? branches(node.items, components) : [];
      const properties = isObject(node.properties) ? node.properties : {};
      return segment in properties ? branches(properties[segment], components) : [];
    });
    if (!nodes.length) return [];
  }
  return nodes;
}

type InputSchema = { input: Schema; components: Record<string, Schema> };
type SchemaSource =
  | { kind: "full"; schema: InputSchema; info: FalGuardInfo }
  | { kind: "summary"; fields: Map<string, { max?: number; array?: boolean }>; info: FalGuardInfo }
  | { kind: "none"; info: FalGuardInfo };

/** Tracked sources only (fal operation snapshots, tracked Higgsfield schema docs, catalogue summaries): no cache, no network. */
function schemaSource(provider: ProviderId, endpoint: string, catalogueDir?: string): SchemaSource {
  const entry = findProviderEntry(provider, endpoint, catalogueDir);
  const base = { endpoint, provider, family: "catalog", operation: entry?.category, category: entry?.category };
  const snapshot = provider === "fal" ? tracked.get(endpoint) : undefined;
  if (snapshot) {
    const schema = { input: snapshot.input, components: snapshot.schemas };
    const info: FalGuardInfo = {
      ...base,
      family: snapshot.family,
      variant: snapshot.variant,
      operation: snapshot.operation,
      inputSchema: branches(snapshot.input, snapshot.schemas)[0] ?? {},
      components: snapshot.schemas,
    };
    return { kind: "full", schema, info };
  }
  const empty: FalGuardInfo = { ...base, inputSchema: {}, components: {} };
  if (provider === "higgsfield" && entry?.schema) {
    try {
      const resolved = resolveProviderSnapshot("higgsfield", endpoint, { dir: catalogueDir });
      if (resolved) {
        const components = resolved.schemas as unknown as Record<string, Schema>;
        const input = resolved.input as Schema;
        return {
          kind: "full",
          schema: { input, components },
          info: { ...empty, inputSchema: branches(input, components)[0] ?? {}, components },
        };
      }
    } catch {
      // A missing tracked doc falls back to the catalogue summary below.
    }
  }
  if (entry?.inputs.length)
    return {
      kind: "summary",
      fields: new Map(entry.inputs.map((field) => [field.name, { max: field.max, array: field.array }])),
      info: empty,
    };
  return { kind: "none", info: empty };
}

type Expectation = { pointer?: string; path: string; value: unknown };
const MC = KLING_ELEMENT_LIMITS;
/** What each guard enforces, by pointer; only checked where the guard matches the endpoint. */
const GUARD_RULES: Record<string, (info: FalGuardInfo) => Expectation[]> = {
  "seedance-2.5": (info) => {
    if (info.operation !== "reference-to-video") return [];
    const L = SEEDANCE_25_REFERENCE_LIMITS;
    const duration = (pointer: string) => [
      { pointer, path: "durationSec.min", value: L.minDurationSec },
      { pointer, path: "durationSec.max", value: L.maxDurationSec },
      { pointer, path: "durationSec.combinedMax", value: L.combinedMaxDurationSec },
    ];
    return [
      { pointer: "/image_urls", path: "max", value: L.images },
      { pointer: "/image_urls", path: "maxBytes", value: L.imageMaxBytes },
      { pointer: "/video_urls", path: "max", value: L.videos },
      { pointer: "/video_urls", path: "maxBytes", value: L.videoMaxBytes },
      ...duration("/video_urls"),
      { pointer: "/video_urls", path: "pixels.minEdge", value: L.videoMinEdge },
      { pointer: "/video_urls", path: "pixels.maxEdge", value: L.videoMaxEdge },
      { pointer: "/video_urls", path: "pixels.aspect", value: [...L.videoAspect] },
      { pointer: "/video_urls", path: "fps", value: [...L.videoFps] },
      { pointer: "/audio_urls", path: "max", value: L.audio },
      { pointer: "/audio_urls", path: "maxBytes", value: L.audioMaxBytes },
      ...duration("/audio_urls"),
      { path: "totals.max", value: L.total },
    ];
  },
  kling: (info) => [
    { pointer: "/elements/{n}/reference_image_urls", path: "min", value: MC.referenceImagesMin },
    { pointer: "/elements/{n}/reference_image_urls", path: "max", value: MC.referenceImagesMax },
    { pointer: "/elements/{n}/video_url", path: "max", value: MC.videoElementsMax },
    ...(info.operation === "motion-control"
      ? [
          { pointer: "/elements/{n}/frontal_image_url", path: "max", value: MC.motionControlElementsMax },
          { pointer: "/video_url", path: "durationSec.max", value: MC.motionControlMaxDurationSec.video },
        ]
      : []),
    ...(info.operation?.startsWith("video-to-video")
      ? [{ path: "totals.withVideoMaxImages", value: MC.videoToVideoCombinedMax }]
      : []),
  ],
  "nano-banana-2.1": (info) =>
    info.operation === "edit"
      ? [
          { pointer: "/image_urls", path: "max", value: NANO_EDIT_LIMITS.images },
          { pointer: "/video_url", path: "maxBytes", value: NANO_EDIT_LIMITS.inlineContextMaxBytes },
        ]
      : [],
  "flux-2": (info) =>
    info.operation === "edit" ? [{ pointer: "/image_urls", path: "min", value: FLUX_EDIT_LIMITS.minImages }] : [],
  "higgsfield-genjutsu": (info) => [
    { pointer: "/video_url", path: "durationSec.min", value: GENJUTSU_SOURCE_LIMITS.minDurationSec },
    { pointer: "/video_url", path: "durationSec.max", value: GENJUTSU_SOURCE_LIMITS.trimDurationSec },
    ...(info.endpoint === "higgsfield/genjutsu/restyle/v1.0"
      ? [{ pointer: "/video_url", path: "maxBytes", value: GENJUTSU_SOURCE_LIMITS.restyleMaxBytes }]
      : []),
  ],
};
const at = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, part) => (isObject(node) ? node[part] : undefined), value);

export type CheckOptions = {
  /** A profiles file other than the shipped one (tests). */
  file?: string;
  /** fal catalogue directory override (tests); Higgsfield uses its own default. */
  catalogueDir?: string;
};

/** Profiles ↔ catalogue ↔ endpoint input schemas ↔ guards. `ok` is false when any finding is an error. */
export function checkReferenceProfiles(options: CheckOptions = {}): ProfileCheck {
  const findings: ProfileFinding[] = [];
  const add = (finding: Omit<ProfileFinding, "severity">, severity: ProfileFinding["severity"] = "error") =>
    findings.push({ ...finding, severity });
  const file = options.file ?? REFERENCE_PROFILES_FILE;
  const raw: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  const parsed = ReferenceProfilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      add({ kind: "schema-invalid", message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
    return summarise(0, 0, findings);
  }
  const owners = new Map<string, string>();
  let endpoints = 0;
  for (const profile of parsed.data.profiles) {
    const { family, provider } = profile;
    checkMarkers(profile, add);
    for (const endpoint of profile.endpoints) {
      endpoints++;
      const owner = owners.get(key(provider, endpoint));
      if (owner)
        add({ kind: "endpoint-duplicate", family, endpoint, message: `${provider} ${endpoint} is also in ${owner}.` });
      owners.set(key(provider, endpoint), family);
      if (/[*?[\]]/.test(endpoint)) {
        add({ kind: "endpoint-glob", family, endpoint, message: "Globs are not resolved; list exact endpoint ids." });
        continue;
      }
      const dir = provider === "fal" ? options.catalogueDir : undefined;
      const entry = findProviderEntry(provider, endpoint, dir);
      if (!entry) {
        add({
          kind: "endpoint-missing",
          family,
          endpoint,
          message: `${endpoint} is not in the ${provider} catalogue.`,
        });
        continue;
      }
      if (entry.status !== "active" && profile.status === "live")
        add(
          { kind: "endpoint-retired", family, endpoint, message: `${endpoint} is ${entry.status} in the catalogue.` },
          "warning",
        );
      const source = schemaSource(provider, endpoint, dir);
      checkPointers(profile, endpoint, source, add);
      checkGuards(profile, endpoint, source.info, add);
    }
  }
  return summarise(parsed.data.profiles.length, endpoints, findings);
}

function summarise(profiles: number, endpoints: number, findings: ProfileFinding[]): ProfileCheck {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  return { ok: errors === 0, profiles, endpoints, errors, warnings: findings.length - errors, findings };
}

type Add = (finding: Omit<ProfileFinding, "severity">, severity?: ProfileFinding["severity"]) => void;

function checkPointers(profile: ReferenceProfile, endpoint: string, source: SchemaSource, add: Add): void {
  const family = profile.family;
  if (source.kind === "none") {
    add(
      { kind: "schema-unavailable", family, endpoint, message: "No tracked input schema; pointers are unchecked." },
      "warning",
    );
    return;
  }
  for (const slot of profile.slots) {
    const pointer = slot.pointer;
    const segments = pointer.split("/").slice(1);
    if (source.kind === "summary") {
      const field = source.fields.get(segments[0]!);
      if (!field) {
        add({ kind: "pointer-missing", family, endpoint, pointer, message: `${segments[0]} is not an input field.` });
        continue;
      }
      if (segments.length > 1)
        add(
          {
            kind: "pointer-unverified",
            family,
            endpoint,
            pointer,
            message: "Only top-level fields are tracked for this endpoint; the nested path is unchecked.",
          },
          "warning",
        );
      else if (field.array && field.max !== undefined) exceeds(slot, field.max, endpoint, family, add);
      continue;
    }
    const nodes = walk(source.schema.input, source.schema.components, pointer);
    if (!nodes.length) {
      add({ kind: "pointer-missing", family, endpoint, pointer, message: `${pointer} is not in the input schema.` });
      continue;
    }
    const maxItems = nodes.map((node) => node.maxItems).find((value) => typeof value === "number");
    if (typeof maxItems === "number") exceeds(slot, maxItems, endpoint, family, add);
  }
}

function exceeds(slot: Slot, maxItems: number, endpoint: string, family: string, add: Add): void {
  if (slot.max > maxItems)
    add({
      kind: "limit-exceeds-schema",
      family,
      endpoint,
      pointer: slot.pointer,
      message: `Slot ${slot.id} allows ${slot.max}; the schema allows ${maxItems}.`,
    });
}

const MARKER_TEMPLATES = { image: "@Image{n}", video: "@Video{n}", audio: "@Audio{n}" } as const;
/**
 * Marker numbering (RFC 0003 §3.9): indexed slots in different marker groups must not share a marker form, or the
 * compiler would emit the same marker twice; an explicitly indexed slot in a parameter or none dialect never shows.
 */
function checkMarkers(profile: ReferenceProfile, add: Add): void {
  const { family, dialect } = profile;
  if (dialect.kind === "parameter" || dialect.kind === "none") {
    for (const slot of profile.slots)
      if (slot.marker === "indexed")
        add(
          {
            kind: "marker-unused",
            family,
            pointer: slot.pointer,
            message: `Slot ${slot.id} is marked indexed but the ${dialect.kind} dialect names no reference in the prompt.`,
          },
          "warning",
        );
    return;
  }
  if (dialect.kind === "at-named") return;
  const groupsByForm = new Map<string, Set<string>>();
  for (const slot of profile.slots) {
    if (slot.marker === "none" || (slot.pointer.includes("{n}") && dialect.kind === "at-element")) continue;
    const form =
      dialect.kind === "at-indexed" || dialect.kind === "at-element"
        ? (dialect.templates?.[slot.modality] ?? MARKER_TEMPLATES[slot.modality])
        : `${dialect.kind}:${slot.modality}`;
    const groups = groupsByForm.get(form) ?? new Set<string>();
    groups.add(slot.markerGroup ?? slot.modality);
    groupsByForm.set(form, groups);
  }
  for (const [form, groups] of groupsByForm)
    if (groups.size > 1)
      add({
        kind: "marker-collision",
        family,
        message: `Marker groups ${[...groups].join(", ")} all number ${form}; one pack could name two attachments with the same marker.`,
      });
}

function checkGuards(profile: ReferenceProfile, endpoint: string, info: FalGuardInfo, add: Add): void {
  const family = profile.family;
  for (const guard of listFalGuards()) {
    const rules = GUARD_RULES[guard.id];
    if (!rules || !guard.match(info)) continue;
    for (const rule of rules(info)) {
      let actual: unknown;
      if (rule.pointer) {
        const slot = profile.slots.find((candidate) => candidate.pointer === rule.pointer);
        if (!slot) continue;
        actual = at(slot, rule.path);
      } else actual = at(profile, rule.path);
      const where = `${rule.pointer ? `${rule.pointer} ` : ""}${rule.path}`;
      if (actual === undefined)
        add(
          {
            kind: "guard-limit-missing",
            family,
            endpoint,
            pointer: rule.pointer,
            message: `Guard ${guard.id} enforces ${where} = ${JSON.stringify(rule.value)}; the profile omits it.`,
          },
          "warning",
        );
      else if (!isDeepStrictEqual(actual, rule.value))
        add({
          kind: "guard-disagreement",
          family,
          endpoint,
          pointer: rule.pointer,
          message: `Guard ${guard.id} enforces ${where} = ${JSON.stringify(rule.value)}; the profile says ${JSON.stringify(actual)}.`,
        });
    }
  }
}
