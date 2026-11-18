import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { catalogEntry, useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { CATALOG_DIR, HF_CATALOG_DIR, loadCatalog } from "../src/lib/models/fal-catalog";
import { findFalEndpointResult, findFalEndpoints } from "../src/lib/models/fal-find";
import { FalFindResultSchema, type FalCatalogEntry } from "../src/types/fal-catalog";

useTempFalCatalog([{ endpoint: "fal-ai/flux/schnell", patch: { outputs: { kinds: ["image"], fields: [] } } }]);
const image = catalogEntry("fal-ai/flux/schnell", {
  outputs: { kinds: ["image"], fields: [] },
  displayName: "Spectral Relighting",
  tags: [],
});
const junk = catalogEntry("fal-ai/ace-step/audio-outpaint", {
  tier: "verified",
  displayName: "Audio",
  tags: [],
  outputs: { kinds: ["audio"], fields: [] },
});
const catalog = new Map([image, junk].map((entry) => [entry.endpoint, entry]));
const options = { catalog, env: {} };

for (const task of [
  undefined,
  "",
  "привет",
  "как дела",
  "сделай хорошо",
  "please make it nice",
  "budget",
  "hero",
  "черновик",
  "лучшее качество",
])
  test(`no signal returns no catalogue: ${task}`, () => {
    const result = findFalEndpointResult({ task, explain: true, includeSchemaless: true }, options);
    FalFindResultSchema.parse(result);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.match.matched, false);
    assert.equal(result.match.via, "none");
    assert.ok(result.message);
    assert.equal(result.suggestions.length, 3);
    assert.ok(result.suggestions.every((row) => row.exampleCommand.includes("--category")));
    assert.match(result.nextActions[0]!, /pnpm memory --add --type gap.*--agent orchestrator --evidence/);
    if (task !== undefined) assert.deepEqual(findFalEndpoints({ task }, options), []);
  });

test("explicit category/input/output filters admit ranking and report explicit provenance", () => {
  for (const query of [
    { categories: ["image-to-image" as const] },
    { inputs: ["image" as const] },
    { outputs: ["image" as const] },
  ]) {
    const result = findFalEndpointResult({ task: "привет", ...query }, options);
    assert.equal(result.match.via, "explicit");
    assert.equal(result.match.matched, true);
  }
  assert.ok(findFalEndpoints({}, options).length, "legacy array-only catalogue browsing remains compatible");
  assert.equal(findFalEndpointResult({ categories: [], inputs: [], outputs: [] }, options).match.matched, false);
});

test("lexical fallback uses both providers' names, ids, tags, family titles and descriptions", () => {
  for (const provider of ["fal", "higgsfield"] as const) {
    for (const field of ["displayName", "endpoint", "tags", "family", "description"] as const) {
      const entry: FalCatalogEntry = {
        ...image,
        provider,
        endpoint: "test/plain",
        displayName: "Plain",
        description: undefined,
        ...(field === "displayName" ? { displayName: "Spectral Relighting" } : {}),
        ...(field === "endpoint" ? { endpoint: "test/spectral-relighting" } : {}),
        ...(field === "tags" ? { tags: ["spectral-relighting"] } : {}),
        ...(field === "family" ? { family: { slug: "plain", title: "Spectral Relighting" } } : {}),
        ...(field === "description" ? { description: "Spectral relighting reconstruction" } : {}),
      };
      const task = field === "description" ? "spectral relighting reconstruction" : "spectral relighting";
      const result = findFalEndpointResult(
        { provider: "any", task },
        {
          ...options,
          catalog: new Map([
            ["hit", entry],
            ["junk", junk],
          ]),
        },
      );
      assert.equal(result.match.via, "lexical", `${provider} ${field}`);
      assert.deepEqual(
        result.candidates.map((row) => row.endpoint),
        [entry.endpoint],
      );
      assert.match(result.candidates[0]!.warnings.join(" "), /Lexical/);
      assert.ok(result.nextActions.length);
      FalFindResultSchema.parse(result);
    }
  }
});

test("weak description overlap and generic media words cannot trigger lexical ranking", () => {
  const entry = { ...image, displayName: "Plain", description: "spectral relighting" };
  for (const task of [
    "spectral",
    "spectral relighting",
    "audio",
    "make image",
    "text",
    "spectral something entirely different",
  ]) {
    assert.equal(
      findFalEndpointResult({ task }, { ...options, catalog: new Map([[entry.endpoint, entry]]) }).match.matched,
      false,
      task,
    );
  }
});

