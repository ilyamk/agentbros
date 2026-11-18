import type { z } from "zod";
import { CliErrorObject } from "../cli";
import { FalOperationError } from "../providers/fal-errors";
import { validateJsonSchema, type JsonSchema, type SchemaComponents } from "../providers/json-schema-validate";
import { genjutsuEndpoint } from "../model-preparation/profiles";
import type { ModelPreparationSpec } from "../../types/model-preparation";
import {
  ReferencePackSpecSchema,
  type DerivationStep,
  type Modality,
  type PackAttachment,
  type ReferencePackSpec,
} from "../../types/references";
import {
  ReferenceProfileSchema,
  type PromptSection,
  type ReferenceProfile,
  type Slot,
} from "../../types/reference-profiles";
import { dialectHasMarkers, findMarkers, markerFor, type NaturalWording } from "./dialects";

/**
 * The reference-pack compiler (RFC 0003 §7): spec + profile + measured media → provider input, compiled prompt
 * and marker map. Pure: the caller measures the media once and passes the facts keyed by assetId. Media outside
 * a slot's limits is refused with the derivation step that would fix it; nothing is repaired here.
 */

/** Measured facts of one asset (keyed by assetId in CompilePackArgs.media). */
export type MediaFacts = {
  bytes: number;
  contentType: string;
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
  hasAlpha?: boolean;
  sha256?: string;
};
export type CompilePackArgs = {
  spec: z.input<typeof ReferencePackSpecSchema>;
  profile: z.input<typeof ReferenceProfileSchema>;
  media: Record<string, MediaFacts>;
  /** The endpoint's input schema; the compiled input must validate strictly against it. */
  inputSchema?: JsonSchema;
  schemaComponents?: SchemaComponents;
  /** Provider guard hook (the caller passes the real fal guard); may throw, push warnings or normalise input. */
  guard?: (input: Record<string, unknown>, warnings: string[]) => void;
};
export type CompiledAttachment = { requirementKey: string; marker: string; pointer: string; assetRef: string };
export type CompiledPack = {
  input: Record<string, unknown>;
  compiledPrompt: string;
  /** Marker → assetId; an element marker maps to its frontal (or video) asset. Empty for marker-less dialects. */
  markerMap: Record<string, string>;
  attachments: CompiledAttachment[];
  warnings: string[];
};

