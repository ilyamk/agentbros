import test from "node:test";
import assert from "node:assert/strict";
import { compilePack, packSpecFromPreparation, type MediaFacts } from "../src/lib/references/compile";
import { findMarkers, markerFor, namedTag, ordinalWord } from "../src/lib/references/dialects";
import { genjutsuPrompt } from "../src/lib/model-preparation/prepare";
import { genjutsuEndpoint } from "../src/lib/model-preparation/profiles";
import { loadHiggsfieldRestylePresets } from "../src/lib/models/hf-restyle-presets";
import { FalOperationError } from "../src/lib/providers/fal-errors";
import { CliErrorObject } from "../src/lib/cli";
import { ModelPreparationSpecSchema } from "../src/types/model-preparation";
import { ReferenceProfileSchema } from "../src/types/reference-profiles";
import type { z } from "zod";
import { profileByFamily } from "../src/lib/references/profiles";

/** RFC 0003 WP3: the pure reference-pack compiler (AC11, AC12, AC15 prompt part). Fixture profiles only. */

type ProfileIn = z.input<typeof ReferenceProfileSchema>;
const evidence = { tier: "observed" as const, checkedAt: "2026-11-17" };
const policies = { realFaces: "unknown" as const };
const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const id = (seed: string) => `sha256:${hex(seed)}`;
const ref = (seed: string) => `asset://sha256/${hex(seed)}`;
const image = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  bytes: 200_000,
  contentType: "image/png",
  width: 1024,
  height: 1024,
  ...over,
});
const video = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  bytes: 2_000_000,
  contentType: "video/mp4",
  width: 1280,
  height: 720,
  durationSec: 5,
  fps: 30,
  ...over,
});
const audio = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  bytes: 300_000,
  contentType: "audio/mpeg",
  durationSec: 6,
  ...over,
});

test("speech pack binds the approved line and voice to the ordered audio pointer and rejects mixed audio ownership", () => {
  const profile = profileByFamily("seedance-2.5")!;
  const endpoint = "bytedance/seedance-2.5/reference-to-video";
  const line = { lineId: "line-a", speakerId: "host", language: "ru", text: "Не открывай.", startSec: 2, endSec: 4 };
  const spec = {
    schemaVersion: 1 as const,
    id: "speech-shot",
    shotId: "s1",
    endpoint,
    profileFamily: profile.family,
    audioPolicy: "replace-in-edit" as const,
    params: { duration: 6 },
    prompt: { action: "The host raises the radio to her mouth." },
    attachments: [
      {
        requirementKey: "line",
        source: { assetId: id("b") },
        slot: "audio",
        order: 2,
        roleSentence: "the host's spoken line",
        speech: {
          kind: "performed-lines" as const,
          sha256: hex("b"),
          receipt: "take.json",
          receiptSha256: hex("d"),
          use: "reference" as const,
          lines: [line],
        },
      },
      {
        requirementKey: "sample",
        source: { assetId: id("c") },
        slot: "audio",
        order: 1,
        roleSentence: "her voice sample",
        speech: { kind: "voice-sample" as const },
      },
      {
        requirementKey: "host",
        source: { assetId: id("a") },
        slot: "images",
        order: 1,
        roleSentence: "the host's look",
      },
    ],
  };
  const args = {
    profile,
    spec,
    media: {
      [id("a")]: image(),
      [id("b")]: audio({ sha256: hex("b"), durationSec: 2 }),
      [id("c")]: audio({ durationSec: 2 }),
    },
  };
  const compiled = compilePack(args);
  assert.deepEqual(compiled.input.audio_urls, [ref("c"), ref("b")]);
  assert.equal(compiled.input.generate_audio, false);
  assert.match(compiled.compiledPrompt, /host speaks in ru: "Не открывай\.", timed to @Audio2/);
  assert.throws(() => compilePack({ ...args, spec: { ...spec, audioPolicy: "native" } }), /one final audio owner/);
  assert.throws(
    () => compilePack({ ...args, media: { ...args.media, [id("b")]: audio({ sha256: hex("f") }) } }),
    /hash differs/,
  );
});

test("Sync uses the pinned audio_url and video_url without adding an unsupported prompt field", () => {
  const profile = profileByFamily("sync-v3-speech")!;
  const spec = {
    schemaVersion: 1 as const,
    id: "lipsync",
    shotId: "s1",
    endpoint: "fal-ai/sync-lipsync/v3",
    profileFamily: profile.family,
    prompt: { action: "The host opens the door." },
    audioPolicy: "replace-in-edit" as const,
    attachments: [
      { requirementKey: "picture", source: { assetId: id("a") }, slot: "video", order: 1, roleSentence: "the host" },
      {
        requirementKey: "line",
        source: { assetId: id("b") },
        slot: "speech",
        order: 1,
        roleSentence: "her line",
        speech: {
          kind: "performed-lines" as const,
          sha256: hex("b"),
          receipt: "take.json",
          receiptSha256: hex("c"),
          use: "drive" as const,
          lines: [{ lineId: "a", speakerId: "host", language: "en", text: "Ready?", startSec: 0, endSec: 2 }],
        },
      },
    ],
  };
  const result = compilePack({ profile, spec, media: { [id("a")]: video(), [id("b")]: audio({ sha256: hex("b") }) } });
  assert.deepEqual(result.input, { video_url: ref("a"), audio_url: ref("b") });
  assert.match(result.compiledPrompt, /host speaks in en: "Ready\?", timed to the supplied speech audio/);
});

test("OmniHuman checks the selected resolution against the performed audio duration", () => {
  const profile = profileByFamily("omnihuman-1.5-speech")!;
  const spec = {
    schemaVersion: 1 as const,
    id: "avatar",
    shotId: "s1",
    endpoint: "fal-ai/bytedance/omnihuman/v1.5",
    profileFamily: profile.family,
    prompt: { action: "The host glances purposefully at the radio." },
    audioPolicy: "reference-driven" as const,
    attachments: [
      {
        requirementKey: "portrait",
        source: { assetId: id("a") },
        slot: "portrait",
        order: 1,
        roleSentence: "the host",
      },
      {
        requirementKey: "line",
        source: { assetId: id("b") },
        slot: "speech",
        order: 1,
        roleSentence: "her line",
        speech: {
          kind: "performed-lines" as const,
          sha256: hex("b"),
          receipt: "take.json",
          receiptSha256: hex("c"),
          use: "drive" as const,
          lines: [{ lineId: "a", speakerId: "host", language: "en", text: "Ready?", startSec: 0, endSec: 2 }],
        },
      },
    ],
  };
  const media = { [id("a")]: image(), [id("b")]: audio({ sha256: hex("b"), durationSec: 45 }) };
  assert.throws(() => compilePack({ profile, spec, media }), /within 30 seconds/);
  const accepted = compilePack({ profile, spec: { ...spec, params: { resolution: "720p" } }, media });
  assert.equal(accepted.input.image_url, ref("a"));
  assert.equal(accepted.input.audio_url, ref("b"));
});

