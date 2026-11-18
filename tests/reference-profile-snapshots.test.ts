import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compilePack, type MediaFacts } from "../src/lib/references/compile";
import { listProfiles, profileByFamily } from "../src/lib/references/profiles";
import { buildFalOperation } from "../src/lib/providers/fal-operations";
import operationSnapshots from "../src/lib/providers/schemas/fal-operations.json";
import { PROFILE_FIXTURES, fixturePack } from "./helpers/reference-profile-fixtures";

/**
 * RFC 0003 AC11: one fixture pack per shipped profile family, compiled with the real profile from
 * src/lib/models/reference-profiles.json. The compiled prompt, the input fields and the attachment pointers are fixed
 * here; a profile or compiler change that alters them must update this snapshot deliberately. "asset:N" stands for
 * the fixture asset whose hash is N repeated. Tracked and cached endpoint schema fixtures also exercise strict
 * validation and provider guards.
 */

process.env.AGENTBROS_FAL_SCHEMA_CACHE = path.resolve(import.meta.dirname, "fixtures/fal-catalog/schemas");

const SNAPSHOTS: Record<string, { prompt: string; input: unknown; markers: unknown; pointers: string[][] }> = {
  "seedance-2.0": {
    prompt:
      "Mara dances in the rain.\n@Image1 is the face and hair of Mara. @Video1 is the dance movement only. @Audio1 is the voice of Mara.\nSlow push in.",
    input: {
      image_urls: ["asset:1"],
      video_urls: ["asset:2"],
      audio_urls: ["asset:3"],
    },
    markers: {
      "@Image1": "asset:1",
      "@Video1": "asset:2",
      "@Audio1": "asset:3",
    },
    pointers: [
      ["hero-identity", "@Image1", "/image_urls/0"],
      ["dance-motion", "@Video1", "/video_urls/0"],
      ["hero-voice", "@Audio1", "/audio_urls/0"],
    ],
  },
  "seedance-2.5": {
    prompt:
      "Mara dances across the market as the lamps come on.\n@Image1 is the face and hair of Mara. @Image2 is the market at dusk, take only the place and light. @Video1 is the dance movement only. @Audio1 is the voice of Mara.\nMara wears a red scarf.\nMara hums softly.\nAvoid: text overlays.",
    input: {
      image_urls: ["asset:1", "asset:2"],
      video_urls: ["asset:3"],
      audio_urls: ["asset:4"],
    },
    markers: {
      "@Image1": "asset:1",
      "@Image2": "asset:2",
      "@Video1": "asset:3",
      "@Audio1": "asset:4",
    },
    pointers: [
      ["hero-identity", "@Image1", "/image_urls/0"],
      ["market-plate", "@Image2", "/image_urls/1"],
      ["dance-motion", "@Video1", "/video_urls/0"],
      ["hero-voice", "@Audio1", "/audio_urls/0"],
    ],
  },
  "kling-o1": {
    prompt: "Mara runs through the warehouse.\n@Image1 is the warehouse interior. @Element1 is Mara, the courier.",
    input: {
      image_urls: ["asset:3"],
      elements: [
        {
          frontal_image_url: "asset:1",
          reference_image_urls: ["asset:2"],
        },
      ],
      duration: "5",
    },
    markers: {
      "@Image1": "asset:3",
      "@Element1": "asset:1",
    },
    pointers: [
      ["warehouse", "@Image1", "/image_urls/0"],
      ["hero-front", "@Element1", "/elements/0/frontal_image_url"],
      ["hero-side", "@Element1", "/elements/0/reference_image_urls/0"],
    ],
  },
  // start_image_url is positional (marker "none"): its role sentence reads as prose and takes no @Image number.
  "kling-o3": {
    prompt:
      "Mara turns and walks into the fog.\n@Image1 is the film look, colour and grain only. @Element1 is Mara, the courier. The start image is the opening frame.\nHandheld follow.",
    input: {
      image_urls: ["asset:4"],
      elements: [
        {
          frontal_image_url: "asset:1",
          reference_image_urls: ["asset:2", "asset:3"],
        },
      ],
      start_image_url: "asset:1",
      duration: "5",
    },
    markers: {
      "@Image1": "asset:4",
      "@Element1": "asset:1",
    },
    pointers: [
      ["look", "@Image1", "/image_urls/0"],
      ["hero-front", "@Element1", "/elements/0/frontal_image_url"],
      ["hero-side", "@Element1", "/elements/0/reference_image_urls/0"],
      ["hero-back", "@Element1", "/elements/0/reference_image_urls/1"],
      ["opening", "", "/start_image_url"],
    ],
  },
  "kling-o3-video": {
    prompt:
      "Replace the performer with Mara and move the scene to the night street.\n@Video1 is the source performance and camera. @Image1 is the night street. @Element1 is Mara, the courier.",
    input: {
      video_url: "asset:1",
      image_urls: ["asset:4"],
      elements: [
        {
          frontal_image_url: "asset:2",
          reference_image_urls: ["asset:3"],
        },
      ],
    },
    markers: {
      "@Video1": "asset:1",
      "@Image1": "asset:4",
      "@Element1": "asset:2",
    },
    pointers: [
      ["source", "@Video1", "/video_url"],
      ["plate", "@Image1", "/image_urls/0"],
      ["hero-front", "@Element1", "/elements/0/frontal_image_url"],
      ["hero-side", "@Element1", "/elements/0/reference_image_urls/0"],
    ],
  },
  "kling-v3-motion-control": {
    prompt:
      "Mara performs the dance.\nThe character image is Mara in her red coat. The motion video is the dance performance. @Element1 is Mara's face.",
    input: {
      image_url: "asset:1",
      video_url: "asset:2",
      elements: [
        {
          frontal_image_url: "asset:3",
          reference_image_urls: ["asset:4"],
        },
      ],
      character_orientation: "video",
    },
    markers: {
      "@Element1": "asset:3",
    },
    pointers: [
      ["character", "", "/image_url"],
      ["motion", "", "/video_url"],
      ["face", "@Element1", "/elements/0/frontal_image_url"],
      ["face-side", "@Element1", "/elements/0/reference_image_urls/0"],
    ],
  },
  "kling-v2.6-motion-control": {
    prompt:
      "She performs the dance.\nThe character image is the woman in the red coat. The motion video is the dance performance.",
    input: {
      image_url: "asset:1",
      video_url: "asset:2",
    },
    markers: {},
    pointers: [
      ["character", "", "/image_url"],
      ["motion", "", "/video_url"],
    ],
  },
  "nano-banana-2.1": {
    prompt:
      "Place the bottle on the counter in morning light.\nImage 1 is the bottle and its label. Image 2 is the kitchen counter, take only the place and light.",
    input: {
      image_urls: ["asset:1", "asset:2"],
    },
    markers: {
      "image 1": "asset:1",
      "image 2": "asset:2",
    },
    pointers: [
      ["product", "image 1", "/image_urls/0"],
      ["scene", "image 2", "/image_urls/1"],
    ],
  },
  "flux-2": {
    prompt:
      "Paint the woman in this look.\nImage 1 is the woman. Image 2 is the painterly look only.\nAvoid: watermarks.",
    input: {
      image_urls: ["asset:1", "asset:2"],
    },
    markers: {
      "image 1": "asset:1",
      "image 2": "asset:2",
    },
    pointers: [
      ["subject", "image 1", "/image_urls/0"],
      ["look", "image 2", "/image_urls/1"],
    ],
  },
  "gemini-omni": {
    prompt:
      "The woman walks along the pier.\nThe first reference image is the woman in the red coat. The first reference video is the camera move only.",
    input: {
      image_urls: ["asset:1"],
      reference_video_urls: ["asset:2"],
    },
    markers: {
      "the first reference image": "asset:1",
      "the first reference video": "asset:2",
    },
    pointers: [
      ["hero", "the first reference image", "/image_urls/0"],
      ["move", "the first reference video", "/reference_video_urls/0"],
    ],
  },
  "genjutsu-object-swap": {
    prompt:
      "In @Video1, change only the performer on the left. Use the approved hero identity.\nReference bindings: @Image1 (hero, front).\nPreserve: camera and motion.\nDo not alter these other subjects: the performer on the right.",
    input: {
      video_url: "asset:1",
      image_urls: ["asset:2"],
      resolution: "720p",
    },
    markers: {
      "@Video1": "asset:1",
      "@Image1": "asset:2",
    },
    pointers: [
      ["source", "@Video1", "/video_url"],
      ["image-1", "@Image1", "/image_urls/0"],
    ],
  },
  "genjutsu-motion-transfer": {
    prompt:
      "Use the movement, timing and camera of @Video1 to rebuild the scene. A night market. The hero walks.\nReference bindings: @Image1 (hero, front).\nPreserve: the walking rhythm.",
    input: {
      video_url: "asset:1",
      image_urls: ["asset:2"],
      resolution: "720p",
    },
    markers: {
      "@Video1": "asset:1",
      "@Image1": "asset:2",
    },
    pointers: [
      ["source", "@Video1", "/video_url"],
      ["image-1", "@Image1", "/image_urls/0"],
    ],
  },
  "genjutsu-restyle": {
    prompt: "Restyle @Video1 using the selected style preset. A rainy street. Keep it moody.\nPreserve: the framing.",
    input: {
      video_url: "asset:1",
      image_urls: [],
      resolution: "720p",
      preset_id: "c2143317-f28d-4c3c-a0b8-39bd547e08a7",
    },
    markers: {
      "@Video1": "asset:1",
    },
    pointers: [["source", "@Video1", "/video_url"]],
  },
  "omnihuman-1.5-speech": {
    prompt:
      'Mara glances at the radio.\nThe portrait image is Mara. The speech audio is Mara\'s line.\nFrom 0s to 2s, mara speaks in en: "Ready?", timed to the supplied speech audio.',
    input: { image_url: "asset:1", audio_url: "asset:2" },
    markers: {},
    pointers: [
      ["portrait", "", "/image_url"],
      ["line", "", "/audio_url"],
    ],
  },
  "sync-v3-speech": {
    prompt:
      'Mara glances at the radio.\nFrom 0s to 2s, mara speaks in en: "Ready?", timed to the supplied speech audio.',
    input: { video_url: "asset:1", audio_url: "asset:2" },
    markers: {},
    pointers: [
      ["picture", "", "/video_url"],
      ["line", "", "/audio_url"],
    ],
  },
};

