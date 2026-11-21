import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { catalogEntry, useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { modelChoicePrice, planningVideoDimensions } from "../src/lib/models/model-choice-price";
import { checkModelConstraints } from "../src/lib/models/model-constraints";
import { checkModelSlots, loadModelSlots, pickModel } from "../src/lib/models/model-slots";
import { proposeSlotChanges } from "../src/lib/models/model-slots-refresh";
import { renderModelSlotsDoc } from "../src/lib/models/model-slots-maintenance";
import { ModelReferenceSettingSchema, type ModelSlotCandidate } from "../src/types/model-slots";
import type { FalCatalogEntry, ModelChoicePrice } from "../src/types/fal-catalog";
import { resetFalPricesCache } from "../src/lib/models/fal-pricing";
import { quote } from "../src/lib/pricing";

const now = new Date("2026-11-15T00:00:00Z");
const candidate = (endpoint: string, order = 1): ModelSlotCandidate => ({
  endpoint,
  provider: "fal",
  class: order === 1 ? "hero" : "budget",
  order,
  status: "active",
  why: "Fixture",
  addedAt: "2026-11-15",
  evidence: [{ kind: "owner", text: "Fixture", source: "owner", date: "2026-11-15" }],
});
const entry = (endpoint: string, patch: Partial<FalCatalogEntry> = {}) =>
  catalogEntry("fal-ai/flux/schnell", {
    endpoint,
    tier: "verified",
    category: "text-to-image",
    outputs: { kinds: ["image"], fields: [] },
    ...patch,
  });
const temp = useTempFalCatalog([
  { endpoint: "fal-ai/flux/schnell", patch: { endpoint: "fal-ai/flux-2/flash", category: "text-to-image" } },
  {
    endpoint: "fal-ai/flux/schnell",
    patch: {
      endpoint: "fal-ai/kling-video/o3/pro/reference-to-video",
      category: "image-to-video",
      inputs: [{ name: "duration", type: "integer", required: false, min: 3, max: 15 }],
    },
  },
  { endpoint: "fal-ai/flux/schnell", patch: { endpoint: "fixture/characters", category: "text-to-speech" } },
  {
    endpoint: "fal-ai/flux/schnell",
    patch: {
      endpoint: "fixture/audio",
      category: "audio-to-audio",
      inputs: [{ name: "audio_url", type: "string", media: "audio", required: true }],
    },
  },
  {
    endpoint: "fal-ai/flux/schnell",
    patch: {
      endpoint: "fixture/minutes",
      category: "speech-to-text",
      inputs: [{ name: "audio_url", type: "string", media: "audio", required: true }],
    },
  },
  { endpoint: "fal-ai/flux/schnell", patch: { endpoint: "fixture/megapixels", category: "text-to-image" } },
  {
    endpoint: "fal-ai/flux/schnell",
    patch: {
      endpoint: "fixture/images",
      category: "text-to-image",
      inputs: [{ name: "num_images", type: "integer", required: false, default: 1 }],
    },
  },
]);
const root = path.dirname(temp.catalogDir);
process.env.AGENTBROS_FAL_PRICES = path.join(root, "prices.json");
writeFileSync(
  process.env.AGENTBROS_FAL_PRICES,
  JSON.stringify({
    version: 1,
    syncedAt: "2026-11-15",
    prices: [
      ["fal-ai/kling-video/o3/pro/reference-to-video", "seconds", 0.14],
      ["fixture/audio", "seconds", 0.001],
      ["fixture/characters", "1k characters", 0.08],
      ["fixture/images", "images", 0.02],
      ["fixture/megapixels", "megapixels", 0.03],
      ["fixture/minutes", "minutes", 0.008],
    ].map(([endpoint, unit, unitPrice]) => ({
      endpoint,
      unit,
      unitPrice,
      currency: "USD",
      observedAsOf: "2026-11-15",
      source: "platform-pricing-api",
    })),
  }),
);

function withSlots(fn: (file: ReturnType<typeof loadModelSlots>) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), "slots-pricing-")),
    previous = process.env.AGENTBROS_MODEL_SLOTS;
  try {
    process.env.AGENTBROS_MODEL_SLOTS = path.join(directory, "slots.json");
    writeFileSync(
      process.env.AGENTBROS_MODEL_SLOTS,
      readFileSync(path.resolve(import.meta.dirname, "fixtures/model-slots/minimal.json")),
    );
    fn(loadModelSlots());
  } finally {
    if (previous === undefined) delete process.env.AGENTBROS_MODEL_SLOTS;
    else process.env.AGENTBROS_MODEL_SLOTS = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}
