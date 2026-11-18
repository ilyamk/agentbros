import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCatalogEntry,
  computeDrift,
  loadCatalog,
  readCachedApiModel,
  resetCatalogCache,
  resolveCatalogSnapshot,
  summariseInputs,
  summariseOutputs,
  writeCachedApiModel,
  writeCatalog,
} from "../src/lib/models/fal-catalog";
import { retryAfterMs, runFalSync } from "../src/lib/models/fal-sync";
import { snapshotFromOpenApi, type FalApiModel } from "../src/lib/providers/fal-openapi";
import {
  FalCatalogFileSchema,
  FalVerifiedFileSchema,
  type FalCatalogEntry,
  type FalVerifiedPin,
} from "../src/types/fal-catalog";
import operations from "../src/lib/providers/schemas/fal-operations.json";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";

const FIXTURES = path.resolve("tests/fixtures/fal-catalog");
const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")).endpoints as Record<
  string,
  { sha256: string; category: string }
>;
const model = (endpoint: string): FalApiModel =>
  JSON.parse(readFileSync(path.join(FIXTURES, "schemas", `${manifest[endpoint]!.sha256}.json`), "utf8"));
const snapshot = (endpoint: string) => snapshotFromOpenApi(model(endpoint), "2026-11-15");
const listing = (): FalApiModel[] => JSON.parse(readFileSync(path.join(FIXTURES, "catalog-page.json"), "utf8")).models;
const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), `fal-a-${prefix}-`));
const TODAY = "2026-11-15";
const entry = (
  endpoint: string,
  pins: Record<string, FalVerifiedPin> = {},
  extra: Partial<Parameters<typeof buildCatalogEntry>[1]> = {},
) => buildCatalogEntry(model(endpoint), { today: TODAY, verifiedPins: pins, ...extra });

test("verified pins cover non-stream snapshots and additional catalogue endpoints with fixture hashes", () => {
  const file = FalVerifiedFileSchema.parse(JSON.parse(readFileSync("src/lib/models/fal-verified.json", "utf8")));
  const expected = (operations as Array<{ endpoint: string }>)
    .map((row) => row.endpoint)
    .filter((id) => !id.endsWith("/stream"))
    .sort();
  assert.ok(expected.every((endpoint) => Object.hasOwn(file.pins, endpoint)));
  for (const endpoint of Object.keys(file.pins).filter((endpoint) => !expected.includes(endpoint))) {
    const pin = file.pins[endpoint]!;
    assert.ok(
      pin.catalogSha256 && existsSync(path.join(FIXTURES, "schemas", `${pin.catalogSha256}.json`)),
      `${endpoint} requires a tracked verified schema`,
    );
  }
  assert.equal(expected.length, 96);
  assert.ok(
    Object.values(file.pins).every((pin) => pin.catalogSha256 === null || /^[a-f0-9]{64}$/.test(pin.catalogSha256)),
  );
  for (const [endpoint, pin] of Object.entries(file.pins).filter(([endpoint]) => !expected.includes(endpoint))) {
    const indexed = loadCatalog().get(endpoint);
    assert.ok(indexed?.schema && indexed.tier === "verified", endpoint);
    assert.equal(pin.catalogSha256, indexed.schema.sha256, endpoint);
  }
});

test("input summaries: types, required, enums, bounds, defaults and media", () => {
  const flux = summariseInputs(snapshot("fal-ai/flux/schnell"));
  const prompt = flux.find((field) => field.name === "prompt")!;
  assert.equal(prompt.required, true);
  assert.equal(prompt.type, "string");
  const steps = flux.find((field) => field.name === "num_inference_steps")!;
  assert.equal(typeof steps.min, "number");
  assert.equal(typeof steps.max, "number");
  assert.deepEqual(flux.find((field) => field.name === "acceleration")!.enum, ["none", "regular", "high"]);
  assert.equal(flux.find((field) => field.name === "num_images")!.media, undefined, "a count is not media");
  assert.equal(flux.find((field) => field.name === "image_size")!.type, "object|string");
  const seedream = summariseInputs(snapshot("bytedance/seedream/v5/lite/edit"));
  assert.deepEqual(
    seedream.find((field) => field.name === "image_urls"),
    { ...seedream.find((field) => field.name === "image_urls"), media: "image", array: true },
  );
  const sync = summariseInputs(snapshot("fal-ai/sync-lipsync"));
  assert.equal(sync.find((field) => field.name === "video_url")!.media, "video");
  assert.equal(sync.find((field) => field.name === "audio_url")!.media, "audio");
  assert.equal(
    summariseInputs(snapshot("fal-ai/meshy/rigging/multi-animation")).find((field) => field.name === "model_url")!
      .media,
    "model3d",
  );
  assert.equal(
    summariseInputs(snapshot("blackforestlabs/flux-3/klein/base/trainer")).find(
      (field) => field.name === "images_data_url",
    )!.media,
    "file",
  );
});