const PROMPT_FIELD = "prompt";
const NEGATIVE_FIELD = "negative_prompt";
const invalid = (message: string, details?: Record<string, unknown>) =>
  new CliErrorObject({ code: "VALIDATION", message, ...(details ? { details } : {}) });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw invalid(
      `${what} is invalid: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  return result.data;
}
const assetRef = (assetId: string) => `asset://sha256/${assetId.slice("sha256:".length)}`;
const globMatch = (glob: string, value: string) =>
  new RegExp(
    `^${glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(value);
const templated = (slot: Slot) => slot.pointer.includes("{n}");
/** A pointer whose last segment is plural ("image_urls", "reference_image_urls") holds an array. */
const isArrayPointer = (pointer: string) => /s$/.test(pointer.split("/").pop() ?? "");
const wordingFor = (profile: ReferenceProfile): NaturalWording =>
  profile.promptTemplate === "genjutsu-legacy" ? "attached" : "reference";

type Ordered = PackAttachment & { slotDef: Slot; slotIndex: number; modality: Modality; facts: MediaFacts };

// --- Step 1: limits (AC12) ---

function refuse(a: Ordered, problem: string, fix: DerivationStep["op"] | null, how: string): never {
  throw invalid(
    `Attachment ${a.requirementKey} (slot ${a.slot}): ${problem}. ${
      fix ? `Fix it with a "${fix}" derivative: ${how}.` : how
    } The compiler never repairs media.`,
    { requirementKey: a.requirementKey, slot: a.slot, fix },
  );
}
function checkMedia(a: Ordered, warnings: string[]): void {
  const { slotDef: slot, facts: m } = a;
  if (slot.formats && !slot.formats.includes(m.contentType))
    refuse(
      a,
      `${m.contentType} is not an accepted format (${slot.formats.join(", ")})`,
      null,
      "No derivation step changes the format alone; import or derive the media in an accepted format.",
    );
  if (a.modality !== "audio" && (slot.pixels || slot.maxBytes)) {
    const { width: w, height: h } = m;
    if (slot.pixels && (!w || !h))
      refuse(a, "its pixel size is not measured", null, "Measure the asset before packing.");
    const p = slot.pixels ?? {};
    if (w && h) {
      if (p.minEdge !== undefined && Math.min(w, h) < p.minEdge)
        refuse(
          a,
          `short edge ${Math.min(w, h)} px is below ${p.minEdge} px`,
          "scale",
          `scale to at least ${p.minEdge} px on the short edge, or choose a larger source`,
        );
      if (p.maxEdge !== undefined && Math.max(w, h) > p.maxEdge)
        refuse(
          a,
          `long edge ${Math.max(w, h)} px exceeds ${p.maxEdge} px`,
          "scale",
          `scale to at most ${p.maxEdge} px on the long edge`,
        );
      if (p.multipleOf !== undefined && (w % p.multipleOf || h % p.multipleOf))
        refuse(a, `${w}×${h} is not a multiple of ${p.multipleOf}`, "snap", `snap to multipleOf ${p.multipleOf}`);
      if (p.aspect && (w / h < p.aspect[0] - 1e-9 || w / h > p.aspect[1] + 1e-9))
        refuse(
          a,
          `aspect ${(w / h).toFixed(3)} is outside ${p.aspect[0]}–${p.aspect[1]}`,
          "crop",
          "crop (or scale with fit pad) into the accepted aspect range",
        );
    }
  }
  if (a.modality !== "image") {
    if (slot.durationSec && m.durationSec === undefined)
      refuse(a, "its duration is not measured", null, "Measure the asset before packing.");
    const d = slot.durationSec;
    if (d && m.durationSec !== undefined) {
      if (m.durationSec < d.min)
        refuse(
          a,
          `duration ${m.durationSec} s is below ${d.min} s`,
          null,
          "No derivation step lengthens media; choose a longer source segment.",
        );
      if (m.durationSec > d.max)
        refuse(
          a,
          `duration ${m.durationSec} s exceeds ${d.max} s`,
          a.modality === "audio" ? "audio-trim" : "trim",
          `trim to at most ${d.max} s`,
        );
    }
    if (a.modality === "video" && slot.fps) {
      if (m.fps === undefined) refuse(a, "its frame rate is not measured", null, "Measure the asset before packing.");
      if (m.fps < slot.fps[0] || m.fps > slot.fps[1])
        refuse(
          a,
          `${m.fps} fps is outside ${slot.fps[0]}–${slot.fps[1]} fps`,
          "fps",
          `resample to a rate within ${slot.fps[0]}–${slot.fps[1]} fps`,
        );
    }
  }
  if (slot.maxBytes !== undefined && m.bytes > slot.maxBytes)
    refuse(
      a,
      `${m.bytes} bytes exceed ${slot.maxBytes}`,
      a.modality === "image" ? "scale" : a.modality === "audio" ? "audio-trim" : "trim",
      a.modality === "image" ? "scale down until the file fits" : "shorten it (or scale it down) until the file fits",
    );
  if (m.hasAlpha && a.modality === "image") {
    if (slot.alpha === "flatten")
      refuse(
        a,
        "it has transparency, which this slot does not accept",
        "flatten",
        "flatten onto a solid background colour",
      );
    if (slot.alpha === "unknown")
      warnings.push(
        `${a.requirementKey} has transparency and slot ${a.slot} does not state alpha handling; consider a flatten derivative.`,
      );
  }
}

function checkCounts(profile: ReferenceProfile, ordered: Ordered[]): void {
  const plain = ordered.filter((a) => !a.element);
  for (const slot of profile.slots) {
    const inSlot = ordered.filter((a) => a.slot === slot.id);
    if (templated(slot)) {
      const perElement = new Map<number, number>();
      for (const a of inSlot) perElement.set(a.element!.index, (perElement.get(a.element!.index) ?? 0) + 1);
      for (const [index, count] of perElement)
        if (count > slot.max)
          throw invalid(
            `Element ${index} has ${count} attachments in slot ${slot.id}; the slot allows ${slot.max} per element.`,
          );
      continue;
    }
    if (inSlot.length > slot.max)
      throw invalid(`Slot ${slot.id} has ${inSlot.length} attachments; ${profile.family} allows ${slot.max}.`);
    if (inSlot.length < slot.min)
      throw invalid(`Slot ${slot.id} needs at least ${slot.min} attachment(s); the pack has ${inSlot.length}.`);
    const combined = slot.durationSec?.combinedMax;
    const sum = inSlot.reduce((total, a) => total + (a.facts.durationSec ?? 0), 0);
    if (combined !== undefined && sum > combined + 1e-9)
      throw invalid(
        `Slot ${slot.id} carries ${sum} s combined; ${profile.family} allows ${combined} s. Fix it with "${
          slot.modality === "audio" ? "audio-trim" : "trim"
        }" derivatives that shorten the clips. The compiler never repairs media.`,
        { slot: slot.id, fix: slot.modality === "audio" ? "audio-trim" : "trim" },
      );
  }
  const elements = new Set(ordered.filter((a) => a.element).map((a) => a.element!.index));
  const total = plain.length + elements.size;
  if (profile.totals.max !== undefined && total > profile.totals.max)
    throw invalid(
      `The pack has ${total} references (elements count once); ${profile.family} allows ${profile.totals.max}.`,
    );
  const hasVideo = ordered.some((a) => a.modality === "video");
  const images = plain.filter((a) => a.modality === "image").length;
  if (hasVideo && profile.totals.withVideoMaxImages !== undefined && images > profile.totals.withVideoMaxImages)
    throw invalid(
      `With a video reference ${profile.family} allows ${profile.totals.withVideoMaxImages} images; the pack has ${images}.`,
    );
}

