import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isEndpointSuccessor, proposeSlotChanges } from "../src/lib/models/model-slots-refresh";
import { loadModelSlots } from "../src/lib/models/model-slots-loader";
import { refreshModels, type ModelRefreshSnapshot } from "../src/lib/models/models-refresh";
import { writeModelSlotRefresh } from "../src/lib/models/model-slots-maintenance";
import type { FalCatalogEntry, ModelChoicePrice } from "../src/types/fal-catalog";
import type { ModelSlotsFile } from "../src/types/model-slots";

const now = new Date("2026-11-15T00:00:00Z");
const pairs: [string, string, boolean][] = [
  ["openai/gpt-image-2.5/flare/edit", "openai/gpt-image-2.6/flare/edit", true],
  ["openai/gpt-image-2.5/flare/text-to-image", "openai/gpt-image-2.6/flare/text-to-image", true],
  ["openai/gpt-image-2.5/sunburst/edit", "openai/gpt-image-3/sunburst/edit", true],
  ["bytedance/seedance-2.5/text-to-video", "bytedance/seedance-2.6/text-to-video", true],
  ["bytedance/seedance-2.5/image-to-video", "bytedance/seedance-2.10/image-to-video", true],
  ["bytedance/seedance-2.5/reference-to-video", "bytedance/seedance-3.0/reference-to-video", true],
  ["fal-ai/kling-video/v3/pro/image-to-video", "fal-ai/kling-video/v4/pro/image-to-video", true],
  ["kling-video/v3/standard", "kling-video/v4/standard", true],
  ["fal-ai/wan-2-5/text-to-video", "fal-ai/wan-2-6/text-to-video", true],
  ["fal-ai/wan/v2.5/image-to-video", "fal-ai/wan/v2.6/image-to-video", true],
  ["higgsfield-ai/soul/v2/standard", "higgsfield-ai/soul/v3/standard", true],
  ["fal-ai/flux.1/dev", "fal-ai/flux.2/dev", true],
  ["openai/gpt-image-2.5/flare/edit", "openai/gpt-image-2.6/sunburst/edit", false],
  ["bytedance/seedance-2.5/image-to-video", "bytedance/seedance-2.6/text-to-video", false],
  ["fal-ai/kling-video/v3/pro", "fal-ai/kling-video/v4/standard", false],
  ["openai/gpt-image-2.5/flare/edit", "openai/gpt-image-2.4/flare/edit", false],
  ["openai/gpt-image-2.5/flare/edit", "another/gpt-image-2.6/flare/edit", false],
  ["openai/gpt-image-2.5/flare/edit", "openai/gpt-image-2.5/flare/edit", false],
  ["fal-ai/flux/schnell", "fal-ai/flux/dev", false],
  ["fal-ai/kling-video/v3", "fal-ai/kling-video/v3.0", false],
];
for (const [before, after, expected] of pairs)
  test(`successor ${before} → ${after}: ${expected}`, () => assert.equal(isEndpointSuccessor(before, after), expected));
function entry(endpoint: string, patch: Partial<FalCatalogEntry> = {}): FalCatalogEntry {
  return {
    endpoint,
    category: "text-to-image",
    displayName: endpoint,
    status: "active",
    firstSeen: "2026-11-01",
    lastSeen: "2026-11-15",
    schema: null,
    inputs: [],
    outputs: { kinds: ["image"], fields: [] },
    transport: "queue",
    tags: [],
    tier: "verified",
    price: null,
    ...patch,
  };
}
function fixture(): ModelSlotsFile {
  const file = loadModelSlots();
  file.slots = [file.slots[0]!];
  file.slots[0]!.reviewBy = "2026-11-01";
  file.slots[0]!.candidates = [
    {
      provider: "fal",
      endpoint: "openai/gpt-image-2.5/flare/edit",
      class: "hero",
      status: "active",
      order: 10,
      why: "fixture",
      evidence: [],
      addedAt: "2026-11-01",
    },
    {
      provider: "fal",
      endpoint: "test/budget-v1",
      class: "budget",
      status: "candidate",
      order: 20,
      why: "fixture",
      evidence: [],
      addedAt: "2026-11-01",
    },
    {
      provider: "fal",
      endpoint: "test/draft-v1",
      class: "draft",
      status: "active",
      order: 30,
      why: "fixture",
      evidence: [],
      addedAt: "2026-11-01",
    },
  ];
  return file;
}
function price(usd: number): ModelChoicePrice {
  return {
    kind: "exact",
    label: "fixture",
    usd,
    unitPrice: usd,
    unit: "request",
    asOf: "2026-11-15",
    evidenceKind: "fixture",
    basis: "request",
  };
}

