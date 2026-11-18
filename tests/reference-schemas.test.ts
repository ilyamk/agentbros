import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DerivationStepSchema,
  DerivativeReceiptSchema,
  DerivativeSpecSchema,
  EntityReferenceFactsSchema,
  EntityViewRoleSchema,
  ModalitySchema,
  PackApprovalSchema,
  PackResultReviewSchema,
  PackRightsSchema,
  ReferencePackBindingSchema,
  ReferencePackReceiptSchema,
  ReferencePackSpecSchema,
  ReferenceRequirementSchema,
  ReferenceRoleSchema,
  ReferencesPlanSchema,
  ReferenceViewFactsSchema,
  ShotReferencesSchema,
} from "../src/types/references";
import { ReferenceProfileSchema, ReferenceProfilesFileSchema, SlotSchema } from "../src/types/reference-profiles";
import { EntityCardInputSchema, EntityVersionSchema } from "../src/types/entities";
import { MaterialItemSchema } from "../src/types/film";
import { FalOperationContextSchema } from "../src/types/generation";

const H = (c: string) => c.repeat(64);
const A = (c: string) => `sha256:${H(c)}`;
const at = "2026-11-17T10:00:00.000Z";
const fails = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));

const pin = (c: string) => ({
  assetId: A(c),
  sha256: H(c),
  original: "front.png",
  bytes: 100,
  width: 1024,
  height: 1024,
  contentType: "image/png",
  hasAudio: false,
});

test("roles, modalities and entity view roles", () => {
  assert.equal(ReferenceRoleSchema.parse("source-video"), "source-video");
  fails(ReferenceRoleSchema, "face");
  assert.equal(ModalitySchema.parse("audio"), "audio");
  for (const role of ["front", "voice-sample", "expression:smile", "outfit:red-coat", "custom:left-hand"])
    assert.equal(EntityViewRoleSchema.parse(role), role);
  for (const role of ["sideways", "custom:", "expression:Smile", "mood:happy"]) fails(EntityViewRoleSchema, role);
});

test("view facts: the RFC schema fills unknowns, the card schema adds nothing", () => {
  assert.deepEqual(ReferenceViewFactsSchema.parse({ yawDeg: 45 }), {
    yawDeg: 45,
    background: "unknown",
    lighting: "unknown",
  });
  assert.deepEqual(EntityReferenceFactsSchema.parse({ yawDeg: 45 }), { yawDeg: 45 });
  fails(EntityReferenceFactsSchema, { yawDeg: 200 });
  fails(EntityReferenceFactsSchema, { background: "green" });
  fails(EntityReferenceFactsSchema, { extra: true });
});

test("derivation steps cover every §6.4 op and reject bad values", () => {
  const steps = [
    { op: "trim", startSec: 0, durationSec: 5 },
    { op: "crop", x: 0, y: 10, width: 100, height: 200 },
    { op: "scale", width: 1280, height: 720, fit: "pad" },
    { op: "fps", fps: 24 },
    { op: "snap", multipleOf: 16 },
    { op: "extract-frame", at: "last" },
    { op: "extract-frame", at: 1.5 },
    { op: "flatten", background: "#FFFFFF" },
    { op: "cutout", engine: "matte-onnx" },
    { op: "strip-audio" },
    { op: "depth-video", engine: "fal", endpoint: "fal-ai/depth" },
    { op: "pose-video", engine: "local" },
    { op: "mask-video", engine: "matte-onnx", prompt: "the dancer" },
    { op: "edge-video", kind: "canny" },
    { op: "blender-pass", scene: "kitchen", pass: "camera-path" },
    { op: "audio-clean", engine: "local" },
    { op: "audio-trim", startSec: 1, durationSec: 4 },
    { op: "loudness", lufs: -16 },
    { op: "contact-sheet", columns: 4 },
  ];
  for (const step of steps) assert.deepEqual(DerivationStepSchema.parse(step), step);
  for (const bad of [
    { op: "trim", startSec: -1, durationSec: 5 },
    { op: "crop", x: 0.5, y: 0, width: 10, height: 10 },
    { op: "flatten", background: "white" },
    { op: "contact-sheet", columns: 9 },
    { op: "strip-audio", extra: 1 },
    { op: "blur", radius: 2 },
  ])
    fails(DerivationStepSchema, bad);
});