function save(file: ReturnType<typeof loadModelSlots>) {
  writeFileSync(process.env.AGENTBROS_MODEL_SLOTS!, JSON.stringify(file));
}
const round = (amount: number) => Math.ceil(amount * 10000 - 1e-9) / 10000;

for (const resolution of ["480p", "720p"] as const)
  for (const aspect of ["16:9", "9:16", "1:1"])
    for (const durationSec of [5, 10]) {
      test(`Seedance planning formula: ${resolution} ${aspect} ${durationSec} s`, () => {
        const dimensions =
          resolution === "720p"
            ? aspect === "1:1"
              ? [720, 720]
              : [1280, 720]
            : aspect === "1:1"
              ? [480, 480]
              : [854, 480];
        const tokens = (dimensions[0]! * dimensions[1]! * durationSec * 24) / 1024;
        const price = modelChoicePrice(entry("bytedance/seedance-2.5/image-to-video"), {
          resolution,
          aspect,
          durationSec,
        });
        assert.equal(price.kind, "approximate");
        assert.equal(price.usd, round((tokens / 1000) * 0.0214 * 1.05));
        assert.match(price.label, new RegExp(`${tokens} tokens`));
        assert.match(price.label, /fal.ai\/models\/bytedance\/seedance-2.5\/image-to-video/);
        assert.match(price.label, /5% local margin/);
      });
    }

test("reference video seconds add to output seconds and select only the tracked multiplier", () => {
  const price = modelChoicePrice(entry("bytedance/seedance-2.5/reference-to-video"), {
    resolution: "720p",
    aspect: "16:9",
    durationSec: 5,
    inputVideoDurationSec: 10,
  });
  assert.equal(price.usd, round(((1280 * 720 * 15 * 24) / 1024 / 1000) * 0.0214 * 0.6 * 1.05));
  assert.match(price.label, /× 0.6/);
  for (const parameters of [
    { resolution: "8k", aspect: "16:9", durationSec: 5 },
    { resolution: "720p", aspect: "auto", durationSec: 5 },
  ])
    assert.equal(modelChoicePrice(entry("bytedance/seedance-2.5/image-to-video"), parameters).kind, "unknown");
  // 1080p and 4K are priced from the 2026-11-21 page rates; the US endpoints have no reviewed 4K rate.
  const uhd = modelChoicePrice(entry("bytedance/seedance-2.5/image-to-video"), {
    resolution: "4k",
    aspect: "16:9",
    durationSec: 5,
  });
  assert.equal(uhd.usd, round(((3840 * 2160 * 5 * 24) / 1024 / 1000) * 0.0094 * 1.05));
  assert.equal(
    modelChoicePrice(entry("bytedance/seedance-2.5/us/image-to-video"), {
      resolution: "4k",
      aspect: "16:9",
      durationSec: 5,
    }).kind,
    "unknown",
  );
  assert.equal(planningVideoDimensions("720p", "2:1"), undefined);
  // This planning feature supplies no forecast or dimensions to admission.
  assert.equal(
    quote({ model: "bytedance/seedance-2.5/image-to-video", resolution: "720p", durationSec: 5 }).bounded,
    false,
  );
});