function refusal(fn: () => unknown, pattern: RegExp, fix?: string | null) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof CliErrorObject, `expected a CliErrorObject, got ${String(caught)}`);
  assert.equal(caught.code, "VALIDATION");
  assert.match(caught.message, pattern);
  if (fix !== undefined) assert.equal(caught.details?.fix, fix);
  return caught;
}

// --- Fixture profiles, one per dialect kind ---

const seedance: ProfileIn = {
  schemaVersion: 1,
  family: "seedance-like",
  endpoints: ["bytedance/seedance-like/reference-to-video"],
  provider: "fal",
  status: "live",
  slots: [
    {
      id: "images",
      modality: "image",
      pointer: "/image_urls",
      roles: ["identity", "location", "product", "style"],
      max: 9,
      pixels: { minEdge: 300, maxEdge: 6000, aspect: [0.4, 2.5] },
      maxBytes: 30 * 1024 * 1024,
      formats: ["image/png", "image/jpeg"],
      alpha: "flatten",
      evidence,
    },
    {
      id: "videos",
      modality: "video",
      pointer: "/video_urls",
      roles: ["motion", "camera"],
      max: 3,
      durationSec: { min: 2, max: 15, combinedMax: 15 },
      fps: [24, 60],
      evidence,
    },
    {
      id: "audio",
      modality: "audio",
      pointer: "/audio_urls",
      roles: ["music", "voice"],
      max: 3,
      durationSec: { min: 2, max: 15, combinedMax: 15 },
      evidence,
    },
  ],
  totals: { max: 12, withVideoMaxImages: 4 },
  dialect: {
    kind: "at-indexed",
    templates: { image: "@Image{n}", video: "@Video{n}", audio: "@Audio{n}" },
    evidence,
  },
  policies,
};
const seedancePack = {
  schemaVersion: 1 as const,
  id: "market-dance",
  shotId: "s03",
  endpoint: "bytedance/seedance-like/reference-to-video",
  profileFamily: "seedance-like",
  attachments: [
    {
      requirementKey: "market-plate",
      source: { assetId: id("b") },
      slot: "images",
      order: 2,
      roleSentence: "the market at dusk, take only the place and light",
    },
    {
      requirementKey: "mara-identity",
      source: { assetId: id("a") },
      slot: "images",
      order: 1,
      roleSentence: "the face and hair of Mara.",
    },
    {
      requirementKey: "dance-motion",
      source: { assetId: id("c") },
      slot: "videos",
      order: 1,
      roleSentence: "the dance moves to copy",
    },
    {
      requirementKey: "song",
      source: { assetId: id("d") },
      slot: "audio",
      order: 1,
      roleSentence: "the music she dances to",
    },
  ],
  prompt: {
    action: "Mara dances through the night market.",
    invariants: ["Mara wears a red coat with brass buttons."],
    camera: "Slow dolly-in at eye level.",
    audio: "Market chatter, no dialogue.",
    preserve: ["Mara's face", "the coat"],
    avoid: ["extra people"],
  },
  params: { duration: 8, aspect_ratio: "9:16" },
  audioPolicy: "reference-driven" as const,
};
const seedanceMedia = {
  [id("a")]: image(),
  [id("b")]: image({ width: 1920, height: 1080 }),
  [id("c")]: video(),
  [id("d")]: audio(),
};

const kling: ProfileIn = {
  schemaVersion: 1,
  family: "kling-like",
  endpoints: ["fal-ai/kling-like/*"],
  provider: "fal",
  status: "live",
  slots: [
    {
      id: "element-frontal",
      modality: "image",
      pointer: "/elements/{n}/frontal_image_url",
      roles: ["identity", "product"],
      max: 1,
      evidence,
    },
    {
      id: "element-references",
      modality: "image",
      pointer: "/elements/{n}/reference_image_urls",
      roles: ["identity", "product"],
      min: 1,
      max: 3,
      evidence,
    },
    {
      id: "element-video",
      modality: "video",
      pointer: "/elements/{n}/video_url",
      roles: ["performance"],
      max: 1,
      durationSec: { min: 3, max: 10 },
      evidence,
    },
    { id: "images", modality: "image", pointer: "/image_urls", roles: ["location", "style"], max: 4, evidence },
  ],
  totals: { max: 4 },
  dialect: { kind: "at-element", templates: { image: "@Image{n}" }, elementTemplate: "@Element{n}", evidence },
  policies,
};
const klingPack = {
  schemaVersion: 1 as const,
  id: "courier",
  shotId: "s05",
  endpoint: "fal-ai/kling-like/reference-to-video",
  profileFamily: "kling-like",
  attachments: [
    {
      requirementKey: "warehouse",
      source: { assetId: id("e") },
      slot: "images",
      order: 1,
      roleSentence: "the warehouse set",
    },
    {
      requirementKey: "dancer",
      source: { assetId: id("f") },
      slot: "element-video",
      order: 1,
      roleSentence: "the dancer whose performance to keep",
      element: { index: 2, part: "video" as const },
    },
    {
      requirementKey: "mara-side",
      source: { assetId: id("b") },
      slot: "element-references",
      order: 2,
      roleSentence: "Mara from the side",
      element: { index: 1, part: "reference" as const },
    },
    {
      requirementKey: "mara-front",
      source: { assetId: id("a") },
      slot: "element-frontal",
      order: 1,
      roleSentence: "Mara, the courier",
      element: { index: 1, part: "frontal" as const },
    },
    {
      requirementKey: "mara-back",
      source: { assetId: id("c") },
      slot: "element-references",
      order: 1,
      roleSentence: "Mara from behind",
      element: { index: 1, part: "reference" as const },
    },
  ],
  prompt: { action: "@Element1 walks through @Image1 and dances like @Element2." },
  params: { duration: "5" },
  audioPolicy: "mute" as const,
};
const klingMedia = {
  [id("a")]: image(),
  [id("b")]: image(),
  [id("c")]: image(),
  [id("e")]: image(),
  [id("f")]: video(),
};

