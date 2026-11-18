import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { loadModelSlots } from "../src/lib/models/model-slots";
import { modelStats, readModelPreferences, writeModelVerdict } from "../src/lib/models/model-slots-project";
import { OperationDatabaseSchema } from "../src/lib/jobs/types";
import { prepareCommand } from "../src/mcp/bridge";
import { COMMANDS } from "../src/mcp/catalog";

const repo = path.resolve(import.meta.dirname, "..");
const now = new Date("2026-11-15T00:00:00Z");
const fixture = path.join(repo, "tests/fixtures/model-slots/minimal.json");
const temporary = () => mkdtempSync(path.join(tmpdir(), "slots-cli-"));
const catalogs = useTempFalCatalog([
  { endpoint: "fal-ai/flux/schnell", patch: { tier: "verified", outputs: { kinds: ["image"], fields: [] } } },
]);
function cli(root: string, script: string, args: string[], slots = fixture) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repo, "node_modules/tsx/dist/loader.mjs"),
      path.join(repo, `scripts/models-${script}.ts`),
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        AGENTBROS_MODEL_SLOTS: slots,
        AGENTBROS_FAL_CATALOG_DIR: catalogs.catalogDir,
        AGENTBROS_FAL_SCHEMA_CACHE: catalogs.cacheDir,
        AGENTBROS_HF_CATALOG_DIR: path.join(root, "empty-hf"),
        AGENTBROS_FAL_PRICES: process.env.AGENTBROS_FAL_PRICES,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
      },
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.stdout.trim().split("\n").length, 1, child.stderr + child.stdout);
  const envelope = JSON.parse(child.stdout);
  assert.equal(typeof envelope.elapsedMs, "number");
  assert.equal(envelope.ok, child.status === 0, child.stderr + child.stdout);
  return { ...child, envelope };
}
function project(root: string, id = "test") {
  const directory = path.join(root, `public/projects/${id}/pipeline`);
  mkdirSync(directory, { recursive: true });
  const job = (operationId: string, state = "published") => ({
    operationId,
    provider: "fal",
    endpoint: "fal-ai/flux/schnell",
    inputHash: "fixture",
    assetId: operationId,
    quote: {
      currency: "USD",
      lowUsd: 1,
      expectedUsd: 1,
      highUsd: 1,
      bounded: true,
      source: "fixture",
      asOf: "2026-11-15",
      confidence: "published-rate",
    },
    repair: false,
    state,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    reservedMicros: 0,
    paidAttempts: 1,
    history: [],
  });
  const operations = OperationDatabaseSchema.parse({
    version: 1,
    projectId: id,
    revision: 0,
    policy: { ceilingUsd: 10, maxJobUsd: 2 },
    jobs: {
      op1: job("op1"),
      op2: job("op2", "failed"),
      op3: job("op3", "cancelled"),
      pending: job("pending", "running"),
    },
  });
  writeFileSync(path.join(directory, "operations.json"), JSON.stringify(operations));
  writeFileSync(
    path.join(directory, "cost-ledger.jsonl"),
    [
      {
        operationId: "op1",
        provider: "fal",
        service: "fal",
        model: "fal-ai/flux/schnell",
        actualUsd: null,
        estimatedUsd: 1,
      },
      {
        operationId: "op1",
        provider: "fal",
        service: "fal",
        model: "fal-ai/flux/schnell",
        actualUsd: 0.75,
        estimatedUsd: 1,
      },
      { operationId: "op2", provider: "fal", service: "fal", model: "fal-ai/flux/schnell", estimatedUsd: null },
    ]
      .map((s) => JSON.stringify(s))
      .join("\n") + "\n",
  );
  return directory;
}

