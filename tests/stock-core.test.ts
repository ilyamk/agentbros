import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResponseCache, cacheKey } from "../src/lib/resources/cache";
import { ResourceService } from "../src/lib/resources/service";
import { rankCandidates, requiredSourceSize, resolutionFit, StockClient } from "../src/lib/resources/stock";
import { colourCloseness } from "../src/lib/resources/stock/rank";
import { downloadSize } from "../src/lib/resources/stock/resolution";
import { pickRendition } from "../src/lib/resources/stock/renditions";
import type { ResourceCandidate } from "../src/types/resources";
import {
  TIME,
  TIME_MS,
  json,
  pexelsPhoto,
  pixabayImage,
  routedFetch,
  unsplashPhoto,
  type Call,
} from "./helpers/stock-fixtures";

test("required source size follows the frame, push-in and the 1.5x house limit", () => {
  assert.deepEqual(requiredSourceSize("vertical", 1.3), {
    frame: { width: 1080, height: 1920 },
    ideal: { width: 1404, height: 2496 },
    minimum: { width: 936, height: 1664 },
  });
  assert.deepEqual(requiredSourceSize("landscape").ideal, { width: 1920, height: 1080 });
  assert.equal(resolutionFit({ width: 3000, height: 4000 }, "vertical").status, "ideal");
  assert.deepEqual(resolutionFit({ width: 1280, height: 853 }, "vertical"), { status: "too-small", upscale: 2.25 });
  assert.equal(resolutionFit({ width: 853, height: 1280 }, "vertical").status, "acceptable");
  assert.equal(resolutionFit({}, "square").status, "unknown");
  assert.deepEqual(downloadSize({ width: 8000, height: 4000 }, undefined), { width: 4096, height: 2048 });
  assert.deepEqual(downloadSize({ width: 1000, height: 1000 }, "square", 2), { width: 1000, height: 1000 });
});

test("rendition choice: smallest that fills, else largest; no target takes the largest", () => {
  const files = [
    { url: "https://x/1080.mp4", width: 1920, height: 1080 },
    { url: "https://x/4k.mp4", width: 3840, height: 2160 },
    { url: "https://x/720.mp4", width: 1280, height: 720 },
  ];
  assert.equal(pickRendition(files, { format: "landscape" })!.url, "https://x/1080.mp4");
  assert.equal(pickRendition(files, { format: "vertical", zoom: 1 })!.url, "https://x/4k.mp4");
  assert.equal(pickRendition(files, undefined)!.url, "https://x/4k.mp4");
  assert.equal(pickRendition([], undefined), undefined);
});

function stockCandidate(id: string, overrides: Partial<ResourceCandidate> = {}): ResourceCandidate {
  return {
    id,
    provider: "unsplash",
    kind: "image",
    title: "",
    sourceUrl: `https://unsplash.com/photos/${id}`,
    author: "A",
    acquisition: "direct",
    media: {},
    tags: [],
    rights: {
      licence: "Unsplash",
      commercialAllowed: true,
      derivativesAllowed: true,
      attributionRequired: false,
      attributionText: "x",
      shareAlike: false,
      allowedPlacements: [],
      restrictions: [],
      evidenceUrl: "https://unsplash.com/license",
      checkedAsOf: TIME,
      verifiedAtSource: true,
    },
    cost: { status: "free" },
    ...overrides,
  } as ResourceCandidate;
}