test("characters, input audio seconds/minutes, images and megapixels use their own quantities", () => {
  const chars = modelChoicePrice(entry("fixture/characters", { category: "text-to-speech" }), {
    inputCharacters: 1001,
  });
  assert.equal(chars.usd, 0.16);
  assert.match(chars.label, /ceil\(1001 characters \/ 1000\)/);
  assert.equal(
    modelChoicePrice(
      entry("fixture/audio", {
        category: "audio-to-audio",
        inputs: [{ name: "audio_url", type: "string", media: "audio", required: true }],
      }),
      { inputAudioSec: 90 },
    ).usd,
    0.09,
  );
  assert.equal(
    modelChoicePrice(entry("fixture/minutes", { category: "speech-to-text" }), { inputAudioSec: 90 }).usd,
    0.012,
  );
  assert.equal(modelChoicePrice(entry("fixture/images"), { images: 3 }).usd, 0.06);
  assert.equal(modelChoicePrice(entry("fixture/megapixels"), { megapixels: 2.1, images: 2 }).usd, 0.18);
  assert.equal(
    modelChoicePrice(entry("fixture/audio", { category: "audio-to-audio" }), { durationSec: 90 }).kind,
    "unknown",
  );
  assert.equal(
    modelChoicePrice(entry("openai/gpt-image-2.6/flare/text-to-image"), { megapixels: 1, images: 1 }).kind,
    "unknown",
  );
  assert.equal(modelChoicePrice(entry("google/nano-banana-2.1"), { megapixels: 1, images: 1 }).kind, "unknown");
});

test("slot references are optional, strict, labelled and overridden by explicit query settings", () =>
  withSlots((file) => {
    assert.equal(ModelReferenceSettingSchema.safeParse({ images: 0 }).success, false);
    assert.equal(ModelReferenceSettingSchema.safeParse({ inputCharacters: 1.5 }).success, false);
    assert.equal(ModelReferenceSettingSchema.safeParse({ guessedTokens: 100 }).success, false);
    const slot = file.slots[0]!;
    slot.candidates = [candidate("fixture/images")];
    slot.reference = { images: 2 };
    save(file);
    const deps = { catalogs: { fal: new Map([["fixture/images", entry("fixture/images")]]) }, now };
    slot.reference.resolution = "720p";
    save(file);
    const result = pickModel({ slot: slot.id }, deps);
    assert.equal(result.pick?.price.usd, 0.04);
    assert.match(result.pick!.price.label, /at reference setting/);
    assert.deepEqual(result.referenceFields, ["resolution", "images"]);
    const explicit = pickModel({ slot: slot.id, images: 3 }, deps);
    assert.equal(explicit.pick?.price.usd, 0.06);
    assert.ok(explicit.pick);
    assert.ok(explicit.referenceFields.includes("resolution"));
    assert.equal(pickModel({ slot: slot.id, resolution: "unsupported" }, deps).pick, null);
    assert.match(renderModelSlotsDoc(file, deps), /0.04/);
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/models-pick.ts",
        "--slot",
        slot.id,
        "--chars",
        "1234",
        "--audio-seconds",
        "42",
        "--images",
        "3",
        "--megapixels",
        "2",
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          AGENTBROS_MODEL_SLOTS: process.env.AGENTBROS_MODEL_SLOTS,
          AGENTBROS_MODEL_USE_CASES: process.env.AGENTBROS_MODEL_USE_CASES,
          AGENTBROS_FAL_CATALOG_DIR: temp.catalogDir,
          AGENTBROS_FAL_PRICES: process.env.AGENTBROS_FAL_PRICES,
          AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
        },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(child.stdout).metadata.referenceSetting, {
      resolution: "720p",
      images: 3,
      megapixels: 2,
      inputCharacters: 1234,
      inputAudioSec: 42,
    });
  }));