/** Kling-style elements: a video alone, or one frontal image plus references within the reference slot's limits. */
function checkElements(profile: ReferenceProfile, ordered: Ordered[]): void {
  const groups = new Map<number, Ordered[]>();
  for (const a of ordered) if (a.element) groups.set(a.element.index, [...(groups.get(a.element.index) ?? []), a]);
  const indices = [...groups.keys()].sort((x, y) => x - y);
  indices.forEach((index, i) => {
    if (index !== i + 1) throw invalid(`Element indices must run 1…${indices.length} without gaps; found ${index}.`);
  });
  let videoElements = 0;
  for (const [index, parts] of groups) {
    const count = (part: string) => parts.filter((a) => a.element!.part === part).length;
    const [frontal, references, video] = [count("frontal"), count("reference"), count("video")];
    if (video) {
      videoElements++;
      if (video > 1 || frontal || references)
        throw invalid(`Element ${index} must be either one video or a frontal image with references, not both.`);
      continue;
    }
    const referenceSlot =
      parts.find((a) => a.element!.part === "reference")?.slotDef ??
      profile.slots.find((slot) => templated(slot) && /reference/.test(slot.pointer));
    const [min, max] = [Math.max(1, referenceSlot?.min ?? 1), referenceSlot?.max ?? 3];
    if (frontal !== 1 || references < min || references > max)
      throw invalid(
        `Element ${index} needs one frontal image and ${min}–${max} reference images (has ${frontal} frontal, ${references} references).`,
      );
  }
  if (videoElements > 1)
    throw invalid(`${profile.family} accepts one video element per request; the pack has ${videoElements}.`);
}