test("output summaries by category: image, video, 3d, tts, stt, llm, training", () => {
  const kinds = (endpoint: string) => summariseOutputs(snapshot(endpoint)).kinds;
  assert.deepEqual(summariseOutputs(snapshot("fal-ai/flux/schnell")), { kinds: ["image"], fields: ["images"] });
  assert.deepEqual(summariseOutputs(snapshot("fal-ai/kling-video/v3/pro/text-to-video")), {
    kinds: ["video"],
    fields: ["video"],
  });
  assert.deepEqual(summariseOutputs(snapshot("hitem3d/hi3d/v3.0/multi-view-to-3d")), {
    kinds: ["image", "model3d"],
    fields: ["model_mesh", "thumbnail"],
  });
  assert.ok(kinds("meshy/v7/image-to-3d").includes("model3d"));
  assert.deepEqual(kinds("fal-ai/minimax/preview/speech-2.5-hd"), ["audio"]);
  assert.deepEqual(summariseOutputs(snapshot("fal-ai/wizper")).fields, ["chunks", "languages", "text"]);
  assert.ok(kinds("fal-ai/wizper").includes("text"));
  assert.deepEqual(summariseOutputs(snapshot("nvidia/nemotron-3-nano-omni")), {
    kinds: ["text", "json"],
    fields: ["output", "usage"],
  });
  assert.deepEqual(summariseOutputs(snapshot("blackforestlabs/flux-3/klein/base/trainer")), {
    kinds: ["weights", "file"],
    fields: ["config_file", "lora_file"],
  });
  assert.deepEqual(kinds("fal-ai/sam-audio/visual-separate"), ["audio"], "a File field with audio examples is audio");
  assert.deepEqual(kinds("openrouter/router/openai/v1/responses"), ["json"], "a free-form output is JSON");
});

test("catalogue entries: transport, schema-less realtime, routing, retirement", () => {
  const trainer = entry("blackforestlabs/flux-3/klein/base/trainer");
  assert.equal(trainer.transport, "training");
  assert.equal(trainer.category, "training");
  const kotoba = entry("kotoba-technologies/kotoba-sts/v1/realtime_voice", {
    "kotoba-technologies/kotoba-sts/v1/realtime_voice": { catalogSha256: null, since: TODAY },
  });
  assert.equal(kotoba.schema, null);
  assert.equal(kotoba.transport, "realtime");
  assert.equal(kotoba.tier, "discovered", "no schema is never verified");
  assert.deepEqual(kotoba.inputs, []);
  assert.equal(
    resolveCatalogSnapshot("kotoba-technologies/kotoba-sts/v1/realtime_voice", { dir: tmp("empty") }),
    undefined,
  );
  assert.equal(entry("xai/grok-voice/realtime").transport, "realtime");
  const kling = entry("fal-ai/kling-video/v3/pro/text-to-video");
  assert.deepEqual(kling.routing, { family: "kling-v3", variant: "pro", operation: "text-to-video", region: "global" });
  assert.equal(kling.transport, "queue");
  const meshy = entry("meshy/v7/image-to-3d");
  assert.equal(meshy.retiresAt, "2026-12-31T08:00:00.000Z");
  assert.equal(meshy.replacement, "meshy/v7.1/image-to-3d");
  assert.equal(meshy.status, "active");
});

