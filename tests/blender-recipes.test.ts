import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { blenderArguments, blenderProfileEnvironment, runBlender } from "../src/lib/backends/blender-run";
import { RgbImage } from "../src/lib/vision/image";
import { determinism, recipeQuality } from "../src/lib/blender-arsenal/recipe-quality";
import { RecipeMetaSchema, RecipeProofSchema, RecipeStatsSchema } from "../src/lib/blender-arsenal/recipe-schema";
import {
  findRecipe,
  listRecipes,
  proofRecipes,
  recipeRequest,
  renderRecipe,
  readRecipeFrame,
  validateRecipeParams,
  type ProofDependencies,
} from "../src/lib/blender-arsenal/recipes";

const recipes = listRecipes();
const image = (offset = 0) => {
  const frame = RgbImage.filled(32, 18, [28, 35, 42]);
  frame.fillRect(8 + offset, 4, 10, 10, [140, 100, 50]);
  return frame;
};
const baseline = () => RgbImage.filled(32, 18, [28, 35, 42]);

test("literal META records have typed bounded defaults and opening shot intents", () => {
  assert.ok(recipes.length >= 20);
  assert.equal(new Set(recipes.map((r) => r.id)).size, recipes.length);
  for (const meta of recipes) {
    assert.deepEqual(RecipeMetaSchema.parse(meta), meta);
    assert.equal(Object.keys(validateRecipeParams(meta, {})).length, Object.keys(meta.params).length);
    assert.deepEqual(Object.keys(meta.cost_hint).sort(), ["cycles", "eevee"]);
  }
  assert.throws(() => RecipeMetaSchema.parse({ ...recipes[0], unknown: true }));
  assert.throws(() =>
    RecipeMetaSchema.parse({
      ...recipes[0],
      params: { n: { type: "integer", default: 1.5, min: 0, max: 1, doc: "invalid" } },
    }),
  );
});

test("params reject unknown keys, type confusion, non-finite and out-of-range values", () => {
  const meta = findRecipe("confetti", recipes);
  for (const value of [
    [],
    null,
    "wrong",
    { count: true },
    { count: 12.5 },
    { count: Infinity },
    { count: 2 },
    { seed: null },
    { unknown: 1 },
  ])
    assert.throws(() => validateRecipeParams(meta, value));
  assert.throws(() => findRecipe("../escape", recipes));
  assert.equal(validateRecipeParams(meta, { count: 12 }).count, 12);
});

test("recipe request uses the existing backend and isolated profile, without shell interpolation", () => {
  const meta = findRecipe("text-3d", recipes);
  const request = recipeRequest(meta, { output: "/tmp/a path", params: { text: "$(touch nope)" }, frames: [1, 31] });
  assert.equal(request.device, "cpu");
  assert.equal(recipeRequest(meta, { output: "/tmp/metal", device: "auto" }).device, "auto");
  assert.equal(request.factoryStartup, true);
  assert.match(request.script!, /recipes\/_render\.py$/);
  assert.match(request.userResources!, /blender-arsenal\/local\/trials\/recipe-profile$/);
  assert.equal(JSON.parse(request.scriptArgs[0]!).params.text, "$(touch nope)");
  const argv = blenderArguments(request);
  assert.ok(argv.includes("--disable-autoexec") && argv.includes("--offline-mode"));
  assert.equal(argv.at(-1), request.scriptArgs[0]);
  for (const value of Object.values(blenderProfileEnvironment(request.userResources!)))
    assert.ok(value.startsWith(request.userResources!));
  const bake = recipeRequest(findRecipe("cloth-drape", recipes), { output: "/tmp/bake", bake: true });
  assert.equal(bake.noRender, true);
  assert.equal(bake.frames, undefined);
  assert.throws(() => recipeRequest(meta, { output: "/tmp/x", frames: [4, 2] }));
  assert.throws(() => recipeRequest(meta, { output: "/tmp/x", frames: [1, 65] }));
  assert.throws(() => recipeRequest(meta, { output: "/tmp/x", resolution: [0, 40] }));
  assert.throws(() => recipeRequest(meta, { output: "/tmp/x", params: null }));
});

