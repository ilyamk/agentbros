import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { falFixtureManifest, useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { buildCatalogEntry, loadCatalog, CATALOG_DIR } from "../src/lib/models/fal-catalog";
import type { FalApiModel } from "../src/lib/providers/fal-openapi";
import { findFalEndpoints } from "../src/lib/models/fal-find";
import { parseFalTask } from "../src/lib/models/fal-task-map";
import { FalCurationFileSchema, FalFindCandidateSchema } from "../src/types/fal-catalog";
import { resetFalPricesCache } from "../src/lib/models/fal-pricing";
import curation from "../src/lib/models/fal-curation.json";

const entries = Object.entries(falFixtureManifest.endpoints).map(([endpoint, fixture]) => {
  const model = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures/fal-catalog/schemas", `${fixture.sha256}.json`), "utf8"),
  ) as FalApiModel;
  const entry = buildCatalogEntry(model, { today: "2026-11-15", verifiedPins: {} });
  return {
    endpoint,
    patch: {
      ...entry,
      schema: entry.schema ? { ...entry.schema, sha256: fixture.sha256 } : null,
      ...(endpoint === "fal-ai/ltx-video-13b-distilled/image-to-video"
        ? { retiresAt: "2026-12-01", replacement: "fal-ai/pixverse/c1/transition" }
        : {}),
    },
  };
});
const temp = useTempFalCatalog(entries);
const prices = path.join(temp.catalogDir, "..", "prices.json");
process.env.AGENTBROS_FAL_PRICES = prices;
writeFileSync(prices, JSON.stringify({ version: 1, syncedAt: null, prices: [] }));

const golden: [string, string][] = [
  ["оживить фото", "fal-ai/pixverse/c1/transition"],
  ["озвучка", "elevenlabs/tts/eleven-v4"],
  ["транскрипция", "fal-ai/elevenlabs/speech-to-text/scribe-v2"],
  ["3d модель", "meshy/v7.1/image-to-3d"],
  ["сделать 3d модель из фото", "meshy/v7.1/image-to-3d"],
  ["убрать фон", "fal-ai/birefnet"],
  ["upscale", "fal-ai/aura-sr"],
  ["vision", "fal-ai/florence-2-large/caption"],
  ["music", "fal-ai/elevenlabs/music"],
  ["llm", "fal-ai/bytedance/seed/v2/mini"],
  ["animate photo", "fal-ai/pixverse/c1/transition"],
];
for (const [task, endpoint] of golden)
  test(`golden shortlist: ${task}`, () => {
    const found = findFalEndpoints({ task });
    assert.equal(found[0]?.endpoint, endpoint);
    assert.ok(
      found.every(
        (row) => row.category !== "training" && !row.warnings.some((warning) => warning.startsWith("Retires")),
      ),
    );
    for (const row of found) FalFindCandidateSchema.parse(row);
  });

test("task stems and explicit duration, aspect and resolution", () => {
  assert.deepEqual(parseFalTask("ОЖИВИТЬ ФОТО на 10 секунд, вертикальное видео 9:16 1080p").inputs, ["image"]);
  assert.equal(parseFalTask("10s 9:16 1080p").durationSec, 10);
  assert.equal(parseFalTask("10,5 секунд").durationSec, 10.5);
  assert.equal(parseFalTask("вертикальное видео").aspect, "9:16");
  assert.deepEqual(parseFalTask("звуковые эффекты").roles, ["sfx", "foley"]);
  assert.deepEqual(parseFalTask("липсинк").categories, ["audio-to-video", "video-to-video"]);
});

test("an audio-driven portrait needs a declared audio input when the task only asks to animate a photo", () => {
  const endpoint = "fal-ai/bytedance/omnihuman/v1.5";
  const catalog = new Map([[endpoint, loadCatalog().get(endpoint)!]]);
  const [photo] = findFalEndpoints({ task: "animate photo", explain: true }, { catalog });
  assert.match(photo?.rejectedBecause?.join(" ") ?? "", /requires audio in addition to the photo/);
  assert.equal(
    findFalEndpoints({ task: "animate photo", inputs: ["image", "audio"] }, { catalog })[0]?.endpoint,
    endpoint,
  );
  assert.equal(findFalEndpoints({ task: "talking head" }, { catalog })[0]?.endpoint, endpoint);
});