const flux: ProfileIn = {
  schemaVersion: 1,
  family: "flux-like",
  endpoints: ["fal-ai/flux-like/edit"],
  provider: "fal",
  status: "live",
  slots: [
    {
      id: "images",
      modality: "image",
      pointer: "/image_urls",
      roles: ["identity", "style", "product"],
      max: 10,
      evidence,
    },
  ],
  dialect: { kind: "prose-indexed", evidence },
  negativePrompt: true,
  policies,
};
const twoImagePack = (family: string, endpoint: string) => ({
  schemaVersion: 1 as const,
  id: "poster",
  shotId: "s01",
  endpoint,
  profileFamily: family,
  attachments: [
    {
      requirementKey: "subject",
      source: { assetId: id("a") },
      slot: "images",
      order: 1,
      roleSentence: "the woman in the green coat",
    },
    {
      requirementKey: "look",
      source: { assetId: id("b") },
      slot: "images",
      order: 2,
      roleSentence: "the watercolour style, without its subject",
    },
  ],
  prompt: { action: "A poster of the woman cycling along the river.", avoid: ["text", "watermarks"] },
  audioPolicy: "mute" as const,
});
const twoImages = { [id("a")]: image(), [id("b")]: image() };

const natural: ProfileIn = {
  ...flux,
  family: "omni-like",
  endpoints: ["fal-ai/omni-like"],
  slots: [
    {
      id: "images",
      modality: "image",
      pointer: "/reference_image_urls",
      roles: ["identity", "style"],
      max: 3,
      evidence,
    },
  ],
  dialect: { kind: "natural", evidence },
  negativePrompt: false,
};
const parameter: ProfileIn = {
  ...flux,
  family: "mj-like",
  endpoints: ["mj-like/imagine"],
  slots: [
    { id: "omni", modality: "image", pointer: "/omni_reference_url", roles: ["identity"], max: 1, evidence },
    { id: "style", modality: "image", pointer: "/style_reference_urls", roles: ["style"], max: 4, evidence },
  ],
  dialect: { kind: "parameter", evidence },
  negativePrompt: false,
};
const named: ProfileIn = {
  ...flux,
  family: "runway-like",
  endpoints: ["runway-like/references"],
  slots: [
    {
      id: "images",
      modality: "image",
      pointer: "/reference_image_urls",
      roles: ["identity", "location"],
      max: 3,
      evidence,
    },
  ],
  dialect: { kind: "at-named", evidence },
  negativePrompt: false,
};
const genjutsu: ProfileIn = {
  schemaVersion: 1,
  family: "genjutsu-like",
  endpoints: ["higgsfield/genjutsu/*/v1.0"],
  provider: "higgsfield",
  status: "live",
  slots: [
    {
      id: "source",
      modality: "video",
      pointer: "/video_url",
      roles: ["source-video"],
      min: 1,
      max: 1,
      durationSec: { min: 4, max: 30 },
      evidence,
    },
    {
      id: "images",
      modality: "image",
      pointer: "/image_urls",
      roles: ["identity", "wardrobe", "prop"],
      max: 8,
      evidence,
    },
  ],
  dialect: { kind: "at-indexed", templates: { image: "@Image{n}", video: "@Video{n}" }, evidence },
  promptTemplate: "genjutsu-legacy",
  policies,
};

// --- AC11: one pack per profile, fixed output ---

test("at-indexed (Seedance-like): input, prompt, markers and pointers", () => {
  const out = compilePack({ spec: seedancePack, profile: seedance, media: seedanceMedia });
  assert.equal(
    out.compiledPrompt,
    [
      "Mara dances through the night market.",
      "@Image1 is the face and hair of Mara. @Image2 is the market at dusk, take only the place and light. @Video1 is the dance moves to copy. @Audio1 is the music she dances to.",
      "Mara wears a red coat with brass buttons.",
      "Slow dolly-in at eye level.",
      "Market chatter, no dialogue.",
      "Preserve: Mara's face; the coat.",
      "Avoid: extra people.",
    ].join("\n"),
  );
  assert.equal(
    JSON.stringify(out.input),
    JSON.stringify({
      image_urls: [ref("a"), ref("b")],
      video_urls: [ref("c")],
      audio_urls: [ref("d")],
      prompt: out.compiledPrompt,
      duration: 8,
      aspect_ratio: "9:16",
    }),
  );
  assert.deepEqual(out.markerMap, { "@Image1": id("a"), "@Image2": id("b"), "@Video1": id("c"), "@Audio1": id("d") });
  assert.deepEqual(out.attachments, [
    { requirementKey: "mara-identity", marker: "@Image1", pointer: "/image_urls/0", assetRef: ref("a") },
    { requirementKey: "market-plate", marker: "@Image2", pointer: "/image_urls/1", assetRef: ref("b") },
    { requirementKey: "dance-motion", marker: "@Video1", pointer: "/video_urls/0", assetRef: ref("c") },
    { requirementKey: "song", marker: "@Audio1", pointer: "/audio_urls/0", assetRef: ref("d") },
  ]);
  assert.deepEqual(out.warnings, []);
});

test("at-element (Kling-like): elements assembled, element and image markers", () => {
  const out = compilePack({ spec: klingPack, profile: kling, media: klingMedia });
  assert.equal(
    out.compiledPrompt,
    "@Element1 walks through @Image1 and dances like @Element2.\n@Element1 is Mara, the courier. @Element2 is the dancer whose performance to keep. @Image1 is the warehouse set.",
  );
  assert.equal(
    JSON.stringify(out.input),
    JSON.stringify({
      elements: [{ frontal_image_url: ref("a"), reference_image_urls: [ref("c"), ref("b")] }, { video_url: ref("f") }],
      image_urls: [ref("e")],
      prompt: out.compiledPrompt,
      duration: "5",
    }),
  );
  assert.deepEqual(out.markerMap, { "@Element1": id("a"), "@Element2": id("f"), "@Image1": id("e") });
  assert.deepEqual(
    out.attachments.map((a) => [a.requirementKey, a.marker, a.pointer]),
    [
      ["mara-front", "@Element1", "/elements/0/frontal_image_url"],
      ["mara-back", "@Element1", "/elements/0/reference_image_urls/0"],
      ["mara-side", "@Element1", "/elements/0/reference_image_urls/1"],
      ["dancer", "@Element2", "/elements/1/video_url"],
      ["warehouse", "@Image1", "/image_urls/0"],
    ],
  );
});