test("tiers: pinned verified, pin mismatch demotes, priced, discovered; firstSeen kept", () => {
  const id = "fal-ai/kling-video/v3/pro/text-to-video";
  const sha = entry(id).schema!.sha256;
  assert.equal(entry(id, { [id]: { catalogSha256: null, since: TODAY } }).tier, "verified");
  assert.equal(entry(id, { [id]: { catalogSha256: sha, since: TODAY } }).tier, "verified");
  const other = "0".repeat(64);
  assert.equal(entry(id, { [id]: { catalogSha256: other, since: TODAY } }).tier, "discovered");
  const price = {
    endpoint: id,
    unitPrice: 0.112,
    unit: "seconds",
    currency: "USD" as const,
    observedAsOf: TODAY,
    source: "platform-pricing-api" as const,
  };
  const priced = entry(id, { [id]: { catalogSha256: other, since: TODAY } }, { priceFor: () => price });
  assert.equal(priced.tier, "priced");
  assert.deepEqual(priced.price, {
    unitPrice: 0.112,
    unit: "seconds",
    currency: "USD",
    observedAsOf: TODAY,
    source: "platform-pricing-api",
  });
  assert.equal(entry("fal-ai/flux/srpo").tier, "discovered");
  const previous = { ...entry(id), firstSeen: "2026-10-11" };
  const next = buildCatalogEntry(model(id), { today: "2026-11-20", previous, verifiedPins: {} });
  assert.equal(next.firstSeen, "2026-10-11");
  assert.equal(next.lastSeen, "2026-11-20");
  const { openapi: _openapi, ...listed } = model(id);
  const kept = buildCatalogEntry(listed, { today: "2026-11-20", previous: entry(id), verifiedPins: {} });
  assert.deepEqual(kept.schema, entry(id).schema, "a listing without openapi keeps the previous schema");
  assert.deepEqual(kept.inputs, entry(id).inputs);
  for (const endpoint of Object.keys(manifest))
    assert.notEqual(entry(endpoint, { [endpoint]: { catalogSha256: null, since: TODAY } }).tier, "live");
});

test("drift: added, gone, schemaChanged, retiring and demoted", () => {
  const a = entry("fal-ai/flux/schnell", { "fal-ai/flux/schnell": { catalogSha256: null, since: TODAY } });
  const b = entry("fal-ai/aura-sr");
  const c = entry("meshy/v7/image-to-3d");
  const { retiresAt: _r, replacement: _p, ...cBefore } = c;
  const previous: FalCatalogEntry[] = [a, b, cBefore as FalCatalogEntry];
  const changedSha = "f".repeat(64);
  const next: FalCatalogEntry[] = [
    { ...a, schema: { ...a.schema!, sha256: changedSha }, tier: "discovered" },
    { ...b, status: "gone" },
    c,
    entry("fal-ai/birefnet"),
  ];
  const drift = computeDrift(previous, next, { generatedAt: "2026-11-15T00:00:00.000Z" });
  assert.deepEqual(drift.added, ["fal-ai/birefnet"]);
  assert.deepEqual(drift.gone, ["fal-ai/aura-sr"]);
  assert.deepEqual(drift.schemaChanged, [{ endpoint: "fal-ai/flux/schnell", from: a.schema!.sha256, to: changedSha }]);
  assert.deepEqual(drift.retiring, [
    { endpoint: "meshy/v7/image-to-3d", retiresAt: "2026-12-31T08:00:00.000Z", replacement: "meshy/v7.1/image-to-3d" },
  ]);
  assert.equal(drift.demoted.length, 1);
  assert.equal(drift.demoted[0]!.endpoint, "fal-ai/flux/schnell");
  assert.equal(drift.demoted[0]!.from, "verified");
  assert.match(drift.demoted[0]!.reason, /schema hash changed/);
  assert.deepEqual(drift.priceDrift, []);
  assert.deepEqual(computeDrift(next, next).retiring, [], "an unchanged retirement is not drift");
  const priceDrift = [{ endpoint: "fal-ai/flux/schnell", tracked: "0.003/megapixels", observed: "0.004/megapixels" }];
  assert.deepEqual(computeDrift(previous, next, { priceDrift }).priceDrift, priceDrift);
});

