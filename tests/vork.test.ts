import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VorkTaskSchema, VorkReceiptSchema } from "../src/types/vork";
import { buildRecipe, recipeParams, VORK_RECIPES } from "../src/lib/vork/recipes";
import { renderPlan, renderVork, sceneInputs, assertVorkResult, exportVork } from "../src/lib/vork/render";
import { digest, hashFile, probeVork, runProcess, vorkEnvironment } from "../src/lib/vork/runtime";
import { importAsset } from "../src/lib/assets/registry";
import { assertImportedVorkAssets, captureVorkProvenance } from "../src/lib/vork/provenance";
import { ProductionRouteSchema } from "../src/types/reference";
import { bridgeVork } from "../src/lib/vork/bridge";
import { runBlender } from "../src/lib/backends/blender-run";

function workspace(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "vork-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fakeEngine(root: string) {
  const image = path.join(root, "fixture.png");
  const encoded = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=0.1", "-frames:v", "1", image],
    { encoding: "utf8" },
  );
  assert.equal(encoded.status, 0, encoded.stderr);
  const executable = path.join(root, "fake-vork.mjs");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2); if(args[0]==='--version'){console.log('vork 0.5.1');process.exit(0);}
const scene=JSON.parse(fs.readFileSync(args[1],'utf8')); if(args[0]==='check')process.exit(0);
if(scene.failure)process.exit(scene.failure);
const out=args[args.indexOf('--out')+1], first=Number(args[args.indexOf('--frame-start')+1]), last=Number(args[args.indexOf('--frame-end')+1]);
for(let i=first;i<=last;i++)fs.copyFileSync(${JSON.stringify(image)},path.join(out,String(i).padStart(6,'0')+'.png'));
if(scene.mutate)fs.writeFileSync(args[1],JSON.stringify({...scene,changed:true}));
if(!scene.noMetadata)fs.writeFileSync(path.join(out,'meta.json'),JSON.stringify({version:3,fps:30,exposure:{coverage:scene.coverage??1},render_settings:{resolution:[16,16],samples:4},frames:Array.from({length:last-first+1},(_,i)=>({index:first+i,time:(first+i)/30})),warnings:scene.warning?[{code:'missing_image',requested:'texture',dropped:'magenta'}]:[]}));
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}
const simpleScene = (file: string, extra: Record<string, unknown> = {}) =>
  writeFileSync(
    file,
    JSON.stringify({ version: 2, nodes: [], render: { resolution: [16, 16], fps: 30, duration: 0.1 }, ...extra }),
  );