test("prose-indexed (FLUX-like): 'image N' wording and a negative prompt field", () => {
  const out = compilePack({
    spec: twoImagePack("flux-like", "fal-ai/flux-like/edit"),
    profile: flux,
    media: twoImages,
  });
  assert.equal(
    out.compiledPrompt,
    "A poster of the woman cycling along the river.\nImage 1 is the woman in the green coat. Image 2 is the watercolour style, without its subject.",
  );
  assert.deepEqual(out.input, {
    image_urls: [ref("a"), ref("b")],
    prompt: out.compiledPrompt,
    negative_prompt: "text, watermarks",
  });
  assert.deepEqual(out.markerMap, { "image 1": id("a"), "image 2": id("b") });
  assert.doesNotMatch(out.compiledPrompt, /@/);
});

test("natural (Omni-like): role descriptions, no @ markers, avoid folded into prose", () => {
  const out = compilePack({ spec: twoImagePack("omni-like", "fal-ai/omni-like"), profile: natural, media: twoImages });
  assert.equal(
    out.compiledPrompt,
    "A poster of the woman cycling along the river.\nThe first reference image is the woman in the green coat. The second reference image is the watercolour style, without its subject.\nAvoid: text; watermarks.",
  );
  assert.deepEqual(out.input, { reference_image_urls: [ref("a"), ref("b")], prompt: out.compiledPrompt });
  assert.doesNotMatch(out.compiledPrompt, /@(Image|Video|Audio|Element)/);
  assert.deepEqual(Object.keys(out.markerMap), ["the first reference image", "the second reference image"]);
  refusal(
    () =>
      compilePack({
        spec: { ...twoImagePack("omni-like", "fal-ai/omni-like"), prompt: { action: "Keep @Image1 as she is." } },
        profile: natural,
        media: twoImages,
      }),
    /is not a marker of omni-like \(natural dialect\)/,
  );
});

test("parameter (Midjourney-like): references bound to fields, no prompt markers", () => {
  const spec = {
    ...twoImagePack("mj-like", "mj-like/imagine"),
    attachments: [
      { requirementKey: "subject", source: { assetId: id("a") }, slot: "omni", order: 1, roleSentence: "the woman" },
      {
        requirementKey: "look",
        source: { assetId: id("b") },
        slot: "style",
        order: 1,
        roleSentence: "the watercolour look",
      },
    ],
  };
  const out = compilePack({ spec, profile: parameter, media: twoImages });
  assert.equal(out.compiledPrompt, "A poster of the woman cycling along the river.\nAvoid: text; watermarks.");
  assert.deepEqual(out.input, {
    omni_reference_url: ref("a"),
    style_reference_urls: [ref("b")],
    prompt: out.compiledPrompt,
  });
  assert.deepEqual(out.markerMap, {});
  assert.deepEqual(
    out.attachments.map((a) => [a.marker, a.pointer]),
    [
      ["", "/omni_reference_url"],
      ["", "/style_reference_urls/0"],
    ],
  );
});