test("schema cache: canonical bytes round-trip by hash; tampering is rejected", () => {
  const dir = tmp("cache");
  const source = model("fal-ai/wizper");
  const sha = writeCachedApiModel(source, dir);
  const bytes = readFileSync(path.join(dir, `${sha}.json`));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
  const back = readCachedApiModel(sha, dir)!;
  assert.equal(back.endpoint_id, "fal-ai/wizper");
  assert.equal(back.metadata && "is_favorited" in back.metadata, false, "the per-account flag is not cached");
  assert.equal(
    writeCachedApiModel(
      {
        ...source,
        metadata: {
          ...source.metadata,
          is_favorited: true,
          updated_at: "2027-01-01T00:00:00Z",
          thumbnail_url: "https://x/y.png",
        },
      },
      dir,
    ),
    sha,
    "the hash ignores who asked and presentation",
  );
  writeFileSync(path.join(dir, `${sha}.json`), Buffer.concat([bytes, Buffer.from(" ")]));
  assert.throws(() => readCachedApiModel(sha, dir), /hash check/);
});

test("writeCatalog: one sorted, valid file per category; stale category files removed", () => {
  const dir = tmp("index");
  writeFileSync(path.join(dir, "worlds.json"), "{}");
  writeFileSync(path.join(dir, "README.md"), "keep");
  const entries = ["fal-ai/flux/srpo", "fal-ai/flux/schnell", "fal-ai/nano-banana", "fal-ai/wizper"].map((id) =>
    entry(id),
  );
  const written = writeCatalog(entries, dir, { syncedAt: TODAY });
  assert.deepEqual(
    written.map((file) => path.basename(file)),
    ["speech-to-text.json", "text-to-image.json"],
  );
  assert.deepEqual(readdirSync(dir).sort(), ["README.md", "speech-to-text.json", "text-to-image.json"]);
  const file = FalCatalogFileSchema.parse(JSON.parse(readFileSync(path.join(dir, "text-to-image.json"), "utf8")));
  assert.deepEqual(
    file.entries.map((item) => item.endpoint),
    ["fal-ai/flux/schnell", "fal-ai/flux/srpo", "fal-ai/nano-banana"],
  );
  resetCatalogCache();
  assert.equal(loadCatalog(dir).size, 4);
  resetCatalogCache();
});

type Call = { url: URL; headers: Record<string, string> };
function fakeApi(
  handler: (url: URL, call: number) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = handler(url, calls.length);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof fetch;
  return { impl, calls };
}

