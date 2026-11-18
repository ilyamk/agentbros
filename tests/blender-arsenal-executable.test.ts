import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectCheckout, parsePlannedCommand } from "../src/lib/blender-arsenal/eval-checkout";
import { scoreExecutablePlan, inspectPythonPlans, distribution } from "../src/lib/blender-arsenal/eval-executable";
import { readArsenalTasks } from "../src/lib/blender-arsenal/eval";
import { executablePlan } from "./blender-arsenal-eval-fixtures";

const root = process.cwd(),
  inventory = inspectCheckout(root),
  task = readArsenalTasks("bench/blender-arsenal/tasks.json")[0]!;

test("checkout inspection extracts real registry aliases, flags, recipes, source states and pins", () => {
  assert.ok(inventory.commands["blender:run"]?.flags.some((f) => f.name === "frames"));
  assert.ok(inventory.commands["blender:recipe"]?.actions.includes("render"));
  assert.equal(inventory.recipes.length, 28);
  assert.ok(inventory.assets.some((a) => a.id === "ambientcg:Wood096"));
  assert.ok(inventory.extensions.some((e) => e.id === "commotion" && e.status === "proposed"));
});

test("a complete native script with actual parameters passes static verification", () => {
  const result = scoreExecutablePlan(task, executablePlan(), root, inventory);
  assert.equal(result.score, 100, JSON.stringify(result.findings));
});

test("fake recipe, wrong flag and out-of-bounds or unknown parameters lose executable points", () => {
  for (const [id, params] of [
    ["fake-recipe", {}],
    ["confetti", { count: 999999 }],
    ["confetti", { wrong: true }],
    ["confetti", { count: "wrong" }],
  ] as const) {
    const p = executablePlan();
    p.execution.recipes.push({ id, params: JSON.stringify(params) });
    const result = scoreExecutablePlan(task, p, root, inventory);
    assert.ok(result.score < 100);
    assert.ok(
      result.findings.some((f) => f.category === "references" && /Recipe/.test(f.message)),
      JSON.stringify(result),
    );
  }
  const p = executablePlan();
  p.commands[1]!.argv.push("--invented-flag", "true");
  const result = scoreExecutablePlan(task, p, root, inventory);
  assert.ok(result.score < 100 && result.findings.some((f) => f.message.includes("unknown flag")));
});

test("checkout-specific inventory rejects capabilities absent from that checkout", () => {
  const empty = { ...inventory, commands: {}, recipes: [], assets: [], extensions: [], collections: {} };
  const p = executablePlan();
  p.execution.recipes.push({ id: "confetti", params: '{"count":24}' });
  p.execution.assets.push("ambientcg:Wood096");
  const result = scoreExecutablePlan(task, p, root, empty);
  assert.ok(result.findings.some((f) => /Unknown checkout command/.test(f.message)));
  assert.ok(result.findings.some((f) => /Recipe absent/.test(f.message)));
  assert.ok(result.findings.some((f) => /Asset pinned/.test(f.message)));
});

test("proposed extensions require explicit conditional approval and real asset ids", () => {
  const p = executablePlan();
  p.execution.extensions.push({ id: "commotion", requiresApproval: false });
  p.execution.assets.push("polyhaven:imaginary");
  const result = scoreExecutablePlan(task, p, root, inventory);
  assert.ok(result.findings.some((f) => f.category === "safety" && f.message.includes("Unapproved extension")));
  assert.ok(result.findings.some((f) => f.category === "references" && f.message.includes("imaginary")));
  p.execution.assets = [];
  p.execution.extensions[0]!.requiresApproval = true;
  assert.equal(scoreExecutablePlan(task, p, root, inventory).score, 100);
});

test("Python is analysed, never executed; syntax, undefined names, stubs and unbaked simulations fail", () => {
  const facts = inspectPythonPlans([
    "raise RuntimeError('MUST NOT EXECUTE')",
    'import bpy\nbpy.context.object.modifiers.new(name="Cloth", type="CLOTH")',
    "def scene():\n    pass",
    "bpy.ops.mesh.primitive_cube_add(",
  ]);
  assert.equal(facts[0]!.error, null);
  assert.equal(facts[1]!.simulation, true);
  assert.equal(facts[1]!.baked, false);
  assert.equal(facts[2]!.concrete, 0);
  assert.ok(facts[3]!.error);
  const p = executablePlan();
  p.execution.scripts[0]!.code +=
    '\nbpy.context.object.modifiers.new(name="Cloth", type="CLOTH")\nmissing_function()\n';
  const result = scoreExecutablePlan(task, p, root, inventory);
  assert.ok(result.findings.some((f) => f.message.includes("simulation bake")));
  assert.ok(result.findings.some((f) => f.message.includes("undefined globals")));
});