test("derivative spec and receipt", () => {
  const spec = {
    schemaVersion: 1,
    id: "dance-trim",
    input: { assetId: A("a") },
    steps: [{ op: "trim", startSec: 0, durationSec: 8 }],
    purpose: "fit the motion slot",
  };
  assert.ok(DerivativeSpecSchema.parse(spec));
  assert.ok(DerivativeSpecSchema.parse({ ...spec, input: { derivativeId: "dance-raw" } }));
  fails(DerivativeSpecSchema, { ...spec, steps: [] });
  fails(DerivativeSpecSchema, { ...spec, input: { assetId: A("a"), derivativeId: "x" } });
  const receipt = {
    schemaVersion: 1,
    id: "dance-trim",
    specSha256: H("b"),
    createdAt: at,
    input: pin("a"),
    output: pin("c"),
    engine: { kind: "ffmpeg", version: "7.1" },
    costUsd: null,
    warnings: [],
  };
  assert.deepEqual(DerivativeReceiptSchema.parse(receipt).measurements, {});
  fails(DerivativeReceiptSchema, { ...receipt, engine: { kind: "fal", version: "1" } });
  assert.ok(DerivativeReceiptSchema.parse({ ...receipt, engine: { kind: "fal", version: "1", operationId: "op-1" } }));
});

const requirement = {
  key: "hero-identity",
  role: "identity",
  modality: "image",
  roleSentence: "the face and hair of the woman",
  status: "ready",
  source: {
    kind: "entity",
    entity: { entityId: "mara", kind: "character", revision: 2 },
    viewRole: "front",
  },
};

test("requirement: defaults, sources and ready implies source", () => {
  const parsed = ReferenceRequirementSchema.parse(requirement);
  assert.equal(parsed.required, true);
  assert.deepEqual(parsed.prepare, []);
  for (const source of [
    { kind: "asset", assetId: A("d") },
    { kind: "derivative", derivativeId: "dance-trim" },
    { kind: "shot-output", shotId: "s01", frame: "last" },
  ])
    assert.ok(ReferenceRequirementSchema.parse({ ...requirement, source }));
  const { source: _source, ...unsourced } = requirement;
  void _source;
  fails(ReferenceRequirementSchema, unsourced);
  assert.ok(ReferenceRequirementSchema.parse({ ...unsourced, status: "missing" }));
  fails(ReferenceRequirementSchema, { ...requirement, roleSentence: "" });
  fails(ReferenceRequirementSchema, { ...requirement, role: "face" });
  fails(ReferenceRequirementSchema, { ...requirement, source: { kind: "asset", assetId: "abc" } });
  fails(ReferenceRequirementSchema, { ...requirement, marker: "@Image1" });
});

const shot = {
  shotId: "s02",
  materialItemId: "m-s02",
  intent: "reference-to-video",
  target: { family: "seedance-2.5" },
  requirements: [requirement],
};

test("shot references and the plan file", () => {
  assert.equal(ShotReferencesSchema.parse(shot).chaining, "none");
  fails(ShotReferencesSchema, { ...shot, requirements: [] });
  fails(ShotReferencesSchema, { ...shot, requirements: [requirement, requirement] });
  fails(ShotReferencesSchema, { ...shot, intent: "remix" });
  assert.ok(ShotReferencesSchema.parse({ ...shot, chaining: "first-from-previous-last" }));
  assert.ok(ReferencesPlanSchema.parse({ schemaVersion: 1, shots: [shot, { ...shot, shotId: "s03" }] }));
  fails(ReferencesPlanSchema, { schemaVersion: 1, shots: [shot, shot] });
  fails(ReferencesPlanSchema, { schemaVersion: 2, shots: [] });
});