for (const withSchema of [false, true]) {
  for (const withPrevious of [false, true]) {
    test(`runFalSync: lookup metadata survives ${withSchema ? "schema" : "verify-known"} lookup with ${withPrevious ? "an unknown previous entry" : "no previous index"}`, async (t) => {
      const previousCatalogDir = process.env.AGENTBROS_FAL_CATALOG_DIR;
      const previousCacheDir = process.env.AGENTBROS_FAL_SCHEMA_CACHE;
      t.after(() => {
        if (previousCatalogDir === undefined) delete process.env.AGENTBROS_FAL_CATALOG_DIR;
        else process.env.AGENTBROS_FAL_CATALOG_DIR = previousCatalogDir;
        if (previousCacheDir === undefined) delete process.env.AGENTBROS_FAL_SCHEMA_CACHE;
        else process.env.AGENTBROS_FAL_SCHEMA_CACHE = previousCacheDir;
        resetCatalogCache();
      });
      const id = "fal-ai/kling-video/v3/pro/text-to-video";
      const { catalogDir: outDir, cacheDir } = useTempFalCatalog(
        withPrevious
          ? [{ endpoint: id, patch: { category: "unknown", displayName: id, schema: null, firstSeen: "2026-10-11" } }]
          : [],
      );
      const verifiedFile = path.join(cacheDir, "verified.json");
      writeFileSync(
        verifiedFile,
        JSON.stringify({ version: 1, pins: { [id]: { catalogSha256: null, since: TODAY } } }),
      );
      const source = model(id);
      const { openapi: _openapi, ...withoutSchema } = source;
      assert.equal(source.metadata!.category, "text-to-video");
      assert.notEqual(source.metadata!.display_name, id);
      const api = fakeApi((url) => {
        if (!url.searchParams.has("endpoint_id")) return { status: 200, body: { models: [], has_more: false } };
        assert.equal(url.searchParams.get("endpoint_id"), id);
        assert.equal(url.searchParams.get("expand"), withSchema ? "openapi-3.0" : null);
        return { status: 200, body: { models: [withSchema ? source : withoutSchema] } };
      });
      const result = await runFalSync(
        {
          catalog: true,
          ...(withSchema ? { schemas: [id] } : { verifyKnown: true }),
          outDir,
          cacheDir,
          verifiedFile,
          now: () => new Date(`${TODAY}T12:00:00Z`),
        },
        api.impl,
      );
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.notFound, []);
      assert.equal(result.listed, 0);
      assert.equal(result.schemasFetched, withSchema ? 1 : 0);
      assert.equal(api.calls.length, 2);
      const actual = loadCatalog(outDir).get(id)!;
      assert.equal(actual.category, "text-to-video");
      assert.equal(actual.displayName, source.metadata!.display_name);
      assert.equal(actual.firstSeen, withPrevious ? "2026-10-11" : TODAY);
      const categoryFile = FalCatalogFileSchema.parse(
        JSON.parse(readFileSync(path.join(outDir, "text-to-video.json"), "utf8")),
      );
      assert.deepEqual(
        categoryFile.entries.map((item) => item.endpoint),
        [id],
      );
      assert.equal(
        existsSync(path.join(outDir, "unknown.json")),
        false,
        "the endpoint leaves the unknown category file",
      );
      if (withSchema) {
        const cached = readCachedApiModel(actual.schema!.sha256, cacheDir)!;
        assert.equal(cached.metadata!.category, source.metadata!.category);
        assert.equal(cached.metadata!.display_name, source.metadata!.display_name);
      }
    });
  }
}

