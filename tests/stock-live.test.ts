/**
 * Live stock checks against the real APIs, gated by RUN_STOCK_LIVE_TESTS=1 and the keys in .env.
 * Cost: about 4 Unsplash requests (of 50/hour in demo), 2 Pixabay and 2 Pexels; no paid service.
 * Each provider is skipped, and reported as skipped, when its key is absent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { ResourceService } from "../src/lib/resources/service";
import { projectRoot } from "./helpers/stock-fixtures";

const live = ["1", "true"].includes(process.env.RUN_STOCK_LIVE_TESTS ?? "");
if (live && existsSync(".env")) process.loadEnvFile(".env");
const keys = {
  unsplash: process.env.UNSPLASH_ACCESS_KEY,
  pixabay: process.env.PIXABAY_API_KEY,
  pexels: process.env.PEXELS_API_KEY,
};
const skip = (key: string | undefined, name: string) =>
  !live ? "set RUN_STOCK_LIVE_TESTS=1" : !key ? `${name} not set` : false;
// Memory-only cache, so live answers never come from an earlier run.
const service = () => new ResourceService({ credentials: keys, cacheDir: false });

test(
  "live Unsplash: search, inspect and a tracked frame-sized download",
  { skip: skip(keys.unsplash, "UNSPLASH_ACCESS_KEY") },
  async () => {
    const unsplash = service();
    const found = await unsplash.stock.search(["unsplash"], {
      query: "barista pouring latte",
      kind: "image",
      limit: 5,
      filters: { format: "vertical", zoom: 1.3, color: "brown", safe: true },
    });
    assert.equal(found.providers.unsplash!.status, "ok");
    const best = found.results.find((item) => !item.blocked)!;
    assert.ok(best, "a photo fills a vertical frame");
    assert.match(best.candidate.sourceUrl, /utm_source=/);
    assert.ok(best.candidate.tracking?.downloadLocation);
    const inspected = await unsplash.inspect(best.candidate);
    assert.equal(inspected.id, best.candidate.id);
    const { root } = projectRoot();
    try {
      const result = await unsplash.acquire(inspected, {
        projectId: "demo",
        rootDir: root,
        usage: { credit: true },
        target: { format: "vertical", zoom: 1.3 },
      });
      const receipt = JSON.parse(readFileSync(result.resourceReceipt, "utf8"));
      assert.equal(receipt.tracking.status, "reported");
      assert.ok(result.asset.media && (result.asset.media.width ?? 0) >= 900);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("live Pixabay: photo and video search", { skip: skip(keys.pixabay, "PIXABAY_API_KEY") }, async () => {
  const pixabay = service();
  const photos = await pixabay.search("pixabay", { query: "coffee", kind: "image", limit: 3 });
  assert.ok(photos.length > 0 && photos.every((item) => item.rights.licence === "Pixabay"));
  const videos = await pixabay.search("pixabay", { query: "coffee", kind: "video", limit: 3 });
  assert.ok(videos.every((item) => (item.renditions ?? []).length > 0));
});

test("live Pexels: photo and video search", { skip: skip(keys.pexels, "PEXELS_API_KEY") }, async () => {
  const pexels = service();
  assert.ok((await pexels.search("pexels", { query: "coffee", kind: "image", limit: 3 })).length > 0);
  assert.ok((await pexels.search("pexels", { query: "coffee", kind: "video", limit: 3 })).length > 0);
});