test("at-named (Runway-like): tags from hyphenated requirement keys, validated", () => {
  const spec = {
    ...twoImagePack("runway-like", "runway-like/references"),
    attachments: [
      {
        requirementKey: "hero-identity",
        source: { assetId: id("a") },
        slot: "images",
        order: 1,
        roleSentence: "the hero's face",
      },
      { requirementKey: "market", source: { assetId: id("b") }, slot: "images", order: 2, roleSentence: "the market" },
    ],
    prompt: { action: "@heroidentity walks through @market at dusk." },
  };
  const out = compilePack({ spec, profile: named, media: twoImages });
  assert.equal(
    out.compiledPrompt,
    "@heroidentity walks through @market at dusk.\n@heroidentity is the hero's face. @market is the market.",
  );
  assert.deepEqual(out.markerMap, { "@heroidentity": id("a"), "@market": id("b") });
  assert.equal(namedTag("hero-identity"), "@heroidentity");
  refusal(() => namedTag("a-very-long-requirement-key"), /3–15 letters or digits/);
  refusal(() => namedTag("7up"), /starting with a letter/);
  refusal(
    () =>
      compilePack({
        spec: { ...spec, prompt: { action: "@heroine walks through @market." } },
        profile: named,
        media: twoImages,
      }),
    /"@heroine" is not a marker of runway-like \(at-named/,
  );
});

test("dialect helpers: ordinals, digit-bounded parsing, foreign markers", () => {
  assert.equal(ordinalWord(3), "third");
  assert.equal(ordinalWord(21), "21st");
  assert.equal(ordinalWord(12), "twelfth");
  const profile = ReferenceProfileSchema.parse(seedance);
  assert.equal(markerFor(profile, { modality: "audio", ordinal: 2, requirementKey: "x" }), "@Audio2");
  assert.deepEqual(
    findMarkers(profile, "@Image10 then @Image1, @Element1 and @Image 2").map((m) => [m.text, m.kind, m.marker]),
    [
      ["@Image10", "own", "@Image10"],
      ["@Image1", "own", "@Image1"],
      ["@Element1", "foreign", undefined],
      ["@Image 2", "foreign", undefined],
    ],
  );
  const prose = ReferenceProfileSchema.parse(flux);
  assert.deepEqual(
    findMarkers(prose, "Image 1 and image 12, not @Image1").map((m) => [m.kind, m.marker ?? m.text]),
    [
      ["own", "image 1"],
      ["own", "image 12"],
      ["foreign", "@Image1"],
    ],
  );
});

// --- AC11: bijection ---

test("bijection: out-of-range, zero, foreign and unnamed markers are refused", () => {
  const withAction = (action: string, extra: object = {}) => ({
    ...seedancePack,
    prompt: { ...seedancePack.prompt, action, ...extra },
  });
  const run = (spec: object, profile: ProfileIn = seedance) =>
    compilePack({ spec: spec as typeof seedancePack, profile, media: seedanceMedia });
  run(withAction("@Image1 dances in @Image2 to @Audio1.")); // in-range markers in user text are fine
  refusal(() => run(withAction("@Image3 dances.")), /"@Image3" does not name any attachment/);
  refusal(() => run(withAction("@Image0 dances.")), /"@Image0" does not name/);
  refusal(() => run(withAction("@Image10 dances.")), /"@Image10" does not name/);
  refusal(() => run(withAction("@Video2 dances.")), /"@Video2" does not name/);
  refusal(
    () => run(withAction("Mara dances.", { invariants: ["@Element1 keeps the coat."] })),
    /"@Element1" is not a marker of seedance-like \(at-indexed/,
  );
  refusal(() => run(withAction("Mara dances.", { additional: "Like [Audio1]." })), /"\[Audio1\]" is not/);
  refusal(() => run(withAction("Mara dances.", { preserve: ["@Image 1"] })), /"@Image 1" is not/);
  refusal(
    () => run(seedancePack, { ...seedance, promptOrder: ["action", "invariants", "camera", "audio", "preserve"] }),
    /mara-identity \(@Image1\) is never named/,
  );
  // A marker in the avoid list is checked in the negative prompt too.
  refusal(
    () =>
      compilePack({
        spec: {
          ...twoImagePack("flux-like", "fal-ai/flux-like/edit"),
          prompt: { action: "A poster.", avoid: ["image 3"] },
        },
        profile: flux,
        media: twoImages,
      }),
    /"image 3" does not name/,
  );
});

test("sections outside the profile's prompt order are dropped with a warning", () => {
  const out = compilePack({
    spec: seedancePack,
    profile: { ...seedance, promptOrder: ["bindings", "action", "preserve"] },
    media: seedanceMedia,
  });
  assert.match(out.compiledPrompt, /^@Image1 is the face/);
  assert.ok(out.warnings.some((w) => /camera is not in seedance-like's prompt order/.test(w)));
});

// --- Positional slots (marker "none") and marker groups ---

const framed: ProfileIn = {
  schemaVersion: 1,
  family: "framed-like",
  endpoints: ["fal-ai/framed-like/reference-to-video"],
  provider: "fal",
  status: "live",
  slots: [
    // First in slot order: a counter that still advanced here would turn image_urls into @Image2.
    {
      id: "start",
      modality: "image",
      pointer: "/start_image_url",
      roles: ["first-frame"],
      max: 1,
      marker: "none",
      evidence,
    },
    { id: "images", modality: "image", pointer: "/image_urls", roles: ["identity", "style"], max: 4, evidence },
    {
      id: "end",
      modality: "image",
      pointer: "/end_image_url",
      roles: ["last-frame"],
      max: 1,
      marker: "none",
      evidence,
    },
  ],
  dialect: { kind: "at-indexed", templates: { image: "@Image{n}" }, evidence },
  policies,
};
const framedPack = (attachments: [string, string, string][], action = "Mara walks out of the fog.") => ({
  schemaVersion: 1 as const,
  id: "framed",
  shotId: "s05",
  endpoint: "fal-ai/framed-like/reference-to-video",
  profileFamily: "framed-like",
  attachments: attachments.map(([slot, seed, roleSentence]) => ({
    requirementKey: slot,
    source: { assetId: id(seed) },
    slot,
    order: 1,
    roleSentence,
  })),
  prompt: { action },
  audioPolicy: "native" as const,
});
const framedMedia = { [id("a")]: image(), [id("b")]: image(), [id("c")]: image() };
const all: [string, string, string][] = [
  ["start", "a", "the opening frame"],
  ["images", "b", "Mara, the courier"],
  ["end", "c", "the closing frame"],
];

test("marker none: positional slots take no marker number and read as prose", () => {
  const out = compilePack({ spec: framedPack(all), profile: framed, media: framedMedia });
  assert.equal(
    out.compiledPrompt,
    "Mara walks out of the fog.\nThe start image is the opening frame. @Image1 is Mara, the courier. The end image is the closing frame.",
  );
  assert.deepEqual(out.markerMap, { "@Image1": id("b") });
  assert.deepEqual(
    out.attachments.map((a) => [a.requirementKey, a.marker, a.pointer]),
    [
      ["start", "", "/start_image_url"],
      ["images", "@Image1", "/image_urls/0"],
      ["end", "", "/end_image_url"],
    ],
  );
  assert.equal(out.input.start_image_url, ref("a"));
  assert.equal(out.input.end_image_url, ref("c"));
  // A natural dialect reads the same prose; a parameter dialect renders no bindings at all.
  const natural = compilePack({
    spec: framedPack(all),
    profile: { ...framed, dialect: { kind: "natural", evidence } },
    media: framedMedia,
  });
  assert.match(natural.compiledPrompt, /^The start image is the opening frame\. The first reference image is Mara/m);
  const parameter = compilePack({
    spec: framedPack(all),
    profile: { ...framed, dialect: { kind: "parameter", evidence } },
    media: framedMedia,
  });
  assert.equal(parameter.compiledPrompt, "Mara walks out of the fog.");
});

test("marker none: the bijection ignores positional slots and refuses a marker aimed at one", () => {
  const noBindings = { ...framed, promptOrder: ["action" as const] };
  // Only @Image1 must be named; the start and end frames are never named and need not be.
  const out = compilePack({
    spec: framedPack(all, "@Image1 walks out of the fog."),
    profile: noBindings,
    media: framedMedia,
  });
  assert.equal(out.compiledPrompt, "@Image1 walks out of the fog.");
  refusal(
    () => compilePack({ spec: framedPack(all, "@Image2 fades in."), profile: framed, media: framedMedia }),
    /"@Image2" does not name any attachment \(the pack names @Image1\)\. Slot start \(\/start_image_url\) is bound by position and never named by a marker/,
  );
  // With only the start frame attached, "@Image1" cannot reach it either.
  refusal(
    () =>
      compilePack({
        spec: framedPack([all[0]!], "@Image1 opens the shot."),
        profile: framed,
        media: framedMedia,
      }),
    /"@Image1" does not name any attachment \(the pack names none\)\. Slot start/,
  );
});

test("markerGroup: slots in one group share a running index; separate groups of one form collide", () => {
  const shared: ProfileIn = {
    ...framed,
    family: "shared-like",
    endpoints: ["fal-ai/shared-like/reference-to-video"],
    slots: [
      {
        id: "images",
        modality: "image",
        pointer: "/image_urls",
        roles: ["identity"],
        max: 4,
        markerGroup: "refs",
        evidence,
      },
      {
        id: "videos",
        modality: "video",
        pointer: "/video_urls",
        roles: ["motion"],
        max: 2,
        markerGroup: "refs",
        evidence,
      },
    ],
    dialect: { kind: "at-indexed", templates: { image: "@Ref{n}", video: "@Ref{n}" }, evidence },
  };
  const spec = {
    ...framedPack([
      ["images", "a", "Mara, the courier"],
      ["videos", "d", "the dance movement"],
    ]),
    endpoint: "fal-ai/shared-like/reference-to-video",
    profileFamily: "shared-like",
  };
  const media = { [id("a")]: image(), [id("d")]: video() };
  const out = compilePack({ spec, profile: shared, media });
  assert.equal(
    out.compiledPrompt,
    "Mara walks out of the fog.\n@Ref1 is Mara, the courier. @Ref2 is the dance movement.",
  );
  assert.deepEqual(out.markerMap, { "@Ref1": id("a"), "@Ref2": id("d") });
  const split = { ...shared, slots: shared.slots.map(({ markerGroup: _group, ...slot }) => slot) };
  refusal(() => compilePack({ spec, profile: split, media }), /Two attachments share a marker \(@Ref1, @Ref1\)/);
});

test("schema: a marker-less slot has no marker group and is never an element slot", () => {
  const slot = { ...framed.slots[0]!, markerGroup: "frames" };
  assert.equal(ReferenceProfileSchema.safeParse({ ...framed, slots: [slot] }).success, false);
  const element = { ...framed.slots[0]!, pointer: "/elements/{n}/frontal_image_url" };
  assert.equal(ReferenceProfileSchema.safeParse({ ...framed, slots: [element] }).success, false);
});

// --- AC12: limits refused with the fix named ---

test("each slot limit refuses with the derivation step that fixes it", () => {
  const run = (key: string, facts: MediaFacts, profile: ProfileIn = seedance) =>
    compilePack({ spec: seedancePack, profile, media: { ...seedanceMedia, [id(key)]: facts } });
  refusal(
    () => run("a", image({ width: 200, height: 400 })),
    /short edge 200 px is below 300 px.*"scale" derivative/,
    "scale",
  );
  refusal(() => run("a", image({ width: 8000, height: 4000 })), /long edge 8000 px exceeds 6000 px/, "scale");
  refusal(() => run("a", image({ width: 3000, height: 1000 })), /aspect 3\.000 is outside 0\.4–2\.5.*"crop"/, "crop");
  refusal(() => run("a", image({ bytes: 40 * 1024 * 1024 })), /bytes exceed/, "scale");
  refusal(() => run("a", image({ hasAlpha: true })), /transparency.*"flatten"/, "flatten");
  refusal(() => run("a", image({ contentType: "image/webp" })), /not an accepted format.*No derivation step/, null);
  refusal(() => run("c", video({ durationSec: 20 })), /duration 20 s exceeds 15 s.*"trim"/, "trim");
  refusal(() => run("c", video({ durationSec: 1 })), /below 2 s.*No derivation step lengthens/, null);
  refusal(() => run("c", video({ fps: 120 })), /120 fps is outside 24–60.*"fps"/, "fps");
  refusal(() => run("c", video({ durationSec: undefined })), /not measured/, null);
  refusal(() => run("d", audio({ durationSec: 16 })), /exceeds 15 s.*"audio-trim"/, "audio-trim");
  const snapProfile = {
    ...seedance,
    slots: seedance.slots.map((s, i) => (i ? s : { ...s, pixels: { multipleOf: 16 } })),
  };
  refusal(() => run("a", image({ width: 1000, height: 1000 }), snapProfile), /not a multiple of 16.*"snap"/, "snap");
  // Combined duration across a slot.
  const twoVideos = {
    ...seedancePack,
    attachments: [
      ...seedancePack.attachments,
      {
        requirementKey: "dance-two",
        source: { assetId: id("9") },
        slot: "videos",
        order: 2,
        roleSentence: "the second dance",
      },
    ],
    prompt: { ...seedancePack.prompt, action: "Mara dances like @Video2." },
  };
  refusal(
    () =>
      compilePack({
        spec: twoVideos,
        profile: seedance,
        media: { ...seedanceMedia, [id("c")]: video({ durationSec: 10 }), [id("9")]: video({ durationSec: 10 }) },
      }),
    /20 s combined.*"trim"/,
    "trim",
  );
  refusal(
    () => compilePack({ spec: seedancePack, profile: seedance, media: { [id("a")]: image() } }),
    /no measured media facts/,
  );
  // Unknown alpha handling warns instead of refusing.
  const unknownAlpha = { ...flux, slots: [{ ...flux.slots[0]!, alpha: "unknown" as const }] };
  const out = compilePack({
    spec: twoImagePack("flux-like", "fal-ai/flux-like/edit"),
    profile: unknownAlpha,
    media: { ...twoImages, [id("a")]: image({ hasAlpha: true }) },
  });
  assert.ok(out.warnings.some((w) => /transparency/.test(w)));
});

test("counts: per slot, totals, images with video, required slots, duplicates", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      requirementKey: `img-${i + 1}`,
      source: { assetId: id(i.toString(16)) },
      slot: "images",
      order: i + 1,
      roleSentence: `image ${i + 1}`,
    }));
  const media = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [id(i.toString(16)), image()]));
  const flat = (n: number) => ({ ...twoImagePack("flux-like", "fal-ai/flux-like/edit"), attachments: many(n) });
  refusal(
    () => compilePack({ spec: flat(11), profile: flux, media }),
    /Slot images has 11 attachments; flux-like allows 10/,
  );
  refusal(
    () => compilePack({ spec: flat(4), profile: { ...flux, totals: { max: 3 } }, media }),
    /4 references.*allows 3/,
  );
  const withVideo = {
    ...seedancePack,
    attachments: [...many(5).map((a) => ({ ...a, roleSentence: "a reference" })), seedancePack.attachments[2]!],
    prompt: { action: "Dance." },
  };
  refusal(
    () => compilePack({ spec: withVideo, profile: seedance, media: { ...media, [id("c")]: video() } }),
    /With a video reference seedance-like allows 4 images; the pack has 5/,
  );
  refusal(
    () =>
      compilePack({
        spec: { ...seedancePack, attachments: [seedancePack.attachments[1]!] },
        profile: { ...seedance, slots: seedance.slots.map((s) => (s.id === "audio" ? { ...s, min: 1 } : s)) },
        media: seedanceMedia,
      }),
    /Slot audio needs at least 1/,
  );
  const duplicate = {
    ...seedancePack,
    attachments: [...seedancePack.attachments, { ...seedancePack.attachments[0]!, requirementKey: "again", order: 3 }],
  };
  refusal(() => compilePack({ spec: duplicate, profile: seedance, media: seedanceMedia }), /attached twice/);
  refusal(
    () => compilePack({ spec: { ...seedancePack, profileFamily: "other" }, profile: seedance, media: seedanceMedia }),
    /targets profile other/,
  );
  refusal(
    () => compilePack({ spec: { ...seedancePack, endpoint: "fal-ai/other" }, profile: seedance, media: seedanceMedia }),
    /not covered by profile/,
  );
});