// --- Step 3: bind ---

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}
function bindAt(input: Record<string, unknown>, pointer: string, value: string): string {
  const segments = pointerSegments(pointer);
  let node: Record<string, unknown> | unknown[] = input;
  for (const [i, segment] of segments.slice(0, -1).entries()) {
    const nextIsIndex = /^\d+$/.test(segments[i + 1]!);
    const key = Array.isArray(node) ? Number(segment) : segment;
    const container = node as Record<string | number, unknown>;
    container[key] ??= nextIsIndex ? [] : {};
    node = container[key] as Record<string, unknown> | unknown[];
  }
  const last = segments.at(-1)!;
  const container = node as Record<string, unknown>;
  if (isArrayPointer(pointer)) {
    const list = (container[last] ??= []) as unknown[];
    list.push(value);
    return `${pointer}/${list.length - 1}`;
  }
  if (container[last] !== undefined) throw invalid(`Two attachments bind the single field ${pointer}.`);
  container[last] = value;
  return pointer;
}

function bindEmpty(input: Record<string, unknown>, pointer: string): void {
  const segments = pointerSegments(pointer);
  let node = input;
  for (const segment of segments.slice(0, -1)) node = (node[segment] ??= {}) as Record<string, unknown>;
  node[segments.at(-1)!] ??= [];
}

// --- Step 5: compose ---

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Positional slots read as prose wherever the prompt carries bindings (not parameter or none dialects). */
const proseBindings = (profile: ReferenceProfile) =>
  profile.dialect.kind !== "parameter" && profile.dialect.kind !== "none";
const isPositional = (slot: Slot) => slot.marker === "none" && !templated(slot);
const positionalSubject = (slot: Slot) => `The ${slot.id.replaceAll("-", " ")} ${slot.modality}`;
const clause = (text: string) => text.trim().replace(/[.;]+$/, "");
type Group = {
  marker: string | null;
  /** A marker-less ("none") slot's prose subject, "The start image"; the group is never named by a marker. */
  positional?: string;
  element?: number;
  modality: Modality;
  roleSentence: string;
  assetId: string;
  members: Ordered[];
};

function composePrompt(
  profile: ReferenceProfile,
  spec: ReferencePackSpec,
  groups: Group[],
  warnings: string[],
): string {
  const p = spec.prompt;
  const legacy = profile.promptTemplate === "genjutsu-legacy";
  const named = groups.filter((g) => g.marker !== null);
  const legacyImages = named.filter((g) => g.modality === "image");
  const speak = (line: NonNullable<ReferencePackSpec["nativeSpeech"]>[number], source?: string) =>
    `From ${line.startSec}s to ${line.endSec}s, ${line.speakerId} speaks in ${line.language}: ${JSON.stringify(line.text)}${source ? `, timed to ${source}` : ""}.`;
  const speech = [
    ...(spec.nativeSpeech ?? []).map((line) => speak(line)),
    ...groups.flatMap((g) =>
      g.members.flatMap((member) =>
        member.speech?.kind === "performed-lines"
          ? member.speech.lines.map((line) => speak(line, g.marker ?? "the supplied speech audio"))
          : [],
      ),
    ),
  ];
  const sections: Record<PromptSection, string> = {
    action: p.action,
    bindings: legacy
      ? legacyImages.length
        ? `Reference bindings: ${legacyImages.map((g) => `${g.marker} (${g.roleSentence})`).join("; ")}.`
        : ""
      : groups
          .map((g) =>
            g.marker !== null
              ? `${capitalise(g.marker)} is ${clause(g.roleSentence)}.`
              : g.positional && proseBindings(profile)
                ? `${g.positional} is ${clause(g.roleSentence)}.`
                : "",
          )
          .filter(Boolean)
          .join(" "),
    invariants: p.invariants.join(" "),
    camera: p.camera ?? "",
    audio: [p.audio, ...speech].filter(Boolean).join(" "),
    preserve: p.preserve.length ? `Preserve: ${p.preserve.join("; ")}.` : "",
    otherSubjects: p.otherSubjects.length ? `Do not alter these other subjects: ${p.otherSubjects.join("; ")}.` : "",
    avoid: p.avoid.length && !profile.negativePrompt ? `Avoid: ${p.avoid.join("; ")}.` : "",
    additional: p.additional ?? "",
  };
  for (const [section, text] of Object.entries(sections))
    if (text && !profile.promptOrder.includes(section as PromptSection))
      warnings.push(`Prompt section ${section} is not in ${profile.family}'s prompt order and was left out.`);
  return profile.promptOrder
    .map((section) => sections[section])
    .filter(Boolean)
    .join("\n");
}