const packSpec = {
  schemaVersion: 1,
  id: "s02-pack-1",
  shotId: "s02",
  endpoint: "bytedance/seedance-2.5/reference-to-video",
  profileFamily: "seedance-2.5",
  attachments: [
    {
      requirementKey: "hero-identity",
      source: { assetId: A("a") },
      slot: "images",
      order: 1,
      roleSentence: "the face",
    },
    {
      requirementKey: "market-plate",
      source: { assetId: A("b") },
      slot: "images",
      order: 2,
      roleSentence: "the market",
    },
  ],
  prompt: {
    action: "She walks through the market.",
    otherSubjects: ["the vendor"],
    additional: "Keep it handheld.",
  },
  audioPolicy: "native",
};

test("pack spec: prompt sections, defaults and unique slot order", () => {
  const parsed = ReferencePackSpecSchema.parse(packSpec);
  assert.deepEqual(parsed.prompt.invariants, []);
  assert.deepEqual(parsed.prompt.otherSubjects, ["the vendor"]);
  assert.equal(parsed.prompt.additional, "Keep it handheld.");
  assert.deepEqual(parsed.params, {});
  fails(ReferencePackSpecSchema, { ...packSpec, attachments: [] });
  fails(ReferencePackSpecSchema, {
    ...packSpec,
    attachments: [packSpec.attachments[0], { ...packSpec.attachments[1], order: 1 }],
  });
  fails(ReferencePackSpecSchema, { ...packSpec, prompt: { ...packSpec.prompt, additional: "x".repeat(6001) } });
  fails(ReferencePackSpecSchema, { ...packSpec, audioPolicy: "keep" });
  assert.ok(
    ReferencePackSpecSchema.parse({
      ...packSpec,
      attachments: [{ ...packSpec.attachments[0], element: { index: 1, part: "frontal" } }],
    }),
  );
});

test("pack receipt binds its spec", () => {
  const receipt = {
    schemaVersion: 1,
    projectId: "demo",
    id: packSpec.id,
    createdAt: at,
    spec: packSpec,
    profileSha256: H("1"),
    endpoint: packSpec.endpoint,
    schemaSha256: H("2"),
    requestSha256: H("3"),
    attachments: [
      {
        requirementKey: "hero-identity",
        marker: "@Image1",
        pointer: "/image_urls/0",
        media: pin("a"),
        provenanceSha256: H("4"),
      },
    ],
    compiledPrompt: "@Image1 is the woman. She walks through the market.",
    markerMap: { "@Image1": A("a") },
    warnings: [],
    reviewFiles: [{ path: "board.html", sha256: H("5") }],
  };
  assert.ok(ReferencePackReceiptSchema.parse(receipt));
  fails(ReferencePackReceiptSchema, { ...receipt, id: "other" });
  fails(ReferencePackReceiptSchema, { ...receipt, endpoint: "fal-ai/other" });
  fails(ReferencePackReceiptSchema, { ...receipt, reviewFiles: [] });
});