test("pixel determinism reports exact, max absolute difference and finite PSNR", () => {
  assert.deepEqual(determinism(image(), image()), { pass: true, exact: true, maxAbsDiff: 0, psnr: null });
  const changed = image();
  changed.data[0]! += 1;
  const result = determinism(image(), changed);
  assert.equal(result.maxAbsDiff, 1);
  assert.equal(result.pass, false);
  assert.ok(result.psnr! > 50);
  assert.throws(() => determinism(image(), RgbImage.filled(2, 2, [0, 0, 0])));
});

test("Metal permits sparse two-level rounding, but refuses systematic drift", () => {
  const a = RgbImage.filled(640, 360, [40, 40, 40]),
    b = RgbImage.filled(640, 360, [40, 40, 40]);
  b.data[0] = 42;
  assert.equal(determinism(a, b).pass, false);
  assert.equal(determinism(a, b, "METAL").pass, true);
  b.data.fill(41);
  assert.equal(determinism(a, b, "METAL").pass, false);
});

test("backend passes all profile locations to Blender and creates them before startup", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "avc-recipe-profile-"));
  try {
    const executable = path.join(directory, "fake-blender");
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version')) { process.stdout.write('Blender 5.2.3 LTS'); process.exit(0); }
const request = JSON.parse(fs.readFileSync(process.env.AGENTBROS_BLENDER_REQUEST, 'utf8'));
const profile = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('BLENDER_USER_') || key === 'BLENDER_SYSTEM_EXTENSIONS'));
fs.writeFileSync(path.join(request.output, 'profile.json'), JSON.stringify(profile));
fs.writeFileSync(request.resultFile, JSON.stringify({ blenderVersion:'5.2.3', engine:'CYCLES', device:'CPU', samples:4, width:160, height:90, fps:30, filmTransparent:false, viewTransform:'AgX', look:'None', motionBlur:true, frameStart:1, frameEnd:64, rendered:false }));
`,
      { mode: 0o755 },
    );
    const request = recipeRequest(findRecipe("dust-burst", recipes), {
      output: path.join(directory, "output"),
      bake: true,
      executable,
    });
    request.userResources = path.join(directory, "isolated");
    await runBlender(request);
    const actual = JSON.parse(readFileSync(path.join(request.output, "profile.json"), "utf8")) as Record<
      string,
      string
    >;
    assert.deepEqual(actual, blenderProfileEnvironment(request.userResources));
    for (const file of Object.values(actual)) assert.equal(existsSync(file), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quality accepts coherent motion, rejects blank, clipped, uncovered and static proofs", () => {
  const frames = [image(0), image(1), image(2)];
  const empty = frames.map(baseline);
  assert.equal(recipeQuality(frames, empty).pass, true);
  for (const [colour, failure] of [
    [[0, 0, 0], "empty-or-blank"],
    [[255, 255, 255], "clipped-highlights"],
  ] as const) {
    const flat = frames.map(() => RgbImage.filled(32, 18, colour));
    assert.ok(recipeQuality(flat, empty).failures.includes(failure));
  }
  assert.ok(recipeQuality(empty, empty).failures.includes("subject-coverage"));
  assert.ok(recipeQuality([image(), image(), image()], empty).failures.includes("no-temporal-activity"));
  assert.equal(recipeQuality([image(), image(), image()], empty, { requireActivity: false }).pass, true);
  assert.ok(recipeQuality(frames).failures.includes("coverage-baseline-missing"));
  assert.equal(recipeQuality(frames, undefined, { requireCoverage: false }).pass, true);
});

test("quality detects flicker and a missing floor contact patch", () => {
  const frames = [image(), image(), RgbImage.filled(32, 18, [200, 200, 200]), image(), image()];
  assert.ok(recipeQuality(frames, frames.map(baseline)).failures.includes("temporal-flicker"));
  const contact = { x: 8, y: 15, width: 10, height: 2 };
  const good = [image(), image(1), image(2)];
  assert.ok(
    recipeQuality(good, good.map(baseline), { contactRegion: contact }).failures.includes("missing-contact-shadow"),
  );
  good.forEach((frame) => frame.fillRect(8, 15, 10, 2, [10, 10, 10]));
  assert.equal(recipeQuality(good, good.map(baseline), { contactRegion: contact }).pass, true);
  assert.throws(() => recipeQuality([], []));
  assert.throws(() => recipeQuality(good, []));
});

test("zero-mean floor noise is not contact shadow evidence", () => {
  const frames = [image(), image(1), image(2)],
    empty = frames.map(baseline);
  for (const frame of frames)
    for (let x = 0; x < 32; x++) frame.fillRect(x, 16, 1, 2, x % 2 ? [40, 40, 40] : [60, 60, 60]);
  empty.forEach((frame) => frame.fillRect(0, 16, 32, 2, [50, 50, 50]));
  assert.ok(
    recipeQuality(frames, empty, { contactRegion: { x: 0, y: 16, width: 32, height: 2 } }).failures.includes(
      "missing-contact-shadow",
    ),
  );
});

test("a smooth reveal followed by a long hold is not a flicker spike", () => {
  const frames = Array.from({ length: 64 }, (_, i) => {
    const frame = baseline();
    const value = 80 + Math.min(i, 10) * 5;
    frame.fillRect(2, 2, 28, 14, [value, value, value]);
    return frame;
  });
  assert.equal(recipeQuality(frames, frames.map(baseline)).failures.includes("temporal-flicker"), false);
});

test("flicker magnitude and ratio must belong to the same frame", () => {
  const frames = Array.from({ length: 25 }, (_, i) => {
    const value = 40 + Math.min(i, 5) * 4 + (i === 15 ? 2 : 0);
    return RgbImage.filled(32, 18, [value, value, value]);
  });
  assert.equal(recipeQuality(frames, frames.map(baseline)).failures.includes("temporal-flicker"), false);
});

test("sparse key-frame deltas are normalised by their frame gaps", () => {
  const frames = [image(0), image(1), image(2)];
  const full = recipeQuality(frames, frames.map(baseline));
  const sparse = recipeQuality(frames, frames.map(baseline), { frameNumbers: [1, 11, 21] });
  assert.ok(Math.abs(sparse.activity - full.activity / 10) < 1e-10);
  const held = image();
  for (let i = 0; i < held.data.length / 2; i++) held.data[i]! += 1;
  const uneven = recipeQuality([image(), held, held], [baseline(), baseline(), baseline()], {
    frameNumbers: [1, 2, 64],
  });
  assert.ok(Math.abs(uneven.activity - 0.5 / 63) < 1e-10);
  assert.ok(uneven.failures.includes("no-temporal-activity"));
  assert.throws(() => recipeQuality(frames, undefined, { frameNumbers: [1, 1, 3] }));
  assert.throws(() => recipeQuality(frames, undefined, { frameNumbers: [1, 3] }));
});

test("pure Python maths, cache identity and complete-cache reuse", () => {
  const result = spawnSync("python3", ["tests/blender-recipes.test.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("CLI keeps one JSON line and validates without launching Blender", () => {
  const cases: Array<[string[], boolean]> = [
    [["list"], true],
    [["describe", "--id", "dissolve"], true],
    [["render", "--id", "shatter", "--params", '{"oops":1}', "--dry-run"], false],
    [["render", "--id", "shatter", "--params", "null", "--dry-run"], false],
    [["proof", "--all", "--frames", "1-1", "--dry-run"], false],
    [["bake", "--id", "cloth-drape", "--frames", "1-3", "--dry-run"], false],
  ];
  for (const [argv, expected] of cases) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/blender-recipe.ts", ...argv], {
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
    });
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, result.stderr);
    const envelope = JSON.parse(lines[0]!);
    assert.equal(envelope.ok, expected);
    assert.equal(result.status, expected ? 0 : 1);
  }
});

test("proof retains partial metrics and failures in a strict index", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "avc-recipe-proof-"));
  try {
    const report = await proofRecipes(
      recipes.slice(0, 2),
      { output: directory, frames: [1, 3], resolution: [32, 18] },
      {
        render: async () => {
          throw new Error("fake startup failure");
        },
        readFrame: () => image(),
        sheet: () => "unused",
      },
    );
    assert.equal(report.pass, false);
    assert.equal(report.recipes.length, 2);
    assert.ok(report.recipes.every((r) => r.error === "fake startup failure"));
    assert.deepEqual(
      RecipeProofSchema.parse(JSON.parse(readFileSync(path.join(directory, "index.json"), "utf8"))),
      report,
    );
    await assert.rejects(proofRecipes(recipes, { output: directory, frames: [1, 3] }), /Proof index exists/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const device of ["CPU", "METAL"])
  test(`proof covers range, alone, empty stage and ${device} determinism before passing`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "avc-recipe-success-"));
    const calls: string[] = [];
    let mismatch = false;
    try {
      const meta = findRecipe("abstract-field", recipes);
      const deps: ProofDependencies = {
        render: async (_meta, options) => {
          calls.push(path.basename(options.output));
          if (options.emptyStage) assert.deepEqual(options.frames, [2, 2]);
          const frames = options.frames!;
          return {
            output: options.output,
            logFile: path.join(directory, "missing.log"),
            frames: Array.from({ length: frames[1] - frames[0] + 1 }, (_, i) => ({
              frame: frames[0] + i,
              path: `${options.emptyStage ? "empty" : "subject"}-${frames[0] + i}`,
              sha256: "fixture",
            })),
            stats: RecipeStatsSchema.parse({
              recipe: meta.id,
              objects: 1,
              polygons: 12,
              instances: 0,
              result: { objects: ["fixture"], materials: [], bake: null },
            }),
            manifest: "fixture",
            render: {
              device: options.device === "cpu" ? "CPU" : device,
              blenderVersion: mismatch && path.basename(options.output) === "alone" ? "5.3.0" : "5.2.3 LTS",
            } as never,
            elapsedSec: 1,
            executable: "fixture",
            review: undefined,
            camera: undefined,
            encoded: undefined,
            script: undefined,
            blend: undefined,
          };
        },
        readFrame: (file) => (file.startsWith("empty") ? baseline() : image(Number(file.split("-")[1]) - 1)),
        sheet: (_image, file) => file,
      };
      const report = await proofRecipes([meta], { output: directory, frames: [1, 3], resolution: [32, 18] }, deps);
      assert.equal(report.pass, true);
      assert.equal(report.recipes[0]!.determinism!.exact, true);
      assert.deepEqual(
        calls,
        device === "METAL" ? ["range", "alone", "empty", "cpu-range", "cpu-alone"] : ["range", "alone", "empty"],
      );
      if (device === "METAL") assert.equal(report.recipes[0]!.cpuDeterminism!.exact, true);
      assert.equal(report.settings.blenderVersion, "5.2.3 LTS");
      mismatch = true;
      const changed = await proofRecipes(
        [meta],
        { output: path.join(directory, "mismatch"), frames: [1, 3], resolution: [32, 18] },
        deps,
      );
      assert.equal(changed.pass, false);
      assert.match(changed.recipes[0]!.error!, /Blender version changed/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

test(
  "real Blender: legacy recipes, one midpoint alone versus a three-frame range, exact CPU pixels",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 3_600_000 },
  async () => {
    const retainedOutput = process.env.BLENDER_RECIPE_TEST_OUTPUT;
    const directory = retainedOutput ?? mkdtempSync(path.join(tmpdir(), "avc-recipes-real-"));
    mkdirSync(directory, { recursive: true });
    const report = RecipeProofSchema.parse({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      settings: { samples: 4, resolution: [160, 90], frames: [16, 18], engine: "cycles", device: "cpu" },
      pass: false,
      recipes: [],
      sheet: null,
    });
    try {
      for (const meta of recipes.filter(
        (r) => !r.requires?.extensions.length && !["liquid-pour", "product-splash", "smoke-plume"].includes(r.id),
      )) {
        const entry: (typeof report.recipes)[number] = { id: meta.id, status: "failed" };
        report.recipes.push(entry);
        try {
          const range = await renderRecipe(meta, {
            output: path.join(directory, meta.id, "range"),
            frames: [16, 18],
            samples: 4,
            resolution: [160, 90],
            device: "cpu",
          });
          const alone = await renderRecipe(meta, {
            output: path.join(directory, meta.id, "alone"),
            frames: [17, 17],
            samples: 4,
            resolution: [160, 90],
            device: "cpu",
          });
          report.settings.blenderVersion ??= range.render.blenderVersion;
          assert.equal(range.render.blenderVersion, report.settings.blenderVersion);
          assert.equal(alone.render.blenderVersion, report.settings.blenderVersion);
          if (process.env.BLENDER_EXPECTED_VERSION)
            assert.equal(range.render.blenderVersion, process.env.BLENDER_EXPECTED_VERSION);
          entry.blenderVersion = range.render.blenderVersion;
          entry.device = range.render.device;
          entry.stats = range.stats;
          entry.determinism = determinism(
            readRecipeFrame(range.frames[1]!.path, [160, 90]),
            readRecipeFrame(alone.frames[0]!.path, [160, 90]),
          );
          entry.status = entry.determinism.pass ? "passed" : "failed";
        } catch (error) {
          entry.error = String(error);
        }
        writeFileSync(path.join(directory, "index.json"), JSON.stringify(RecipeProofSchema.parse(report), null, 2));
      }
      report.pass = report.recipes.every((row) => row.status === "passed");
      writeFileSync(path.join(directory, "index.json"), JSON.stringify(RecipeProofSchema.parse(report), null, 2));
      assert.equal(report.pass, true, JSON.stringify(report.recipes.filter((row) => row.status === "failed")));
    } finally {
      if (!retainedOutput) rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real Blender: effects preserve existing objects and compositor chains",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "avc-recipes-compose-"));
    try {
      const script = path.join(directory, "compose.py");
      writeFileSync(
        script,
        `import bpy, avc_export
