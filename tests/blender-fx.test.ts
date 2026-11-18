import { pythonArgs, pythonEnvironment, pythonUv } from "../src/lib/python";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GeneratorManifestSchema, readGenerators } from "../src/lib/blender-arsenal/generators";
import { runBlender } from "../src/lib/backends/blender-run";
import { acquirePdb } from "../src/lib/blender-arsenal/pdb";
import { arsenalCandidates } from "../src/lib/blender-arsenal/overview";
import { findRecipe, readRecipeFrame, recipeRequest, renderRecipe } from "../src/lib/blender-arsenal/recipes";
import { determinism } from "../src/lib/blender-arsenal/recipe-quality";

const pdb =
  "HEADER    SYNTHETIC GLYCINE TEST FIXTURE\nTITLE     SYNTHETIC COORDINATES FOR IMPORT TEST ONLY\nATOM      1  N   GLY A   1       0.000   0.000   0.000  1.00 10.00           N  \nATOM      2  CA  GLY A   1       1.400   0.000   0.000  1.00 10.00           C  \nATOM      3  C   GLY A   1       2.000   1.400   0.000  1.00 10.00           C  \nATOM      4  O   GLY A   1       1.400   2.400   0.000  1.00 10.00           O  \nEND\n";

test("capability discovery lists recipes and approved tools with explicit verdicts", () => {
  for (const [tag, ids] of Object.entries({
    fluids: ["liquid-pour", "product-splash"],
    volumes: ["smoke-plume"],
    science: ["molecule", "molecularnodes"],
    pattern: ["pattern-surface", "tissue"],
    materials: ["procedural-materials"],
  })) {
    const entries = arsenalCandidates(process.cwd(), tag);
    for (const id of ids)
      assert.ok(
        entries.some((e) => e.id === id && e.verdict && e.capabilities.includes(tag)),
        id,
      );
    assert.ok(entries.every((e) => e.capabilities.includes(tag)));
  }
  assert.deepEqual(arsenalCandidates(process.cwd(), "unknown-capability"), []);
  assert.equal(recipeRequest(findRecipe("pattern-surface"), { output: "/tmp/pattern" }).extensions, "tissue");
  assert.equal(recipeRequest(findRecipe("molecule"), { output: "/tmp/molecule" }).extensions, "molecularnodes");
});

test("PDB acquisition pins exact bytes and attribution, reuses cache and repairs corruption", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "avc-pdb-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://files.rcsb.org/download/1ABC.pdb");
    assert.equal(options?.redirect, "error");
    return new Response(pdb);
  };
  const first = await acquirePdb("1abc", root, fetcher);
  assert.equal(first.reused, false);
  assert.match(first.receipt.attribution, /SYNTHETIC/);
  assert.equal(first.receipt.licence, "CC0-1.0");
  assert.equal(readFileSync(first.file, "utf8"), pdb);
  assert.equal(existsSync(path.join(path.dirname(first.file), "source.json")), true);
  assert.equal((await acquirePdb("1ABC", root, fetcher)).reused, true);
  assert.equal(calls, 1);
  writeFileSync(first.file, "corrupt");
  assert.equal((await acquirePdb("1ABC", root, fetcher)).reused, false);
  assert.equal(calls, 2);
  await assert.rejects(acquirePdb("../escape", root, fetcher));
  assert.equal(calls, 2);
  await assert.rejects(
    acquirePdb("2ABC", root, async () => new Response("<html>error</html>")),
    /no PDB atom/,
  );
  await assert.rejects(
    acquirePdb("2ABC", root, async () => new Response("not found", { status: 404 })),
    /HTTP 404/,
  );
  await assert.rejects(
    acquirePdb("2ABC", root, async () => new Response("x".repeat(16 * 1024 * 1024 + 1))),
    /16 MiB/,
  );
});