test("runFalSync: pagination, 429 Retry-After, schemas, verify-known 404 → gone, pins", async () => {
  const out = tmp("sync-out");
  const cache = tmp("sync-cache");
  const verifiedFile = path.join(tmp("sync-pins"), "fal-verified.json");
  const pinned = "fal-ai/flux/schnell";
  writeFileSync(
    verifiedFile,
    JSON.stringify({
      version: 1,
      pins: {
        [pinned]: { catalogSha256: null, since: TODAY },
        "fal-ai/flux-2-trainer": { catalogSha256: null, since: TODAY },
      },
    }),
  );
  // Previous index: an entry the listing will miss and the API no longer knows, and one it misses but still serves.
  const old = {
    ...entry("fal-ai/aura-sr"),
    endpoint: "fal-ai/old-upscaler",
    firstSeen: "2026-10-11",
    lastSeen: "2026-10-11",
  };
  const hidden = {
    ...entry("fal-ai/birefnet"),
    endpoint: "bytedance/seedance-2.5/text-to-video",
    category: "image-to-image" as const,
    firstSeen: "2026-10-11",
    lastSeen: "2026-10-11",
  };
  writeCatalog([old, hidden], out, { syncedAt: "2026-10-11" });
  const models = listing().filter((item) =>
    ["fal-ai/flux/schnell", "fal-ai/wizper", "meshy/v7/image-to-3d"].includes(item.endpoint_id),
  );
  const sleeps: number[] = [];
  let limited = false;
  const api = fakeApi((url) => {
    if (url.searchParams.get("endpoint_id")) {
      const id = url.searchParams.get("endpoint_id")!;
      if (id === "bytedance/seedance-2.5/text-to-video")
        return {
          status: 200,
          body: {
            models: [
              {
                endpoint_id: id,
                metadata: { category: "text-to-video", display_name: "Seedance 2.5", status: "active" },
              },
            ],
          },
        };
      if (id === pinned && !limited) {
        limited = true;
        return { status: 429, headers: { "retry-after": "2" } };
      }
      if (id === pinned) return { status: 200, body: { models: [model(pinned)] } };
      return { status: 404, body: { detail: "not found" } };
    }
    const cursor = url.searchParams.get("cursor");
    assert.equal(url.searchParams.get("status"), "active");
    assert.equal(url.searchParams.get("limit"), "100");
    return cursor === "p2"
      ? { status: 200, body: { models: models.slice(2), has_more: false, next_cursor: null } }
      : { status: 200, body: { models: models.slice(0, 2), has_more: true, next_cursor: "p2" } };
  });
  const result = await runFalSync(
    {
      catalog: true,
      schemas: [pinned],
      verifyKnown: true,
      pinVerified: true,
      outDir: out,
      cacheDir: cache,
      verifiedFile,
      now: () => new Date("2026-11-15T10:00:00Z"),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      concurrency: 1,
    },
    api.impl,
  );
  assert.equal(result.pages, 2);
  assert.equal(result.listed, 3);
  assert.deepEqual(sleeps, [2000], "429 honours Retry-After");
  assert.deepEqual(result.verified.gone, ["fal-ai/old-upscaler"]);
  assert.deepEqual(result.verified.found, ["bytedance/seedance-2.5/text-to-video"]);
  assert.deepEqual(
    result.notFound,
    ["fal-ai/flux-2-trainer"],
    "a pinned endpoint never indexed is reported, not invented",
  );
  assert.deepEqual(result.drift.gone, ["fal-ai/old-upscaler"]);
  assert.deepEqual(result.drift.added.sort(), ["fal-ai/flux/schnell", "fal-ai/wizper", "meshy/v7/image-to-3d"]);
  assert.equal(result.drift.retiring.length, 1);
  assert.deepEqual(result.pinned, [pinned]);
  assert.ok(
    api.calls.every((call) => !("Authorization" in call.headers)),
    "no key, no auth header",
  );
  resetCatalogCache();
  const index = loadCatalog(out);
  resetCatalogCache();
  assert.equal(index.get("fal-ai/old-upscaler")!.status, "gone");
  assert.equal(index.get("fal-ai/old-upscaler")!.lastSeen, "2026-10-11");
  assert.equal(index.get("bytedance/seedance-2.5/text-to-video")!.category, "text-to-video");
  assert.equal(index.get("bytedance/seedance-2.5/text-to-video")!.firstSeen, "2026-10-11");
  const schnell = index.get(pinned)!;
  assert.equal(schnell.tier, "verified");
  assert.equal(schnell.schema!.cached, true);
  assert.ok(existsSync(path.join(cache, `${schnell.schema!.sha256}.json`)));
  assert.equal(resolveCatalogSnapshot(pinned, { dir: out, cacheDir: cache })!.endpoint, pinned);
  const pins = FalVerifiedFileSchema.parse(JSON.parse(readFileSync(verifiedFile, "utf8"))).pins;
  assert.equal(pins[pinned]!.catalogSha256, schnell.schema!.sha256);
  assert.equal(pins["fal-ai/flux-2-trainer"]!.catalogSha256, null);
  resetCatalogCache();
});