// --- Step 6: bijection (AC11) ---

function checkBijection(profile: ReferenceProfile, groups: Group[], texts: string[]): void {
  const known = new Map(groups.filter((g) => g.marker !== null).map((g) => [g.marker!, g]));
  const positional = groups.filter((g) => g.positional);
  const positionalHint = positional
    .map(
      (g) =>
        ` Slot ${g.members[0]!.slot} (${g.members[0]!.slotDef.pointer}) is bound by position and never named by a marker; describe it through its role sentence.`,
    )
    .join("");
  const tags = profile.dialect.kind === "at-named" ? [...known.keys()] : [];
  const named = new Set<string>();
  for (const text of texts)
    for (const found of findMarkers(profile, text, tags)) {
      if (found.kind === "foreign")
        throw invalid(
          `"${found.text}" is not a marker of ${profile.family} (${profile.dialect.kind} dialect); name references only with the pack's markers.`,
          { marker: found.text },
        );
      if (!known.has(found.marker!))
        throw invalid(
          `Marker "${found.text}" does not name any attachment (the pack names ${[...known.keys()].join(", ") || "none"}).${positionalHint}`,
          { marker: found.text },
        );
      named.add(found.marker!);
    }
  if (dialectHasMarkers(profile.dialect.kind))
    for (const [marker, group] of known)
      if (!named.has(marker))
        throw invalid(`Attachment ${group.members[0]!.requirementKey} (${marker}) is never named in the prompt.`, {
          marker,
        });
}

// --- The compiler ---