test("pack rights and approval are bound to the pack hash", () => {
  const rights = {
    schemaVersion: 1,
    packSha256: H("a"),
    status: "owned",
    userStatement: "I own these photos.",
    evidence: "user message",
    recordedAt: at,
    processingAllowed: true,
    commercialAllowed: true,
    placements: ["tiktok"],
    usage: { advertising: true, endorsement: false, standaloneResale: false },
    audioRights: "muted",
    assets: [{ assetId: A("b"), sha256: H("b") }],
  };
  assert.ok(PackRightsSchema.parse(rights));
  fails(PackRightsSchema, { ...rights, status: "study-only" });
  fails(PackRightsSchema, { ...rights, preparationSha256: H("a") });
  const review = {
    packSha256: H("a"),
    reviewer: "agent",
    evidence: "board.html viewed",
    markersVerified: true,
    promptReviewed: true,
    attachments: [{ sha256: H("b"), requirementKey: "hero-identity", suitable: true, evidence: "frontal, even light" }],
  };
  const approval = {
    schemaVersion: 1,
    packSha256: H("a"),
    rightsSha256: H("c"),
    userStatement: "Yes, generate it.",
    approvedAt: at,
    review,
  };
  assert.ok(PackApprovalSchema.parse(approval));
  fails(PackApprovalSchema, { ...approval, review: { ...review, packSha256: H("d") } });
  fails(PackApprovalSchema, { ...approval, review: { ...review, markersVerified: false } });
});

test("result review: a failed dimension cannot pass", () => {
  const review = {
    schemaVersion: 1,
    packSha256: H("a"),
    outputSha256: H("b"),
    reviewer: "agent",
    evidence: "frames 1, 40, 80",
    identity: "pass",
    wardrobe: "not-applicable",
    preserved: "pass",
    otherSubjects: "not-applicable",
    motion: "pass",
    naturalness: "pass",
    promptFit: "pass",
    temporalConsistency: "pass",
    audio: "replace-in-edit",
    verdict: "pass",
  };
  assert.ok(PackResultReviewSchema.parse(review));
  for (const dimension of [
    "identity",
    "wardrobe",
    "preserved",
    "otherSubjects",
    "motion",
    "naturalness",
    "promptFit",
    "temporalConsistency",
    "audio",
  ]) {
    fails(PackResultReviewSchema, { ...review, [dimension]: "fail" });
    assert.ok(PackResultReviewSchema.parse({ ...review, [dimension]: "fail", verdict: "repair" }));
  }
  fails(PackResultReviewSchema, { ...review, preserved: "not-applicable" });
  assert.ok(
    PackResultReviewSchema.parse({
      ...review,
      identitySimilarity: [{ attachmentSha256: H("c"), model: "arcface", version: "1.0", score: 0.71 }],
    }),
  );
});

test("pack binding", () => {
  assert.deepEqual(ReferencePackBindingSchema.parse({ id: "s02-pack-1", sha256: H("a") }), {
    id: "s02-pack-1",
    sha256: H("a"),
  });
  fails(ReferencePackBindingSchema, { id: "s02-pack-1", sha256: "abc" });
  fails(ReferencePackBindingSchema, { id: "-bad", sha256: H("a") });
  fails(ReferencePackBindingSchema, { id: "ok", sha256: H("a"), extra: 1 });
});

const evidence = { tier: "official", url: "https://fal.ai/models/x", checkedAt: "2026-11-17" };
const profile = {
  schemaVersion: 1,
  family: "seedance-2.5",
  endpoints: ["bytedance/seedance-2.5/reference-to-video"],
  provider: "fal",
  status: "live",
  slots: [
    { id: "images", modality: "image", pointer: "/image_urls", roles: ["identity", "location"], max: 10, evidence },
    {
      id: "videos",
      modality: "video",
      pointer: "/video_urls",
      roles: ["motion"],
      max: 3,
      durationSec: { min: 2, max: 15, combinedMax: 15 },
      evidence,
    },
  ],
  dialect: { kind: "at-indexed", templates: { image: "@Image{n}", video: "@Video{n}" }, evidence },
  policies: { realFaces: "consented-flow" },
};