test("ranking prefers fit, aspect and words; too-small files are listed last as blocked", () => {
  const input = [
    stockCandidate("tiny", { title: "barista latte", media: { width: 400, height: 600 } }),
    stockCandidate("wide", { title: "barista latte", media: { width: 6000, height: 4000 } }),
    stockCandidate("tall", { title: "barista latte", media: { width: 3000, height: 5333 } }),
    stockCandidate("tall-off", { title: "mountain", media: { width: 3000, height: 5333 } }),
    stockCandidate("dupe", { sourceUrl: "https://unsplash.com/photos/tall", media: { width: 1, height: 1 } }),
  ];
  const ranked = rankCandidates(input, "barista latte", { format: "vertical" });
  assert.deepEqual(
    ranked.map((item) => item.candidate.id),
    ["tall", "wide", "tall-off", "tiny"],
  );
  assert.match(ranked.at(-1)!.blocked!, /resolution/);
  assert.ok(ranked[0]!.reasons.includes("matches: barista, latte"));
  const again = rankCandidates([...input], "barista latte", { format: "vertical" });
  assert.deepEqual(
    again.map((item) => [item.candidate.id, item.score]),
    ranked.map((item) => [item.candidate.id, item.score]),
    "deterministic for the same input",
  );
});

test("equal matches keep each provider's own relevance order, not id order", () => {
  const clip = (id: string) =>
    stockCandidate(id, {
      provider: "pexels",
      sourceUrl: `https://www.pexels.com/video/${id}`,
      media: { width: 1920, height: 1080 },
    });
  const ranked = rankCandidates([clip("pexels:video:9"), clip("pexels:video:1"), clip("pexels:video:5")], "pour", {
    format: "landscape",
  });
  assert.deepEqual(
    ranked.map((item) => item.candidate.id),
    ["pexels:video:9", "pexels:video:1", "pexels:video:5"],
  );
  assert.deepEqual(
    ranked.map((item) => item.position),
    [0, 1, 2],
  );
});

test("colour ranking uses the dominant colour", () => {
  assert.ok(colourCloseness("#8b5a2b", "brown") > 0.99);
  assert.ok(colourCloseness("#777777", "black_and_white") === 1);
  assert.ok(colourCloseness("#ff0000", "black_and_white") === 0);
  const ranked = rankCandidates(
    [
      stockCandidate("blue", { visual: { dominantColor: "#2a7fba" } }),
      stockCandidate("brown", { visual: { dominantColor: "#8a5a2c" } }),
    ],
    "",
    { color: "brown" },
  );
  assert.equal(ranked[0]!.candidate.id, "brown");
});

test("the response cache coalesces requests, honours its TTL and keys without secrets", async () => {
  let now = 0,
    loads = 0;
  const cache = new ResponseCache({ ttlMs: 1000, now: () => now });
  const load = async () => ({ value: ++loads });
  const [a, b] = await Promise.all([cache.through("k", load), cache.through("k", load)]);
  assert.deepEqual([a, b, loads], [{ value: 1 }, { value: 1 }, 1]);
  now = 999;
  assert.deepEqual(await cache.through("k", load), { value: 1 });
  now = 1000;
  assert.deepEqual(await cache.through("k", load), { value: 2 });
  assert.deepEqual(await cache.through("k", load, { fresh: true }), { value: 3 });
  assert.equal(
    cacheKey("https://pixabay.com/api/?q=a&key=one", ["key"]),
    cacheKey("https://pixabay.com/api/?key=two&q=a", ["key"]),
  );
  assert.throws(() => new ResponseCache({ ttlMs: 0 }));
});