test("pure Python frame remap and complete-payload validation", () => {
  const result = spawnSync(pythonUv(), pythonArgs("stdlib", ["tests/blender-fx.test.py"]), {
    env: pythonEnvironment("stdlib"),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test(
  "real Blender: FX cache reuse and frame-alone/range CPU pixels",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 3_600_000 },
  async (t) => {
    const directory = process.env.BLENDER_FX_TEST_OUTPUT ?? mkdtempSync(path.join(tmpdir(), "avc-fx-real-"));
    mkdirSync(directory, { recursive: true });
    if (!process.env.BLENDER_FX_TEST_OUTPUT) t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "glycine.pdb");
    writeFileSync(file, pdb);
    const cases = [
      { id: "liquid-pour", params: { resolution: 32, mesh_scale: 1, simulation_frames: 24 } },
      { id: "product-splash", params: { resolution: 32, mesh_scale: 1, simulation_frames: 24 } },
      { id: "smoke-plume", params: { resolution: 32, simulation_frames: 24 } },
      { id: "smoke-plume", params: { resolution: 32, method: "grid", simulation_frames: 24 } },
      { id: "pattern-surface", params: { cells: 5 } },
      { id: "molecule", params: { file } },
    ];
    const results = [];
    for (const [index, entry] of cases.entries()) {
      const meta = findRecipe(entry.id),
        output = path.join(directory, `${index}-${entry.id}`);
      const range = await renderRecipe(meta, {
        output: path.join(output, "range"),
        params: entry.params,
        frames: [16, 18],
        samples: 8,
        resolution: [480, 270],
        device: "cpu",
      });
      const alone = await renderRecipe(meta, {
        output: path.join(output, "alone"),
        params: entry.params,
        frames: [17, 17],
        samples: 8,
        resolution: [480, 270],
        device: "cpu",
      });
      const pixels = determinism(
        readRecipeFrame(range.frames[1]!.path, [480, 270]),
        readRecipeFrame(alone.frames[0]!.path, [480, 270]),
      );
      assert.equal(pixels.exact, true, `${entry.id}: ${JSON.stringify(pixels)}`);
      assert.equal(range.render.blenderVersion, "5.3.0");
      if (range.stats.result.bake) {
        assert.equal(alone.stats.result.bake?.path, range.stats.result.bake.path);
        assert.equal(alone.stats.result.bake?.reused, true);
      }
      assert.ok(range.stats.polygons > 0);
      results.push({
        id: entry.id,
        params: entry.params,
        pixels,
        stats: range.stats,
        rangeSeconds: range.elapsedSec,
        aloneSeconds: alone.elapsedSec,
      });
      writeFileSync(path.join(directory, "fx-results.json"), JSON.stringify(results, null, 2));
    }
  },
);

test("PDB cache refuses symlink writes outside the selected worktree", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "avc-pdb-safe-")),
    outside = mkdtempSync(path.join(tmpdir(), "avc-pdb-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, "blender-arsenal/local/generated"), { recursive: true });
  symlinkSync(outside, path.join(root, "blender-arsenal/local/generated/molecularnodes"));
  let called = false;
  await assert.rejects(
    acquirePdb("1ABC", root, async () => {
      called = true;
      return new Response(pdb);
    }),
    /symlink/,
  );
  assert.equal(called, false);
});

test("generator pins are strict and require an immutable source identity", () => {
  const entries = readGenerators();
  for (const id of ["mantaflow", "volume-grids", "procedural-materials"])
    assert.ok(entries.some((e) => e.id === id && e.status === "approved"));
  const fx = entries.find((e) => e.id === "mantaflow")!;
  assert.equal(
    GeneratorManifestSchema.safeParse({
      schemaVersion: 1,
      generators: [{ ...fx, install: { ...fx.install, method: "external", commit: null } }],
    }).success,
    false,
  );
  assert.equal(GeneratorManifestSchema.safeParse({ schemaVersion: 1, generators: [fx, fx] }).success, false);
  assert.equal(
    GeneratorManifestSchema.safeParse({ schemaVersion: 1, generators: [{ ...fx, unknown: true }] }).success,
    false,
  );
});

test(
  "real Blender: flagship frame-order pixels, grounded contact and safe framing",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 600_000 },
  async (t) => {
    const directory = process.env.BLENDER_FX_TEST_OUTPUT ?? mkdtempSync(path.join(tmpdir(), "avc-fx-hero-"));
    if (!process.env.BLENDER_FX_TEST_OUTPUT) t.after(() => rmSync(directory, { recursive: true, force: true }));
    const outputs = [];
    for (const [label, frames] of [
      ["range", [16, 18]],
      ["alone", [17, 17]],
    ] as const) {
      const request = recipeRequest(findRecipe("product-splash"), {
        output: path.join(directory, `flagship-${label}`),
        frames: [...frames],
        samples: 8,
        resolution: [480, 270],
        device: "cpu",
      });
      request.script = path.resolve("scripts/blender/shots/product_splash.py");
      request.scriptArgs = [JSON.stringify({ variant: "b", resolution: 64, mesh_scale: 2, simulation_frames: 32 })];
      outputs.push(await runBlender(request));
    }
    const pixels = determinism(
      readRecipeFrame(outputs[0]!.frames[1]!.path, [480, 270]),
      readRecipeFrame(outputs[1]!.frames[0]!.path, [480, 270]),
    );
    assert.equal(pixels.exact, true, JSON.stringify(pixels));
    const craft = JSON.parse(readFileSync(path.join(outputs[1]!.output, "craft-report.json"), "utf8")) as {
      rows: Array<{ floorGap: number }>;
      problems: string[];
    };
    assert.deepEqual(craft.problems, []);
    assert.equal(craft.rows.length, 5);
    assert.ok(craft.rows.every((row) => Math.abs(row.floorGap) <= 0.00001));
    writeFileSync(path.join(directory, "flagship-results.json"), JSON.stringify({ pixels, craft }, null, 2));
  },
);
