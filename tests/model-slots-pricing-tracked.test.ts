import "./helpers/tracked-prices";
import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadModelSlots, MODEL_SLOTS_FILE, pickModel, slotCatalogs } from "../src/lib/models/model-slots";

// Deliberate tracked-table regression gate; all other price behaviour uses isolated fixtures.
process.env.AGENTBROS_FAL_PRICES = path.resolve(import.meta.dirname, "../src/lib/models/fal-prices.json");
process.env.AGENTBROS_FAL_HISTORICAL_PRICES = path.resolve(
  import.meta.dirname,
  "../src/lib/models/fal-historical-prices.json",
);
const slots = loadModelSlots(MODEL_SLOTS_FILE),
  catalogs = slotCatalogs();
const now = new Date("2026-11-15T00:00:00Z");

test("active tracked candidate unknown coverage cannot regress, and every unknown has a documented cause", () => {
  const counts: Record<string, number> = {};
  for (const slot of slots.slots) {
    assert.ok(slot.reference, `${slot.id} needs an explicit reference setting`);
    for (const candidate of slot.candidates.filter((c) => c.status === "active")) {
      const result = pickModel(
        { slot: slot.id, model: candidate.endpoint, provider: candidate.provider },
        { slots, catalogs, now },
      );
      const price = result.userPin!.price;
      counts[price.kind] = (counts[price.kind] ?? 0) + 1;
      assert.ok(
        candidate.evidence.some((evidence) => evidence.kind === "docs"),
        `${slot.id}/${candidate.endpoint}: missing source documentation`,
      );
      if (price.kind === "unknown") {
        assert.equal(price.usd, null, `${candidate.endpoint}: unknown price cannot become a numeric quote`);
        assert.ok(price.label.trim().length > 0, `${candidate.endpoint}: missing unknown-price explanation`);
      }
    }
  }
  // S5 adds active specialist/draft candidates whose processing usage remains unbounded.
  assert.ok((counts.unknown ?? 0) <= 18, JSON.stringify(counts));
});

test("tracked photo-motion probes respect $3/$0.30 and warn about source aspect", () => {
  const deps = { slots, catalogs, now };
  const result = pickModel({ task: "видео из фото 9:16 5 секунд", maxUsd: 3 }, deps);
  assert.equal(result.pick?.endpoint, "bytedance/seedance-2.5/image-to-video");
  assert.equal(result.pick?.provider, "higgsfield");
  assert.equal(result.pick?.price.usd, 1.3235); // exact Higgsfield beats fal ≈$2.43
  assert.equal(pickModel({ task: "видео из фото 9:16 5 секунд", maxUsd: 0.3 }, deps).pick, null);
  const kling = pickModel(
    {
      slot: "video.image-to-video",
      model: "fal-ai/kling-video/v3/standard/image-to-video",
      provider: "fal",
      aspect: "9:16",
      maxUsd: 1,
    },
    deps,
  );
  assert.ok(kling.pick, JSON.stringify(kling.userPin?.rejectedBecause));
  assert.ok(kling.pick.warnings.some((w) => w.includes("aspect follows the input")));
});