test("one asset may serve two slots, never twice in one slot or one element", () => {
  // The frontal image of element 1 is also the scene image: legitimate (a keyframe as identity and as image).
  const reused = {
    ...klingPack,
    attachments: klingPack.attachments.map((a) =>
      a.requirementKey === "warehouse" ? { ...a, source: { assetId: id("a") } } : a,
    ),
  };
  const out = compilePack({ spec: reused, profile: kling, media: klingMedia });
  assert.equal(out.markerMap["@Image1"], id("a"));
  assert.equal(out.markerMap["@Element1"], id("a"));
  assert.equal((out.input.image_urls as string[])[0], ref("a"));
  // The same asset as frontal and reference of one element: refused.
  const sameElement = {
    ...klingPack,
    attachments: klingPack.attachments.map((a) =>
      a.requirementKey === "mara-side" ? { ...a, source: { assetId: id("a") } } : a,
    ),
  };
  refusal(() => compilePack({ spec: sameElement, profile: kling, media: klingMedia }), /attached twice in element 1/);
});

test("Kling-like element assembly rules", () => {
  const without = (key: string) => klingPack.attachments.filter((a) => a.requirementKey !== key);
  const run = (attachments: object[]) =>
    compilePack({
      spec: { ...klingPack, attachments: attachments as typeof klingPack.attachments },
      profile: kling,
      media: { ...klingMedia, [id("9")]: image(), [id("8")]: image(), [id("7")]: video() },
    });
  refusal(() => run(without("mara-front")), /Element 1 needs one frontal image and 1–3 reference images/);
  refusal(
    () => run(without("mara-back").filter((a) => a.requirementKey !== "mara-side")),
    /Element 1 needs one frontal image and 1–3/,
  );
  const extraRefs = [3, 4].map((order, i) => ({
    requirementKey: `ref-${order}`,
    source: { assetId: id(["9", "8"][i]!) },
    slot: "element-references",
    order,
    roleSentence: "more Mara",
    element: { index: 1, part: "reference" },
  }));
  refusal(
    () => run([...klingPack.attachments, ...extraRefs]),
    /Element 1 has 4 attachments in slot element-references; the slot allows 3/,
  );
  refusal(
    () =>
      run([
        ...klingPack.attachments,
        {
          requirementKey: "mixed",
          source: { assetId: id("7") },
          slot: "element-video",
          order: 2,
          roleSentence: "x",
          element: { index: 1, part: "video" },
        },
      ]),
    /either one video or a frontal image/,
  );
  refusal(
    () =>
      run([
        ...without("warehouse"),
        {
          requirementKey: "dancer-two",
          source: { assetId: id("7") },
          slot: "element-video",
          order: 2,
          roleSentence: "x",
          element: { index: 3, part: "video" },
        },
      ]),
    /one video element per request/,
  );
  refusal(
    () =>
      run(
        klingPack.attachments.map((a) =>
          a.requirementKey === "dancer" ? { ...a, element: { index: 3, part: "video" } } : a,
        ),
      ),
    /without gaps/,
  );
  refusal(
    () =>
      run(
        klingPack.attachments.map((a) =>
          a.requirementKey === "warehouse" ? { ...a, element: { index: 1, part: "reference" } } : a,
        ),
      ),
    /not an element slot/,
  );
  refusal(
    () => run(klingPack.attachments.map((a) => (a.requirementKey === "dancer" ? { ...a, element: undefined } : a))),
    /needs an element index/,
  );
});

