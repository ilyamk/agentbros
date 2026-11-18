import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fixtures from "./fixtures/provider-contracts/slot-valid.json";
import { buildFalOperation, validateFalOperationResult } from "../src/lib/providers/fal-operations";
import { findProviderEntry } from "../src/lib/models/fal-catalog";
import { publicTariff } from "../src/lib/models/public-tariffs";

process.env.AGENTBROS_FAL_SCHEMA_CACHE = path.resolve(import.meta.dirname, "fixtures/fal-catalog/schemas");
for (const fixture of fixtures)
  test(`offline slot contract ${fixture.request.provider}:${fixture.request.endpoint}`, () => {
    const request = {
      ...fixture.request,
      provider: fixture.request.provider as "fal" | "higgsfield",
      context: { now: "2026-11-15T00:00:00Z" },
    };
    const plan = buildFalOperation(request);
    assert.equal(plan.schemaSha256, fixture.schemaSha256);
    assert.equal(findProviderEntry(request.provider, request.endpoint)?.tier, "verified");
    assert.equal(plan.verification.schema, true);
    assert.equal(plan.verification.live, false);
    assert.throws(
      () => buildFalOperation({ ...request, input: { ...request.input, unsupported_provider_option: true } }),
      /unsupported field/,
    );
    assert.doesNotThrow(() => validateFalOperationResult(request.endpoint, fixture.result, request.provider));
  });

test("GPT 2.6 has only the three independently read public token tariffs", () => {
  for (const operation of ["flare/text-to-image", "flare/edit", "sunburst/edit"]) {
    const tariff = publicTariff(`openai/gpt-image-2.6/${operation}`)!;
    assert.equal(tariff.evidence.observedAsOf, "2026-11-15");
    assert.equal(tariff.pricing.kind, "tokens");
    assert.deepEqual(tariff.pricing, publicTariff(`openai/gpt-image-2.5/${operation}`)?.pricing);
  }
  assert.equal(publicTariff("openai/gpt-image-2.6/sunburst/text-to-image"), undefined);
});