test("all new CLI help and invalid calls obey one JSON line and exit status", () => {
  const root = temporary();
  try {
    for (const script of ["pick", "slots", "slot", "verdict", "stats"]) {
      assert.equal(cli(root, script, ["--help"]).envelope.ok, true);
      assert.equal(cli(root, script, ["--unexpected"]).envelope.ok, false);
    }
    const pin = ["--slot", "image.generate", "--model", "fal-ai/flux/schnell", "--provider", "fal"];
    assert.equal(cli(root, "pick", pin).envelope.metadata.pinPassed, true);
    const capability = cli(root, "pick", [...pin, "--capability", "end-frame"]);
    assert.equal(capability.envelope.metadata.pick, null);
    assert.ok(
      capability.envelope.metadata.userPin.rejectedBecause.includes("missing capability: end-frame"),
      capability.stdout,
    );
    assert.equal(cli(root, "pick", ["--slot", "image.generate", "--capability", "teleport"]).envelope.ok, false);
    const result = cli(root, "pick", ["--task", "hello"]);
    assert.equal(result.envelope.metadata.matched, false);
    assert.equal(result.envelope.metadata.pick, null);
    assert.equal(cli(root, "slots", ["--list"]).envelope.metadata.slots[0].id, "image.generate");
    assert.equal(cli(root, "slots", ["--show", "image.generate"]).envelope.metadata.slot.title, "Generate images");
    assert.equal(cli(root, "slots", ["--show", "missing.slot"]).envelope.ok, false);
    assert.equal(cli(root, "slots", ["--check"]).envelope.error, "VALIDATION");
    assert.equal(cli(root, "slots", ["--list", "--check"]).envelope.error, "INVALID_INPUT");
    assert.equal(
      cli(root, "slot", ["--slot", "image.generate", "--retire", "test/gone", "--provider", "fal"]).envelope.ok,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project preferences, brief quality, verdict CLI and stats read existing operations without changing execution data", () => {
  const root = temporary();
  try {
    const directory = project(root),
      slots = path.join(root, "slots.json");
    copyFileSync(fixture, slots);
    const file = loadModelSlots(slots);
    file.slots[0]!.candidates = [
      {
        provider: "fal",
        endpoint: "fal-ai/flux/schnell",
        class: "hero",
        order: 1,
        status: "active",
        why: "fixture",
        evidence: [{ kind: "owner", source: "owner", text: "fixture", date: "2026-11-15" }],
        addedAt: "2026-11-15",
      },
    ];
    writeFileSync(slots, JSON.stringify(file));
    writeFileSync(path.join(directory, "brief.json"), JSON.stringify({ qualityTier: "fast" }));
    assert.equal(readModelPreferences("test", root).qualityTier, "fast");
    const pick = cli(root, "pick", ["--slot", "image.generate", "--project", "test"], slots);
    assert.equal(pick.envelope.metadata.requestedClass, "budget");
    writeFileSync(
      path.join(directory, "model-preferences.json"),
      JSON.stringify({ version: 1, pins: [], avoid: [], defaultClass: "balanced" }),
    );
    assert.equal(
      cli(root, "pick", ["--slot", "image.generate", "--project", "test"], slots).envelope.metadata.requestedClass,
      "balanced",
    );
    assert.deepEqual(cli(root, "stats", ["--propose"], slots).envelope.metadata.acceptanceProposals, []);
    assert.equal(
      cli(
        root,
        "slot",
        ["--slot", "image.generate", "--endpoint", "fal-ai/flux/schnell", "--provider", "fal", "--evidence-acceptance"],
        slots,
      ).envelope.error,
      "VALIDATION",
    );
    const before = readFileSync(path.join(directory, "operations.json"), "utf8"),
      ledgerBefore = readFileSync(path.join(directory, "cost-ledger.jsonl"), "utf8");
    assert.equal(
      cli(root, "verdict", ["--project", "test", "--operation-id", "op1", "--accepted"], slots).envelope.ok,
      true,
    );
    assert.equal(
      cli(root, "verdict", ["--project", "test", "--operation-id", "op1", "--rejected"], slots).envelope.ok,
      true,
    );
    assert.equal(
      cli(root, "verdict", ["--project", "test", "--operation-id", "missing", "--accepted"], slots).envelope.error,
      "VALIDATION",
    );
    assert.equal(
      cli(root, "verdict", ["--project", "test", "--operation-id", "toString", "--accepted"], slots).envelope.error,
      "VALIDATION",
    );
    const rows = modelStats(file, { project: "test", root });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.generations, 3);
    assert.equal(rows[0]!.failures, 2);
    assert.equal(rows[0]!.accepted, 1);
    assert.equal(rows[0]!.firstPassAcceptance, 1);
    assert.equal(rows[0]!.avgCostUsd, 0.75);
    assert.equal(cli(root, "stats", ["--project", "test"], slots).envelope.metadata.stats[0].generations, 3);
    assert.deepEqual(modelStats(file, { all: true, root }), rows);
    project(root, "second");
    assert.equal(
      cli(root, "verdict", ["--project", "second", "--operation-id", "op1", "--rejected"], slots).envelope.ok,
      true,
    );
    const proposed = cli(root, "stats", ["--propose"], slots).envelope.metadata.acceptanceProposals;
    assert.deepEqual(proposed, [
      {
        slot: "image.generate",
        provider: "fal",
        endpoint: "fal-ai/flux/schnell",
        accepted: 1,
        rejected: 1,
        judged: 2,
        firstPassAcceptance: 0.5,
      },
    ]);
    assert.equal(
      cli(
        root,
        "slot",
        ["--slot", "image.generate", "--endpoint", "fal-ai/flux/schnell", "--provider", "fal", "--evidence-acceptance"],
        slots,
      ).envelope.ok,
      true,
    );
    const evidence = loadModelSlots(slots).slots[0]!.candidates[0]!.evidence.find((e) => e.kind === "acceptance");
    assert.ok(evidence && evidence.kind === "acceptance");
    assert.equal(evidence.accepted, 1);
    assert.equal(evidence.generations, 2);
    assert.match(evidence.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.doesNotMatch(JSON.stringify(evidence), /test|second|op1/);
    assert.equal(readFileSync(path.join(directory, "cost-ledger.jsonl"), "utf8"), ledgerBefore);
    assert.equal(readFileSync(path.join(directory, "operations.json"), "utf8"), before);
    assert.equal(existsSync(path.join(directory, "model-outcomes.jsonl")), false);
    assert.equal(cli(root, "slot", ["--slot", "image.generate", "--review-by", "2027-01-01"], slots).envelope.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project paths and verdict writes refuse traversal and symlink escapes", () => {
  const root = temporary(),
    outside = temporary();
  try {
    project(root);
    const linkedRoot = path.join(root, "linked-root");
    mkdirSync(path.join(linkedRoot, "public"), { recursive: true });
    mkdirSync(path.join(outside, "test"));
    symlinkSync(outside, path.join(linkedRoot, "public/projects"));
    assert.throws(() => readModelPreferences("test", linkedRoot), /symlink/);
    assert.throws(() => readModelPreferences("../outside", root), /Project ID/);
    symlinkSync(outside, path.join(root, "public/projects/escape"));
    assert.throws(() => readModelPreferences("escape", root), /symlink/);
    symlinkSync(
      path.join(outside, "verdicts.jsonl"),
      path.join(root, "public/projects/test/pipeline/model-verdicts.jsonl"),
    );
    assert.throws(
      () => writeModelVerdict("test", { operationId: "op1", verdict: "accepted" }, { root, now }),
      /symlink/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("new MCP tools are local read-only with strict fields and existing project scoping", () => {
  const root = temporary();
  try {
    const options = { root, projectScope: "test", codeRoot: repo, allowPaid: false };
    for (const name of ["models_pick", "models_slots"]) {
      const definition = COMMANDS.find((c) => c.name === name)!;
      assert.equal(definition.readOnly, true);
      assert.equal(definition.paid, "local");
      assert.throws(() => prepareCommand(definition, { project: "other", slot: "image.generate" }, options));
      assert.throws(() => prepareCommand(definition, { project: "test", "write-doc": true }, options));
      assert.throws(() => prepareCommand(definition, { project: "test", out: "../escape" }, options));
      const flags =
        name === "models_pick" ? { project: "test", slot: "image.generate" } : { project: "test", list: true };
      assert.equal(prepareCommand(definition, flags, options).flags.project, "test");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