test("runFalSync: a pin mismatch demotes on the next sync; requests stay anonymous; bad IDs skipped", async () => {
  const out = tmp("sync2-out");
  const cache = tmp("sync2-cache");
  const verifiedFile = path.join(tmp("sync2-pins"), "fal-verified.json");
  const id = "fal-ai/wizper";
  writeFileSync(verifiedFile, JSON.stringify({ version: 1, pins: { [id]: { catalogSha256: null, since: TODAY } } }));
  const untouched = { ...entry("fal-ai/flux/srpo"), firstSeen: "2026-10-11", lastSeen: "2026-10-11" };
  writeCatalog([untouched], out, { syncedAt: "2026-10-11" });
  const first = fakeApi((url) =>
    url.searchParams.get("endpoint_id")
      ? { status: 200, body: { models: [model(id)] } }
      : {
          status: 200,
          body: {
            models: [listing().find((item) => item.endpoint_id === id), { endpoint_id: "bad id with spaces" }],
            has_more: false,
          },
        },
  );
  const one = await runFalSync(
    {
      catalog: true,
      schemas: [id],
      pinVerified: true,
      outDir: out,
      cacheDir: cache,
      verifiedFile,
      apiKey: "k",
      now: () => new Date("2026-11-15T10:00:00Z"),
    },
    first.impl,
  );
  assert.equal(one.skipped[0]!.endpoint, "bad id with spaces");
  assert.ok(
    first.calls.every((call) => !("Authorization" in call.headers)),
    "catalogue requests stay anonymous even with a key: authenticated lookups drop metadata",
  );
  resetCatalogCache();
  assert.deepEqual(
    loadCatalog(out).get("fal-ai/flux/srpo"),
    untouched,
    "missing from the listing without --verify-known: kept unchanged",
  );
  resetCatalogCache();
  const changed = model(id);
  changed.metadata = { ...changed.metadata, description: "a new description" };
  const second = fakeApi(() => ({ status: 200, body: { models: [changed] } }));
  const two = await runFalSync(
    { schemas: [id], outDir: out, cacheDir: cache, verifiedFile, now: () => new Date("2026-11-16T10:00:00Z") },
    second.impl,
  );
  assert.equal(two.drift.schemaChanged.length, 1);
  assert.deepEqual(
    two.drift.demoted.map((item) => [item.endpoint, item.from, item.to]),
    [[id, "verified", "discovered"]],
  );
  resetCatalogCache();
});

test("runFalSync: a schemas-only sync rewrites only the changed category files", async () => {
  const out = tmp("sync-only-out");
  const cache = tmp("sync-only-cache");
  const verifiedFile = path.join(tmp("sync-only-pins"), "fal-verified.json");
  const id = "fal-ai/wizper";
  const other = "fal-ai/flux/srpo";
  writeFileSync(verifiedFile, JSON.stringify({ version: 1, pins: {} }));
  const looked = { ...entry(id), firstSeen: "2026-10-11", lastSeen: "2026-10-11" };
  const untouched = { ...entry(other), firstSeen: "2026-10-11", lastSeen: "2026-10-11" };
  assert.notEqual(looked.category, untouched.category, "the fixture needs two categories");
  writeCatalog([looked, untouched], out, { syncedAt: "2026-10-11" });
  const otherFile = path.join(out, `${untouched.category}.json`);
  const lookedFile = path.join(out, `${looked.category}.json`);
  const before = readFileSync(otherFile);
  const api = fakeApi(() => ({ status: 200, body: { models: [model(id)] } }));
  const result = await runFalSync(
    { schemas: [id], outDir: out, cacheDir: cache, verifiedFile, now: () => new Date("2026-11-16T10:00:00Z") },
    api.impl,
  );
  assert.deepEqual(result.written, [lookedFile]);
  assert.deepEqual(readFileSync(otherFile), before, "an untouched category file stays byte-identical");
  const updated = FalCatalogFileSchema.parse(JSON.parse(readFileSync(lookedFile, "utf8")));
  assert.equal(updated.syncedAt, "2026-11-16");
  assert.equal(updated.entries[0]!.lastSeen, "2026-11-16");
  assert.ok(updated.entries[0]!.schema, "the looked-up endpoint gains its schema");
  assert.ok(readCachedApiModel(updated.entries[0]!.schema!.sha256, cache), "the schema cache is written");
  resetCatalogCache();
});

test("runFalSync refuses an incomplete listing and bad arguments", async () => {
  const endless = fakeApi(() => ({ status: 200, body: { models: [], has_more: true, next_cursor: "again" } }));
  await assert.rejects(
    runFalSync({ catalog: true, outDir: tmp("cap"), cacheDir: tmp("cap-c"), pageCap: 3, dryRun: true }, endless.impl),
    /3-page cap/,
  );
  await assert.rejects(
    runFalSync({ verifyKnown: true, outDir: tmp("vk"), dryRun: true }, endless.impl),
    /add --catalog/,
  );
  await assert.rejects(
    runFalSync({ schemas: ["not an id"], outDir: tmp("id"), dryRun: true }, endless.impl),
    /Not endpoint IDs/,
  );
  const limited = fakeApi(() => ({ status: 429 }));
  await assert.rejects(
    runFalSync({ catalog: true, outDir: tmp("rl"), dryRun: true, maxRetries: 1, sleep: async () => {} }, limited.impl),
    (error: { code?: string }) => error.code === "RATE_LIMIT",
  );
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(retryAfterMs(new Date(Date.now() + 5000).toUTCString(), Date.now()) !== undefined, true);
  assert.equal(retryAfterMs(null), undefined);
});

