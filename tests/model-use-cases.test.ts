import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ModelUseCasesFileSchema } from "../src/types/model-slots";
import { loadModelUseCases, MODEL_USE_CASES_FILE } from "../src/lib/models/model-slots-loader";
import {
  checkModelSlots,
  loadModelSlots,
  MODEL_SLOTS_FILE,
  pickModel,
  resolveTaskSlot,
  slotCatalogs,
} from "../src/lib/models/model-slots";

const slots = loadModelSlots(MODEL_SLOTS_FILE),
  useCases = loadModelUseCases(MODEL_USE_CASES_FILE),
  catalogs = slotCatalogs();
const now = new Date("2026-11-15T00:00:00Z");
const deps = { slots, useCases, catalogs, now };
const trackedPrices = path.resolve(import.meta.dirname, "../src/lib/models/fal-prices.json");
process.env.AGENTBROS_FAL_PRICES = trackedPrices;

test("strict use-case schema and isolated loader honour overrides without caching", () => {
  const root = mkdtempSync(path.join(tmpdir(), "use-cases-")),
    previous = process.env.AGENTBROS_MODEL_USE_CASES;
  try {
    process.env.AGENTBROS_MODEL_USE_CASES = path.join(root, "use-cases.json");
    const file = { version: 1, updatedAt: "2026-11-15", useCases: [], categories: {} };
    writeFileSync(process.env.AGENTBROS_MODEL_USE_CASES, JSON.stringify(file));
    assert.deepEqual(loadModelUseCases(), file);
    writeFileSync(process.env.AGENTBROS_MODEL_USE_CASES, JSON.stringify({ ...file, updatedAt: "2026-11-16" }));
    assert.equal(loadModelUseCases().updatedAt, "2026-11-16");
    assert.equal(
      ModelUseCasesFileSchema.safeParse({ ...file, categories: { unknown: { excluded: true, why: "" } } }).success,
      false,
    );
    assert.equal(
      ModelUseCasesFileSchema.safeParse({ ...file, useCases: [useCases.useCases[0], useCases.useCases[0]] }).success,
      false,
    );
    assert.equal(ModelUseCasesFileSchema.safeParse({ ...file, extra: true }).success, false);
  } finally {
    if (previous === undefined) delete process.env.AGENTBROS_MODEL_USE_CASES;
    else process.env.AGENTBROS_MODEL_USE_CASES = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("every indexed provider category is mapped or explicitly excluded, and mappings are real", () => {
  const categories = new Set(
    Object.values(catalogs).flatMap((catalog) => [...catalog.values()].map((entry) => entry.category)),
  );
  assert.deepEqual(Object.keys(useCases.categories).sort(), [...categories].sort());
  for (const category of categories) {
    const mapping = useCases.categories[category]!;
    assert.ok(mapping.why.trim(), category);
    if ("slots" in mapping)
      for (const id of mapping.slots)
        assert.ok(
          slots.slots.some((slot) => slot.id === id && slot.categories.includes(category)),
          `${category} -> ${id}`,
        );
  }
});

test("30–60 playbook use cases reach active slots, and every slot is reachable", () => {
  assert.ok(useCases.useCases.length >= 30 && useCases.useCases.length <= 60);
  for (const row of useCases.useCases) {
    assert.ok(
      row.slots.some((id) =>
        slots.slots.some(
          (slot) => slot.id === id && slot.candidates.some((candidate) => candidate.status === "active"),
        ),
      ),
      row.id,
    );
    for (const id of row.slots)
      assert.ok(
        slots.slots.some((slot) => slot.id === id),
        `${row.id}: missing ${id}`,
      );
    for (const id of row.playbooks)
      assert.ok(existsSync(path.resolve(import.meta.dirname, `../playbooks/${id}/playbook.json`)), id);
  }
  for (const slot of slots.slots)
    assert.ok(useCases.useCases.some((row) => row.slots.includes(slot.id)) || slot.concepts.length > 0, slot.id);
});

test("tracked slot table has 38 populated slots, 3–8 candidates each and zero validation errors", () => {
  assert.equal(slots.slots.length, 38);
  for (const slot of slots.slots) {
    assert.ok(slot.candidates.length >= 3 && slot.candidates.length <= 8, slot.id);
    assert.ok(
      slot.candidates.every(
        (candidate) =>
          candidate.evidence.length &&
          candidate.why.includes("Schema capabilities:") &&
          candidate.why.includes("Class "),
      ),
      slot.id,
    );
  }
  assert.deepEqual(checkModelSlots(slots, catalogs, undefined, now).errors, []);
});

const goldens: [string, string, string][] = [
  ["hero фото товара с надписью", "text-card", "image.text-render"],
  ["product image with lettering", "text-card", "image.text-render"],
  ["фото товара", "hero-image", "image.product"],
  ["product hero image", "hero-image", "image.product"],
  ["концепт кадра", "scene-image", "image.generate"],
  ["scene concept still", "scene-image", "image.generate"],
  ["исправить изображение", "edit-image", "image.edit"],
  ["repair image", "edit-image", "image.edit"],
  ["один персонаж во всех сценах", "character-sheet", "image.character"],
  ["character reference sheet", "character-sheet", "image.character"],
  ["фото инфлюенсера", "influencer-photo", "image.character"],
  ["influencer photo", "influencer-photo", "image.character"],
  ["апскейл фото", "upscale-image", "image.upscale"],
  ["upscale photo", "upscale-image", "image.upscale"],
  ["вырезать товар", "cutout-image", "image.cutout"],
  ["product cutout", "cutout-image", "image.cutout"],
  ["дорисовать края", "outpaint-image", "image.outpaint"],
  ["extend image", "outpaint-image", "image.outpaint"],
  ["видео по тексту", "b-roll", "video.text-to-video"],
  ["b roll shot", "b-roll", "video.text-to-video"],
  ["видео из фото 9:16 5 секунд", "photo-motion", "video.image-to-video"],
  ["animate photo 9:16 5 seconds", "photo-motion", "video.image-to-video"],
  ["видео по референсу", "reference-shot", "video.reference-to-video"],
  ["shot from references", "reference-shot", "video.reference-to-video"],
  ["заменить человека в клипе", "replace-person", "video.character-swap"],
  ["replace person in clip", "replace-person", "video.character-swap"],
  ["стилизовать видео", "restyle-clip", "video.restyle"],
  ["restyle clip", "restyle-clip", "video.restyle"],
  ["заменить объект в видео", "edit-clip", "video.edit"],
  ["edit video", "edit-clip", "video.edit"],
  ["интерполяция кадров", "slow-motion", "video.interpolate"],
  ["slow motion", "slow-motion", "video.interpolate"],
  ["говорящий ведущий", "talking-presenter", "video.avatar"],
  ["talking head", "talking-presenter", "video.avatar"],
  ["озвучка объяснения", "explainer-voice", "audio.voiceover"],
  ["explainer voiceover", "explainer-voice", "audio.voiceover"],
  ["фоновая музыка", "music-bed", "audio.music"],
  ["background music bed", "music-bed", "audio.music"],
  ["звук интерфейса", "ui-cue", "audio.sfx"],
  ["ui sound cue", "ui-cue", "audio.sfx"],
  ["фоли для видео", "foley-action", "audio.foley"],
  ["video foley", "foley-action", "audio.foley"],
  ["очистить звук", "clean-speech", "audio.denoise"],
  ["clean audio", "clean-speech", "audio.denoise"],
  ["отделить вокал", "split-stems", "audio.stems"],
  ["split stems", "split-stems", "audio.stems"],
  ["транскрибация речи", "subtitle-transcript", "text.transcribe"],
  ["subtitle transcript", "subtitle-transcript", "text.transcribe"],
  ["3d модель из фото", "mesh-image", "3d.from-image"],
  ["mesh from description", "mesh-text", "3d.from-text"],
  ["обучить lora", "train-identity", "train.lora"],
  ["train approved style", "train-identity", "train.lora"],
];
for (const [phrase, useCase, slot] of goldens)
  test(`playbook task: ${phrase}`, () => {
    const result = resolveTaskSlot(phrase, slots, undefined, useCases);
    assert.equal(result.useCase, useCase);
    assert.equal(result.slot?.id, slot);
  });

test("tracked picks prefer owner heroes, permit a cheap planning class and respect explicit pins", () => {
  const hero = pickModel({ task: "hero фото товара с надписью" }, deps);
  assert.equal(hero.pick?.endpoint, "openai/gpt-image-2.6/flare/text-to-image");
  const video = pickModel({ task: "видео из фото 9:16 5 секунд" }, deps);
  assert.equal(video.pick?.endpoint, "bytedance/seedance-2.5/image-to-video");
  assert.equal(
    pickModel({ task: "заменить человека в клипе" }, deps).pick?.endpoint,
    "higgsfield/genjutsu/motion-transfer/v1.0",
  );
  const cheap = pickModel({ useCase: "hero-image", maxUsd: 0.01 }, deps);
  assert.ok(cheap.pick && ["budget", "draft"].includes(cheap.pick.class));
  assert.ok(cheap.pick.price.usd! <= 0.01);
  assert.equal(
    pickModel({ useCase: "hero-image", model: "fal-ai/flux-2/klein/4b", provider: "fal" }, deps).pick?.endpoint,
    "fal-ai/flux-2/klein/4b",
  );
  const refused = pickModel(
    { useCase: "hero-image", model: "openai/gpt-image-2.6/flare/text-to-image", provider: "fal", maxUsd: 0.01 },
    deps,
  );
  assert.equal(refused.pick, null);
  assert.ok(refused.userPin?.rejectedBecause.length);
  assert.ok(refused.bestAlternative);
  assert.equal(pickModel({ useCase: "does-not-exist" }, deps).matched, false);
});

test("tracked pick moves an approximate fal price to the exact, cheaper equivalent provider", () => {
  const seedance = pickModel(
    { slot: "video.text-to-video", durationSec: 10, resolution: "720p", aspect: "16:9" },
    deps,
  );
  assert.equal(seedance.pick?.endpoint, "bytedance/seedance-2.5/text-to-video");
  assert.equal(seedance.pick?.provider, "higgsfield");
  assert.equal(seedance.pick?.price.kind === "approximate", false);
  assert.ok(seedance.pick?.warnings.some((w) => w.includes("is cheaper") || w.includes("no planning price")));
});

test("models:pick CLI uses the tracked use-case table and serialises pin rejection", () => {
  const env = {
    ...process.env,
    AGENTBROS_MODEL_SLOTS: MODEL_SLOTS_FILE,
    AGENTBROS_MODEL_USE_CASES: MODEL_USE_CASES_FILE,
    AGENTBROS_FAL_PRICES: trackedPrices,
  };
  for (const args of [
    ["--use-case", "text-card"],
    ["--task", "видео из фото 9:16 5 секунд"],
    ["--use-case", "hero-image", "--max-usd", "0.01"],
    ["--use-case", "hero-image", "--model", "missing/model", "--provider", "fal"],
  ]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/models-pick.ts", ...args], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.offline, true);
    assert.equal(result.metadata.matched, true);
    if (args.includes("--model")) {
      assert.equal(result.metadata.pick, null);
      assert.ok(result.metadata.userPin.rejectedBecause.length);
    } else assert.ok(result.metadata.pick);
  }
});

test("explicit and phrased use cases keep specialism when curated contracts are pending", () => {
  const pendingSlots = structuredClone(slots);
  for (const slot of pendingSlots.slots) slot.candidates = [];
  const unrelated = ["fal-ai/deepfilternet3", "fal-ai/aura-sr", "fal-ai/kling-video/o3/pro/video-to-video/reference"];
  const pending = {
    ...deps,
    slots: pendingSlots,
    catalogs: { fal: new Map(unrelated.map((endpoint) => [endpoint, catalogs.fal!.get(endpoint)!])) },
  };
  for (const useCase of ["clone-voice", "denoise-image", "denoise-video", "cutout-video"]) {
    const row = useCases.useCases.find((row) => row.id === useCase)!;
    for (const query of [{ useCase }, { task: row.phrasings.en[0]! }]) {
      const result = pickModel(query, pending);
      assert.equal(result.pick, null, `${useCase} must not fall back to unrelated category matches`);
      assert.deepEqual(result.fallback, []);
    }
  }
});