export function compilePack(args: CompilePackArgs): CompiledPack {
  const spec = parse(ReferencePackSpecSchema, args.spec, "Pack spec");
  const profile = parse(ReferenceProfileSchema, args.profile, "Reference profile");
  if (spec.profileFamily !== profile.family)
    throw invalid(`Pack ${spec.id} targets profile ${spec.profileFamily}, not ${profile.family}.`);
  if (!profile.endpoints.some((glob) => globMatch(glob, spec.endpoint)))
    throw invalid(`Endpoint ${spec.endpoint} is not covered by profile ${profile.family}.`);
  const warnings: string[] = [];
  if (spec.nativeSpeech && (spec.audioPolicy !== "native" || spec.params.generate_audio === false))
    throw invalid("Native speech requires enabled native audio");
  if (spec.nativeSpeech && profile.omitPrompt) throw invalid("The endpoint does not accept a native speech prompt");
  const lineIds = new Set<string>();
  const outputDuration = Number(spec.params.duration);
  const checkLines = (lines: NonNullable<ReferencePackSpec["nativeSpeech"]>) => {
    for (const line of lines) {
      if (lineIds.has(line.lineId)) throw invalid(`Speech line ${line.lineId} is bound more than once`);
      if (Number.isFinite(outputDuration) && line.endSec > outputDuration)
        throw invalid(`Speech line ${line.lineId} exceeds the shot duration`);
      lineIds.add(line.lineId);
    }
  };
  checkLines(spec.nativeSpeech ?? []);

  // 1. Resolve.
  const slotIndex = new Map(profile.slots.map((slot, index) => [slot.id, index]));
  const ordered: Ordered[] = spec.attachments.map((a) => {
    const index = slotIndex.get(a.slot);
    if (index === undefined) throw invalid(`Attachment ${a.requirementKey} names unknown slot ${a.slot}.`);
    const slotDef = profile.slots[index]!;
    if (templated(slotDef) !== Boolean(a.element))
      throw invalid(
        templated(slotDef)
          ? `Attachment ${a.requirementKey} in element slot ${a.slot} needs an element index and part.`
          : `Attachment ${a.requirementKey} has an element but slot ${a.slot} is not an element slot.`,
      );
    const partModality =
      a.element && { frontal: "image", reference: "image", video: "video", voice: "audio" }[a.element.part];
    if (partModality && partModality !== slotDef.modality)
      throw invalid(
        `Attachment ${a.requirementKey} is an element ${a.element!.part} part but slot ${a.slot} carries ${slotDef.modality}.`,
      );
    const facts = args.media[a.source.assetId];
    if (!facts)
      throw invalid(
        `Attachment ${a.requirementKey}: ${a.source.assetId} has no measured media facts; measure it first.`,
      );
    if (a.speech && slotDef.modality !== "audio") throw invalid("Speech bindings require an audio slot");
    if (profile.speechInput === "drive" && slotDef.modality === "audio" && a.speech?.kind !== "performed-lines")
      throw invalid("An audio-driven shot requires a performed line with its take receipt");
    if (a.speech?.kind === "performed-lines") {
      const speechInput =
        profile.speechInput ?? (["seedance-2.0", "seedance-2.5"].includes(profile.family) ? "reference" : undefined);
      if (
        speechInput !== a.speech.use ||
        !["reference-driven", "replace-in-edit"].includes(spec.audioPolicy) ||
        spec.nativeSpeech
      )
        throw invalid("Performed lines need a matching speech input profile and one final audio owner");
      if (facts.sha256 !== a.speech.sha256) throw invalid("Performed speech audio hash differs from the attachment");
      if (profile.family === "omnihuman-1.5-speech") {
        const limit = spec.params.resolution === "720p" ? 60 : 30;
        if (!facts.durationSec || facts.durationSec > limit)
          throw invalid(`OmniHuman speech audio must fit within ${limit} seconds at the selected resolution`);
      }
      checkLines(a.speech.lines);
    }
    return { ...a, slotDef, slotIndex: index, modality: slotDef.modality, facts };
  });
  // One asset may serve two slots (a keyframe as first frame and as identity reference), never twice in one slot
  // or one element: that would name the same picture under two markers of the same kind.
  const keys = new Set<string>(),
    placed = new Set<string>();
  for (const a of ordered) {
    if (keys.has(a.requirementKey)) throw invalid(`Requirement ${a.requirementKey} is attached twice.`);
    keys.add(a.requirementKey);
    for (const place of [`slot:${a.slot}`, ...(a.element ? [`element:${a.element.index}`] : [])]) {
      const key = `${place}\0${a.source.assetId}`;
      if (placed.has(key))
        throw invalid(
          `Asset ${a.source.assetId} is attached twice in ${place.replace(":", " ")}; do not attach one image under two markers of one slot.`,
        );
      placed.add(key);
    }
  }
  for (const a of ordered) checkMedia(a, warnings);
  checkCounts(profile, ordered);
  checkElements(profile, ordered);

  // 2. Order: profile slot order, then `order` within the slot.
  ordered.sort((x, y) => x.slotIndex - y.slotIndex || x.order - y.order);

  // 3. Bind, 4. emit markers.
  const input: Record<string, unknown> = {};
  const wording = wordingFor(profile);
  // One running index per marker group (default: the modality); marker-less slots take no number.
  const ordinals = new Map<string, number>();
  const groups: Group[] = [];
  const byElement = new Map<number, Group>();
  const bound: { a: Ordered; group: Group; pointer: string }[] = [];
  for (const a of ordered) {
    const pointer = bindAt(
      input,
      a.element ? a.slotDef.pointer.replaceAll("{n}", String(a.element.index - 1)) : a.slotDef.pointer,
      assetRef(a.source.assetId),
    );
    let group = a.element ? byElement.get(a.element.index) : undefined;
    if (!group && isPositional(a.slotDef)) {
      group = {
        marker: null,
        positional: positionalSubject(a.slotDef),
        modality: a.modality,
        roleSentence: a.roleSentence,
        assetId: a.source.assetId,
        members: [],
      };
      groups.push(group);
    } else if (!group) {
      const markerGroup = a.slotDef.markerGroup ?? a.modality;
      let ordinal = 0;
      if (!(a.element && profile.dialect.kind === "at-element")) {
        ordinal = (ordinals.get(markerGroup) ?? 0) + 1;
        ordinals.set(markerGroup, ordinal);
      }
      group = {
        marker: markerFor(
          profile,
          { modality: a.modality, ordinal, element: a.element?.index, requirementKey: a.requirementKey },
          wording,
        ),
        element: a.element?.index,
        modality: a.modality,
        roleSentence: a.roleSentence,
        assetId: a.source.assetId,
        members: [],
      };
      groups.push(group);
      if (a.element) byElement.set(a.element.index, group);
    }
    if (a.element && (a.element.part === "frontal" || a.element.part === "video")) {
      group.roleSentence = a.roleSentence;
      group.assetId = a.source.assetId;
    }
    group.members.push(a);
    bound.push({ a, group, pointer });
  }
  // Element groups read in element order, at the place of the first one.
  const elementGroups = groups.filter((g) => g.element !== undefined).sort((x, y) => x.element! - y.element!);
  const firstElement = groups.findIndex((g) => g.element !== undefined);
  if (firstElement >= 0)
    groups.splice(
      0,
      groups.length,
      ...[
        ...groups.slice(0, firstElement).filter((g) => g.element === undefined),
        ...elementGroups,
        ...groups.slice(firstElement).filter((g) => g.element === undefined),
      ],
    );
  if (profile.promptTemplate === "genjutsu-legacy")
    for (const slot of profile.slots)
      if (!templated(slot) && isArrayPointer(slot.pointer) && !ordered.some((a) => a.slot === slot.id))
        bindEmpty(input, slot.pointer); // the legacy request keeps image_urls: [] for a restyle without references
  const markers = groups.map((g) => g.marker).filter((m): m is string => m !== null);
  if (new Set(markers).size !== markers.length)
    throw invalid(`Two attachments share a marker (${markers.join(", ")}); make the requirement keys distinct.`);

  // 5. Compose.
  const compiledPrompt = composePrompt(profile, spec, groups, warnings);
  const negative = profile.negativePrompt && spec.prompt.avoid.length ? spec.prompt.avoid.join(", ") : undefined;

  // 6. Bijection over everything the model reads.
  checkBijection(profile, groups, [compiledPrompt, ...(negative ? [negative] : [])]);

  if (!profile.omitPrompt) input[PROMPT_FIELD] = compiledPrompt;
  if (negative !== undefined) input[NEGATIVE_FIELD] = negative;
  const reserved = new Set([
    PROMPT_FIELD,
    NEGATIVE_FIELD,
    ...profile.slots.map((slot) => pointerSegments(slot.pointer)[0]!),
  ]);
  for (const [key, value] of Object.entries(spec.params)) {
    if (reserved.has(key) || key in input)
      throw invalid(`Pack params cannot set /${key}: the compiler owns reference fields and the prompt.`, {
        param: key,
      });
    input[key] = value;
  }
  if (lineIds.size && ["seedance-2.0", "seedance-2.5"].includes(profile.family)) {
    const nativeAudio = spec.audioPolicy !== "replace-in-edit";
    if (input.generate_audio !== undefined && input.generate_audio !== nativeAudio)
      throw invalid("The generation audio switch conflicts with the shot's final speech owner");
    input.generate_audio = nativeAudio;
  }

  // 7. Validate.
  try {
    if (args.inputSchema)
      validateJsonSchema(args.inputSchema, input, { components: args.schemaComponents ?? {}, strict: true });
    args.guard?.(input, warnings);
  } catch (error) {
    if (error instanceof FalOperationError) throw invalid(`Compiled input fails the endpoint check: ${error.message}`);
    throw error;
  }

  return {
    input,
    compiledPrompt: profile.omitPrompt ? compiledPrompt : (input[PROMPT_FIELD] as string),
    markerMap: Object.fromEntries(groups.filter((g) => g.marker !== null).map((g) => [g.marker!, g.assetId])),
    attachments: bound.map(({ a, group, pointer }) => ({
      requirementKey: a.requirementKey,
      marker: group.marker ?? "",
      pointer,
      assetRef: assetRef(a.source.assetId),
    })),
    warnings,
  };
}

