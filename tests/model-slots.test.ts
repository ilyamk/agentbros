import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { catalogEntry, useTempFalCatalog } from "./helpers/fal-temp-catalog";
import {
  ModelSlotsFileSchema,
  ModelPreferencesSchema,
  ModelVerdictSchema,
  type ModelSlotCandidate,
} from "../src/types/model-slots";
import {
  checkModelSlots,
  loadModelSlots,
  MODEL_SLOTS_FILE,
  pickModel,
  classFallbackOrder,
  resolveTaskSlot,
  type PickDependencies,
} from "../src/lib/models/model-slots";
import { editModelSlot, renderModelSlotsDoc } from "../src/lib/models/model-slots-maintenance";
import type { FalCatalogEntry, ModelChoicePrice } from "../src/types/fal-catalog";
import { findFalEndpointResult } from "../src/lib/models/fal-find";
import { CATALOG_DIR, HF_CATALOG_DIR, loadCatalog } from "../src/lib/models/fal-catalog";
import { checkModelConstraints } from "../src/lib/models/model-constraints";

const now = new Date("2026-11-15T00:00:00Z");
const fixture = path.resolve(import.meta.dirname, "fixtures/model-slots/minimal.json");
const minimal = () => loadModelSlots(fixture);
const candidate = (endpoint: string, overrides: Partial<ModelSlotCandidate> = {}): ModelSlotCandidate => ({
  provider: "fal",
  endpoint,
  class: "hero",
  order: 1,
  status: "active",
  why: "Fixture quality judgement",
  evidence: [{ kind: "owner", text: "Fixture verdict", source: "owner", date: "2026-11-15" }],
  addedAt: "2026-11-15",
  ...overrides,
});
const entry = (endpoint: string, patch: Partial<FalCatalogEntry> = {}) =>
  catalogEntry("fal-ai/flux/schnell", {
    endpoint,
    tier: "verified",
    outputs: { kinds: ["image"], fields: [] },
    ...patch,
  });
const price = (usd: number | null): ModelChoicePrice => ({
  kind: usd === null ? "unknown" : "exact",
  label: "fixture",
  usd,
  unitPrice: usd,
  unit: "request",
  asOf: "2026-11-15",
  evidenceKind: "fixture",
  basis: "request",
});
function setup(
  candidates: ModelSlotCandidate[],
  entries = candidates.map((c) => entry(c.endpoint, { provider: c.provider })),
  amounts = candidates.map(() => 1),
) {
  const slots = minimal();
  slots.slots[0]!.candidates = candidates;
  const deps: PickDependencies = {
    slots,
    catalogs: {
      fal: new Map(entries.filter((e) => (e.provider ?? "fal") === "fal").map((e) => [e.endpoint, e])),
      higgsfield: new Map(entries.filter((e) => e.provider === "higgsfield").map((e) => [e.endpoint, e])),
    },
    prices: new Map(candidates.map((c, index) => [`${c.provider}:${c.endpoint}`, price(amounts[index] ?? null)])),
    now,
  };
  return deps;
}
const pick = (deps: PickDependencies, query: Omit<Parameters<typeof pickModel>[0], "slot"> = {}) =>
  pickModel({ slot: "image.generate", ...query }, deps);

