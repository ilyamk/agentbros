import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCatalogEntry } from "../src/lib/models/fal-catalog";
import { findFalEndpointResult } from "../src/lib/models/fal-find";
import type { FalApiModel } from "../src/lib/providers/fal-openapi";
import type { FalCatalogEntry, FalCategory, InputMedia, OutputKind } from "../src/types/fal-catalog";
import { falFixtureManifest } from "./helpers/fal-temp-catalog";

const catalog = new Map(
  Object.entries(falFixtureManifest.endpoints).map(([endpoint, fixture]) => {
    const model = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "fixtures/fal-catalog/schemas", `${fixture.sha256}.json`), "utf8"),
    ) as FalApiModel;
    return [endpoint, buildCatalogEntry(model, { today: "2026-11-15", verifiedPins: {} })];
  }),
);
const now = new Date("2026-11-15T00:00:00Z");
const find = (task: string, fixture = catalog) =>
  findFalEndpointResult({ task, limit: 100 }, { catalog: fixture, env: {}, now }).candidates;
// Synthetic catalogue rows exercise missing specialisms and stronger, incompatible decoys.
function synthetic(
  endpoint: string,
  category: FalCategory,
  media: InputMedia[],
  output: OutputKind,
  patch: Partial<FalCatalogEntry> = {},
): FalCatalogEntry {
  return {
    ...catalog.get("fal-ai/aura-sr")!,
    endpoint,
    displayName: endpoint,
    category,
    tier: "discovered",
    tags: [],
    inputs: media.map((kind) => ({ name: `${kind}_url`, type: "string", media: kind, required: true })),
    outputs: { kinds: [output], fields: [] },
    ...patch,
  };
}
const withRows = (...rows: FalCatalogEntry[]) =>
  new Map([...catalog, ...rows.map((row) => [row.endpoint, row] as const)]);

test("slow motion selects interpolation instead of higher-trust video generation", () => {
  const interpolation = synthetic("test/rife/video", "video-to-video", ["video"], "video");
  const fixture = withRows(interpolation, synthetic("test/generator", "text-to-video", [], "video", { tier: "live" }));
  for (const task of ["замедлить видео плавно", "slow-mo video", "больше кадров в видео", "video 60 fps"]) {
    const rows = find(task, fixture);
    assert.ok(rows.length);
    assert.ok(rows.every((row) => row.category === "video-to-video"));
    assert.ok(rows.some((row) => row.endpoint === interpolation.endpoint));
    assert.ok(!rows.some((row) => row.endpoint === "fal-ai/aura-sr"));
  }
});

test("explicit video utilities suppress photo animation and its broad reference role", () => {
  const fixture = withRows(
    synthetic("test/denoise/video", "video-to-video", ["video"], "video"),
    synthetic("test/background-removal/video", "video-to-video", ["video"], "video"),
  );
  for (const task of [
    "upscale video from photo",
    "denoise video from photos",
    "remove background from video from photo",
  ]) {
    const rows = find(task, fixture);
    assert.ok(rows.length, task);
    assert.ok(
      rows.every((row) => row.category === "video-to-video"),
      task,
    );
  }
});

test("upscale respects named video, including Russian medium synonyms, with image as the default", () => {
  const video = "fal-ai/seedvr/upscale/video";
  const fixture = withRows({ ...catalog.get("fal-ai/aura-sr")!, tier: "live" });
  for (const medium of ["video", "видео", "ролик", "клип", "video-to-video"]) {
    const rows = find(`upscale ${medium} to 4k`, fixture);
    assert.ok(rows.length);
    assert.ok(rows.every((row) => row.category === "video-to-video"));
    assert.ok(rows.some((row) => row.endpoint === video));
  }
  for (const task of ["upscale", "upscale photo"]) {
    const rows = find(task, fixture);
    assert.equal(rows[0]?.endpoint, "fal-ai/aura-sr");
    assert.ok(rows.every((row) => row.category === "image-to-image"));
  }
  const noVideoInput = synthetic("test/upscale/video", "video-to-video", ["image"], "video", { tier: "live" });
  assert.ok(!find("upscale video", withRows(noVideoInput)).some((row) => row.endpoint === noVideoInput.endpoint));
});