test("Vork discovery is pinned, offline-aware and does not install", (t) => {
  const root = workspace(t),
    executable = fakeEngine(root);
  assert.equal(probeVork(executable).available, true);
  assert.equal(probeVork(path.join(root, "missing")).available, false);
  assert.equal(vorkEnvironment().VORK_NO_UPDATE_NOTIFIER, "1");
  assert.equal(vorkEnvironment().FAL_KEY, undefined);
  writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("vork 0.6.0")');
  assert.equal(probeVork(executable).available, false);
});
test("scene dependencies pin buffers, shader imports and external glTF images", (t) => {
  const root = workspace(t),
    scene = path.join(root, "scene.json");
  writeFileSync(path.join(root, "mesh.bin"), "mesh");
  writeFileSync(path.join(root, "shared.slang"), "struct Inputs {};");
  writeFileSync(path.join(root, "surface.slang"), "import shared;");
  simpleScene(scene, { buffers: { p: { file: "mesh.bin" } }, programs: { surface: { file: "surface.slang" } } });
  assert.equal(sceneInputs(scene).length, 4);
  const child = path.join(root, "child");
  mkdirSync(child);
  const inline = path.join(child, "scene.json");
  simpleScene(inline, { programs: { inline: { source: '#include "../surface.slang"' } } });
  assert.ok(sceneInputs(inline).includes(path.join(root, "shared.slang")));
  writeFileSync(path.join(root, "evidence.json"), JSON.stringify({ file: "not-a-scene-resource" }));
  assert.ok(sceneInputs(inline, [path.join(root, "evidence.json")]).length === 4);
  writeFileSync(scene, JSON.stringify({ images: { x: { file: "https://example.org/x.png" } } }));
  assert.throws(() => sceneInputs(scene), /local files/);
});
test("geometry dry run does not invoke or create output, and checks sidecar collisions", async (t) => {
  const root = workspace(t),
    scene = path.join(root, "scene.json"),
    output = path.join(root, "asset.glb");
  simpleScene(scene);
  const result = await exportVork(scene, output, {
    executable: path.join(root, "missing"),
    dryRun: true,
    node: "hero",
  });
  assert.ok(result.argv?.includes("hero"));
  assert.equal(existsSync(output), false);
  writeFileSync(path.join(root, "asset.export.json"), "{}");
  await assert.rejects(exportVork(scene, output, { dryRun: true }), /exists/);
});
test("render plans reject invalid settings and existing output, including dry runs", (t) => {
  const root = workspace(t),
    scene = path.join(root, "scene.json");
  simpleScene(scene);
  assert.throws(() => renderPlan({ scene, output: path.join(root, "new"), samples: 0 }), /Samples/);
  assert.throws(() => renderPlan({ scene, output: path.join(root, "new"), frames: [3, 1] }), /frame range/);
  assert.throws(() => renderPlan({ scene, output: root }), /contain/);
  assert.throws(() => renderPlan({ scene, output: path.join(root, "new"), profile: "unknown" }), /profile/);
  const plan = renderPlan({ scene, output: path.join(root, "new"), frames: [0, 2], samples: 4 });
  assert.ok(plan.argv.includes("seed=42"));
  assert.deepEqual(plan.settings.frames, [0, 2]);
});
test("fresh render metadata, warnings and input hashes govern usable outputs", async (t) => {
  const root = workspace(t),
    executable = fakeEngine(root),
    scene = path.join(root, "scene.json");
  simpleScene(scene);
  const rendered = await renderVork({ scene, output: path.join(root, "good"), root, executable, frames: [0, 0] });
  assert.ok("receipt" in rendered);
  assert.equal(
    rendered.receipt.outputs.some((pin) => pin.file.endsWith("000000.png")),
    true,
  );
  assert.equal(VorkReceiptSchema.safeParse(rendered.receipt).success, true);
  simpleScene(scene, { noMetadata: true });
  await assert.rejects(renderVork({ scene, output: path.join(root, "incomplete"), root, executable, frames: [0, 0] }));
  assert.equal(existsSync(path.join(root, "incomplete", "vork-receipt.json")), false);
  simpleScene(scene, { mutate: true });
  await assert.rejects(
    renderVork({ scene, output: path.join(root, "mutated"), root, executable, frames: [0, 0] }),
    /changed/,
  );
  simpleScene(scene, { warning: true });
  const warned = await renderVork({
    scene,
    output: path.join(root, "warned"),
    root,
    executable,
    frames: [0, 0],
    purpose: "production",
  });
  assert.ok("receipt" in warned);
  assert.equal(warned.state, "needs-review");
  assert.throws(() => assertVorkResult(warned.receipt, warned.receipt.outputs[0]!.sha256, root, true), /preview-only/);
  simpleScene(scene, { coverage: 0.5 });
  await assert.rejects(
    renderVork({ scene, output: path.join(root, "alpha-h264"), root, executable, frames: [0, 0], encode: "h264" }),
    /discard alpha/,
  );
});
test(
  "real Blender composite preserves a nonzero source clock and input bytes",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 180000 },
  async (t) => {
    const root = workspace(t),
      blend = path.join(root, "source.blend"),
      script = path.join(root, "source.py");
    writeFileSync(
      script,
      `import bpy\nbpy.context.scene.render.fps=25\nbpy.context.scene.frame_start=11\nbpy.context.scene.frame_end=60\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})\n`,
    );
    await runBlender({
      script,
      output: path.join(root, "setup"),
      format: "png",
      device: "auto",
      factoryStartup: true,
      noRender: true,
      overwrite: false,
      resume: false,
      scriptArgs: [],
      timeoutSec: 120,
    });
    const before = hashFile(blend),
      image = path.join(root, "pass.png");
    await runProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=16x16:d=0.1", "-frames:v", "1", image]);
    const request = path.join(root, "request.json");
    writeFileSync(request, JSON.stringify({ blend, image }));
    const result = await bridgeVork("composite", request, path.join(root, "composite"));
    assert.equal(hashFile(blend), before);
    assert.equal(result.report.fps, 25);
    assert.equal(result.report.frameStart, 11);
    assert.equal(result.report.frameEnd, 60);
    assert.ok(existsSync(result.scene));
    const invalid = path.join(root, "volume.blend"),
      volumeScript = path.join(root, "volume.py");
    writeFileSync(
      volumeScript,
      `import bpy\nbpy.ops.wm.open_mainfile(filepath=${JSON.stringify(blend)},use_scripts=False)\nmat=bpy.data.materials.get('Material')\nmat.use_nodes=True\nvolume=mat.node_tree.nodes.new('ShaderNodeVolumePrincipled')\noutput=mat.node_tree.nodes.get('Material Output')\nmat.node_tree.links.new(volume.outputs['Volume'],output.inputs['Volume'])\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(invalid)})\n`,
    );
    await runBlender({
      script: volumeScript,
      output: path.join(root, "volume-setup"),
      format: "png",
      device: "auto",
      factoryStartup: true,
      noRender: true,
      overwrite: false,
      resume: false,
      scriptArgs: [],
      timeoutSec: 120,
    });
    const invalidHash = hashFile(invalid),
      rejected = path.join(root, "rejected-export");
    await assert.rejects(
      bridgeVork("from-blender", invalid, rejected),
      /mixed surface\/displacement and Volume export not supported/,
    );
    assert.equal(hashFile(invalid), invalidHash);
    assert.equal(existsSync(path.join(rejected, "bridge-receipt.json")), false);
  },
);
test("import and delivery retain Vork sources and refuse draft, altered receipts and duplicates", async (t) => {
  const root = workspace(t),
    executable = fakeEngine(root),
    scene = path.join(root, "scene.json");
  simpleScene(scene);
  mkdirSync(path.join(root, "public/projects/example/pipeline"), { recursive: true });
  writeFileSync(
    path.join(root, "public/projects/example/pipeline/brief.json"),
    JSON.stringify({ renderMode: "bespoke" }),
  );
  const rendered = await renderVork({ scene, output: path.join(root, "render"), root, executable, frames: [0, 0] });
  assert.ok("receipt" in rendered);
  const image = path.join(root, "render/frames/000000.png");
  const vorkResult = {
    receipt: rendered.receipt,
    receiptHash: digest(JSON.stringify(rendered.receipt)),
    sourceOutputHash: hashFile(image),
  };
  const result = importAsset({
    rootDir: root,
    projectId: "example",
    sourceFile: image,
    provenance: { origin: "manual" },
    vorkResult,
  });
  const imported = path.join(root, "public", result.asset.files.original),
    registry = path.join(root, result.registryPath);
  assert.throws(() => assertImportedVorkAssets([imported], registry, root), /preview-only/);
  const captured: string[] = [];
  captureVorkProvenance(imported, root, (file) => captured.push(file));
  assert.ok(captured.includes(scene));
  assert.ok(captured.includes(registry));
  assert.throws(
    () =>
      importAsset({
        rootDir: root,
        projectId: "example",
        sourceFile: image,
        provenance: { origin: "manual" },
        vorkResult: { ...vorkResult, receiptHash: "0".repeat(64) },
      }),
    /receipt/,
  );
  mkdirSync(path.join(root, "public/projects/second/pipeline"), { recursive: true });
  writeFileSync(
    path.join(root, "public/projects/second/pipeline/brief.json"),
    JSON.stringify({ renderMode: "bespoke" }),
  );
  const second = importAsset({
    rootDir: root,
    projectId: "second",
    sourceFile: imported,
    provenance: { origin: "manual" },
  });
  assert.equal(second.asset.vorkResult?.receiptHash, vorkResult.receiptHash);
  assert.throws(
    () =>
      assertImportedVorkAssets(
        [path.join(root, "public", second.asset.files.original)],
        path.join(root, second.registryPath),
        root,
      ),
    /preview-only/,
  );
  writeFileSync(scene, "changed");
  assert.throws(() => captureVorkProvenance(imported, root, () => {}), /changed/);
});
test("recipes and tasks are strict, frame-driven and discoverable without GPU", async (t) => {
  const root = workspace(t);
  assert.equal(VORK_RECIPES.length, 10);
  assert.equal(ProductionRouteSchema.parse("vork"), "vork");
  assert.throws(() => recipeParams.parse({ typo: true }));
  const built = await buildRecipe("gpu-swarm", path.join(root, "swarm"), { count: 5 });
  const task = VorkTaskSchema.parse(JSON.parse(readFileSync(built.taskFile, "utf8")));
  assert.equal(task.seed, 42);
  assert.match(readFileSync(path.join(root, "swarm/swarm.slang"), "utf8"), /c.time/);
  assert.throws(() => VorkTaskSchema.parse({ ...task, unknown: true }));
  await assert.rejects(buildRecipe("product-stage", path.join(root, "swarm")), /exists/);
  const seeded = await buildRecipe("product-stage", path.join(root, "seeded"), { seed: 19 });
  const plan = await renderVork({
    scene: seeded.scene,
    task: seeded.taskFile,
    output: path.join(root, "planned"),
    dryRun: true,
  });
  assert.equal(plan.settings.seed, 19);
  await assert.rejects(
    renderVork({
      scene: seeded.scene,
      task: seeded.taskFile,
      output: path.join(root, "planned"),
      seed: 42,
      dryRun: true,
    }),
    /Seed override/,
  );
});
test("manufactured profiles and seeded instance finishes retain valid authoring data", async (t) => {
  const root = workspace(t);
  const product = await buildRecipe("product-stage", path.join(root, "product"));
  const scene = JSON.parse(readFileSync(product.scene, "utf8"));
  for (const node of scene.nodes.filter((node: { name: string }) => ["hero", "plinth"].includes(node.name))) {
    const profile = node.geometry.profile as number[][];
    assert.equal(profile[0]![0], 0);
    assert.equal(profile.at(-1)![0], 0);
    assert.ok(profile.every((point) => point.length === 2 && point.every(Number.isFinite) && point[0]! >= 0));
    assert.ok(
      profile.every(
        (point, i) => i === 0 || Math.hypot(point[0]! - profile[i - 1]![0]!, point[1]! - profile[i - 1]![1]!) > 0,
      ),
    );
  }
  const builds = await Promise.all(
    [42, 42, 19].map((seed, index) => buildRecipe("gpu-swarm", path.join(root, `swarm-${index}`), { seed, count: 17 })),
  );
  const attributes = builds.map((built) => JSON.parse(readFileSync(built.scene, "utf8")).nodes[0].instances.attributes);
  assert.deepEqual(attributes[0], attributes[1]);
  assert.notDeepEqual(attributes[0], attributes[2]);
  for (const columns of attributes) {
    assert.equal(columns.SCALE.data.length, 17);
    assert.equal(columns.ROTATION.data.length, 17);
    assert.equal(columns.finish.data.length, 17);
    assert.ok(columns.SCALE.data.every((scale: number[]) => scale.every((value) => value > 0)));
    assert.ok(columns.ROTATION.data.every((rotation: number[]) => Math.abs(Math.hypot(...rotation) - 1) < 1e-12));
    assert.ok(columns.finish.data.every((value: number) => value >= 0 && value <= 1));
  }
});
test("fluid worker maps its normalised SDK domain onto the visible basin in metres", async (t) => {
  const root = workspace(t),
    executable = fakeEngine(root),
    sdk = path.join(root, "python/vork");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    path.join(sdk, "__init__.py"),
    "import json\nfrom pathlib import Path\ndef write_scene(scene, file, **options):\n    Path(file).write_text(json.dumps(scene))\n",
  );
  writeFileSync(
    path.join(sdk, "fluid.py"),
    'def build(**request):\n    return {"buffers": {}, "programs": {}, "geometry": {"water": {"sdkRequest": request}}, "materials": {}, "simulation": {}}\n',
  );
  for (const quality of ["preview", "final"]) {
    const built = await buildRecipe(
      "fluid-basin",
      path.join(root, quality),
      { duration: 8, simulationQuality: quality },
      executable,
    );
    const scene = JSON.parse(readFileSync(built.scene, "utf8")),
      request = scene.geometry.water.sdkRequest;
    const hero = scene.nodes.find((node: { name: string }) => node.name === "hero");
    assert.deepEqual(hero.scale, request.extent);
    const right = scene.nodes.find((node: { name: string }) => node.name === "basin-right");
    const back = scene.nodes.find((node: { name: string }) => node.name === "basin-back");
    for (const [axis, wall] of [
      [0, right],
      [2, back],
    ] as const) {
      const inner = Math.abs(wall.translation[axis]) - wall.geometry.size[axis] / 2;
      const rendered = ((0.42 * request.scale) / request.extent[axis]) * hero.scale[axis];
      assert.ok(Math.abs(rendered - inner) < 1e-12);
      assert.ok(Math.abs(inner - 0.21) < 1e-12);
    }
    const bottom = scene.nodes.find((node: { name: string }) => node.name === "basin-bottom");
    const visibleFloor = bottom.translation[1] + bottom.geometry.size[1] / 2;
    const renderedFloor = ((-0.34 * request.scale) / request.extent[1]) * hero.scale[1] + hero.translation[1];
    assert.ok(Math.abs(renderedFloor - visibleFloor) < 1e-12);
    assert.ok(Math.abs(visibleFloor - 0.33) < 1e-12);
    if (quality === "final")
      assert.ok(
        Math.abs(request.particle_budget.reduce((a: number, b: number) => a * b, 1) * request.spacing ** 3 - 0.008192) <
          1e-12,
      );
  }
});
test("bounded local execution terminates on deadline and preserves failure class", async (t) => {
  const root = workspace(t);
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutSec: 0.1 }),
    /timed out/,
  );
  await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(3)"]), /exited 3/);
  for (const [index, stdio] of ["['ignore',process.stdout,process.stderr]", "'ignore'"].entries()) {
    const pidFile = path.join(root, `child-${index}`);
    const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:${stdio}});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    await assert.rejects(runProcess(process.execPath, ["-e", script], { timeoutSec: 3 }), /timed out/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});
test("real Vork smoke explicitly requires opt-in", { skip: process.env.RUN_VORK_TESTS !== "1" }, async (t) => {
  const root = workspace(t),
    built = await buildRecipe("product-stage", path.join(root, "source"));
  const rendered = await renderVork({
    scene: built.scene,
    output: path.join(root, "render"),
    frames: [0, 0],
    resolution: [160, 90],
    profile: "std/draft",
    samples: 4,
  });
  assert.ok("receipt" in rendered);
  assert.equal(rendered.receipt.warnings.length, 0);
});