// --- Params, schema and guard ---

test("params cannot overwrite reference fields or the prompt", () => {
  for (const key of ["image_urls", "prompt", "audio_urls"])
    refusal(
      () =>
        compilePack({ spec: { ...seedancePack, params: { [key]: ["x"] } }, profile: seedance, media: seedanceMedia }),
      new RegExp(`cannot set /${key}`),
    );
  refusal(
    () => compilePack({ spec: { ...klingPack, params: { elements: [] } }, profile: kling, media: klingMedia }),
    /cannot set \/elements/,
  );
  refusal(
    () =>
      compilePack({
        spec: { ...twoImagePack("flux-like", "fal-ai/flux-like/edit"), params: { negative_prompt: "blur" } },
        profile: flux,
        media: twoImages,
      }),
    /cannot set \/negative_prompt/,
  );
});

test("params cannot inject references into an unused slot or set the negative prompt", () => {
  const noAudio = { ...seedancePack, attachments: seedancePack.attachments.filter((a) => a.slot !== "audio") };
  refusal(
    () =>
      compilePack({
        spec: { ...noAudio, params: { audio_urls: ["https://example.com/a.mp3"] } },
        profile: seedance,
        media: seedanceMedia,
      }),
    /cannot set \/audio_urls/,
  );
  refusal(
    () =>
      compilePack({
        spec: {
          ...klingPack,
          attachments: klingPack.attachments.filter((a) => !a.element),
          prompt: { action: "In @Image1." },
          params: { elements: [] },
        },
        profile: kling,
        media: klingMedia,
      }),
    /cannot set \/elements/,
  );
  refusal(
    () =>
      compilePack({
        spec: { ...noAudio, params: { negative_prompt: "@Image9" } },
        profile: seedance,
        media: seedanceMedia,
      }),
    /cannot set \/negative_prompt/,
  );
});