test("lexical categories follow the best hits; ties and catalogue order are stable", () => {
  const strong = { ...image, displayName: "Spectral relighting reconstruction" };
  const weak = { ...junk, displayName: "Spectral" };
  const a = findFalEndpointResult(
    { task: "spectral relighting reconstruction" },
    {
      ...options,
      catalog: new Map([
        ["weak", weak],
        ["strong", strong],
      ]),
    },
  );
  const b = findFalEndpointResult(
    { task: "spectral relighting reconstruction" },
    {
      ...options,
      catalog: new Map([
        ["strong", strong],
        ["weak", weak],
      ]),
    },
  );
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.candidates.map((row) => row.category),
    ["text-to-image"],
  );
});

test("CLI entry used by MCP returns one successful JSON envelope for an unmatched task", () => {
  // avc_fal_find invokes this same CLI through the literal-argv bridge.
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/fal-find.ts", "--provider", "fal", "--task", "привет", "--explain"],
    {
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        AGENTBROS_FAL_CATALOG_DIR: process.env.AGENTBROS_FAL_CATALOG_DIR,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0]!);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.match.matched, false);
  assert.deepEqual(envelope.metadata.candidates, []);
  assert.deepEqual(envelope.metadata.rejected, []);
});

test("gap commands shell-quote literal tasks and keep the memory summary within its contract", () => {
  const task = "don't `execute` $(anything) " + "q".repeat(300);
  const result = findFalEndpointResult({ task }, options);
  assert.equal(result.match.via, "none");
  const child = spawnSync(
    "/bin/sh",
    ["-c", `pnpm() { for arg do printf '%s\\n' "$arg"; done; }; ${result.nextActions[0]}`],
    { encoding: "utf8", env: {} },
  );
  assert.equal(child.status, 0, child.stderr);
  const args = child.stdout.trim().split("\n");
  assert.ok(args[args.indexOf("--summary") + 1]!.length <= 160);
  assert.ok(args[args.indexOf("--evidence") + 1]!.includes(task));
});

test("generic provider and catalogue terms do not revive whole-catalogue ranking", () => {
  const entries = [...loadCatalog(CATALOG_DIR).values(), ...loadCatalog(HF_CATALOG_DIR).values()];
  const realCatalog = new Map(entries.map((entry, index) => [String(index), entry]));
  for (const task of ["fal", "higgsfield", "model", "models", "generation", "find", "модель", "генерация"]) {
    const result = findFalEndpointResult({ provider: "any", task }, { catalog: realCatalog, env: {} });
    assert.equal(result.match.matched, false, task);
    assert.deepEqual(result.candidates, []);
  }
});

test("capability end-frame filters the shortlist by catalogue input names", () => {
  const fal = loadCatalog(CATALOG_DIR);
  const ids = [
    "fal-ai/kling-video/v3/pro/image-to-video",
    "blackforestlabs/flux-3/first-last-frame-to-video/draft",
    "blackforestlabs/flux-3/image-to-video/draft",
  ];
  const catalog = new Map(ids.map((id) => [id, fal.get(id)!]));
  const result = findFalEndpointResult(
    { provider: "fal", categories: ["image-to-video"], capabilities: ["end-frame"], explain: true },
    { catalog, env: {} },
  );
  FalFindResultSchema.parse(result);
  const passing = result.candidates.filter((row) => !row.rejectedBecause).map((row) => row.endpoint);
  assert.deepEqual(passing.sort(), ids.slice(0, 2).sort());
  const rejected = result.candidates.find((row) => row.endpoint === ids[2]);
  assert.ok(rejected?.rejectedBecause?.includes("missing capability: end-frame"));
});

test("empty category arrays cannot erase the inferred task category", () => {
  assert.equal(
    findFalEndpointResult({ task: "generate image", categories: [] }, options).candidates[0]?.category,
    "text-to-image",
  );
});

test("hero boosts a role without bypassing avatar specialism", () => {
  const hero = catalogEntry("fal-ai/kling-video/v3/pro/text-to-video", {
    displayName: "Kling Video",
    tier: "verified",
    outputs: { kinds: ["video"], fields: [] },
  });
  const avatar = catalogEntry("veed/avatars/audio-to-video", {
    displayName: "Avatar",
    outputs: { kinds: ["video"], fields: [] },
  });
  const catalog = new Map([hero, avatar].map((entry) => [entry.endpoint, entry]));
  const result = findFalEndpointResult({ task: "hero talking head" }, { catalog, env: {} });
  assert.deepEqual(
    result.candidates.map((row) => row.endpoint),
    [avatar.endpoint],
  );
  const ordinary = findFalEndpointResult({ task: "make a video" }, { catalog, env: {} }).candidates.find(
    (row) => row.endpoint === hero.endpoint,
  )!;
  const boosted = findFalEndpointResult({ task: "hero video" }, { catalog, env: {} }).candidates.find(
    (row) => row.endpoint === hero.endpoint,
  )!;
  assert.equal(boosted.score - ordinary.score, 20);
});