test("cutout and denoise cannot cross the named medium", () => {
  const cutout = synthetic("test/background-removal/video", "video-to-video", ["video"], "video");
  const denoise = synthetic("test/denoise/video", "video-to-video", ["video"], "video");
  const image = synthetic("test/denoise/image", "image-to-image", ["image"], "image");
  const fixture = withRows(
    cutout,
    denoise,
    image,
    { ...catalog.get("fal-ai/birefnet")!, tier: "live" },
    { ...catalog.get("fal-ai/deepfilternet3")!, tier: "live" },
  );
  for (const [task, category, endpoint] of [
    ["убери фон с видео", "video-to-video", cutout.endpoint],
    ["remove background from video", "video-to-video", cutout.endpoint],
    ["remove background from image", "image-to-image", "fal-ai/birefnet"],
    ["убрать фон", "image-to-image", "fal-ai/birefnet"],
    ["denoise video", "video-to-video", denoise.endpoint],
    ["denoise image", "image-to-image", image.endpoint],
    ["denoise audio", "audio-to-audio", "fal-ai/deepfilternet3"],
    ["denoise audio from video", "audio-to-audio", "fal-ai/deepfilternet3"],
    ["clean audio in video", "audio-to-audio", "fal-ai/deepfilternet3"],
    ["denoise", "audio-to-audio", "fal-ai/deepfilternet3"],
  ]) {
    const rows = find(task!, fixture);
    assert.ok(rows.length, task);
    assert.ok(
      rows.every((row) => row.category === category),
      task,
    );
    assert.ok(
      rows.some((row) => row.endpoint === endpoint),
      task,
    );
  }
});

test("input-driven duration is advisory for parsed and explicit requests even with a conflicting duration field", () => {
  const categories: FalCategory[] = [
    "text-to-speech",
    "speech-to-speech",
    "audio-to-audio",
    "speech-to-text",
    "audio-to-text",
    "audio-to-video",
  ];
  for (const category of categories)
    for (const inputs of [[], [{ name: "duration", type: "integer", required: false, enum: [5] }]]) {
      const entry = synthetic(
        `test/${category}`,
        category,
        [],
        category.endsWith("text") ? "text" : category === "audio-to-video" ? "video" : "audio",
        { inputs },
      );
      for (const query of [{ task: "30 секунд" }, { durationSec: 30 }]) {
        const rows = findFalEndpointResult(
          { ...query, categories: [category] },
          { catalog: new Map([[entry.endpoint, entry]]), env: {}, now },
        ).candidates;
        assert.equal(rows.length, 1, category);
        assert.match(rows[0]!.warnings.join(" "), /Length follows the input; plan the script or source audio for 30 s/);
        assert.ok(!rows[0]!.reasons.some((reason) => reason.startsWith("Supports duration")));
      }
    }
  const rows = find("озвучка 30 секунд");
  assert.ok(rows.length);
  assert.ok(
    rows.every((row) => row.category === "text-to-speech" && row.warnings.some((warning) => warning.includes("30 s"))),
  );
  for (const category of ["text-to-video", "image-to-video", "text-to-audio"] as const) {
    const entry = synthetic(`test/${category}`, category, [], category === "text-to-audio" ? "audio" : "video");
    assert.deepEqual(
      findFalEndpointResult(
        { categories: [category], durationSec: 30 },
        { catalog: new Map([[entry.endpoint, entry]]), env: {}, now },
      ).candidates,
      [],
    );
  }
});

test("audio repairs suppress generic music generation", () => {
  for (const task of ["отделить вокал от музыки", "denoise music audio", "voice change for music"]) {
    const rows = find(task);
    assert.ok(rows.length, task);
    assert.ok(
      rows.every((row) => ["audio-to-audio", "speech-to-speech"].includes(row.category)),
      task,
    );
  }
});

