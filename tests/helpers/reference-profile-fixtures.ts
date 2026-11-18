import type { z } from "zod";
import type { MediaFacts } from "../../src/lib/references/compile";
import type { ReferencePackSpecSchema } from "../../src/types/references";
import { loadHiggsfieldRestylePresets } from "../../src/lib/models/hf-restyle-presets";

/** One fixture pack per shipped reference profile family (RFC 0003 AC11); synthetic asset ids and facts only. */
const hex = (seed: string) => seed.repeat(64).slice(0, 64);
export const fixtureAssetId = (seed: string) => `sha256:${hex(seed)}`;
export const fixtureAssetRef = (seed: string) => `asset://sha256/${hex(seed)}`;
const image = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  bytes: 400_000,
  contentType: "image/png",
  width: 1024,
  height: 1024,
  ...over,
});
const video = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  bytes: 4_000_000,
  contentType: "video/mp4",
  width: 1280,
  height: 720,
  durationSec: 5,
  fps: 30,
  ...over,
});
const audio = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  bytes: 300_000,
  contentType: "audio/wav",
  durationSec: 4,
  ...over,
});
type Attachment = {
  requirementKey: string;
  seed: string;
  slot: string;
  order: number;
  roleSentence: string;
  element?: { index: number; part: "frontal" | "reference" | "video" | "voice" };
  speech?: z.input<typeof ReferencePackSpecSchema>["attachments"][number]["speech"];
  facts: MediaFacts;
};
export type ProfileFixture = {
  family: string;
  endpoint: string;
  attachments: Attachment[];
  prompt: z.input<typeof ReferencePackSpecSchema>["prompt"];
  params?: Record<string, unknown>;
  audioPolicy?: "native" | "mute" | "replace-in-edit" | "reference-driven";
};

const a = (
  requirementKey: string,
  seed: string,
  slot: string,
  order: number,
  roleSentence: string,
  facts: MediaFacts,
  element?: Attachment["element"],
): Attachment => ({ requirementKey, seed, slot, order, roleSentence, facts, ...(element ? { element } : {}) });

const performedLine: Attachment = {
  ...a("line", "2", "speech", 1, "Mara's line", audio({ sha256: hex("2") })),
  speech: {
    kind: "performed-lines",
    use: "drive",
    sha256: hex("2"),
    receipt: "take.json",
    receiptSha256: hex("3"),
    lines: [{ lineId: "mara-1", speakerId: "mara", language: "en", text: "Ready?", startSec: 0, endSec: 2 }],
  },
};

