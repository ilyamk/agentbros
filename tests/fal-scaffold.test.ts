import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { falFixtureManifest, useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { resolveCatalogSnapshot } from "../src/lib/models/fal-catalog";
import { scaffoldFalEndpoint, setFalScaffoldValue, writeFalScaffold } from "../src/lib/models/fal-scaffold";
import { exampleFromSchema } from "../src/lib/providers/json-schema-validate";
import { buildFalOperation } from "../src/lib/providers/fal-operations";

const selected = new Map<string, string>();
for (const [endpoint, fixture] of Object.entries(falFixtureManifest.endpoints))
  if (!selected.has(fixture.category) && !endpoint.includes("realtime")) selected.set(fixture.category, endpoint);
useTempFalCatalog([...selected.values()].map((endpoint) => ({ endpoint })));
for (const [category, endpoint] of selected)
  test(`scaffold validates ${category}: ${endpoint}`, () => {
    const schema = resolveCatalogSnapshot(endpoint)!;
    const example = exampleFromSchema(schema.input, schema.schemas) as Record<string, unknown>;
    const set = Object.entries(example).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    const result = scaffoldFalEndpoint(endpoint, { set });
    assert.deepEqual(result.missing, []);
    assert.equal(result.valid, true, result.errors.join("\n"));
    assert.equal(buildFalOperation(result.request).endpoint, endpoint);
    assert.ok(Object.values(result.hints).every((hint) => (hint.description?.length ?? 0) <= 200));
  });

test("placeholders are required strings, explicit defaults and schema hints survive", () => {
  const endpoint = "fal-ai/flux/schnell",
    draft = scaffoldFalEndpoint(endpoint);
  assert.ok(draft.missing.includes("prompt"));
  assert.equal(draft.request.input.prompt, "<FILL: prompt>");
  assert.equal(draft.valid, false);
  assert.equal(draft.hints.prompt?.type, "string");
  assert.ok(draft.hints.num_images?.default !== undefined);
  assert.equal(scaffoldFalEndpoint(endpoint, { set: ["prompt=A quiet coast"] }).valid, true);
  assert.equal(scaffoldFalEndpoint(endpoint, { set: ["unknown=true"] }).valid, false);
  assert.equal(scaffoldFalEndpoint("bytedance/seedream/v5/lite/edit").hints.image_urls?.media, "image");
});

test("dotted assignments parse JSON and reject prototype access or scalar parents", () => {
  const input: Record<string, unknown> = {};
  for (const value of [
    "size.width=1080",
    "size.height=1920",
    'options=[1,"a,b"]',
    "prompt=Two equals = fine",
    "enabled=true",
  ])
    setFalScaffoldValue(input, value);
  assert.deepEqual(input, {
    size: { width: 1080, height: 1920 },
    options: [1, "a,b"],
    prompt: "Two equals = fine",
    enabled: true,
  });
  for (const value of ["__proto__.polluted=true", "a.constructor.x=1", "prompt.x=2", "missing-equal"])
    assert.throws(() => setFalScaffoldValue(input, value));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("explicit output refuses overwrite, allows force, and scopes symlinks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fal-scaffold-"));
  try {
    const file = path.join(dir, "request.json"),
      request = scaffoldFalEndpoint("fal-ai/flux/schnell").request;
    writeFalScaffold(file, request);
    const before = readFileSync(file, "utf8");
    assert.throws(() => writeFalScaffold(file, request), /overwrite/);
    assert.equal(readFileSync(file, "utf8"), before);
    writeFalScaffold(file, { ...request, input: { prompt: "new" } }, { force: true });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).input.prompt, "new");
    symlinkSync("/Users", path.join(dir, "outside"));
    assert.throws(() => writeFalScaffold(path.join(dir, "outside", "forbidden.json"), request), /workspace|temporary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncached schema supplies an explicit next action without writing", () => {
  useTempFalCatalog([{ endpoint: "meshy/v7/image-to-3d", cached: false }]);
  const result = scaffoldFalEndpoint("meshy/v7/image-to-3d");
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["SCHEMA_NOT_CACHED"]);
  assert.equal(result.nextAction, "pnpm fal:sync --schemas meshy/v7/image-to-3d");
});

test("bundled verified schema is a fallback when the catalogue cache is absent", () => {
  const result = scaffoldFalEndpoint("openai/gpt-image-2.5/flare/text-to-image", { set: ["prompt=Offline coast"] });
  assert.equal(result.valid, true, result.errors.join(" "));
  assert.equal(result.nextAction, undefined);
});

test("CLI repeated --set preserves JSON commas and never overwrites implicitly", () => {
  useTempFalCatalog([{ endpoint: "fal-ai/flux/schnell" }]);
  const dir = mkdtempSync(path.join(tmpdir(), "fal-scaffold-cli-")),
    file = path.join(dir, "request.json");
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/fal-scaffold.ts", "--endpoint", "fal-ai/flux/schnell", ...args],
      { encoding: "utf8", env: { ...process.env, FAL_KEY: "", ELEVENLABS_API_KEY: "" } },
    );
  try {
    const draft = run("--set", "prompt=literal, prompt", "--set=num_images=2", "--out", file);
    assert.equal(draft.status, 0, draft.stderr);
    const result = JSON.parse(draft.stdout);
    assert.equal(result.metadata.valid, true);
    assert.equal(result.metadata.request.input.num_images, 2);
    assert.equal(draft.stdout.trim().split("\n").length, 1);
    assert.equal(run("--out", file).status, 1);
    assert.equal(run("--set", "prompt=Changed", "--out", file, "--force").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
