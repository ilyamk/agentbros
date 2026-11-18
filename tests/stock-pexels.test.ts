import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { ResourceService } from "../src/lib/resources/service";
import { evaluateResourceUsage } from "../src/lib/resources/rights";
import {
  PNG,
  TIME,
  TIME_MS,
  json,
  pexelsPhoto,
  pexelsVideo,
  projectRoot,
  routedFetch,
  type Call,
} from "./helpers/stock-fixtures";

const service = (fetch: typeof globalThis.fetch) =>
  new ResourceService({ fetch, credentials: { pexels: "pexels-key" }, now: () => TIME, nowMs: () => TIME_MS });

test("Pexels photo search sends orientation, colour and locale with the raw key", async () => {
  const calls: Call[] = [];
  const { fetch } = routedFetch([["v1/search", { photos: [pexelsPhoto()] }]], calls);
  const [photo] = await service(fetch).search("pexels", {
    query: "rocks",
    kind: "image",
    stock: { orientation: "landscape", color: "purple", lang: "de" },
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("orientation"), "landscape");
  assert.equal(url.searchParams.get("color"), "violet");
  assert.equal(url.searchParams.get("locale"), "de-DE");
  assert.equal(calls[0]!.headers.Authorization, "pexels-key");
  assert.equal(photo!.id, "pexels:photo:2014422");
  assert.equal(photo!.authorId, "680589");
  assert.equal(photo!.visual?.dominantColor, "#978E82");
  assert.equal(photo!.rights.attributionRequired, false, "the Pexels licence does not require credit");
  assert.match(photo!.rights.attributionText, /Joey Farina/);
});

test("Pexels video keeps non-HLS sizes, largest first, and acquisition picks the frame's size", async () => {
  const { root } = projectRoot();
  try {
    const calls: Call[] = [];
    const { fetch } = routedFetch(
      [
        ["videos/search", { videos: [pexelsVideo()] }],
        ["videos.pexels.com", PNG],
      ],
      calls,
    );
    const pexels = service(fetch);
    const [video] = await pexels.search("pexels", { query: "city", kind: "video" });
    assert.equal(video!.downloadUrl, "https://videos.pexels.com/3/uhd.mp4");
    assert.deepEqual(
      video!.renditions!.map((item) => item.label),
      ["uhd", "hd", "sd"],
    );
    await pexels.acquire(video!, { projectId: "demo", rootDir: root, usage: {}, target: { format: "landscape" } });
    assert.equal(calls.at(-1)!.url, "https://videos.pexels.com/3/hd.mp4", "1080p fills a 1920x1080 frame");
    await pexels.acquire(
      { ...video!, id: "pexels:video:4" },
      { projectId: "demo", rootDir: root, usage: {}, target: { format: "landscape", zoom: 1.5 } },
    );
    assert.equal(calls.at(-1)!.url, "https://videos.pexels.com/3/uhd.mp4", "a push-in needs the 4K file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pexels stills are resized for the frame and never enlarged", async () => {
  const { root } = projectRoot();
  try {
    const calls: Call[] = [];
    const { fetch } = routedFetch(
      [
        ["v1/search", { photos: [pexelsPhoto()] }],
        ["images.pexels.com", PNG],
      ],
      calls,
    );
    const pexels = service(fetch);
    const [photo] = await pexels.search("pexels", { query: "rocks", kind: "image" });
    await pexels.acquire(photo!, { projectId: "demo", rootDir: root, usage: {}, target: { format: "square" } });
    assert.equal(new URL(calls.at(-1)!.url).searchParams.get("w"), "1080");
    await pexels.acquire({ ...photo!, id: "pexels:photo:2" }, { projectId: "demo", rootDir: root, usage: {} });
    assert.equal(calls.at(-1)!.url, photo!.downloadUrl, "no target downloads the original");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pexels rate-limit headers stop the next request before it is sent", async () => {
  const calls: Call[] = [];
  const reset = Math.floor(TIME_MS / 1000) + 600;
  const { fetch } = routedFetch(
    [
      [
        "v1/search",
        () =>
          json(
            { photos: [pexelsPhoto()] },
            { "X-Ratelimit-Limit": "200", "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": String(reset) },
          ),
      ],
    ],
    calls,
  );
  const pexels = service(fetch);
  await pexels.search("pexels", { query: "rocks", kind: "image" });
  await assert.rejects(
    () => pexels.search("pexels", { query: "other", kind: "image" }),
    (error: any) => error.code === "RATE_LIMIT" && error.retryAfterMs === 600_000,
  );
  assert.equal(calls.length, 1);
});

test("Pexels endorsement stays blocked", async () => {
  const { fetch } = routedFetch([["v1/search", { photos: [pexelsPhoto()] }]]);
  const [photo] = await service(fetch).search("pexels", { query: "rocks", kind: "image" });
  assert.match(evaluateResourceUsage(photo!, { endorsement: true }).blockers.join(" "), /Pexels licence forbids/);
});

test("Pexels videos without alt text take their description from the page slug", async () => {
  const { fetch } = routedFetch([
    [
      "videos/search",
      { videos: [pexelsVideo({ url: "https://www.pexels.com/video/close-up-of-coffee-being-poured-6950167/" })] },
    ],
  ]);
  const [video] = await service(fetch).search("pexels", { query: "coffee", kind: "video" });
  assert.equal(video!.title, "close up of coffee being poured");
});