export const PROFILE_FIXTURES: ProfileFixture[] = [
  {
    family: "seedance-2.0",
    endpoint: "bytedance/seedance-2.0/fast/reference-to-video",
    attachments: [
      a("hero-identity", "1", "images", 1, "the face and hair of Mara", image()),
      a("dance-motion", "2", "videos", 1, "the dance movement only", video()),
      a("hero-voice", "3", "audio", 1, "the voice of Mara", audio()),
    ],
    prompt: { action: "Mara dances in the rain.", camera: "Slow push in." },
    audioPolicy: "reference-driven",
  },
  {
    family: "seedance-2.5",
    endpoint: "bytedance/seedance-2.5/reference-to-video",
    attachments: [
      a("market-plate", "2", "images", 2, "the market at dusk, take only the place and light", image()),
      a("hero-identity", "1", "images", 1, "the face and hair of Mara", image()),
      a("dance-motion", "3", "videos", 1, "the dance movement only", video({ fps: 24 })),
      a("hero-voice", "4", "audio", 1, "the voice of Mara", audio()),
    ],
    prompt: {
      action: "Mara dances across the market as the lamps come on.",
      invariants: ["Mara wears a red scarf."],
      audio: "Mara hums softly.",
      avoid: ["text overlays"],
    },
    audioPolicy: "reference-driven",
  },
  {
    family: "kling-o1",
    endpoint: "fal-ai/kling-video/o1/reference-to-video",
    attachments: [
      a("hero-front", "1", "elements", 1, "Mara, the courier", image(), { index: 1, part: "frontal" }),
      a("hero-side", "2", "element-references", 1, "Mara from the side", image(), { index: 1, part: "reference" }),
      a("warehouse", "3", "images", 1, "the warehouse interior", image()),
    ],
    prompt: { action: "Mara runs through the warehouse." },
    params: { duration: "5" },
  },
  {
    family: "kling-o3",
    endpoint: "fal-ai/kling-video/o3/standard/reference-to-video",
    attachments: [
      a("opening", "1", "start", 1, "the opening frame", image()),
      a("hero-front", "1", "elements", 1, "Mara, the courier", image(), { index: 1, part: "frontal" }),
      a("hero-side", "2", "element-references", 1, "Mara from the side", image(), { index: 1, part: "reference" }),
      a("hero-back", "3", "element-references", 2, "Mara from behind", image(), { index: 1, part: "reference" }),
      a("look", "4", "images", 1, "the film look, colour and grain only", image()),
    ],
    prompt: { action: "Mara turns and walks into the fog.", camera: "Handheld follow." },
    params: { duration: "5" },
  },
  {
    family: "kling-o3-video",
    endpoint: "fal-ai/kling-video/o3/standard/video-to-video/reference",
    attachments: [
      a("source", "1", "source", 1, "the source performance and camera", video()),
      a("hero-front", "2", "elements", 1, "Mara, the courier", image(), { index: 1, part: "frontal" }),
      a("hero-side", "3", "element-references", 1, "Mara from the side", image(), { index: 1, part: "reference" }),
      a("plate", "4", "images", 1, "the night street", image()),
    ],
    prompt: { action: "Replace the performer with Mara and move the scene to the night street." },
  },
  {
    family: "kling-v3-motion-control",
    endpoint: "fal-ai/kling-video/v3/standard/motion-control",
    attachments: [
      a("character", "1", "character", 1, "Mara in her red coat", image({ width: 720, height: 1280 })),
      a("motion", "2", "motion", 1, "the dance performance", video()),
      a("face", "3", "face", 1, "Mara's face", image(), { index: 1, part: "frontal" }),
      a("face-side", "4", "face-references", 1, "Mara's face in profile", image(), { index: 1, part: "reference" }),
    ],
    prompt: { action: "Mara performs the dance." },
    params: { character_orientation: "video" },
  },
  {
    family: "kling-v2.6-motion-control",
    endpoint: "fal-ai/kling-video/v2.6/standard/motion-control",
    attachments: [
      a("character", "1", "character", 1, "the woman in the red coat", image({ width: 720, height: 1280 })),
      a("motion", "2", "motion", 1, "the dance performance", video()),
    ],
    prompt: { action: "She performs the dance." },
  },
  {
    family: "nano-banana-2.1",
    endpoint: "google/nano-banana-2.1/edit",
    attachments: [
      a("product", "1", "images", 1, "the bottle and its label", image()),
      a("scene", "2", "images", 2, "the kitchen counter, take only the place and light", image()),
    ],
    prompt: { action: "Place the bottle on the counter in morning light." },
  },
  {
    family: "flux-2",
    endpoint: "fal-ai/flux-2/edit",
    attachments: [
      a("subject", "1", "images", 1, "the woman", image()),
      a("look", "2", "images", 2, "the painterly look only", image()),
    ],
    prompt: { action: "Paint the woman in this look.", avoid: ["watermarks"] },
  },
  {
    family: "gemini-omni",
    endpoint: "google/gemini-omni-flash/v1.2/reference-to-video",
    attachments: [
      a("hero", "1", "images", 1, "the woman in the red coat", image()),
      a("move", "2", "videos", 1, "the camera move only", video({ durationSec: 3 })),
    ],
    prompt: { action: "The woman walks along the pier." },
  },
  {
    family: "genjutsu-object-swap",
    endpoint: "higgsfield/genjutsu/object-swap/v1.0",
    attachments: [
      a("source", "1", "source", 1, "the source video", video({ durationSec: 5 })),
      a("image-1", "2", "images", 1, "hero, front", image()),
    ],
    prompt: {
      action: "In @Video1, change only the performer on the left. Use the approved hero identity.",
      preserve: ["camera and motion"],
      otherSubjects: ["the performer on the right"],
    },
    params: { resolution: "720p" },
    audioPolicy: "mute",
  },
  {
    family: "genjutsu-motion-transfer",
    endpoint: "higgsfield/genjutsu/motion-transfer/v1.0",
    attachments: [
      a("source", "1", "source", 1, "the source video", video({ durationSec: 5 })),
      a("image-1", "2", "images", 1, "hero, front", image()),
    ],
    prompt: {
      action: "Use the movement, timing and camera of @Video1 to rebuild the scene. A night market. The hero walks.",
      preserve: ["the walking rhythm"],
    },
    params: { resolution: "720p" },
    audioPolicy: "mute",
  },
  {
    family: "genjutsu-restyle",
    endpoint: "higgsfield/genjutsu/restyle/v1.0",
    attachments: [a("source", "1", "source", 1, "the source video", video({ durationSec: 5 }))],
    prompt: {
      action: "Restyle @Video1 using the selected style preset. A rainy street. Keep it moody.",
      preserve: ["the framing"],
    },
    params: { resolution: "720p", preset_id: loadHiggsfieldRestylePresets().presets[0]!.id },
    audioPolicy: "mute",
  },
  {
    family: "omnihuman-1.5-speech",
    endpoint: "fal-ai/bytedance/omnihuman/v1.5",
    attachments: [a("portrait", "1", "portrait", 1, "Mara", image()), performedLine],
    prompt: { action: "Mara glances at the radio." },
    audioPolicy: "reference-driven",
  },
  {
    family: "sync-v3-speech",
    endpoint: "fal-ai/sync-lipsync/v3",
    attachments: [a("picture", "1", "video", 1, "Mara at the radio", video()), performedLine],
    prompt: { action: "Mara glances at the radio." },
    audioPolicy: "replace-in-edit",
  },
];

/** The ReferencePackSpec and media map of a fixture. */
export function fixturePack(fixture: ProfileFixture) {
  return {
    spec: {
      schemaVersion: 1 as const,
      id: `${fixture.family.replace(/\./g, "-")}-fixture`,
      shotId: "s01",
      endpoint: fixture.endpoint,
      profileFamily: fixture.family,
      attachments: fixture.attachments.map(({ seed, facts: _facts, ...rest }) => ({
        ...rest,
        source: { assetId: fixtureAssetId(seed) },
      })),
      prompt: fixture.prompt,
      params: fixture.params ?? {},
      audioPolicy: fixture.audioPolicy ?? "native",
    },
    media: Object.fromEntries(fixture.attachments.map((x) => [fixtureAssetId(x.seed), x.facts])),
  };
}