from avc_recipes import apply
avc_export.apply_overrides()
assert bpy.context.scene.render.dither_intensity == 0
assert not hasattr(bpy.context.scene.render,"compositor_device") or bpy.context.scene.render.compositor_device == "CPU"
assert not hasattr(bpy.context.scene.cycles,"denoising_use_gpu") or not bpy.context.scene.cycles.denoising_use_gpu
bpy.ops.mesh.primitive_cube_add(location=(0,0,1))
source=bpy.context.object
source.name="Existing hero"
source.data.materials.append(bpy.data.materials.new("Original finish"))
for recipe in ("grow-in", "dissolve", "light-sweep", "scatter-surface"):
    if recipe == "scatter-surface":
        source.modifiers.clear()
    before=set(bpy.data.objects)
    materials=set(bpy.data.materials)
    result=apply(recipe,{"object":source.name})
    assert set(result["objects"]) == {o.name for o in bpy.data.objects if o not in before}
    assert set(result["materials"]) == {m.name for m in bpy.data.materials if m not in materials}
    assert source.name not in result["objects"], (recipe,result)
assert source.name in bpy.context.scene.objects
source.shape_key_add(name="Basis")
try:
    apply("scatter-surface",{"object":source.name})
except ValueError as exc:
    assert "static mesh geometry" in str(exc)
else:
    raise AssertionError("Deforming scatter source was silently frozen")
from kit import look
scene=bpy.context.scene
tree=look.grade(scene,"clean")
original_nodes=set(tree.nodes)
apply("dissolve",{"object":source.name})
apply("neon-glow",{})
assert scene.compositing_node_group == tree
assert original_nodes.issubset(set(tree.nodes))
assert tree.nodes.get("AVC Dissolve bloom") and tree.nodes.get("AVC Neon bloom")
output=next(n for n in tree.nodes if n.type=="GROUP_OUTPUT" and n.is_active_output)
assert output.inputs[0].links[0].from_node.name == "AVC Neon bloom"
assert tree.nodes["AVC Neon bloom"].inputs["Image"].links[0].from_node.name == "AVC Dissolve bloom"
`,
      );
      const request = recipeRequest(findRecipe("neon-glow", recipes), {
        output: path.join(directory, "output"),
        bake: true,
      });
      await runBlender({ ...request, script, scriptArgs: [] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
