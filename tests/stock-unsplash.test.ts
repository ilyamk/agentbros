import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { ResourceService } from "../src/lib/resources/service";
import { UNSPLASH_UTM_SOURCE, withReferral } from "../src/lib/resources/stock/unsplash";
import { evaluateResourceUsage } from "../src/lib/resources/rights";
import { PNG, TIME, TIME_MS, json, projectRoot, routedFetch, unsplashPhoto, type Call } from "./helpers/stock-fixtures";

function service(fetch: typeof globalThis.fetch, key: string | undefined = "unsplash-key") {
  return new ResourceService({ fetch, credentials: { unsplash: key }, now: () => TIME, nowMs: () => TIME_MS });
}

test("Unsplash search maps shared filters and authenticates with Client-ID", async () => {
  const calls: Call[] = [];
  const { fetch } = routedFetch([["search/photos", { total: 1, total_pages: 1, results: [unsplashPhoto()] }]], calls);
  const found = await service(fetch).search("unsplash", {
    query: "barista latte",
    kind: "image",
    limit: 40,
    stock: { orientation: "portrait", color: "pink", safe: true, collections: ["317099"], lang: "de" },
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, "https://api.unsplash.com/search/photos");
  assert.equal(url.searchParams.get("orientation"), "portrait");
  assert.equal(url.searchParams.get("color"), "magenta");
  assert.equal(url.searchParams.get("content_filter"), "high");
  assert.equal(url.searchParams.get("per_page"), "30", "Unsplash pages hold at most 30");
  assert.equal(url.searchParams.get("collections"), "317099");
  assert.equal(url.searchParams.get("lang"), "de");
  assert.equal(url.searchParams.has("client_id"), false, "the key travels in the header, not the URL");
  assert.equal(calls[0]!.headers.Authorization, "Client-ID unsplash-key");
  assert.equal(calls[0]!.headers["Accept-Version"], "v1");
  const [photo] = found;
  assert.equal(photo!.id, "unsplash:photo:abc123");
  assert.equal(photo!.authorId, "jane");
  assert.equal(new URL(photo!.sourceUrl).searchParams.get("utm_source"), UNSPLASH_UTM_SOURCE);
  assert.equal(new URL(photo!.authorUrl!).searchParams.get("utm_medium"), "referral");
  assert.equal(photo!.visual?.dominantColor, "#8c5a3c");
  assert.equal(photo!.tracking?.downloadLocation, unsplashPhoto().links.download_location);
  assert.match(photo!.previewUrl!, /ixid=/, "previews are the API's own hotlinked URLs");
  assert.deepEqual(photo!.media, { width: 4000, height: 6000 });
  assert.equal(calls.filter((call) => call.url.includes("/download")).length, 0, "search never reports a download");
});

test("square maps to squarish; author and topic use their own routes", async () => {
  const calls: Call[] = [];
  const { fetch } = routedFetch(
    [
      ["users/jane/photos", [unsplashPhoto()]],
      ["topics/film/photos", [unsplashPhoto({ id: "t1" })]],
      ["search/photos", { results: [] }],
    ],
    calls,
  );
  const unsplash = service(fetch);
  await unsplash.search("unsplash", { query: "x", kind: "image", stock: { orientation: "square" } });
  assert.equal(new URL(calls[0]!.url).searchParams.get("orientation"), "squarish");
  const byAuthor = await unsplash.search("unsplash", { query: "", kind: "image", stock: { author: "jane" } });
  assert.equal(byAuthor[0]!.authorId, "jane");
  assert.match(calls[1]!.url, /users\/jane\/photos\?.*order_by=popular/);
  const byTopic = await unsplash.search("unsplash", { query: "", kind: "image", stock: { topic: "film" } });
  assert.equal(byTopic[0]!.id, "unsplash:photo:t1");
});

test("Unsplash refuses video, an empty query and a missing key with clear errors", async () => {
  const { fetch } = routedFetch([]);
  await assert.rejects(() => service(fetch).search("unsplash", { query: "x", kind: "video" }), /does not cover video/);
  await assert.rejects(() => service(fetch).search("unsplash", { query: " ", kind: "image" }), /requires --query/);
  await assert.rejects(
    () => service(fetch, "").search("unsplash", { query: "x", kind: "image" }),
    /Missing UNSPLASH_ACCESS_KEY/,
  );
});

test("Unsplash licence: no credit required, credit text ready, resale and endorsement blocked", async () => {
  const { fetch } = routedFetch([["search/photos", { results: [unsplashPhoto()] }]]);
  const [photo] = await service(fetch).search("unsplash", { query: "latte", kind: "image" });
  assert.equal(photo!.rights.licence, "Unsplash");
  assert.equal(photo!.rights.commercialAllowed, true);
  assert.equal(photo!.rights.attributionRequired, false);
  assert.match(photo!.rights.attributionText, /^Photo by Jane Doe .* on Unsplash/);
  assert.match(photo!.rights.attributionText, new RegExp(`utm_source=${UNSPLASH_UTM_SOURCE}`));
  const plain = evaluateResourceUsage(photo!, { commercial: true });
  assert.equal(plain.allowed, true);
  assert.equal(plain.attribution, "", "credits stay empty unless asked for");
  assert.match(evaluateResourceUsage(photo!, { commercial: true, credit: true }).attribution, /Jane Doe/);
  assert.equal(evaluateResourceUsage(photo!, { standaloneResale: true }).allowed, false);
  assert.equal(evaluateResourceUsage(photo!, { endorsement: true }).allowed, false);
});

test("inspect reads the photo fresh with tags, location and camera", async () => {
  const calls: Call[] = [];
  const detail = unsplashPhoto({
    tags: [{ title: "coffee" }, { title: "cafe" }],
    location: { name: "Lisbon, Portugal", city: "Lisbon", country: "Portugal" },
    exif: { make: "Canon", model: "Canon EOS R5", focal_length: "50.0", aperture: "1.8" },
  });
  const { fetch } = routedFetch(
    [
      ["photos/abc123", detail],
      ["search/photos", { results: [unsplashPhoto()] }],
    ],
    calls,
  );
  const unsplash = service(fetch);
  const [photo] = await unsplash.search("unsplash", { query: "latte", kind: "image" });
  const first = await unsplash.inspect(photo!);
  await unsplash.inspect(photo!);
  assert.deepEqual(first.tags, ["coffee", "cafe"]);
  assert.match(first.details!.location!, /Lisbon/);
  assert.match(first.details!.camera!, /Canon EOS R5 50.0mm f\/1.8/);
  assert.equal(calls.filter((call) => call.url.includes("photos/abc123")).length, 2, "inspect is never cached");
});

test("acquire reports the download once, then fetches a frame-sized copy that keeps ixid", async () => {
  const { root } = projectRoot();
  try {
    const calls: Call[] = [];
    const { fetch } = routedFetch(
      [
        ["photos/abc123/download", { url: "https://images.unsplash.com/photo-1?ixid=x" }],
        ["search/photos", { results: [unsplashPhoto()] }],
        ["images.unsplash.com", PNG],
      ],
      calls,
    );
    const unsplash = service(fetch);
    const [photo] = await unsplash.search("unsplash", { query: "latte", kind: "image" });
    const result = await unsplash.acquire(photo!, {
      projectId: "demo",
      rootDir: root,
      usage: { commercial: true },
      target: { format: "vertical", zoom: 1.3 },
    });
    const tracking = calls.filter((call) => call.url.includes("/download"));
    assert.equal(tracking.length, 1);
    assert.match(tracking[0]!.url, /ixid=/, "tracking keeps the ixid parameter");
    assert.equal(tracking[0]!.headers.Authorization, "Client-ID unsplash-key");
    const image = calls.find((call) => call.url.startsWith("https://images.unsplash.com/"))!;
    const download = new URL(image.url);
    assert.equal(download.searchParams.get("ixid"), "M3wxfDB8MXxzZWFyY2g");
    assert.equal(
      download.searchParams.get("w"),
      "1664",
      "a 4000x6000 portrait resized so its 9:16 crop is 1080 x 1.3 wide",
    );
    assert.equal(download.searchParams.get("fit"), "max");
    assert.ok(calls.indexOf(tracking[0]!) < calls.indexOf(image), "reported before the bytes are fetched");
    const receipt = JSON.parse(readFileSync(result.resourceReceipt, "utf8"));
    assert.equal(receipt.tracking.status, "reported");
    assert.equal(receipt.tracking.endpoint, "https://api.unsplash.com/photos/abc123/download");
    assert.deepEqual(receipt.target, { format: "vertical", zoom: 1.3 });
    assert.match(receipt.resource.rights.attributionText, /Jane Doe/, "the receipt always keeps the creator");
    assert.equal(result.asset.rights.attribution, undefined, "no credit requested, none in the asset record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed download tracking stops the acquisition before any bytes", async () => {
  const { root } = projectRoot();
  try {
    const calls: Call[] = [];
    const { fetch } = routedFetch(
      [
        ["photos/abc123/download", json({ errors: ["nope"] }, {}, 500)],
        ["search/photos", { results: [unsplashPhoto()] }],
        ["images.unsplash.com", PNG],
      ],
      calls,
    );
    const unsplash = service(fetch);
    const [photo] = await unsplash.search("unsplash", { query: "latte", kind: "image" });
    await assert.rejects(() => unsplash.acquire(photo!, { projectId: "demo", rootDir: root, usage: {} }));
    assert.equal(calls.filter((call) => call.url.startsWith("https://images.unsplash.com/")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a photo too small for the frame is refused unless upscale is allowed", async () => {
  const { root } = projectRoot();
  try {
    const small = unsplashPhoto({ width: 800, height: 1200 });
    const { fetch } = routedFetch([
      ["photos/abc123/download", { url: "x" }],
      ["search/photos", { results: [small] }],
      ["images.unsplash.com", PNG],
    ]);
    const unsplash = service(fetch);
    const [photo] = await unsplash.search("unsplash", { query: "latte", kind: "image" });
    await assert.rejects(
      () =>
        unsplash.acquire(photo!, {
          projectId: "demo",
          rootDir: root,
          usage: {},
          target: { format: "vertical", zoom: 1.5 },
        }),
      /enlargement/,
    );
    await unsplash.acquire(photo!, {
      projectId: "demo",
      rootDir: root,
      usage: {},
      target: { format: "vertical", zoom: 1.5 },
      allowUpscale: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("referral links replace rather than duplicate utm parameters", () => {
  const once = withReferral("https://unsplash.com/@jane?utm_source=other");
  assert.equal(new URL(withReferral(once)).searchParams.getAll("utm_source").length, 1);
  assert.equal(new URL(once).searchParams.get("utm_source"), UNSPLASH_UTM_SOURCE);
});
