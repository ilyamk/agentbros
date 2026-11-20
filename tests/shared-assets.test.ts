import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AssetMissingError,
  MANIFESTS,
  assetStatus,
  ensureAssets,
  loadAssets,
  syncAsset,
  type SyncDeps,
} from "../src/lib/shared-assets";
import { COMPOSITION_NEEDS, LIBRARY_NEEDS, needsForComposition, needsForSource } from "../src/lib/shared-assets/needs";

const FIXTURE = "tests/fixtures/shared-assets";
const BYTES = Buffer.from("fixture-hdr-bytes");

function workspace(t: test.TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "shared-assets-"));
  cpSync(path.join(FIXTURE, "public"), path.join(root, "public"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeFetch(routes: Record<string, Buffer | number>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    calls.push(String(url));
    const route = routes[String(url)] ?? 404;
    return typeof route === "number"
      ? new Response(null, { status: route })
      : new Response(new Uint8Array(route), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}

const entry = (root: string, id: string) => loadAssets(root).find((item) => item.id === id)!;

test("committed manifests parse, ids are unique and every download is HTTPS with a sha256", () => {
  const assets = loadAssets();
  assert.ok(assets.length > 0);
  assert.equal(new Set(assets.map((asset) => asset.id)).size, assets.length);
  for (const asset of assets) {
    // Media under public/; model weights only in the model cache, outside the repository and every bundle.
    assert.match(asset.target, asset.family === "models" ? /^\$MODELS\// : /^public\//, asset.id);
    if (asset.source.kind === "url") {
      assert.match(asset.source.url, /^https:\/\//, asset.id);
      assert.ok(asset.sha256, `${asset.id} has a sha256`);
    }
    if (asset.source.kind === "recipe")
      for (const input of asset.source.inputs) assert.match(input.url, /^https:\/\//, asset.id);
  }
  for (const manifest of Object.values(MANIFESTS)) assert.ok(existsSync(manifest), `${manifest} is committed`);
});

test("an invalid manifest is rejected", () => {
  assert.throws(() => loadAssets(path.join(FIXTURE, "invalid")), /sha256|Invalid/);
});

test("download verifies sha256 and a second sync is a no-op", async (t) => {
  const root = workspace(t);
  const { fetch, calls } = fakeFetch({ "https://example.invalid/studio.hdr": BYTES });
  assert.equal(assetStatus(entry(root, "hdri:studio"), root).state, "missing");
  assert.equal((await syncAsset(entry(root, "hdri:studio"), { root, deps: { fetch } })).outcome, "downloaded");
  assert.deepEqual(readFileSync(path.join(root, "public/shared/hdri/studio.hdr")), BYTES);
  assert.equal((await syncAsset(entry(root, "hdri:studio"), { root, deps: { fetch } })).outcome, "unchanged");
  assert.equal(calls.length, 1);
});

test("a source whose bytes changed is refused and leaves nothing behind", async (t) => {
  const root = workspace(t);
  const { fetch } = fakeFetch({ "https://example.invalid/studio.hdr": Buffer.from("tampered") });
  const result = await syncAsset(entry(root, "hdri:studio"), { root, deps: { fetch } });
  assert.equal(result.outcome, "corrupt-source");
  assert.equal(
    readdirSync(path.join(root, "public/shared/hdri")).filter((name) => name.endsWith(".hdr") || name.endsWith(".part"))
      .length,
    0,
  );
});

test("a local file with the wrong bytes is corrupt and a sync replaces it", async (t) => {
  const root = workspace(t);
  writeFileSync(path.join(root, "public/shared/hdri/studio.hdr"), "wrong");
  assert.equal(assetStatus(entry(root, "hdri:studio"), root).state, "corrupt");
  const { fetch } = fakeFetch({ "https://example.invalid/studio.hdr": BYTES });
  assert.equal((await syncAsset(entry(root, "hdri:studio"), { root, deps: { fetch } })).outcome, "downloaded");
  assert.equal(assetStatus(entry(root, "hdri:studio"), root).state, "present");
});

test("a source that disappeared is reported as source-gone with the manifest to update", async (t) => {
  const root = workspace(t);
  const result = await syncAsset(entry(root, "hdri:gone"), { root, deps: fakeFetch({}) });
  assert.equal(result.outcome, "source-gone");
  assert.match(result.detail!, /HTTP 404.*public\/shared\/hdri\/sources\.json/);
});

test("a recipe downloads its verified inputs, runs the literal command and tolerates drift", async (t) => {
  const root = workspace(t);
  const runs: string[][] = [];
  const deps: SyncDeps = {
    ...fakeFetch({ "https://example.invalid/phone-source.glb": BYTES }),
    hasTool: () => true,
    run: (command) => {
      runs.push(command);
      writeFileSync(path.join(root, "public/shared/3d/phone.glb"), "rebuilt by blender");
      return { ok: true, output: "" };
    },
  };
  assert.equal((await syncAsset(entry(root, "3d:phone"), { root, deps })).outcome, "regenerated");
  assert.ok(existsSync(path.join(root, ".cache/assets/3d/inputs/phone-source.glb")));
  assert.ok(runs[0]!.includes("scripts/blender/prepare_devices.py"));
  assert.ok(
    runs[0]!.some((part) => part.includes(path.join(root, ".cache/assets/3d/inputs"))),
    "inputs folder substituted",
  );
  assert.equal(assetStatus(entry(root, "3d:phone"), root).state, "drifted");
  assert.equal((await syncAsset(entry(root, "3d:phone"), { root, deps })).outcome, "unchanged");
  assert.equal(runs.length, 1);
});

test("a recipe without its tool reports needs-tool instead of failing", async (t) => {
  const root = workspace(t);
  const result = await syncAsset(entry(root, "3d:phone"), { root, deps: { hasTool: () => false } });
  assert.equal(result.outcome, "needs-tool");
});

test("ensureAssets fetches downloads on demand and names the sync command for the rest", async (t) => {
  const root = workspace(t);
  const deps = { ...fakeFetch({ "https://example.invalid/studio.hdr": BYTES }), hasTool: () => false };
  await ensureAssets(["hdri:studio"], { root, deps });
  assert.equal(assetStatus(entry(root, "hdri:studio"), root).state, "present");
  await assert.rejects(
    ensureAssets(["hdri:studio", "3d:phone", "collage:cutout"], { root, deps }),
    (error: unknown) => {
      assert.ok(error instanceof AssetMissingError);
      assert.deepEqual(
        error.missing.map((item) => item.id),
        ["3d:phone", "collage:cutout"],
      );
      assert.match(error.message, /pnpm assets:sync --id 3d:phone/);
      return true;
    },
  );
  await assert.rejects(ensureAssets(["hdri:nope"], { root, deps }), /Unknown asset id/);
});

test("needs tables name real assets and cover every manifest target referenced in src/motion", () => {
  const ids = new Set(loadAssets().map((asset) => asset.id));
  const needed = new Set([...Object.values(LIBRARY_NEEDS), ...Object.values(COMPOSITION_NEEDS)].flat());
  for (const id of needed) assert.ok(ids.has(id), `${id} is in a manifest`);
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.tsx?$/.test(name)) sources.push(readFileSync(file, "utf8"));
    }
  };
  walk("src/motion");
  for (const asset of loadAssets()) {
    const relative = asset.target.replace(/^public\//, "");
    if (sources.some((text) => text.includes(relative)))
      assert.ok(
        needed.has(asset.id),
        `${asset.id} (${relative}) is loaded in src/motion but missing from src/lib/shared-assets/needs.ts`,
      );
  }
  assert.deepEqual(needsForComposition("Lib-blender-plate-L"), ["plates:hero-turntable"]);
  assert.deepEqual(needsForSource('<BlenderPlate src="x" />', new Map()), ["plates:hero-turntable"]);
  const plates = new Map(loadAssets().map((asset) => [asset.target, asset.id]));
  assert.deepEqual(
    needsForSource('<PrintingSlip plate={{ src: "shared/3d/plates/printing-slip.mp4", frameCount: 60 }} />', plates),
    ["plates:printing-slip"],
  );
  assert.ok(
    needsForSource('<BlenderPlate src="shared/3d/plates/glass-dome.mp4" />', plates).includes("plates:glass-dome"),
  );
});

test("flat screen and capture reel inputs use supplied media without studio models", () => {
  assert.deepEqual(needsForComposition("Lib-library-reel-V", { capture: { landscape: {} } }), []);
  assert.deepEqual(
    needsForComposition("Lib-scene-product-reveal-L", { presentation: "screen", screenImage: "capture.png" }),
    [],
  );
  assert.ok(
    needsForComposition("Lib-scene-product-reveal-L", { presentation: "screen", screenImage: "" }).includes("3d:phone"),
  );
});