test("reference profile: defaults, dialect templates and invariants", () => {
  const parsed = ReferenceProfileSchema.parse(profile);
  assert.deepEqual(parsed.promptOrder, [
    "action",
    "bindings",
    "invariants",
    "camera",
    "audio",
    "preserve",
    "otherSubjects",
    "avoid",
    "additional",
  ]);
  assert.equal(parsed.promptTemplate, "default");
  assert.equal(parsed.negativePrompt, false);
  assert.deepEqual(parsed.totals, {});
  assert.equal(parsed.slots[0].min, 0);
  assert.equal(parsed.slots[0].alpha, "unknown");
  assert.equal(parsed.policies.audioFromVideoRefs, "unknown");
  assert.deepEqual(parsed.guidance, []);
  parsed.promptOrder.pop();
  assert.equal(ReferenceProfileSchema.parse(profile).promptOrder.length, 9, "default order is not shared");
  assert.equal(
    ReferenceProfileSchema.parse({ ...profile, family: "genjutsu-object-swap", promptTemplate: "genjutsu-legacy" })
      .promptTemplate,
    "genjutsu-legacy",
  );
  fails(ReferenceProfileSchema, { ...profile, promptTemplate: "legacy" });
  fails(ReferenceProfileSchema, { ...profile, dialect: { ...profile.dialect, kind: "brackets" } });
  fails(ReferenceProfileSchema, { ...profile, dialect: { ...profile.dialect, templates: { text: "@T{n}" } } });
  fails(ReferenceProfileSchema, { ...profile, slots: [profile.slots[0], profile.slots[0]] });
  fails(ReferenceProfileSchema, { ...profile, promptOrder: ["action", "action"] });
  fails(ReferenceProfileSchema, { ...profile, endpoints: [] });
  fails(ReferenceProfileSchema, { ...profile, policies: {} });
  fails(SlotSchema, { ...profile.slots[0], min: 11 });
  fails(SlotSchema, { ...profile.slots[0], roles: [] });
  fails(SlotSchema, { ...profile.slots[0], evidence: { tier: "rumour", checkedAt: "2026-11-17" } });
  fails(SlotSchema, { ...profile.slots[0], evidence: { tier: "official", checkedAt: "17 Nov" } });
  fails(SlotSchema, { ...profile.slots[1], durationSec: { min: 20, max: 15 } });
});

test("profiles file: family values are unique", () => {
  assert.ok(ReferenceProfilesFileSchema.parse({ schemaVersion: 1, profiles: [profile] }));
  assert.ok(
    ReferenceProfilesFileSchema.parse({ schemaVersion: 1, profiles: [profile, { ...profile, family: "kling-o3" }] }),
  );
  fails(ReferenceProfilesFileSchema, { schemaVersion: 1, profiles: [profile, profile] });
});

// --- AC3: entity card extension keeps old version hashes ---

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Same content and digest as saveEntityVersion (src/lib/entities/service.ts). */
function versionHash(input: unknown) {
  const card = EntityCardInputSchema.parse(input);
  const content = {
    schemaVersion: 1,
    revision: 1,
    parentRevision: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    card,
    referenceSnapshots: [],
  };
  return EntityVersionSchema.parse({ ...content, contentHash: digest(content) }).contentHash;
}
const oldCharacter = {
  id: "host",
  kind: "character",
  name: "Host",
  description: "Presenter",
  references: [{ assetId: A("a"), role: "front" }],
  appearance: { physical: "tall" },
  persona: { role: "host" },
  voice: { description: "warm", consent: { status: "not-applicable" } },
  likenessConsent: { status: "unknown" },
  createdBy: "agent",
};
const oldObject = {
  id: "mug",
  kind: "object",
  name: "Mug",
  description: "A mug",
  physical: { shape: "cylinder" },
  createdBy: "agent",
};
const NEW_KEYS = ["facts", "fixedSentence", "sampleAssetIds", "pronunciation"];
function keysDeep(value: unknown, out = new Set<string>()) {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysDeep(item, out);
    }
  return out;
}