test("recipe calls embedded in Python receive the same strict parameter validation", () => {
  const p = executablePlan();
  p.execution.scripts[0]!.code += '\nimport avc_recipes\navc_recipes.apply("confetti", {"count": 99999})\n';
  assert.ok(scoreExecutablePlan(task, p, root, inventory).findings.some((f) => f.message.includes("params rejected")));
});

test("command parser honours boolean and enum/value contracts without invoking CLIs", () => {
  assert.equal(
    parsePlannedCommand(["pnpm", "blender:run", "--output", "out/x", "--engine=invalid"], inventory).faults.length,
    1,
  );
  assert.equal(
    parsePlannedCommand(["pnpm", "blender:recipe", "render", "--id", "confetti", "--params", '{"seed":19}'], inventory)
      .faults.length,
    0,
  );
  assert.equal(
    parsePlannedCommand(["pnpm", "blender:run", "--samples", "bad", "--output", "out/x"], inventory).faults.length,
    1,
  );
});

test("mean and population SD are deterministic, including small samples", () => {
  assert.deepEqual(distribution([60, 80]), { mean: 70, sd: 10, min: 60, max: 80, n: 2 });
  assert.deepEqual(distribution([]), { mean: 0, sd: 0, min: 0, max: 0, n: 0 });
});

test("a valid dust implementation cannot satisfy unrelated shot briefs", () => {
  const tasks = readArsenalTasks("bench/blender-arsenal/tasks.json");
  for (const id of ["logo-shatter", "neon-tech", "fabric-reveal"]) {
    const result = scoreExecutablePlan(
      tasks.find((t) => t.id === id)!,
      executablePlan(),
      root,
      inventory,
    );
    assert.ok(
      result.findings.some((f) => f.message.startsWith("Task-specific effect")),
      id,
    );
  }
});

test("unused numbers and uncalled functions do not count as actual scene evidence", () => {
  const p = executablePlan();
  p.execution.scripts[0]!.code = p.execution.scripts[0]!.code.replace(
    "scene.camera.data.lens = 85",
    "unused = (85, 5600, 0.4, 0.2)",
  )
    .replace("blackbody.inputs['Temperature'].default_value = 5600", "")
    .replace("bsdf.inputs['Roughness'].default_value = 0.4", "");
  assert.ok(scoreExecutablePlan(task, p, root, inventory).findings.some((f) => f.category === "specificity"));
  p.execution.scripts[0]!.code =
    "def build():\n" +
    executablePlan()
      .execution.scripts[0]!.code.split("\n")
      .map((line) => "    " + line)
      .join("\n");
  assert.ok(
    scoreExecutablePlan(task, p, root, inventory).findings.some(
      (f) => f.category === "implementation" && f.message.includes("concrete"),
    ),
  );
});

test("keyword dependencies and enable lists parse, transform bake is not solver bake", () => {
  const [fact] = inspectPythonPlans([
    'import avc_recipes, avc_extensions\navc_recipes.apply(recipe_id="confetti", params={"count":24})\navc_extensions.enable(ids=["camera_shakify"])',
  ]);
  assert.deepEqual(fact!.extensions, ["camera_shakify"]);
  assert.equal(fact!.recipes![0]!.id, "confetti");
  const [cloth] = inspectPythonPlans([
    'import bpy\nfrom kit.anim import Timeline\nbpy.context.object.modifiers.new(name="Cloth", type="CLOTH")\ntimeline = Timeline()\ntimeline.bake()',
  ]);
  assert.equal(cloth!.simulation, true);
  assert.equal(cloth!.baked, false);
});

test("comma-separated proposed extensions cannot be enabled in a local command", () => {
  const p = executablePlan();
  p.commands[1]!.argv.push("--extensions", "commotion,animall");
  p.execution.extensions = [
    { id: "commotion", requiresApproval: true },
    { id: "animall", requiresApproval: true },
  ];
  assert.ok(
    scoreExecutablePlan(task, p, root, inventory).findings.some(
      (f) => f.category === "safety" && f.message.includes("Unapproved extension"),
    ),
  );
});