test("needsQuote preserves fallback order, excludes non-price failures and unknown opt-in selects the first", () =>
  withSlots((file) => {
    const slot = file.slots[0]!;
    slot.candidates = [candidate("fixture/unknown"), candidate("fixture/other", 2), candidate("fixture/bad", 3)];
    save(file);
    const deps = {
      catalogs: {
        fal: new Map(
          slot.candidates.map((c) => [
            c.endpoint,
            entry(c.endpoint, c.endpoint === "fixture/bad" ? { status: "gone" } : {}),
          ]),
        ),
      },
      now,
    };
    const result = pickModel({ slot: slot.id, maxUsd: 0.3 }, deps);
    assert.equal(result.pick, null);
    assert.deepEqual(
      result.needsQuote.map((c) => c.endpoint),
      ["fixture/unknown", "fixture/other"],
    );
    assert.match(result.message!, /authoritative quote/);
    for (const row of result.needsQuote) {
      assert.match(row.command, /^pnpm generate:model --request REQUEST-fal-fixture-/);
      assert.match(row.command, /--dry-run$/);
      assert.match(row.scaffoldCommand, new RegExp(`--endpoint ${row.endpoint}`));
    }
    const allowed = pickModel({ slot: slot.id, maxUsd: 0.3, allowUnknownPrice: true }, deps);
    assert.equal(allowed.pick?.endpoint, "fixture/unknown");
    assert.ok(allowed.pick?.warnings.some((w) => w.includes("Unknown price allowed")));
    const pinned = pickModel({ slot: slot.id, model: "fixture/unknown", provider: "fal", maxUsd: 0.3 }, deps);
    assert.equal(pinned.pick, null);
    assert.equal(pinned.needsQuote[0]?.endpoint, "fixture/unknown");
    slot.candidates = [];
    save(file);
    assert.ok(
      pickModel({ slot: slot.id, maxUsd: 0.3 }, deps).needsQuote.some((row) => row.endpoint === "fixture/unknown"),
    );
  }));

const constraints = {
  categories: ["image-to-video"] as const,
  inputs: ["image"] as const,
  outputs: ["video"] as const,
  aspect: "9:16",
  durationSec: 5,
};
test("i2v aspect follows input without an aspect field or with auto; explicit incompatible aspects reject", () => {
  const image = { name: "image_url", type: "string", media: "image", required: true } as const;
  const duration = { name: "duration", type: "integer", min: 1, max: 10, required: false } as const;
  for (const fields of [
    [image, duration],
    [image, duration, { name: "aspect_ratio", type: "string", enum: ["auto", "16:9"], required: false }],
  ]) {
    const result = checkModelConstraints(
      entry("fixture/video", { category: "image-to-video", outputs: { kinds: ["video"], fields: [] }, inputs: fields }),
      {
        ...constraints,
        categories: [...constraints.categories],
        inputs: [...constraints.inputs],
        outputs: [...constraints.outputs],
      },
    );
    assert.deepEqual(result.rejectedBecause, []);
    assert.ok(result.warnings.includes("aspect follows the input; crop/prepare the source to 9:16"));
  }
  const rejected = checkModelConstraints(
    entry("fixture/video", {
      category: "image-to-video",
      inputs: [image, duration, { name: "aspect_ratio", type: "string", enum: ["16:9"], required: false }],
    }),
    { categories: [], inputs: [], outputs: [], aspect: "9:16" },
  );
  assert.deepEqual(rejected.rejectedBecause, ["unsupported aspect: 9:16"]);
  for (const provider of ["fal", "higgsfield"] as const) {
    const result = checkModelConstraints(
      entry("fixture/edit", {
        provider,
        category: "video-to-video",
        inputs: [{ name: "video_url", type: "string", media: "video", required: true }],
      }),
      { categories: [], inputs: [], outputs: [], durationSec: 5, aspect: "9:16" },
    );
    assert.deepEqual(result.rejectedBecause, []);
    assert.ok(result.warnings.some((w) => w.includes("source video for 5 s")));
  }
});

test("class price sanity uses each slot's characters/audio/area instead of a global video setting", () =>
  withSlots((file) => {
    const slot = file.slots[0]!;
    slot.candidates = [candidate("fixture/hero"), candidate("fixture/budget", 2)];
    slot.reference = { inputCharacters: 1000, inputAudioSec: 60, images: 2, megapixels: 1 };
    save(file);
    const seen: unknown[] = [];
    const prices = (e: FalCatalogEntry, parameters: unknown): ModelChoicePrice => {
      seen.push(parameters);
      return {
        kind: "approximate",
        usd: e.endpoint === "fixture/hero" ? 1 : 2,
        label: "fixture",
        unitPrice: null,
        unit: null,
        asOf: "2026-11-15",
        evidenceKind: "fixture",
        basis: "request",
      };
    };
    const checked = checkModelSlots(
      loadModelSlots(),
      { fal: new Map(slot.candidates.map((c) => [c.endpoint, entry(c.endpoint)])) },
      prices,
      now,
    );
    assert.ok(checked.warnings.some((w) => w.includes("pricier than hero")));
    assert.ok(seen.length >= 2);
    for (const parameters of seen) assert.deepEqual(parameters, slot.reference);
    const refresh = proposeSlotChanges(
      loadModelSlots(),
      { fal: new Map(slot.candidates.map((c) => [c.endpoint, entry(c.endpoint)])) },
      prices,
      now,
    );
    assert.ok(refresh.proposals.some((p) => p.kind === "price-drift" && p.message.includes('"inputCharacters":1000')));
    for (const parameters of seen) assert.deepEqual(parameters, slot.reference);
  }));