const short = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (_key, x) =>
    typeof x === "string" && /^asset:\/\/sha256\/(.)\1{63}$/.test(x)
      ? `asset:${x[15]}`
      : typeof x === "string" && /^sha256:(.)\1{63}$/.test(x)
        ? `asset:${x[7]}`
        : x,
  );
const tracked = new Set((operationSnapshots as { endpoint: string }[]).map((row) => row.endpoint));

test("every shipped profile family has a fixture pack and a snapshot", () => {
  const families = listProfiles().map((profile) => profile.family);
  assert.deepEqual(PROFILE_FIXTURES.map((fixture) => fixture.family).sort(), [...families].sort());
  assert.deepEqual(Object.keys(SNAPSHOTS).sort(), [...families].sort());
});

for (const fixture of PROFILE_FIXTURES)
  test(`AC11 snapshot: ${fixture.family}`, () => {
    const profile = profileByFamily(fixture.family)!;
    const { spec, media } = fixturePack(fixture);
    const validated =
      profile.provider === "higgsfield" || tracked.has(fixture.endpoint) || profile.speechInput === "drive";
    let guarded = false;
    const out = compilePack({
      spec,
      profile,
      media,
      ...(validated
        ? {
            // Strict schema and guards as generate:model plans the request; asset refs stand in as measured URLs.
            guard: (input: Record<string, unknown>, warnings: string[]) => {
              const context: Record<string, MediaFacts> = {};
              const probe = JSON.parse(JSON.stringify(input), (_key, x) => {
                if (typeof x !== "string" || !x.startsWith("asset://sha256/")) return x;
                const url = `https://assets.example.invalid/${x.slice("asset://sha256/".length)}`;
                context[url] = media[`sha256:${x.slice("asset://sha256/".length)}`]!;
                return url;
              });
              warnings.push(
                ...buildFalOperation({
                  provider: profile.provider,
                  endpoint: spec.endpoint,
                  input: probe,
                  context: { media: context },
                }).warnings,
              );
              guarded = true;
            },
          }
        : {}),
    });
    assert.equal(guarded, validated);
    const expected = SNAPSHOTS[fixture.family]!;
    const { prompt, ...input } = out.input;
    assert.equal(out.compiledPrompt, expected.prompt);
    assert.equal(prompt, profile.omitPrompt ? undefined : expected.prompt);
    assert.deepEqual(short(input), expected.input);
    assert.deepEqual(short(out.markerMap), expected.markers);
    assert.deepEqual(
      out.attachments.map((a) => [a.requirementKey, a.marker, a.pointer]),
      expected.pointers,
    );
    // Bijection by dialect: every marker appears in the prompt; marker-less dialects use none.
    for (const marker of Object.keys(out.markerMap))
      assert.ok(out.compiledPrompt.toLowerCase().includes(marker.toLowerCase()), `${fixture.family}: ${marker}`);
    if (profile.dialect.kind === "at-indexed" || profile.dialect.kind === "at-element")
      assert.ok(Object.keys(out.markerMap).every((marker) => marker.startsWith("@")));
    else assert.doesNotMatch(out.compiledPrompt, /@(Image|Video|Audio|Element)\d/);
    // Positional slots (marker "none") never get a marker.
    const positional = new Set(profile.slots.filter((slot) => slot.marker === "none").map((slot) => slot.id));
    for (const a of spec.attachments)
      if (positional.has(a.slot))
        assert.equal(out.attachments.find((b) => b.requirementKey === a.requirementKey)!.marker, "", a.requirementKey);
  });
