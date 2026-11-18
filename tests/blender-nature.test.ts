import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { arsenalCandidates } from "../src/lib/blender-arsenal/overview";
import { GeneratorManifestSchema, readGenerators } from "../src/lib/blender-arsenal/generators";
import { findRecipe, readRecipeFrame, recipeRequest, renderRecipe } from "../src/lib/blender-arsenal/recipes";
import { RecipeMetaSchema } from "../src/lib/blender-arsenal/recipe-schema";
import { runBlender } from "../src/lib/backends/blender-run";
import { determinism } from "../src/lib/blender-arsenal/recipe-quality";

const ids = ["terrain", "tree", "vegetation-scatter", "sky-atmosphere"];

test("nature discovery includes approved, deferred and rejected tools by exact capability", () => {
  const candidates = arsenalCandidates(process.cwd(), "nature");
  assert.deepEqual(
    new Set(candidates.map((c) => c.id)),
    new Set(["blender-nature", "sapling_tree_gen", "infinigen", "gscatter"]),
  );
  assert.equal(candidates.find((c) => c.id === "gscatter")?.verdict, "reject");
  assert.equal(candidates.find((c) => c.id === "infinigen")?.verdict, "deferred");
  assert.equal(candidates.find((c) => c.id === "sapling_tree_gen")?.status, "approved");
  assert.deepEqual(arsenalCandidates(process.cwd(), "unknown-capability"), []);
  const generators = readGenerators();
  assert.equal(
    GeneratorManifestSchema.safeParse({ schemaVersion: 1, generators: [...generators, generators[0]] }).success,
    false,
  );
  const external = generators.find((g) => g.id === "infinigen")!;
  assert.equal(
    GeneratorManifestSchema.safeParse({
      schemaVersion: 1,
      generators: [{ ...external, install: { ...external.install, commit: null } }],
    }).success,
    false,
  );
  assert.equal(
    GeneratorManifestSchema.safeParse({ schemaVersion: 1, generators: [{ ...external, unknown: 1 }] }).success,
    false,
  );
});

test("generator manifests cannot escape through a symlink", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "avc-generators-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "blender-arsenal"));
  symlinkSync(path.resolve("blender-arsenal/generators.json"), path.join(directory, "blender-arsenal/generators.json"));
  assert.throws(() => readGenerators(directory), /symlink|outside|escape/i);
});

test("nature recipes declare dependency metadata and remain data-only during discovery", () => {
  for (const id of ids)
    assert.deepEqual(RecipeMetaSchema.parse(findRecipe(id)).requires, { extensions: [], generators: [] });
  const request = recipeRequest(findRecipe("tree"), {
    output: "/tmp/nature-request",
    params: { engine: "sapling" },
    extensions: "sapling_tree_gen",
  });
  assert.equal(request.extensions, "sapling_tree_gen");
  const cli = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/blender-arsenal.ts", "status", "--capability", "nature"],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(cli.stdout).error, "INVALID_INPUT");
});

test(
  "real Blender: nature wrappers render and frame-alone pixels equal range pixels",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 600_000 },
  async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "avc-nature-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const id of ids) {
      const meta = findRecipe(id);
      const options = { frames: [31, 33] as [number, number], resolution: [160, 90] as [number, number], samples: 4 };
      const range = await renderRecipe(meta, { ...options, output: path.join(directory, id, "range") });
      const alone = await renderRecipe(meta, {
        ...options,
        frames: [32, 32],
        output: path.join(directory, id, "alone"),
      });
      const pixels = range.frames.map((f) => readRecipeFrame(f.path, options.resolution));
      const exact = determinism(pixels[1]!, readRecipeFrame(alone.frames[0]!.path, options.resolution));
      assert.equal(exact.exact, true, `${id}: ${JSON.stringify(exact)}`);
      if (["terrain", "sky-atmosphere"].includes(id)) {
        const empty = await renderRecipe(meta, {
          ...options,
          frames: [32, 32],
          emptyStage: true,
          output: path.join(directory, id, "empty"),
        });
        assert.equal(
          determinism(pixels[1]!, readRecipeFrame(empty.frames[0]!.path, options.resolution)).exact,
          false,
          `${id}: baseline must remove its terrain or environment`,
        );
      }
      assert.ok(range.stats.objects > 1 && range.stats.polygons > 0);
      if (meta.needs_bake) assert.equal(alone.stats.result.bake?.reused, true, id);
      if (["tree", "vegetation-scatter"].includes(id))
        assert.equal(determinism(pixels[0]!, pixels[2]!).exact, false, `${id} must move`);
      t.diagnostic(
        `${id}: ${range.elapsedSec.toFixed(3)}s / 3 frames; ${range.stats.objects} objects, ${range.stats.polygons} polygons, ${range.stats.instances} instances; exact=${exact.exact}`,
      );
    }
  },
);

test(
  "real Blender: Sapling cached tree renders deterministically on 5.3",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 300_000 },
  async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "avc-sapling-nature-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const meta = findRecipe("tree");
    const options = {
      params: { engine: "sapling", species: "birch", seed: 41 },
      extensions: "sapling_tree_gen",
      frames: [31, 33] as [number, number],
      samples: 4,
      resolution: [160, 90] as [number, number],
    };
    const range = await renderRecipe(meta, { ...options, output: path.join(directory, "range") });
    const alone = await renderRecipe(meta, { ...options, frames: [32, 32], output: path.join(directory, "alone") });
    assert.equal(alone.stats.result.bake?.reused, true);
    assert.equal(
      determinism(
        readRecipeFrame(range.frames[1]!.path, options.resolution),
        readRecipeFrame(alone.frames[0]!.path, options.resolution),
      ).exact,
      true,
    );
    t.diagnostic(
      `Sapling: ${range.elapsedSec.toFixed(3)}s / 3 frames, ${range.stats.polygons} polygons; cache=${alone.stats.result.bake?.reused}`,
    );
  },
);

test(
  "real Blender: scanned material displacement cannot replace the terrain surface",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 120_000 },
  async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "avc-nature-material-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const script = path.join(directory, "surface.py");
    writeFileSync(
      script,
      `import bpy, avc_assets
from avc_recipes import apply
mat = bpy.data.materials.new('Native scanned fixture')
mat.use_nodes = True
n = mat.node_tree.nodes
out = next(node for node in n if node.type == 'OUTPUT_MATERIAL')
displacement = n.new('ShaderNodeDisplacement')
mat.node_tree.links.new(displacement.outputs[0], out.inputs['Displacement'])
original = avc_assets.append
try:
    avc_assets.append = lambda *args, **kwargs: mat
    result = apply('terrain', {'rock_material':'fixture:rock', 'ground_material':'fixture:ground'})
finally:
    avc_assets.append = original
blend = bpy.data.materials[result['materials'][0]]
for wrapper in (node for node in blend.node_tree.nodes if node.type == 'GROUP'):
    output = next(node for node in wrapper.node_tree.nodes if node.type == 'GROUP_OUTPUT')
    assert len(output.inputs[0].links) == 1
    assert output.inputs[0].links[0].from_node.type == 'BSDF_PRINCIPLED'
`,
    );
    await runBlender({
      ...recipeRequest(findRecipe("terrain"), { output: path.join(directory, "output"), bake: true }),
      script,
      scriptArgs: [],
    });
  },
);
