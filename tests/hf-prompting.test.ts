import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseHiggsfieldWorkflowPage } from "../src/lib/models/hf-docs";
import { snapshotFromHiggsfieldDoc } from "../src/lib/models/fal-catalog";
import { validateJsonSchema } from "../src/lib/providers/json-schema-validate";
import { FalEndpointRequestSchema } from "../src/types/generation";
import { buildFalOperation } from "../src/lib/providers/fal-operations";
import { HF_PRICES_FILE, loadHiggsfieldPrices } from "../src/lib/models/hf-pricing";

const guide = readFileSync("docs/higgsfield-prompting.md", "utf8");

test("prompting price evidence table matches every tracked workflow record", () => {
  const prices = loadHiggsfieldPrices(HF_PRICES_FILE);
  for (const endpoint of examples.map((example) => example.endpoint)) {
    const record = prices.get(endpoint);
    const kind = !record
      ? "No record"
      : record.tiers.length
        ? record.tiers.some((tier) => tier.approximate)
          ? "Approximate tariff"
          : "Parsed tariff"
        : record.estimates.some((row) => row.type === "estimate" && row.usd !== undefined)
          ? "Request-specific estimates"
          : "Unresolved price";
    assert.ok(guide.includes(`| \`${endpoint}\` | ${kind} |`), `${endpoint}: ${kind}`);
  }
  for (const stale of [
    "No restyle price record",
    "Neither endpoint has a price record",
    "No workflow has a price record",
    "no Ads Studio record",
    "other four workflows have no tracked price records",
  ])
    assert.ok(!guide.includes(stale), stale);
});
const fixtures = path.resolve("tests/fixtures/higgsfield/docs");
const docs = readdirSync(fixtures).flatMap((name) => {
  const doc = parseHiggsfieldWorkflowPage(
    readFileSync(path.join(fixtures, name), "utf8"),
    `https://docs.higgsfield.ai/docs/${name.replaceAll("_", "/")}`,
  );
  return doc ? [doc] : [];
});
const examples = [...guide.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((match) =>
  FalEndpointRequestSchema.parse(JSON.parse(match[1]!)),
);

test("prompting guide supplies examples for every documented workflow it covers", () => {
  assert.deepEqual(
    examples.map((example) => example.endpoint).sort(),
    [
      "higgsfield/genjutsu/motion-transfer/v1.0",
      "higgsfield/genjutsu/object-swap/v1.0",
      "higgsfield/genjutsu/restyle/v1.0",
      "higgsfield-ai/soul/v2/standard",
      "higgsfield-ai/soul/cinema",
      "higgsfield-ai/soul/standard",
      "v1/custom-references",
      "marketing-studio/image/flare",
      "marketing-studio/image/sunburst",
      "marketing-studio/image",
      "higgsfield/ads-studio/v1.0",
      "higgsfield/cinema-studio/4.0",
      ...["text-to-video", "image-to-video", "reference-to-video", "video-edit", "video-extend"].map(
        (name) => `bytedance/seedance-2.5/${name}`,
      ),
    ].sort(),
  );
});
for (const request of examples) {
  test(`guide JSON validates offline against recorded schema and guards: ${request.endpoint}`, () => {
    assert.equal(request.provider, "higgsfield");
    const doc = docs.find((doc) => doc.endpoint === request.endpoint);
    assert.ok(doc, "Every JSON example must have a real documented schema");
    const snapshot = snapshotFromHiggsfieldDoc({ ...doc, version: 1, asOf: "2026-11-15" });
    validateJsonSchema(snapshot.input, request.input, { components: snapshot.schemas, at: "input", strict: true });
    assert.equal(buildFalOperation(request).verification.schema, true);
  });
}
test("guide requires consent/rights and discloses unavailable contracts and moderation", () => {
  for (const text of [
    "entity:card",
    "film:rights",
    "entity-workflow.md",
    "production-chain.md",
    "nsfw",
    "refunded terminal",
    "Genjutsu Light",
    "AI Influencer",
    "Kling 4.0",
    "no documented prompting guidance",
  ])
    assert.ok(guide.toLowerCase().includes(text.toLowerCase()), text);
  assert.ok(!/uncensored|bypass(?:es|ing)? moderation/i.test(guide));
  assert.ok(guide.includes("replica-only contract"));
  for (const token of [
    "@Video1",
    "@Image1",
    "model:prepare",
    "motion:library",
    "source-use",
    "house prompt convention",
  ])
    assert.ok(guide.includes(token), token);
});