test("element parts must match their slot's modality; element bindings read in element order", () => {
  refusal(
    () =>
      compilePack({
        spec: {
          ...klingPack,
          attachments: klingPack.attachments.map((a) =>
            a.requirementKey === "mara-front" ? { ...a, element: { index: 1, part: "video" as const } } : a,
          ),
        },
        profile: kling,
        media: klingMedia,
      }),
    /element video part but slot element-frontal carries image/,
  );
  // Element 1 is the video, element 2 the image set: bindings still read @Element1 before @Element2.
  const swapped = klingPack.attachments.map((a) =>
    a.element ? { ...a, element: { ...a.element, index: a.element.index === 1 ? 2 : 1 } } : a,
  );
  const out = compilePack({ spec: { ...klingPack, attachments: swapped }, profile: kling, media: klingMedia });
  assert.equal(
    out.compiledPrompt.split("\n")[1],
    "@Element1 is the dancer whose performance to keep. @Element2 is Mara, the courier. @Image1 is the warehouse set.",
  );
  assert.equal(
    JSON.stringify(out.input.elements),
    JSON.stringify([
      { video_url: ref("f") },
      { frontal_image_url: ref("a"), reference_image_urls: [ref("c"), ref("b")] },
    ]),
  );
});

test("input schema and provider guard run on the compiled input", () => {
  const inputSchema = {
    type: "object",
    properties: {
      image_urls: { type: "array", items: { type: "string" }, maxItems: 9 },
      video_urls: { type: "array", items: { type: "string" } },
      audio_urls: { type: "array", items: { type: "string" } },
      prompt: { type: "string" },
      duration: { type: "integer" },
      aspect_ratio: { enum: ["9:16", "16:9"] },
    },
    required: ["prompt"],
  };
  const seen: Record<string, unknown>[] = [];
  const out = compilePack({
    spec: seedancePack,
    profile: seedance,
    media: seedanceMedia,
    inputSchema,
    guard: (input, warnings) => {
      seen.push(input);
      warnings.push("guard ran");
    },
  });
  assert.equal(seen[0], out.input);
  assert.deepEqual(out.warnings, ["guard ran"]);
  refusal(
    () =>
      compilePack({
        spec: { ...seedancePack, params: { duration: 8, fps: 24 } },
        profile: seedance,
        media: seedanceMedia,
        inputSchema,
      }),
    /fails the endpoint check/,
  );
  refusal(
    () =>
      compilePack({
        spec: seedancePack,
        profile: seedance,
        media: seedanceMedia,
        guard: () => {
          throw new FalOperationError("INVALID_INPUT", "Seedance reference duration must be 1.8–30.2 seconds.");
        },
      }),
    /fails the endpoint check: Seedance reference duration/,
  );
});

// --- AC15 (prompt part): genjutsu-legacy parity with genjutsuPrompt() ---

const presetId = loadHiggsfieldRestylePresets().presets[0]!.id;
const prep = (over: Record<string, unknown> = {}) =>
  ModelPreparationSpecSchema.parse({
    schemaVersion: 1,
    id: "swap-v1",
    mode: "object-swap",
    sourceAssetId: id("0"),
    segment: { startSec: 1, durationSec: 4 },
    references: [{ kind: "character", entityId: "hero", revision: 1, role: "front" }],
    target: {
      description: "the performer on the left",
      change: "Use the approved hero identity.",
      preserve: ["camera and motion", "background"],
      otherSubjects: ["the performer on the right"],
    },
    audioPolicy: "mute",
    ...over,
  });
const parityCases = {
  "object-swap with otherSubjects": prep(),
  "object-swap without markers": prep({ useMarkers: false }),
  "motion-transfer, two refs, additional prompt, no other subjects": prep({
    mode: "motion-transfer",
    references: [
      { kind: "character", entityId: "hero", revision: 1, role: "front" },
      { kind: "object", entityId: "lantern", revision: 2, role: "packshot-front" },
    ],
    target: {
      description: "A lantern-lit night market",
      change: "The hero carries the lantern.",
      preserve: ["the walking rhythm"],
      otherSubjects: [],
    },
    additionalPrompt: "Keep the lantern flame warm and steady.",
    resolution: "1080p",
  }),
  "restyle without references": prep({ mode: "restyle", references: [], presetId }),
  "restyle with a reference, no markers, additional prompt": prep({
    mode: "restyle",
    presetId,
    useMarkers: false,
    additionalPrompt: "Grain like 16 mm film.",
    audioPolicy: "preserve-source",
  }),
};

for (const [name, preparation] of Object.entries(parityCases))
  test(`genjutsu-legacy parity: ${name}`, () => {
    const referenceAssetIds = preparation.references.map((_, i) => id(String(i + 1)));
    const prepared = id("f");
    const { spec, profile } = packSpecFromPreparation(preparation, genjutsu, {
      sourceAssetId: prepared,
      referenceAssetIds,
    });
    assert.equal(spec.endpoint, genjutsuEndpoint(preparation.mode));
    const media = Object.fromEntries([
      [prepared, video({ durationSec: 4 })],
      ...referenceAssetIds.map((asset) => [asset, image()]),
    ]);
    const out = compilePack({ spec, profile, media });
    assert.equal(out.compiledPrompt, genjutsuPrompt(preparation));
    // Same request input, field order included, as prepare.ts builds it.
    assert.equal(
      JSON.stringify(out.input),
      JSON.stringify({
        video_url: ref("f"),
        image_urls: referenceAssetIds.map((asset) => `asset://sha256/${asset.slice(7)}`),
        prompt: genjutsuPrompt(preparation),
        resolution: preparation.resolution,
        ...(preparation.presetId ? { preset_id: preparation.presetId } : {}),
      }),
    );
    if (preparation.useMarkers)
      assert.deepEqual(out.markerMap, {
        "@Video1": prepared,
        ...Object.fromEntries(referenceAssetIds.map((asset, i) => [`@Image${i + 1}`, asset])),
      });
    else assert.doesNotMatch(out.compiledPrompt, /@Video|@Image/);
  });

test("genjutsu-legacy needs a legacy profile and one asset per reference", () => {
  refusal(
    () =>
      packSpecFromPreparation(
        prep(),
        { ...genjutsu, promptTemplate: "default" },
        { sourceAssetId: id("f"), referenceAssetIds: [id("1")] },
      ),
    /genjutsu-legacy/,
  );
  refusal(
    () => packSpecFromPreparation(prep(), genjutsu, { sourceAssetId: id("f"), referenceAssetIds: [] }),
    /exactly one resolved asset/,
  );
});