test("pure proposals insert inactive successors in order, retire gone, flag drift/stale/retiring/unmapped; idempotent", () => {
  const file = fixture(),
    before = JSON.stringify(file);
  const hero = file.slots[0]!.candidates[0]!.endpoint;
  const rows = [
    entry(hero),
    entry(hero.replace("2.5", "2.6")),
    entry(hero.replace("2.5", "2.7")),
    entry("test/budget-v1", { status: "deprecated", retiresAt: "2026-12-01" }),
    entry("test/draft-v1"),
    entry("test/gone", { status: "gone" }),
    entry("test/audio", { category: "text-to-audio" }),
  ];
  file.slots[0]!.candidates.push({ ...file.slots[0]!.candidates[2]!, endpoint: "test/gone", order: 40 });
  const catalogs = { fal: new Map(rows.map((e) => [e.endpoint, e])) },
    prices = new Map([
      [`fal:${hero}`, price(1)],
      ["fal:test/budget-v1", price(2)],
      ["fal:test/draft-v1", price(3)],
    ]);
  const original = structuredClone(file);
  const result = proposeSlotChanges(file, catalogs, prices, now);
  assert.deepEqual(file, original);
  assert.notEqual(JSON.stringify(result.table), before);
  assert.deepEqual(
    result.table.slots[0]!.candidates.slice(0, 3).map((c) => [c.endpoint, c.class, c.status]),
    [
      [hero, "hero", "active"],
      [hero.replace("2.5", "2.6"), "hero", "candidate"],
      [hero.replace("2.5", "2.7"), "hero", "candidate"],
    ],
  );
  assert.equal(result.table.slots[0]!.candidates.find((c) => c.endpoint === "test/gone")!.status, "retired");
  assert.match(
    result.table.slots[0]!.candidates.find((c) => c.endpoint === "test/gone")!.notes!,
    /gone detected 2026-11-15/,
  );
  assert.deepEqual(
    new Set(result.proposals.map((p) => p.kind)),
    new Set(["successor", "gone", "retiring", "price-drift", "stale", "unmapped-category"]),
  );
  assert.equal(result.proposals.filter((p) => p.kind === "price-drift").length, 2);
  const again = proposeSlotChanges(result.table, catalogs, prices, new Date("2026-11-16T00:00:00Z"));
  assert.equal(again.changed, false);
  assert.deepEqual(again.table, result.table);
  assert.ok(!again.proposals.some((p) => ["gone", "successor"].includes(p.kind)));
  assert.ok(
    !proposeSlotChanges(file, { ...catalogs, mappedCategories: ["text-to-audio"] }, prices, now).proposals.some(
      (p) => p.kind === "unmapped-category",
    ),
  );
  assert.equal(
    proposeSlotChanges(file, { higgsfield: new Map(rows.map((e) => [e.endpoint, e])) }, prices, now).changed,
    false,
  );
});

test("new budget successors are flagged for price drift and retirement in the same refresh", () => {
  const file = fixture(),
    hero = file.slots[0]!.candidates[0]!.endpoint;
  const rows = [entry(hero), entry("test/budget-v1"), entry("test/budget-v2", { retiresAt: "2026-12-01" })];
  const result = proposeSlotChanges(
    file,
    { fal: new Map(rows.map((row) => [row.endpoint, row])) },
    new Map([
      [`fal:${hero}`, price(1)],
      ["fal:test/budget-v1", price(0.2)],
      ["fal:test/budget-v2", price(2)],
    ]),
    now,
  );
  for (const kind of ["successor", "price-drift", "retiring"])
    assert.ok(
      result.proposals.some((p) => p.kind === kind && p.endpoint === "test/budget-v2"),
      kind,
    );
});

test("refresh dry-run lists local proposals without writes or calls; real run writes isolated table, doc and report", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "slot-refresh-")),
    file = path.join(root, "slots.json");
  const previous = process.env.AGENTBROS_MODEL_SLOTS;
  try {
    writeFileSync(file, JSON.stringify(fixture()));
    process.env.AGENTBROS_MODEL_SLOTS = file;
    const source = readFileSync(file, "utf8"),
      hero = loadModelSlots().slots[0]!.candidates[0]!.endpoint;
    const snapshot: ModelRefreshSnapshot = {
      entries: [entry(hero), entry(hero.replace("2.5", "2.6"))],
      falPrices: [],
      hfPrices: [],
    };
    const fail = () => {
      throw new Error("unexpected write/call");
    };
    const dependencies = {
      writeMatrix: () => {},
      env: {},
      now,
      snapshot: () => snapshot,
      slotPrices: new Map(),
      mappedCategories: [],
      compare: () => [],
      runStep: async () => ({ ok: true }),
    };
    const dry = await refreshModels(
      { dryRun: true },
      { ...dependencies, runStep: fail, writeReport: fail, writeSlots: fail, writeSlotsDoc: fail },
    );
    assert.ok(dry.slotProposals.some((p) => p.kind === "successor"));
    assert.equal(readFileSync(file, "utf8"), source);
    let markdown = "",
      doc = "";
    await refreshModels(
      {},
      {
        ...dependencies,
        writeReport: (_, body) => {
          markdown = body;
        },
        writeSlotsDoc: (body) => {
          doc = body;
        },
      },
    );
    assert.match(markdown, /## Slot proposals/);
    assert.match(doc, /gpt-image-2.6/);
    assert.equal(loadModelSlots().slots[0]!.candidates[1]!.status, "candidate");
    const written = readFileSync(file, "utf8");
    await refreshModels(
      {},
      {
        ...dependencies,
        writeReport: () => {},
        writeSlots: fail,
        writeSlotsDoc: (body) => {
          assert.equal(body, doc);
        },
      },
    );
    assert.equal(readFileSync(file, "utf8"), written);
    assert.throws(() => writeModelSlotRefresh(JSON.parse(source), loadModelSlots()), /changed during refresh/);
  } finally {
    if (previous === undefined) delete process.env.AGENTBROS_MODEL_SLOTS;
    else process.env.AGENTBROS_MODEL_SLOTS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