test("strict schemas reject duplicates, unknown fields, raw Elo, invalid estimates and verdicts", () => {
  const file = minimal();
  file.slots[0]!.candidates = [candidate("test/a"), candidate("test/b")];
  assert.equal(ModelSlotsFileSchema.safeParse(file).success, false);
  file.slots[0]!.candidates[1]!.order = 2;
  assert.equal(ModelSlotsFileSchema.safeParse(file).success, true);
  for (const patch of [{ version: 2 }, { extra: true }, { updatedAt: "tomorrow" }])
    assert.equal(ModelSlotsFileSchema.safeParse({ ...file, ...patch }).success, false);
  assert.equal(ModelSlotsFileSchema.safeParse({ ...file, slots: [...file.slots, ...file.slots] }).success, false);
  const c = file.slots[0]!.candidates[0]!;
  assert.equal(
    ModelSlotsFileSchema.safeParse({
      ...file,
      slots: [
        {
          ...file.slots[0],
          candidates: [
            {
              ...c,
              evidence: [
                {
                  kind: "arena",
                  rank: 1,
                  value: 1200,
                  source: "AA",
                  url: "https://artificialanalysis.ai/",
                  observedAt: "2026-11-15",
                },
              ],
            },
          ],
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    ModelPreferencesSchema.safeParse({ version: 1, pins: [], avoid: [], defaultClass: "fast" }).success,
    false,
  );
  assert.equal(
    ModelVerdictSchema.safeParse({
      version: 1,
      operationId: "op",
      verdict: "accepted",
      at: now.toISOString(),
      costUsd: 1,
    }).success,
    false,
  );
});

test("loader honours override and rereads atomic edits without a cache", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slots-loader-")),
    target = path.join(dir, "slots.json"),
    before = process.env.AGENTBROS_MODEL_SLOTS;
  try {
    const file = minimal();
    writeFileSync(target, JSON.stringify(file));
    process.env.AGENTBROS_MODEL_SLOTS = target;
    assert.deepEqual(loadModelSlots(), file);
    file.updatedAt = "2026-11-16";
    writeFileSync(target, JSON.stringify(file));
    assert.equal(loadModelSlots().updatedAt, "2026-11-16");
    writeFileSync(target, "{}");
    assert.throws(() => loadModelSlots());
  } finally {
    if (before === undefined) delete process.env.AGENTBROS_MODEL_SLOTS;
    else process.env.AGENTBROS_MODEL_SLOTS = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check rules: evidence, schema, hero, coverage, overdue, missing/gone, price sanity", () => {
  const deps = setup(
    [candidate("test/a", { evidence: [] }), candidate("test/b", { class: "budget", order: 2 })],
    [entry("test/a", { schema: null, tier: "discovered" }), entry("test/b", { status: "gone" })],
  );
  deps.slots!.slots[0]!.reviewBy = "2026-11-14";
  const report = checkModelSlots(deps.slots!, deps.catalogs, deps.prices, now);
  assert.ok(report.errors.some((s) => s.includes("schema missing")));
  assert.ok(report.errors.some((s) => s.includes("needs evidence")));
  assert.ok(report.errors.some((s) => s.includes("missing or gone")));
  assert.ok(report.errors.some((s) => s.includes("Unmapped production concept")));
  assert.ok(report.warnings.some((s) => s.includes("overdue")));
  const cost = setup([candidate("test/a"), candidate("test/b", { class: "budget", order: 2 })], undefined, [1, 2]);
  assert.ok(checkModelSlots(cost.slots!, cost.catalogs, cost.prices, now).warnings.some((s) => s.includes("pricier")));
  cost.slots!.slots[0]!.candidates[0]!.status = "retired";
  assert.ok(
    checkModelSlots(cost.slots!, cost.catalogs, cost.prices, now).errors.some((s) => s.includes("active hero")),
  );
});

test("check rejects a per-image reference estimate on a slot without image output", () => {
  const deps = setup([
    candidate("test/a", {
      referenceEstimate: {
        usd: 0.01,
        per: "image",
        setting: "1 image",
        source: "https://fal.ai/pricing",
        observedAsOf: "2026-11-15",
      },
    }),
  ]);
  assert.ok(
    !checkModelSlots(deps.slots!, deps.catalogs, deps.prices, now).errors.some((s) =>
      s.includes("per-image referenceEstimate"),
    ),
  );
  deps.slots!.slots[0]!.outputs = ["video"];
  assert.ok(
    checkModelSlots(deps.slots!, deps.catalogs, deps.prices, now).errors.some((s) =>
      s.includes("per-image referenceEstimate on a non-image slot"),
    ),
  );
});

test("class fallback follows A2, within-class order and first passing choice", () => {
  assert.deepEqual(classFallbackOrder("budget"), ["budget", "draft", "balanced", "hero"]);
  assert.deepEqual(classFallbackOrder("balanced"), ["balanced", "budget", "draft", "hero"]);
  assert.deepEqual(classFallbackOrder("draft"), ["draft", "budget", "balanced", "hero"]);
  const deps = setup(
    [
      candidate("test/hero"),
      candidate("test/balanced", { class: "balanced", order: 2 }),
      candidate("test/budget", { class: "budget", order: 3 }),
      candidate("test/draft", { class: "draft", order: 4 }),
    ],
    undefined,
    [4, 3, 2, 1],
  );
  assert.equal(pick(deps, { class: "budget" }).pick?.endpoint, "test/budget");
  assert.equal(pick(deps, { class: "budget", maxUsd: 1 }).pick?.endpoint, "test/draft");
  deps.slots!.slots[0]!.candidates[2]!.status = "retired";
  deps.slots!.slots[0]!.candidates[3]!.status = "candidate";
  assert.equal(pick(deps, { class: "budget", maxUsd: 3 }).pick?.endpoint, "test/balanced");
  assert.equal(pick(deps, { class: "budget", maxUsd: 2 }).pick, null);
});

test("quality mapping and class precedence", () => {
  const deps = setup([
    candidate("test/hero"),
    candidate("test/balanced", { class: "balanced", order: 2 }),
    candidate("test/budget", { class: "budget", order: 3 }),
  ]);
  assert.equal(pick({ ...deps, qualityTier: "fast" }).pick?.class, "budget");
  assert.equal(pick({ ...deps, qualityTier: "balanced" }).pick?.class, "balanced");
  assert.equal(pick({ ...deps, qualityTier: "quality" }).pick?.class, "hero");
  const preferences = { version: 1 as const, pins: [], avoid: [], defaultClass: "balanced" as const };
  assert.equal(pick({ ...deps, qualityTier: "fast", preferences }).requestedClass, "balanced");
  assert.equal(pick({ ...deps, preferences }, { class: "draft" }).requestedClass, "draft");
});

test("budget accepts bounded and approximate, rejects unknown unless explicit, estimates scale by seconds", () => {
  const deps = setup([candidate("test/a")]);
  deps.prices = new Map([["fal:test/a", price(null)]]);
  assert.equal(pick(deps, { maxUsd: 1 }).pick, null);
  assert.equal(pick(deps, { maxUsd: 1, allowUnknownPrice: true }).pick?.price.kind, "unknown");
  deps.slots!.slots[0]!.candidates[0]!.referenceEstimate = {
    usd: 0.2,
    per: "second",
    setting: "fixture source setting",
    source: "https://example.com/price",
    observedAsOf: "2026-11-15",
  };
  const audio = entry("test/a", { category: "text-to-speech", outputs: { kinds: ["audio"], fields: [] } });
  deps.catalogs = { fal: new Map([[audio.endpoint, audio]]) };
  deps.slots!.slots[0]!.categories = ["text-to-speech"];
  deps.slots!.slots[0]!.outputs = ["audio"];
  const result = pick(deps, { maxUsd: 1, durationSec: 5 });
  assert.equal(result.pick?.price.kind, "approximate");
  assert.equal(result.pick?.price.usd, 1);
  assert.ok(result.pick?.warnings.some((s) => s.includes("authoritative")));
  assert.equal(pick(deps, { maxUsd: 0.9, durationSec: 5 }).pick, null);
  deps.prices = new Map([["fal:test/a", price(0.1)]]);
  assert.equal(pick(deps, { maxUsd: 1, durationSec: 5 }).pick?.price.kind, "exact");
});

test("explicit user pin passes or reports failure and best alternative without substitution", () => {
  const deps = setup([candidate("test/a"), candidate("test/b", { order: 2 })], undefined, [2, 1]);
  assert.equal(pick(deps, { model: "test/b", provider: "fal" }).pick?.endpoint, "test/b");
  const failed = pick(deps, { model: "test/a", provider: "fal", maxUsd: 1 });
  assert.equal(failed.pick, null);
  assert.equal(failed.pinPassed, false);
  assert.equal(failed.userPin?.endpoint, "test/a");
  assert.equal(failed.bestAlternative?.endpoint, "test/b");
  assert.ok(failed.userPin?.rejectedBecause.length);
  assert.equal(pick(deps, { model: "missing/id", provider: "fal" }).pinPassed, false);
});

test("project pins go first and project avoid remains authoritative", () => {
  const deps = setup([candidate("test/a"), candidate("test/b", { class: "draft", order: 2 })]);
  deps.preferences = {
    version: 1,
    pins: [
      {
        slot: "image.generate",
        provider: "fal",
        endpoint: "test/b",
        reason: "project preference",
        at: now.toISOString(),
      },
    ],
    avoid: [],
  };
  assert.equal(pick(deps).pick?.endpoint, "test/b");
  deps.preferences.avoid = [{ slot: "image.generate", provider: "fal", endpoint: "test/b" }];
  assert.equal(pick(deps).pick?.endpoint, "test/a");
  assert.equal(pick(deps, { model: "test/b", provider: "fal" }).pinPassed, false);
});

test("equivalent models choose cheaper provider and report both without comparing unknowns", () => {
  const deps = setup(
    [candidate("test/same"), candidate("test/same", { provider: "higgsfield", order: 2 })],
    undefined,
    [2, 1],
  );
  const result = pick(deps);
  assert.equal(result.pick?.provider, "higgsfield");
  assert.equal(result.alternatives.length, 0);
  assert.match(JSON.stringify(result.pick), /equivalents/);
  assert.equal(pick(deps, { provider: "fal" }).pick?.provider, "fal");
  assert.equal(pick(deps, { model: "test/same", provider: "fal" }).pick?.provider, "fal");
});

test("constraint checks, retiring rejection/warning and owner evidence trust exception", () => {
  const deps = setup(
    [candidate("test/a")],
    [entry("test/a", { inputs: [{ name: "aspect_ratio", type: "string", required: false, enum: ["16:9"] }] })],
  );
  assert.equal(pick(deps, { aspect: "9:16" }).pick, null);
  assert.equal(pick(deps, { inputs: ["image"] }).pick, null);
  assert.ok(
    pick(deps, { durationSec: 10 }).rejected[0]?.rejectedBecause.some((s) => s.includes("unsupported duration")),
  );
  deps.catalogs!.fal!.get("test/a")!.retiresAt = "2026-12-01";
  assert.ok(pick(deps).rejected[0]?.warnings.some((s) => s.includes("Retires")));
  delete deps.catalogs!.fal!.get("test/a")!.retiresAt;
  deps.catalogs!.fal!.get("test/a")!.tier = "discovered";
  assert.ok(pick(deps).pick?.warnings.includes("unverified contract"));
  deps.slots!.slots[0]!.candidates[0]!.evidence = [];
  assert.equal(pick(deps).pick, null);
});

test("capability end-frame admits endpoints with an end-frame field and rejects the rest", () => {
  const fal = loadCatalog(CATALOG_DIR);
  const hf = loadCatalog(HF_CATALOG_DIR);
  const real = (catalog: ReadonlyMap<string, FalCatalogEntry>, endpoint: string) => {
    const found = catalog.get(endpoint);
    assert.ok(found, `tracked catalogue lacks ${endpoint}`);
    return found;
  };
  const kling = real(fal, "fal-ai/kling-video/v3/pro/image-to-video");
  const draft = real(fal, "blackforestlabs/flux-3/first-last-frame-to-video/draft");
  const hfKling = real(hf, "kling-video/v3.0/pro/image-to-video");
  const none = real(fal, "blackforestlabs/flux-3/image-to-video/draft");
  const check = (item: FalCatalogEntry) =>
    checkModelConstraints(item, {
      categories: [],
      inputs: [],
      outputs: [],
      capabilities: ["end-frame"],
      includeSchemaless: true,
    });
  for (const item of [kling, draft, hfKling]) {
    const result = check(item);
    assert.deepEqual(result.rejectedBecause, [], item.endpoint);
    assert.ok(
      result.reasons.some((reason) => reason.startsWith("Capability end-frame")),
      item.endpoint,
    );
  }
  assert.deepEqual(check(none).rejectedBecause, ["missing capability: end-frame"]);
  const deps = setup(
    [candidate(kling.endpoint), candidate(none.endpoint, { order: 2 })],
    [
      { ...kling, tier: "verified" },
      { ...none, tier: "verified" },
    ],
  );
  const query = { categories: ["image-to-video" as const], outputs: ["video" as const] };
  assert.equal(pick(deps, { ...query, model: none.endpoint, provider: "fal" }).pick?.endpoint, none.endpoint);
  const picked = pick(deps, { ...query, capabilities: ["end-frame"] });
  assert.equal(picked.pick?.endpoint, kling.endpoint);
  assert.deepEqual(picked.pick?.matchedCapabilities, [{ capability: "end-frame", field: "end_image_url" }]);
  const failed = pick(deps, { ...query, model: none.endpoint, provider: "fal", capabilities: ["end-frame"] });
  assert.equal(failed.pinPassed, false);
  assert.ok(failed.userPin?.rejectedBecause.includes("missing capability: end-frame"));
});

test("catalogue fallback is labelled, respects budget, and task misses stay unmatched", () => {
  const deps = setup([], [entry("test/fallback")]);
  deps.prices = new Map([["fal:test/fallback", price(1)]]);
  const result = pick(deps, { maxUsd: 1 });
  assert.equal(result.pick?.endpoint, "test/fallback");
  assert.match(JSON.stringify(result.pick), /"fromCatalogue":true/);
  assert.ok(result.pick?.warnings.includes("not in the slot table"));
  assert.equal(pick(deps, { maxUsd: 0.5 }).pick, null);
  assert.equal(pickModel({ task: "hello" }, deps).matched, false);
  assert.equal(pickModel({ slot: "unknown.slot" }, deps).matched, false);
  assert.equal(pickModel({ task: "generate image" }, deps).slot, "image.generate");
});

test("task slots use concepts and medium specificity with stable alternatives", () => {
  const file = loadModelSlots(MODEL_SLOTS_FILE);
  assert.equal(resolveTaskSlot("reference to video", file).slot?.id, "video.reference-to-video");
  assert.equal(resolveTaskSlot("upscale video", file).slot?.id, "video.upscale");
  assert.equal(resolveTaskSlot("upscale image", file).slot?.id, "image.upscale");
  assert.equal(resolveTaskSlot("image to 3d", file).slot?.id, "3d.from-image");
  assert.equal(resolveTaskSlot("text to 3d", file).slot?.id, "3d.from-text");
  assert.equal(resolveTaskSlot("replace character in video", file).slot?.id, "video.character-swap");
});

test("maintenance atomically validates edits and refuses gone endpoints, duplicate order and last-hero retirement", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slots-edit-")),
    target = path.join(dir, "slots.json");
  const deps = setup([candidate("test/a"), candidate("test/b", { status: "candidate", class: "budget", order: 2 })]);
  try {
    writeFileSync(target, JSON.stringify(deps.slots));
    const options = { file: target, catalogs: deps.catalogs, now };
    assert.throws(
      () => editModelSlot({ slot: "image.generate", action: "retire", endpoint: "test/a", provider: "fal" }, options),
      /active hero/,
    );
    editModelSlot({ slot: "image.generate", action: "promote", endpoint: "test/b", provider: "fal" }, options);
    assert.equal(loadModelSlots(target).slots[0]!.candidates[1]!.status, "active");
    const before = readFileSync(target, "utf8");
    assert.throws(
      () =>
        editModelSlot(
          { slot: "image.generate", action: "move", endpoint: "test/b", provider: "fal", order: 1 },
          options,
        ),
      /Duplicate/,
    );
    assert.equal(readFileSync(target, "utf8"), before);
    assert.throws(
      () =>
        editModelSlot(
          {
            slot: "image.generate",
            action: "add",
            endpoint: "test/gone",
            provider: "fal",
            class: "hero",
            why: "test",
            evidenceOwner: "test",
          },
          options,
        ),
      /gone/,
    );
    editModelSlot({ slot: "image.generate", action: "review-by", reviewBy: "2027-01-01" }, options);
    assert.equal(loadModelSlots(target).slots[0]!.reviewBy, "2027-01-01");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doc generation is deterministic, sorted, attributed and never exposes raw arena values", () => {
  const deps = setup([
    candidate("test/a", {
      evidence: [
        {
          kind: "arena",
          rank: 1,
          source: "Artificial Analysis",
          url: "https://artificialanalysis.ai/",
          observedAt: "2026-11-15",
        },
      ],
    }),
  ]);
  const doc = renderModelSlotsDoc(deps.slots!);
  assert.equal(doc, renderModelSlotsDoc(structuredClone(deps.slots!)));
  assert.match(doc, /https:\/\/artificialanalysis.ai\//);
  assert.doesNotMatch(doc, /Elo|1200/);
});

test("fal:find slot reasons do not affect rankings", () => {
  const temp = useTempFalCatalog([
    { endpoint: "fal-ai/flux/schnell", patch: { outputs: { kinds: ["image"], fields: [] } } },
  ]);
  assert.ok(temp.catalogDir);
  const before = process.env.AGENTBROS_MODEL_SLOTS,
    dir = mkdtempSync(path.join(tmpdir(), "slots-find-"));
  try {
    const file = minimal(),
      target = path.join(dir, "slots.json");
    writeFileSync(target, JSON.stringify(file));
    process.env.AGENTBROS_MODEL_SLOTS = target;
    const a = findFalEndpointResult({ task: "generate image", provider: "fal" });
    file.slots[0]!.candidates = [candidate("fal-ai/flux/schnell")];
    writeFileSync(target, JSON.stringify(file));
    const b = findFalEndpointResult({ task: "generate image", provider: "fal" });
    assert.deepEqual(
      a.candidates.map((c) => [c.endpoint, c.score]),
      b.candidates.map((c) => [c.endpoint, c.score]),
    );
    assert.ok(b.candidates[0]?.reasons.includes("In slot image.generate as hero (#1)"));
  } finally {
    if (before === undefined) delete process.env.AGENTBROS_MODEL_SLOTS;
    else process.env.AGENTBROS_MODEL_SLOTS = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit pins never revive retired candidates; provider-any pins compare passing equivalent prices", () => {
  const deps = setup([candidate("test/a", { status: "retired" })]);
  assert.equal(pick(deps, { model: "test/a", provider: "fal" }).pick, null);
  const both = setup(
    [candidate("test/same"), candidate("test/same", { provider: "higgsfield", order: 2 })],
    undefined,
    [2, 1],
  );
  const result = pick(both, { model: "test/same", provider: "any" });
  assert.equal(result.pick?.provider, "higgsfield");
  assert.match(JSON.stringify(result.pick), /equivalents/);
});

test("catalogue-only equivalent providers are assessed before budget, without inheriting provider-specific reference estimates", () => {
  const deps = setup(
    [candidate("test/same")],
    [entry("test/same"), entry("test/same", { provider: "higgsfield" })],
    [2],
  );
  deps.prices = new Map([
    ["fal:test/same", price(2)],
    ["higgsfield:test/same", price(0.5)],
  ]);
  assert.equal(pick(deps, { maxUsd: 1 }).pick?.provider, "higgsfield");
  deps.prices = new Map([
    ["fal:test/same", price(2)],
    ["higgsfield:test/same", price(null)],
  ]);
  deps.slots!.slots[0]!.candidates[0]!.referenceEstimate = {
    usd: 0.1,
    per: "request",
    setting: "fal only",
    source: "https://example.com/fal",
    observedAsOf: "2026-11-15",
  };
  assert.equal(pick(deps, { maxUsd: 1, provider: "higgsfield" }).pick, null);
});

test("specialised empty slots preserve task filtering, while general edit concepts remain alternatives", () => {
  const deps = setup(
    [],
    [
      entry("test/general-edit", {
        category: "image-to-image",
        inputs: [{ name: "image_url", type: "string", media: "image", required: true }],
      }),
      entry("test/background-cutout", {
        category: "image-to-image",
        inputs: [{ name: "image_url", type: "string", media: "image", required: true }],
      }),
    ],
  );
  const slot = deps.slots!.slots[0]!;
  slot.id = "image.cutout";
  slot.concepts = ["cutout"];
  slot.categories = ["image-to-image"];
  slot.inputs = ["image"];
  assert.equal(pickModel({ slot: slot.id }, deps).pick?.endpoint, "test/background-cutout");
  const pin = pickModel({ slot: slot.id, model: "test/general-edit", provider: "fal" }, deps);
  assert.equal(pin.pick, null);
  assert.ok(pin.userPin?.rejectedBecause.some((reason) => reason.includes("specialism")));
  slot.id = "image.edit";
  slot.concepts = ["image-edit", "inpaint"];
  const result = pickModel({ slot: slot.id }, deps);
  assert.ok(result.fallback.some((r) => r.endpoint === "test/general-edit"));
});

test("fully injected fallback ignores environment tables and scans beyond the first hundred ineligible results", () => {
  const entries = Array.from({ length: 101 }, (_, i) =>
    entry(`test/model-${i}`, { firstSeen: i === 100 ? "2026-01-01" : "2026-11-15" }),
  );
  const deps = setup([], entries);
  deps.prices = new Map(entries.map((e, i) => [`fal:${e.endpoint}`, price(i === 100 ? 0.1 : 2)]));
  const before = process.env.AGENTBROS_MODEL_SLOTS;
  try {
    process.env.AGENTBROS_MODEL_SLOTS = "/missing/injected-table.json";
    assert.equal(pick(deps, { maxUsd: 1 }).pick?.endpoint, "test/model-100");
  } finally {
    if (before === undefined) delete process.env.AGENTBROS_MODEL_SLOTS;
    else process.env.AGENTBROS_MODEL_SLOTS = before;
  }
});