test("AC3: old cards keep their version contentHash and gain no keys", () => {
  // Hashes computed with the entity schema before RFC 0003 WP0 (commit 1c909de1).
  assert.equal(versionHash(oldCharacter), "ce7bd17c9dd922afd7a9905a0852e1fda83b34c8b16842d3a867749667ca18e2");
  assert.equal(versionHash(oldObject), "1e7bdcaafd4af6f6a31f1609eebdf30e8ad2d85464a1444f93ae9841771b78b8");
  for (const card of [oldCharacter, oldObject]) {
    const keys = keysDeep(EntityCardInputSchema.parse(card));
    for (const key of NEW_KEYS) assert.equal(keys.has(key), false, key);
  }
});

test("AC3: cards accept facts, fixedSentence, voice samples and pronunciation", () => {
  const card = EntityCardInputSchema.parse({
    ...oldCharacter,
    fixedSentence: "Mara, a woman in her thirties with a short black bob and a red wool coat.",
    references: [
      { assetId: A("a"), role: "front", facts: { yawDeg: 0, background: "neutral", lighting: "even" } },
      { assetId: A("b"), role: "three-quarter-left", facts: { yawDeg: -45 } },
    ],
    voice: {
      description: "warm",
      consent: { status: "not-applicable" },
      sampleAssetIds: [A("c")],
      pronunciation: { dictionaryAssetId: A("d"), aliases: [{ text: "Agent Bros.", alias: "agent brothers" }] },
    },
  });
  assert.deepEqual(card.references[1].facts, { yawDeg: -45 });
  assert.ok(EntityCardInputSchema.parse({ ...oldObject, fixedSentence: "A white enamel mug." }));
  fails(EntityCardInputSchema, { ...oldCharacter, fixedSentence: "" });
  fails(EntityCardInputSchema, { ...oldCharacter, voice: { ...oldCharacter.voice, sampleAssetIds: ["front.wav"] } });
  fails(EntityCardInputSchema, {
    ...oldCharacter,
    voice: { ...oldCharacter.voice, pronunciation: { aliases: [{ text: "x" }] } },
  });
  fails(EntityCardInputSchema, {
    ...oldCharacter,
    references: [{ assetId: A("a"), role: "front", facts: { lighting: "moody" } }],
  });
});

// --- Bindings on material items and provider requests ---

const material = {
  id: "m-s02",
  shots: ["s02"],
  what: "the market walk",
  kind: "generated-video",
  route: "generated",
  status: "planned",
  provenance: "seedance-2.5",
  licence: "provider terms",
};

test("material item: referencePack and referencePlan", () => {
  const bound = MaterialItemSchema.parse({ ...material, referencePack: { id: "s02-pack-1", sha256: H("a") } });
  assert.deepEqual(bound.referencePack, { id: "s02-pack-1", sha256: H("a") });
  const none = MaterialItemSchema.parse({ ...material, referencePlan: { mode: "none", reason: "pure text-to-video" } });
  assert.deepEqual(none.referencePlan, { mode: "none", reason: "pure text-to-video" });
  assert.equal("referencePack" in MaterialItemSchema.parse(material), false);
  assert.ok(MaterialItemSchema.parse({ ...material, modelPreparation: { id: "prep-1", sha256: H("b") } }));
  fails(MaterialItemSchema, { ...material, referencePack: { id: "s02-pack-1" } });
  fails(MaterialItemSchema, { ...material, referencePlan: { mode: "none", reason: " " } });
  fails(MaterialItemSchema, { ...material, referencePlan: { mode: "some", reason: "x" } });
  fails(MaterialItemSchema, { ...material, referencePlan: { mode: "none", reason: "x", extra: 1 } });
});

test("generation context: referencePack alongside modelPreparation", () => {
  const context = FalOperationContextSchema.parse({
    modelPreparation: { id: "prep-1", sha256: H("b") },
    referencePack: { id: "s02-pack-1", sha256: H("a") },
  });
  assert.deepEqual(context.referencePack, { id: "s02-pack-1", sha256: H("a") });
  assert.equal("referencePack" in FalOperationContextSchema.parse({}), false);
  fails(FalOperationContextSchema, { referencePack: { id: "s02-pack-1", sha256: "x" } });
});