test("translation and rewriting exclude lyrics unless explicitly requested in English or Russian", () => {
  const lyrics = { ...catalog.get("mureka/api/generate/lyrics")!, tier: "live" as const };
  const fixture = withRows(lyrics);
  for (const task of ["перевести текст на английский", "translate text to English", "rewrite this text"]) {
    const rows = find(task, fixture);
    assert.ok(rows.length);
    assert.ok(rows.every((row) => !row.endpoint.includes("lyrics")));
  }
  for (const task of ["rewrite lyrics", "перепиши текст песни", "translate text for a song"])
    assert.equal(find(task, fixture)[0]?.endpoint, lyrics.endpoint);
});

test("product photo animation preserves source input, aspect and duration", () => {
  const original = catalog.get("fal-ai/pixverse/c1/transition")!;
  const fixture = withRows({
    ...original,
    inputs: [...original.inputs, { name: "aspect_ratio", type: "string", required: false, enum: ["9:16"] }],
  });
  const rows = find("сделай видео из фото товара 9:16 10 секунд", fixture);
  assert.ok(rows.length);
  assert.ok(rows.every((row) => row.category === "image-to-video"));
  assert.ok(
    rows.every(
      (row) =>
        row.reasons.includes("Supports duration 10") &&
        row.reasons.includes("Supports aspect 9:16") &&
        row.reasons.includes("Accepts image"),
    ),
  );
});

test("background replacement selects editors and excludes removal-only or image endpoints", () => {
  const editor = synthetic("test/video-to-video/edit", "video-to-video", ["video"], "video");
  const removal = synthetic("test/background-removal", "video-to-video", ["video"], "video", { tier: "live" });
  const rows = find("replace background in video", withRows(editor, removal));
  assert.ok(rows.some((row) => row.endpoint === editor.endpoint));
  assert.ok(rows.every((row) => row.category === "video-to-video" && row.endpoint !== removal.endpoint));
});

test("voice cloning requires cloning evidence and reference audio instead of plain TTS", () => {
  const clone = synthetic("test/clone-voice", "text-to-speech", ["audio"], "audio");
  const tts = { ...catalog.get("elevenlabs/tts/eleven-v4")!, tier: "live" as const, inputs: clone.inputs };
  const rows = find("клонировать голос", withRows(clone, tts));
  assert.ok(rows.some((row) => row.endpoint === clone.endpoint));
  assert.ok(!rows.some((row) => row.endpoint === tts.endpoint));
});

test("recurring characters and 3D textures keep broad curated roles from admitting wrong tasks", () => {
  const character = synthetic("test/consistent-character", "text-to-image", [], "image");
  const characters = find("сделай персонажа для всех сцен", withRows(character));
  assert.ok(characters.some((row) => row.endpoint === character.endpoint));
  assert.ok(characters.every((row) => ["text-to-image", "image-to-image"].includes(row.category)));
  const rigging = { ...catalog.get("meshy/rigging")!, tier: "live" as const };
  const textures = find("текстура для 3d модели", withRows(rigging));
  assert.ok(textures.some((row) => row.endpoint === "meshy/n1/retexture"));
  assert.ok(textures.every((row) => /texture/.test(row.endpoint)));
});

test("lip sync, image expansion and video QA retain their source-specific categories", () => {
  for (const [task, categories] of [
    ["переведи видео на испанский с липсинком", ["audio-to-video", "video-to-video"]],
    ["расширь кадр до 16:9", ["image-to-image"]],
    ["описание кадров видео для QA", ["video-to-text", "vision"]],
  ] as const) {
    const fixture = withRows(
      synthetic("test/outpaint", "image-to-image", ["image"], "image", {
        inputs: [
          { name: "image_url", type: "string", media: "image", required: true },
          { name: "aspect_ratio", type: "string", required: false, enum: ["16:9"] },
        ],
      }),
    );
    const matching = find(task, fixture);
    assert.ok(matching.length, task);
    assert.ok(
      matching.every((row) => (categories as readonly string[]).includes(row.category)),
      task,
    );
  }
});

test("advertising music keeps a hard duration constraint", () => {
  const rows = find("сделай музыку для рекламы 30 секунд");
  assert.ok(rows.length);
  assert.ok(rows.every((row) => row.category === "text-to-audio" && row.reasons.includes("Supports duration 30")));
  assert.ok(rows.every((row) => !row.warnings.some((warning) => warning.includes("Length follows"))));
});