test("fal:sync --from-fixtures --dry-run: one JSON line, nothing written", () => {
  const out = tmp("cli-out");
  const cache = tmp("cli-cache");
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/fal-sync.ts",
      "--from-fixtures",
      FIXTURES,
      "--catalog",
      "--all",
      "--dry-run",
      "--out",
      out,
      "--cache-dir",
      cache,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, FAL_KEY: "", AGENTBROS_FAL_SCHEMA_CACHE: cache },
    },
  );
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, run.stderr);
  const result = JSON.parse(lines[0]!);
  assert.equal(result.ok, true, run.stdout);
  assert.equal(run.status, 0);
  assert.equal(result.metadata.entries, 54);
  assert.equal(result.metadata.drift.added.length, 54);
  assert.equal(result.metadata.dryRun, true);
  assert.deepEqual(result.outputs, []);
  assert.deepEqual(readdirSync(out), []);
  assert.deepEqual(readdirSync(cache), []);
});

test("runFalSync: a listed endpoint that 404s on lookup stays active; a retirement is not a schema change", async () => {
  const out = tmp("sync3-out");
  const cache = tmp("sync3-cache");
  const verifiedFile = path.join(tmp("sync3-pins"), "fal-verified.json");
  const id = "fal-ai/aura-sr";
  writeFileSync(
    verifiedFile,
    JSON.stringify({ version: 1, pins: { "fal-ai/wizper": { catalogSha256: null, since: TODAY } } }),
  );
  const listed = listing().filter((item) => item.endpoint_id === id || item.endpoint_id === "fal-ai/wizper");
  const first = fakeApi((url) =>
    url.searchParams.get("endpoint_id") === id
      ? { status: 404 }
      : url.searchParams.get("endpoint_id")
        ? { status: 200, body: { models: [model("fal-ai/wizper")] } }
        : { status: 200, body: { models: listed, has_more: false } },
  );
  const one = await runFalSync(
    {
      catalog: true,
      schemas: [id, "fal-ai/wizper"],
      verifyKnown: true,
      pinVerified: true,
      outDir: out,
      cacheDir: cache,
      verifiedFile,
      now: () => new Date("2026-11-15T10:00:00Z"),
    },
    first.impl,
  );
  assert.deepEqual(one.lookupMissing, [id]);
  assert.deepEqual(one.notFound, []);
  assert.deepEqual(one.drift.gone, []);
  resetCatalogCache();
  assert.equal(loadCatalog(out).get(id)!.status, "active");
  assert.equal(loadCatalog(out).get(id)!.schema, null);
  resetCatalogCache();
  // fal announces a retirement on the pinned endpoint, written with an offset.
  const retiring = {
    ...model("fal-ai/wizper"),
    retires_at: "2027-01-31T00:00:00+00:00",
    replacement: "fal-ai/wizper/v2",
  };
  const second = fakeApi(() => ({ status: 200, body: { models: [retiring] } }));
  const two = await runFalSync(
    {
      schemas: ["fal-ai/wizper"],
      outDir: out,
      cacheDir: cache,
      verifiedFile,
      now: () => new Date("2026-11-16T10:00:00Z"),
    },
    second.impl,
  );
  assert.deepEqual(two.drift.schemaChanged, []);
  assert.deepEqual(two.drift.demoted, []);
  assert.deepEqual(two.drift.retiring, [
    { endpoint: "fal-ai/wizper", retiresAt: "2027-01-31T00:00:00.000Z", replacement: "fal-ai/wizper/v2" },
  ]);
  resetCatalogCache();
  assert.equal(loadCatalog(out).get("fal-ai/wizper")!.tier, "verified");
  resetCatalogCache();
});