test("photo-to-3D requires image input; text-to-3D is a fallback only when no image candidate passes", () => {
  for (const task of ["сделать 3d модель из фото", "3d model from photo", "3d model from an image"]) {
    assert.deepEqual(parseFalTask(task).inputs, ["image"]);
    const found = findFalEndpoints({ task });
    assert.ok(found.length);
    assert.ok(found.every((row) => row.category === "image-to-3d"));
    const catalog = new Map([...loadCatalog()].filter(([, entry]) => entry.category === "text-to-3d"));
    assert.ok(findFalEndpoints({ task }, { catalog }).every((row) => row.category === "text-to-3d"));
    assert.ok(findFalEndpoints({ task }, { catalog }).length);
    assert.deepEqual(findFalEndpoints({ task, inputs: ["image"] }, { catalog }), []);
  }
  const image = loadCatalog().get("meshy/v7.1/image-to-3d")!;
  const text = { ...loadCatalog().get("meshy/v7.1/text-to-3d")!, tier: "verified" as const };
  const catalog = new Map([
    [image.endpoint, image],
    [text.endpoint, text],
  ]);
  assert.deepEqual(
    findFalEndpoints({ task: "3d model from photo" }, { catalog }).map((row) => row.endpoint),
    [image.endpoint],
  );
  assert.deepEqual(
    findFalEndpoints({ task: "3d model from photo", categories: ["image-to-3d", "text-to-3d"] }, { catalog }).map(
      (row) => row.endpoint,
    ),
    [image.endpoint],
  );
  catalog.set(image.endpoint, { ...image, status: "gone" });
  assert.deepEqual(
    findFalEndpoints({ task: "3d model from photo" }, { catalog }).map((row) => row.endpoint),
    [text.endpoint],
  );
});

test("hard filters, explain, schema-less opt-in and retiring replacements", () => {
  const catalog = loadCatalog();
  const only = new Map([
    ["fal-ai/ltx-video-13b-distilled/image-to-video", catalog.get("fal-ai/ltx-video-13b-distilled/image-to-video")!],
  ]);
  assert.equal(findFalEndpoints({}, { catalog: only }).length, 0);
  const retired = findFalEndpoints({ includeRetiring: true }, { catalog: only });
  assert.match(retired[0]!.warnings.join(" "), /replacement: fal-ai\/pixverse/);
  const rejected = findFalEndpoints({ task: "animate photo", minTier: "verified", explain: true });
  assert.equal(rejected.filter((row) => !row.rejectedBecause).length, 0);
  assert.equal(rejected.length, 10);
  assert.ok(rejected.every((row) => row.rejectedBecause?.length));
  const noSchema = [...catalog.values()].filter((entry) => !entry.schema);
  assert.ok(noSchema.length);
  for (const entry of noSchema) {
    const map = new Map([[entry.endpoint, entry]]);
    assert.equal(findFalEndpoints({}, { catalog: map }).length, 0);
    assert.equal(findFalEndpoints({ includeSchemaless: true }, { catalog: map }).length, 1);
  }
  assert.ok(findFalEndpoints({ categories: ["training"] }).some((row) => row.category === "training"));
  assert.equal(findFalEndpoints({ inputs: ["model3d"], outputs: ["audio"] }).length, 0);
});

test("specialist tasks require the correct media and generic LLMs need no name hints", () => {
  const video = findFalEndpoints({ task: "описать видео" });
  assert.ok(video.length);
  assert.ok(
    video.every((row) =>
      loadCatalog()
        .get(row.endpoint)!
        .inputs.some((field) => field.media === "video"),
    ),
  );
  assert.ok(findFalEndpoints({ task: "lipsync" }).some((row) => row.endpoint === "fal-ai/sync-lipsync"));
  const source = loadCatalog().get("nvidia/nemotron-3-nano-omni")!;
  const plain = { ...source, endpoint: "test/unnamed-language-service", displayName: "Service", tags: [] };
  assert.equal(
    findFalEndpoints({ task: "llm" }, { catalog: new Map([[plain.endpoint, plain]]) })[0]?.endpoint,
    plain.endpoint,
  );
});

test("schema constraint enums and bounds reject unsupported requests", () => {
  const original = loadCatalog().get("fal-ai/pixverse/c1/transition")!;
  const entry = {
    ...original,
    inputs: [
      { name: "image_url", type: "string", media: "image" as const, required: true },
      { name: "duration", type: "integer", min: 2, max: 10, enum: [5, 10], required: false },
      { name: "aspect_ratio", type: "string", enum: ["9:16", "16:9"], required: false },
      { name: "resolution", type: "string", enum: ["720p", "1080p"], required: false },
    ],
  };
  const catalog = new Map([[entry.endpoint, entry]]);
  assert.equal(findFalEndpoints({ durationSec: 10, aspect: "9:16", resolution: "1080p" }, { catalog }).length, 1);
  const sizes = {
    ...entry,
    inputs: [{ name: "image_size", type: "string", enum: ["portrait_16_9", "landscape_16_9"], required: false }],
  };
  assert.equal(findFalEndpoints({ aspect: "9:16" }, { catalog: new Map([[sizes.endpoint, sizes]]) }).length, 1);

  for (const query of [
    { durationSec: 2.5 },
    { durationSec: 11 },
    { durationSec: 7 },
    { aspect: "1:1" },
    { resolution: "4k" },
  ])
    assert.equal(findFalEndpoints(query, { catalog }).length, 0);
});