test("refresh scales sourced per-second reference estimates using slot duration", () =>
  withSlots((file) => {
    const slot = file.slots[0]!;
    slot.reference = { durationSec: 30 };
    slot.candidates = [candidate("fixture/hero"), candidate("fixture/budget", 2)];
    slot.candidates[1]!.referenceEstimate = {
      usd: 0.1,
      per: "second",
      setting: "Fixture",
      source: "https://example.com/tariff",
      observedAsOf: "2026-11-15",
    };
    save(file);
    const heroPrice: ModelChoicePrice = {
      kind: "exact",
      usd: 1,
      label: "fixture",
      unitPrice: 1,
      unit: "request",
      asOf: "2026-11-15",
      evidenceKind: "fixture",
      basis: "request",
    };
    const result = proposeSlotChanges(
      loadModelSlots(),
      { fal: new Map(slot.candidates.map((c) => [c.endpoint, entry(c.endpoint)])) },
      new Map([["fal:fixture/hero", heroPrice]]),
      now,
    );
    assert.ok(
      result.proposals.some((p) => p.kind === "price-drift" && p.message.includes("budget $3 exceeds hero $1")),
    );
  }));

test("unreviewed registry operations use an exact-endpoint API base rate only for controllable output seconds", () => {
  const endpoint = "fal-ai/kling-video/o3/pro/reference-to-video";
  const price = modelChoicePrice(
    entry(endpoint, {
      category: "image-to-video",
      inputs: [{ name: "duration", type: "integer", required: false, min: 3, max: 15 }],
    }),
    { durationSec: 5 },
  );
  assert.equal(price.kind, "approximate");
  assert.equal(price.usd, 0.7);
  assert.match(price.label, /audio variants untracked/);
  assert.match(price.label, /api.fal.ai.*pricing/);
  assert.equal(quote({ model: endpoint, durationSec: 5 }).bounded, false);
  assert.equal(
    modelChoicePrice(
      entry(endpoint, {
        category: "video-to-video",
        inputs: [{ name: "video_url", type: "string", media: "video", required: true }],
      }),
      { durationSec: 5, inputAudioSec: 5 },
    ).kind,
    "unknown",
  );
  assert.equal(
    modelChoicePrice(
      entry("fixture/audio", {
        category: "video-to-video",
        inputs: [{ name: "audio_url", type: "string", media: "audio", required: true }],
      }),
      { inputAudioSec: 5 },
    ).kind,
    "unknown",
  );
});

test("API MP fallbacks retain the API observation date and source rather than registry provenance", () => {
  const endpoint = "fal-ai/flux-2/flash",
    file = process.env.AGENTBROS_FAL_PRICES!;
  const old = readFileSync(file, "utf8");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        syncedAt: "2026-11-15",
        prices: [
          {
            endpoint,
            unit: "megapixels",
            unitPrice: 0.005,
            currency: "USD",
            observedAsOf: "2026-11-15",
            source: "platform-pricing-api",
          },
        ],
      }),
    );
    resetFalPricesCache();
    const price = modelChoicePrice(entry(endpoint), { images: 1, megapixels: 1 });
    assert.equal(price.usd, 0.005);
    assert.equal(price.asOf, "2026-11-15");
    assert.equal(price.evidenceKind, "platform-pricing-api");
    assert.match(price.label, /https:\/\/api.fal.ai\/v1\/models\/pricing/);
  } finally {
    writeFileSync(file, old);
    resetFalPricesCache();
  }
});