// --- Genjutsu (model:prepare) as a pack ---

/**
 * A ReferencePackSpec equivalent to a Genjutsu model preparation, with the effective profile to compile it with:
 * compilePack({ spec, profile }) yields genjutsuPrompt(prep) byte for byte and the same request input. With
 * useMarkers false the effective profile uses the natural dialect ("the attached source video", "attached image N").
 * Slots are chosen by modality (the first video and image slots of a genjutsu-legacy profile).
 */
export function packSpecFromPreparation(
  prep: ModelPreparationSpec,
  genjutsuProfile: z.input<typeof ReferenceProfileSchema>,
  resolved: { sourceAssetId: string; referenceAssetIds: string[] },
): { spec: ReferencePackSpec; profile: ReferenceProfile } {
  const parsed = parse(ReferenceProfileSchema, genjutsuProfile, "Reference profile");
  if (parsed.promptTemplate !== "genjutsu-legacy")
    throw invalid(`Profile ${parsed.family} does not use the genjutsu-legacy prompt template.`);
  if (resolved.referenceAssetIds.length !== prep.references.length)
    throw invalid("Every preparation reference needs exactly one resolved asset.");
  const profile: ReferenceProfile = prep.useMarkers
    ? parsed
    : { ...parsed, dialect: { ...parsed.dialect, kind: "natural" } };
  const videoSlot = profile.slots.find((slot) => slot.modality === "video" && !templated(slot));
  const imageSlot = profile.slots.find((slot) => slot.modality === "image" && !templated(slot));
  if (!videoSlot || (!imageSlot && prep.references.length))
    throw invalid(`Profile ${profile.family} lacks a video or image slot for a Genjutsu preparation.`);
  const source = markerFor(profile, { modality: "video", ordinal: 1, requirementKey: "source" }, wordingFor(profile));
  const { description, change } = prep.target;
  const action =
    prep.mode === "object-swap"
      ? `In ${source}, change only ${description}. ${change}`
      : prep.mode === "motion-transfer"
        ? `Use the movement, timing and camera of ${source} to rebuild the scene. ${description}. ${change}`
        : `Restyle ${source} using the selected style preset. ${description}. ${change}`;
  const spec = parse(
    ReferencePackSpecSchema,
    {
      schemaVersion: 1,
      id: prep.id,
      shotId: prep.id,
      endpoint: genjutsuEndpoint(prep.mode),
      profileFamily: profile.family,
      attachments: [
        {
          requirementKey: "source",
          source: { assetId: resolved.sourceAssetId },
          slot: videoSlot.id,
          order: 1,
          roleSentence: "the source video",
        },
        ...prep.references.map((ref, index) => ({
          requirementKey: `image-${index + 1}`,
          source: { assetId: resolved.referenceAssetIds[index]! },
          slot: imageSlot!.id,
          order: index + 1,
          roleSentence: `${ref.entityId}, ${ref.role}`,
        })),
      ],
      prompt: {
        action,
        preserve: prep.target.preserve,
        otherSubjects: prep.target.otherSubjects,
        ...(prep.additionalPrompt !== undefined ? { additional: prep.additionalPrompt } : {}),
      },
      params: { resolution: prep.resolution, ...(prep.presetId ? { preset_id: prep.presetId } : {}) },
      audioPolicy:
        prep.audioPolicy === "preserve-source"
          ? "reference-driven"
          : prep.audioPolicy === "mute"
            ? "mute"
            : "replace-in-edit",
    },
    "Pack spec",
  );
  return { spec, profile };
}