test("quota memory persists across processes and a 403 with no remaining requests is a rate limit", async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "stock-quota-"));
  try {
    const calls: Call[] = [];
    const { fetch } = routedFetch(
      [
        [
          "search/photos",
          () =>
            json({ errors: ["Rate Limit Exceeded"] }, { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Limit": "50" }, 403),
        ],
      ],
      calls,
    );
    const make = () =>
      new ResourceService({ fetch, credentials: { unsplash: "k" }, now: () => TIME, nowMs: () => TIME_MS, cacheDir });
    await assert.rejects(
      () => make().search("unsplash", { query: "a", kind: "image" }),
      (error: any) => error.code === "RATE_LIMIT" && error.retryAfterMs === 3_600_000,
    );
    await assert.rejects(() => make().search("unsplash", { query: "b", kind: "image" }), /rate limit/);
    assert.equal(calls.length, 1, "the second process knows the window is spent");
    const quota = JSON.parse(readFileSync(path.join(cacheDir, "unsplash-quota.json"), "utf8"));
    assert.equal(quota.remaining, 0);
    assert.ok(!readdirSync(cacheDir).some((name) => /\.tmp$/.test(name)));
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a rejected key is reported as a key problem", async () => {
  const { fetch } = routedFetch([["search/photos", json({ errors: ["OAuth error"] }, {}, 401)]]);
  const service = new ResourceService({ fetch, credentials: { unsplash: "bad" }, now: () => TIME });
  await assert.rejects(() => service.search("unsplash", { query: "a", kind: "image" }), /rejected the access key/);
});

test("auto search fans out to configured providers, ranks the union and survives one failure", async () => {
  const calls: Call[] = [];
  const { fetch } = routedFetch(
    [
      ["api.unsplash.com/search/photos", { results: [unsplashPhoto()] }],
      ["api.pexels.com/v1/search", json({ error: "down" }, {}, 503)],
      ["pixabay.com/api/", { hits: [pixabayImage()] }],
    ],
    calls,
  );
  const service = new ResourceService({
    fetch,
    credentials: { unsplash: "u", pexels: "p", pixabay: "x" },
    now: () => TIME,
    nowMs: () => TIME_MS,
  });
  const result = await service.stock.search("auto", {
    query: "barista latte",
    kind: "image",
    filters: { format: "vertical", zoom: 1.2 },
  });
  assert.equal(result.providers.unsplash!.status, "ok");
  assert.equal(result.providers.pexels!.status, "error");
  assert.equal(result.providers.pexels!.code, "NETWORK");
  assert.equal(result.providers.pixabay!.status, "ok");
  assert.deepEqual(
    result.results.map((item) => item.candidate.id),
    ["unsplash:photo:abc123", "pixabay:photo:195893"],
    "the 4000x6000 Unsplash photo outranks Pixabay's 1280px still",
  );
  assert.deepEqual(result.required!.minimum, { width: 864, height: 1536 });
  const video = await service.stock.search("auto", { query: "pour", kind: "video" }).catch((error) => error);
  assert.ok(!calls.some((call) => call.url.includes("unsplash") && call.url.includes("pour")), "Unsplash has no video");
  assert.ok(video);
});

test("auto search without any key explains which keys to set; every failure is an error", async () => {
  const { fetch } = routedFetch([["pexels", json({}, {}, 500)]]);
  const none = new ResourceService({ fetch, credentials: {}, now: () => TIME });
  await assert.rejects(
    () => none.stock.search("auto", { query: "x", kind: "video" }),
    /PEXELS_API_KEY or PIXABAY_API_KEY/,
  );
  const broken = new ResourceService({ fetch, credentials: { pexels: "p" }, now: () => TIME });
  await assert.rejects(
    () => broken.stock.search(["pexels"], { query: "x", kind: "image" }),
    /Every stock provider failed/,
  );
  assert.throws(() => StockClient.query({ query: "x", kind: "image", filters: { zoom: 2 } }), /--zoom needs --format/);
  assert.throws(() => StockClient.query({ query: "x", kind: "image", limit: 51 }), /pagination/);
  assert.deepEqual(
    StockClient.query({ query: "x", kind: "image", filters: { format: "landscape", minWidth: 3000 } }).minWidth,
    3000,
    "explicit minimums win",
  );
});

test("pexels candidates still flow through the legacy single-provider search", async () => {
  const { fetch } = routedFetch([["v1/search", { photos: [pexelsPhoto()] }]]);
  const service = new ResourceService({ fetch, credentials: { pexels: "p" }, now: () => TIME });
  const [photo] = await service.search("pexels", { query: "rocks", kind: "image" });
  assert.equal(photo!.provider, "pexels");
});
