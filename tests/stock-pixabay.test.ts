import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceService } from "../src/lib/resources/service";
import { evaluateResourceUsage } from "../src/lib/resources/rights";
import {
  PNG,
  TIME,
  TIME_MS,
  projectRoot,
  pixabayImage,
  pixabayVideo,
  routedFetch,
  type Call,
} from "./helpers/stock-fixtures";

function service(fetch: typeof globalThis.fetch, options: { cacheDir?: string; nowMs?: () => number } = {}) {
  return new ResourceService({
    fetch,
    credentials: { pixabay: "pixabay-secret" },
    now: () => TIME,
    nowMs: options.nowMs ?? (() => TIME_MS),
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
  });
}

test("Pixabay image search maps filters, format minimums and page bounds", async () => {
  const calls: Call[] = [];
  const { fetch } = routedFetch([["pixabay.com/api/?", { totalHits: 1, hits: [pixabayImage()] }]], calls);
  const [image] = await service(fetch).search("pixabay", {
    query: "coffee latte",
    kind: "image",
    limit: 1,
    stock: {
      format: "vertical",
      zoom: 1.2,
      color: "teal",
      safe: true,
      editorsChoice: true,
      category: "food",
      imageType: "illustration",
      order: "latest",
      lang: "ru",
    },
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("q"), "coffee latte");
  assert.equal(url.searchParams.get("orientation"), "vertical", "format implies orientation");
  assert.equal(url.searchParams.get("colors"), "turquoise");
  assert.equal(url.searchParams.get("safesearch"), "true");
  assert.equal(url.searchParams.get("editors_choice"), "true");
  assert.equal(url.searchParams.get("category"), "food");
  assert.equal(url.searchParams.get("image_type"), "illustration");
  assert.equal(url.searchParams.get("order"), "latest");
  assert.equal(url.searchParams.get("lang"), "ru");
  assert.equal(url.searchParams.get("per_page"), "3", "Pixabay needs at least 3 per page");
  assert.equal(url.searchParams.get("min_width"), "864", "1080 x 1.2 / 1.5");
  assert.equal(url.searchParams.get("min_height"), "1536", "1920 x 1.2 / 1.5");
  assert.equal(url.searchParams.get("key"), "pixabay-secret");
  assert.equal(image!.id, "pixabay:photo:195893");
  assert.equal(image!.authorId, "48777");
  assert.equal(image!.authorUrl, "https://pixabay.com/users/Josch13-48777/");
  assert.deepEqual(image!.media, { width: 853, height: 1280 }, "honest size of the largest free file");
  assert.equal(image!.downloadUrl, "https://pixabay.com/get/coffee_1280.jpg");
  assert.match(image!.cost.quotaNote!, /1280px without approved full API access \(original 4000x6000\)/);
  assert.deepEqual(image!.tags, ["coffee", "latte", "cafe"]);
});

test("full API access exposes the original still", async () => {
  const { fetch } = routedFetch([
    ["pixabay.com/api/?", { hits: [pixabayImage({ imageURL: "https://pixabay.com/get/coffee_original.jpg" })] }],
  ]);
  const [image] = await service(fetch).search("pixabay", { query: "coffee", kind: "image" });
  assert.deepEqual(image!.media, { width: 4000, height: 6000 });
  assert.equal(image!.downloadUrl, "https://pixabay.com/get/coffee_original.jpg");
  assert.equal(image!.renditions!.length, 2);
});

test("square has no Pixabay filter and is reported; long queries are refused", async () => {
  const calls: Call[] = [];
  const { fetch } = routedFetch([["pixabay.com/api/", { hits: [] }]], calls);
  const result = await service(fetch).stock.search(["pixabay"], {
    query: "x",
    kind: "image",
    filters: { orientation: "square" },
  });
  assert.equal(new URL(calls[0]!.url).searchParams.has("orientation"), false);
  assert.match(result.providers.pixabay!.notes!.join(" "), /no square filter/);
  await assert.rejects(
    () => service(fetch).search("pixabay", { query: "x".repeat(101), kind: "image" }),
    /100 characters/,
  );
});

test("video search keeps every available size and skips the empty 4K slot", async () => {
  const calls: Call[] = [];
  const { fetch } = routedFetch([["pixabay.com/api/videos/", { hits: [pixabayVideo()] }]], calls);
  const [video] = await service(fetch).search("pixabay", {
    query: "pour",
    kind: "video",
    stock: { videoType: "film", color: "red" },
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/videos/");
  assert.equal(url.searchParams.get("video_type"), "film");
  assert.equal(url.searchParams.has("colors"), false, "no colour filter for video");
  assert.deepEqual(
    video!.renditions!.map((item) => item.label),
    ["medium", "small", "tiny"],
  );
  assert.deepEqual(video!.media, { width: 1920, height: 1080, durationSec: 12 });
  assert.equal(video!.previewUrl, "https://cdn.pixabay.com/video/125/tiny.jpg");
});

test("acquire picks the smallest video that fills the frame, else the largest", async () => {
  const { root } = projectRoot();
  try {
    const calls: Call[] = [];
    const { fetch } = routedFetch(
      [
        ["pixabay.com/api/videos/", { hits: [pixabayVideo()] }],
        ["cdn.pixabay.com/video", PNG],
      ],
      calls,
    );
    const pixabay = service(fetch);
    const [video] = await pixabay.search("pixabay", { query: "pour", kind: "video" });
    await pixabay.acquire(video!, { projectId: "demo", rootDir: root, usage: {}, target: { format: "landscape" } });
    assert.equal(calls.at(-1)!.url, "https://cdn.pixabay.com/video/125/medium.mp4");
    const receipt = JSON.parse(
      readFileSync(
        path.join(
          root,
          "public/projects/demo/pipeline/resources",
          readdirSync(path.join(root, "public/projects/demo/pipeline/resources"))[0]!,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(receipt.delivered, { width: 1920, height: 1080 });
    assert.equal(receipt.tracking, undefined, "Pixabay has no download reporting");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pixabay responses are cached for 24 hours and the key never reaches disk", async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "pixabay-cache-"));
  try {
    let now = TIME_MS;
    const calls: Call[] = [];
    const { fetch } = routedFetch([["pixabay.com/api/", { hits: [pixabayImage()] }]], calls);
    const first = service(fetch, { cacheDir, nowMs: () => now });
    await first.search("pixabay", { query: "coffee", kind: "image" });
    now += 23 * 60 * 60_000;
    await service(fetch, { cacheDir, nowMs: () => now }).search("pixabay", { query: "coffee", kind: "image" });
    assert.equal(calls.length, 1, "a new process reuses the disk cache within 24 h");
    now += 2 * 60 * 60_000;
    await service(fetch, { cacheDir, nowMs: () => now }).search("pixabay", { query: "coffee", kind: "image" });
    assert.equal(calls.length, 2, "stale after 24 h");
    for (const name of readdirSync(path.join(cacheDir, "pixabay")))
      assert.doesNotMatch(readFileSync(path.join(cacheDir, "pixabay", name), "utf8"), /pixabay-secret/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("Pixabay licence needs no credit and blocks standalone resale", async () => {
  const { fetch } = routedFetch([["pixabay.com/api/", { hits: [pixabayImage()] }]]);
  const [image] = await service(fetch).search("pixabay", { query: "coffee", kind: "image" });
  assert.equal(image!.rights.licence, "Pixabay");
  assert.equal(image!.rights.attributionRequired, false);
  assert.match(image!.rights.attributionText, /^Image by Josch13 .* via Pixabay/);
  assert.ok(image!.rights.restrictions.some((item) => /trademarks/.test(item)));
  assert.equal(evaluateResourceUsage(image!, { commercial: true, advertising: true }).allowed, true);
  assert.equal(evaluateResourceUsage(image!, { standaloneResale: true }).allowed, false);
});

test("author follows a Pixabay user id locally; inspect fetches by id", async () => {
  const calls: Call[] = [];
  const { fetch } = routedFetch(
    [
      ["id=195893", { hits: [pixabayImage()] }],
      [
        "pixabay.com/api/?",
        { hits: [pixabayImage(), pixabayImage({ id: 7, user_id: 99, pageURL: "https://pixabay.com/photos/x-7/" })] },
      ],
    ],
    calls,
  );
  const pixabay = service(fetch);
  const found = await pixabay.search("pixabay", { query: "coffee", kind: "image", stock: { author: "99" } });
  assert.deepEqual(
    found.map((item) => item.id),
    ["pixabay:photo:7"],
  );
  const inspected = await pixabay.inspect({ ...found[0]!, id: "pixabay:photo:195893" });
  assert.equal(inspected.id, "pixabay:photo:195893");
  await assert.rejects(() => pixabay.inspect({ ...found[0]!, id: "pixabay:photo:../x" }), /Invalid Pixabay id/);
});

test("Pixabay acquisition re-reads the item, because cached file links expire", async () => {
  const { root } = projectRoot();
  try {
    const calls: Call[] = [];
    const { fetch } = routedFetch(
      [
        ["id=195893", { hits: [pixabayImage({ largeImageURL: "https://pixabay.com/get/fresh_1280.jpg" })] }],
        ["pixabay.com/api/", { hits: [pixabayImage()] }],
        ["get/coffee_1280.jpg", new Response("gone", { status: 403 })],
        ["get/fresh_1280.jpg", PNG],
      ],
      calls,
    );
    const pixabay = service(fetch);
    const [image] = await pixabay.search("pixabay", { query: "coffee", kind: "image" });
    assert.equal(image!.downloadUrl, "https://pixabay.com/get/coffee_1280.jpg");
    await pixabay.acquire(image!, { projectId: "demo", rootDir: root, usage: {} });
    assert.equal(calls.at(-1)!.url, "https://pixabay.com/get/fresh_1280.jpg");
    assert.ok(!calls.some((call) => call.url.includes("coffee_1280")), "the stale link is never requested");
    await assert.rejects(
      () => pixabay.acquire({ ...image!, author: "Someone Else" }, { projectId: "demo", rootDir: root, usage: {} }),
      /author or licence changed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