test("recipe CLI frames must respect META and missing inputs are not executable", () => {
  const p = executablePlan();
  p.commands[1]!.argv = ["pnpm", "blender:recipe", "render", "--id", "confetti", "--frames", "1-120"];
  p.execution.frames = [1, 120];
  assert.ok(
    scoreExecutablePlan(task, p, root, inventory).findings.some(
      (f) => f.category === "commands" && f.message.includes("META limit"),
    ),
  );
  p.commands[1]!.argv = ["pnpm", "blender:run", "--output", "out/x"];
  assert.ok(
    scoreExecutablePlan(task, p, root, inventory).findings.some((f) => f.message.includes("needs --script or --blend")),
  );
});

test("literal dict expansions retain unknown recipe params and native temperature is recognised", () => {
  const [fact] = inspectPythonPlans(['import avc_recipes\navc_recipes.apply("confetti", {"count":24, **{"wrong":1}})']);
  assert.deepEqual(fact!.recipes![0]!.params, { count: 24, wrong: 1 });
  const [light] = inspectPythonPlans(["import bpy\nbpy.context.object.data.temperature = 5600"]);
  assert.deepEqual(light!.temperatures, [5600]);
});

test("all existing positional arsenal actions and explicit still/proof subranges are valid", () => {
  for (const argv of [
    ["pnpm", "blender:arsenal", "status"],
    ["pnpm", "blender:assets", "search", "--query", "desk"],
    ["pnpm", "blender:ext", "list"],
  ])
    assert.deepEqual(parsePlannedCommand(argv, inventory).faults, []);
  const p = executablePlan();
  p.commands.push({
    ...p.commands[1]!,
    argv: ["pnpm", "blender:run", "--script", "shot.py", "--output", "out/still", "--frames", "20-20"],
  });
  assert.equal(scoreExecutablePlan(task, p, root, inventory).score, 100);
});

test("parameterised helpers and aliased node collections supply semantic evidence", () => {
  const [facts] = inspectPythonPlans([
    "import bpy\ndef material(rough):\n    mat = bpy.data.materials.new('Dust')\n    ns = mat.node_tree.nodes\n    volume = ns.new('ShaderNodeVolumePrincipled')\n    bsdf = ns.new('ShaderNodeBsdfPrincipled')\n    bsdf.inputs['Roughness'].default_value = rough\nmaterial(0.4)",
  ]);
  assert.ok(facts!.setupTypes!.includes("ShaderNodeVolumePrincipled"));
  assert.ok(facts!.materials!.some((m) => m.input === "Roughness" && m.value === 0.4));
});

test("standalone bundled inventory supplies the same stable Essentials ids without an index", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "arsenal-bundled-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "src/lib/cli"), { recursive: true });
  writeFileSync(path.join(directory, "src/lib/cli/commands.ts"), "export const COMMAND_REGISTRY = [];");
  mkdirSync(path.join(directory, "blender-arsenal/local/library"), { recursive: true });
  writeFileSync(
    path.join(directory, "blender-arsenal/local/library/blender-bundled.json"),
    JSON.stringify({
      blenderVersion: "5.2.3",
      systemRoot: "/system/datafiles",
      files: [
        {
          path: "/system/datafiles/assets/example.blend",
          sha256: "a".repeat(64),
          assets: [{ name: "Array", category: "geometry-node", catalogId: "fixture" }],
        },
      ],
    }),
  );
  const id = "essentials:" + createHash("sha256").update("assets/example.blend").digest("hex").slice(0, 24);
  assert.ok(inspectCheckout(directory).assets.some((a) => a.id === id));
});

test("literal helper defaults provide the same socket evidence as explicit arguments", () => {
  const [facts] = inspectPythonPlans([
    "import bpy\ndef material(bsdf, roughness=0.4, metallic=0.2):\n    bsdf.inputs['Roughness'].default_value = roughness\n    bsdf.inputs['Metallic'].default_value = metallic\nmaterial(bpy.context.object)",
  ]);
  assert.ok(facts!.materials!.some((m) => m.input === "Roughness" && m.value === 0.4));
  assert.ok(facts!.materials!.some((m) => m.input === "Metallic" && m.value === 0.2));
});

test("no-render verification helpers need no scene construction or animation", () => {
  const p = executablePlan();
  p.execution.scripts.push({ path: "check.py", code: 'import json\nprint(json.dumps({"pixels":0}))' });
  p.commands.push({
    argv: ["pnpm", "blender:run", "--script", "check.py", "--output", "out/check", "--no-render"],
    phase: "local",
    purpose: "Verify decoded pixel output after rendering.",
  });
  assert.equal(scoreExecutablePlan(task, p, root, inventory).score, 100);
});