test("bounded price ceilings use endpoint units and explicit seconds; ties are deterministic", () => {
  const a = loadCatalog().get("fal-ai/flux/schnell")!,
    b = loadCatalog().get("fal-ai/flux/srpo")!;
  writeFileSync(
    prices,
    JSON.stringify({
      version: 1,
      syncedAt: null,
      prices: [a, b].map((entry, i) => ({
        endpoint: entry.endpoint,
        unitPrice: i ? 0.2 : 0.1,
        unit: "images",
        currency: "USD",
        observedAsOf: "2026-11-15",
        source: "platform-pricing-api",
      })),
    }),
  );
  resetFalPricesCache();
  const catalog = new Map([
    [b.endpoint, b],
    [a.endpoint, a],
  ]);
  const found = findFalEndpoints({ maxUsd: 0.15 }, { catalog });
  assert.deepEqual(
    found.map((row) => row.endpoint),
    [a.endpoint],
  );
  assert.equal(found[0]!.estimate.unit, "images");
  writeFileSync(prices, JSON.stringify({ version: 1, syncedAt: null, prices: [] }));
  resetFalPricesCache();
  assert.deepEqual(
    findFalEndpoints({}, { catalog }).map((row) => row.endpoint),
    [a.endpoint, b.endpoint],
  );
  const newer = { ...b, firstSeen: "2026-11-16" };
  assert.equal(
    findFalEndpoints(
      {},
      {
        catalog: new Map([
          [a.endpoint, a],
          [b.endpoint, newer],
        ]),
        now: new Date("2026-11-17"),
      },
    )[0]!.endpoint,
    b.endpoint,
  );
  assert.equal(findFalEndpoints({ maxUsd: 10 }, { catalog }).length, 0);
  const verified = { ...b, tier: "verified" as const };
  assert.equal(
    findFalEndpoints(
      {},
      {
        catalog: new Map([
          [a.endpoint, a],
          [b.endpoint, verified],
        ]),
      },
    )[0]?.endpoint,
    b.endpoint,
  );
  for (const status of ["gone", "deprecated"] as const)
    assert.equal(findFalEndpoints({}, { catalog: new Map([[a.endpoint, { ...a, status }]]) }).length, 0);
  const video = loadCatalog().get("fal-ai/pixverse/c1/transition")!;
  writeFileSync(
    prices,
    JSON.stringify({
      version: 1,
      syncedAt: null,
      prices: [
        {
          endpoint: video.endpoint,
          unitPrice: 0.1,
          unit: "seconds",
          currency: "USD",
          observedAsOf: "2026-11-15",
          source: "platform-pricing-api",
        },
      ],
    }),
  );
  resetFalPricesCache();
  const videoCatalog = new Map([[video.endpoint, video]]);
  assert.equal(findFalEndpoints({ durationSec: 10, maxUsd: 1 }, { catalog: videoCatalog })[0]?.estimate.highUsd, 1);
  assert.equal(findFalEndpoints({ durationSec: 10, maxUsd: 0.99 }, { catalog: videoCatalog }).length, 0);
  writeFileSync(prices, JSON.stringify({ version: 1, syncedAt: null, prices: [] }));
  resetFalPricesCache();
});

test("curation validates and names only indexed endpoints with documented provenance", () => {
  const parsed = FalCurationFileSchema.parse(curation),
    catalog = loadCatalog(CATALOG_DIR);
  for (const entry of parsed.entries) {
    assert.equal(catalog.get(entry.endpoint)?.category, entry.category);
    assert.ok(
      [
        "docs/production-model-routing.md",
        "docs/fal-catalogue.md#verified-endpoints",
        "src/lib/providers/fal-music.ts",
      ].includes(entry.source),
    );
    if (entry.source.startsWith("docs/")) assert.equal(catalog.get(entry.endpoint)?.tier, "verified");
  }
});

test("catalogue CLI searches locally and cached schema lookup needs no network", () => {
  const run = (...args: string[]) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/fal-models.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, FAL_KEY: "" },
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout).metadata;
  };
  const found = run("--category", "text-to-speech", "--tier", "discovered", "--search", "ELEVENLABS", "--limit", "1");
  assert.equal(found.offline, true);
  assert.equal(found.models[0].endpoint, "elevenlabs/tts/eleven-v4");
  const schema = run("--schema", "fal-ai/flux/schnell");
  assert.ok(schema.schema.input);
  assert.ok(schema.schema.schemas);
});
