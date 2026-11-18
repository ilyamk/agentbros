import { pythonArgs, pythonEnvironment, pythonUv } from "../src/lib/python";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AppendAssetParamsSchema,
  ApplyRecipeParamsSchema,
  ArsenalParamsSchema,
  EnableExtensionParamsSchema,
  LiveRecipeSchema,
} from "../src/lib/backends/blender-live-schema";
import { livePaths, liveRequest, replayShotScript, startSession, stopSession } from "../src/lib/backends/blender-live";
import { extensionEnvironment } from "../src/lib/blender-arsenal/extensions";
import { IndexSchema } from "../src/lib/blender-arsenal/libraries/schemas";
import { decodePng } from "../src/lib/sensors/pixels";

const root = process.cwd(),
  workers = path.join(root, "scripts/workers/blender");
const executable = "/Applications/Blender.app/Contents/MacOS/Blender";
const real = process.env.RUN_BLENDER_TESTS === "1";
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function workspace() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "live-arsenal-")));
  for (const folder of ["blender-arsenal/local/library", "blender-arsenal/collections", "scripts"])
    mkdirSync(path.join(dir, folder), { recursive: true });
  // Copy trusted text sources so recipe cache hashes and imports use this fixture workspace only.
  cpSync(path.join(root, "scripts/blender"), path.join(dir, "scripts/blender"), { recursive: true });
  writeFileSync(path.join(dir, "blender-arsenal/extensions.json"), '{"note":"fixture","extensions":[]}');
  return dir;
}
function python(dir: string, body: string) {
  const result = spawnSync(
    pythonUv(),
    [
      "--offline",
      ...pythonArgs("stdlib", [
        "-c",
        `import sys, json, os\nsys.path.insert(0, ${JSON.stringify(workers)})\nos.environ['AGENTBROS_REPO_ROOT'] = ${JSON.stringify(dir)}\nimport avc_live_arsenal as a\n${body}`,
      ]),
    ],
    { env: pythonEnvironment("stdlib"), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}
function fixtureExtension(dir: string) {
  const id = "avc_live_fixture",
    profile = path.join(dir, "blender-arsenal/local/blender-user");
  const folder = path.join(profile, "extensions/user_default", id);
  mkdirSync(folder, { recursive: true });
  const files: Record<string, string> = {
    "__init__.py":
      "import bpy\nregistration_count = 0\ndef register():\n    global registration_count\n    registration_count += 1\n    bpy.types.Scene.avc_live_registration = bpy.props.IntProperty(default=registration_count)\ndef unregister():\n    del bpy.types.Scene.avc_live_registration\n",
    "blender_manifest.toml": `schema_version = "1.0.0"\nid = "${id}"\nversion = "1.0.0"\nname = "Live fixture"\ntagline = "Harmless live test fixture"\nmaintainer = "AVC tests"\ntype = "add-on"\nblender_version_min = "4.2.0"\nlicense = ["SPDX:GPL-3.0-or-later"]\n`,
  };
  const tree = createHash("sha256");
  for (const [file, source] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    writeFileSync(path.join(folder, file), source);
    tree.update(file);
    tree.update("\0");
    tree.update(source);
  }
  const entry = JSON.parse(readFileSync(path.join(root, "blender-arsenal/extensions.json"), "utf8")).extensions[0];
  const pin = {
    ...entry,
    id,
    version: "1.0.0",
    status: "approved",
    permissions: {},
    needsAccount: false,
    consent: { by: "Synthetic test", date: "2026-11-15", note: "Fixture only" },
    archive: { url: null, sha256: sha("fixture archive"), size: 1 },
  };
  writeFileSync(
    path.join(dir, "blender-arsenal/extensions.json"),
    JSON.stringify({ note: "Synthetic fixture only", extensions: [pin] }),
  );
  writeFileSync(
    path.join(profile, "installed.json"),
    JSON.stringify({
      extensions: [
        {
          id,
          version: "1.0.0",
          sha256: pin.archive.sha256,
          treeSha256: tree.digest("hex"),
          installedAt: "2026-11-15T00:00:00Z",
        },
      ],
    }),
  );
  return id;
}

test("arsenal schemas reject unknown keys, path-shaped names, bad kinds and non-finite parameters", () => {
  assert.ok(
    AppendAssetParamsSchema.safeParse({ id: "fixture:mat", kind: "materials", target: "Hero", material_scale: 2 })
      .success,
  );
  for (const bad of [
    { id: "fixture:mat", path: "/tmp/x" },
    { id: "fixture:mat", target: "../Hero" },
    { id: "fixture:mat", scale: 0 },
    { id: "fixture:mat", location: [NaN, 0, 0] },
    { id: "../../escape" },
    { id: "fixture:mat", kind: "script" },
  ])
    assert.equal(AppendAssetParamsSchema.safeParse(bad).success, false);
  assert.equal(ApplyRecipeParamsSchema.safeParse({ id: "dust-burst", params: { seed: 42 } }).success, true);
  assert.equal(ApplyRecipeParamsSchema.safeParse({ id: "../x", params: {} }).success, false);
  assert.equal(ApplyRecipeParamsSchema.safeParse({ id: "dust-burst", params: { seed: Infinity } }).success, false);
  assert.equal(EnableExtensionParamsSchema.safeParse({ id: "../addon" }).success, false);
  assert.equal(EnableExtensionParamsSchema.safeParse({ id: "addon", path: "/tmp" }).success, false);
  assert.equal(ArsenalParamsSchema.safeParse({ limit: 101 }).success, false);
  assert.equal(ArsenalParamsSchema.safeParse({ download: true }).success, false);
});

test("Python protocol validates recipe defaults/unknown keys, missing assets, isolation and extension drift without Blender", () => {
  const dir = workspace();
  try {
    const id = fixtureExtension(dir);
    const result = python(
      dir,
      `
from avc_live_protocol import LiveError
os.environ['BLENDER_USER_RESOURCES'] = os.path.join(os.environ['AGENTBROS_REPO_ROOT'], 'blender-arsenal/local/blender-user')
def attempt(op, params, context={}):
    try:
        return a.prepare_step(op, params, context)
    except (LiveError, ValueError) as e:
        return str(e)
valid = attempt('apply-recipe', {'id':'dust-burst','params':{'count':12}})
print(json.dumps({'valid':valid, 'molecule':attempt('apply-recipe', {'id':'molecule','params':{'file':'changed.pdb'}}), 'unknown':attempt('apply-recipe', {'id':'dust-burst','params':{'typo':1}}), 'missing':attempt('append-asset', {'id':'fixture:missing'}), 'profile':attempt('enable-extension', {'id':${JSON.stringify(id)}}), 'enabled':attempt('enable-extension', {'id':${JSON.stringify(id)}}, {'extensionsProfile':True}), 'bad':attempt('arsenal', {})}))`,
    );
    assert.deepEqual(result.valid.params.params, { count: 12, spread: 2.1, seed: 19 });
    assert.match(result.valid.pin.sha256, /^[a-f0-9]{64}$/);
    assert.match(result.molecule, /pinned external structure/);
    const materials = path.join(dir, "scripts/blender/materials");
    mkdirSync(materials, { recursive: true });
    const before = python(dir, "print(json.dumps(a.recipe_code_hash()))");
    writeFileSync(path.join(materials, "__init__.py"), "# material change");
    assert.notEqual(python(dir, "print(json.dumps(a.recipe_code_hash()))"), before);
    assert.match(result.unknown, /Unknown params/);
    assert.match(result.missing, /pnpm blender:assets --action add/);
    assert.match(result.profile, /--extensions/);
    assert.equal(result.enabled.pin.version, "1.0.0");
    writeFileSync(
      path.join(dir, "blender-arsenal/local/blender-user/extensions/user_default", id, "__init__.py"),
      "# drift",
    );
    assert.deepEqual(python(dir, "print(json.dumps(a.installed_extensions()))"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "real Blender: local material/HDRI, two recipes including bake, read-only inventory, extension, rollback and pinned replay pixels",
  { skip: !real && "set RUN_BLENDER_TESTS=1", timeout: 600000 },
  async (t) => {
    const dir = workspace(),
      paths = livePaths(dir, undefined, "arsenal"),
      freshPaths = livePaths(dir, undefined, "fresh"),
      basePaths = livePaths(dir, undefined, "base");
    const timings: Record<string, number> = {};
    try {
      const extension = fixtureExtension(dir);
      const library = path.join(dir, "blender-arsenal/local/library");
      // Generate tiny original maps in Blender; no downloads or pre-existing store required.
      const generate = `import bpy\nimage = bpy.data.images.new('Fixture', width=8, height=4, float_buffer=True)\nimage.pixels = [v for i in range(32) for v in ((0.9,0.15,0.025,1) if i%2 else (0.2,0.025,0.01,1))]\nbpy.context.scene.render.image_settings.file_format='PNG'\nimage.save_render(${JSON.stringify(path.join(library, "colour.png"))})\nimage.pixels = [v for i in range(32) for v in (2.0,1.5,1.0,1)]\nbpy.context.scene.render.image_settings.file_format='OPEN_EXR'\nimage.save_render(${JSON.stringify(path.join(library, "studio.exr"))})`;
      const generated = spawnSync(
        executable,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--offline-mode",
          "--python-expr",
          generate +
            `\nbpy.context.scene.render.fps=37\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(path.join(dir, "base.blend"))})`,
        ],
        { cwd: dir, env: extensionEnvironment(dir), encoding: "utf8", timeout: 120000 },
      );
      assert.equal(generated.status, 0, generated.stderr);
      const asset = (id: string, kind: "materials" | "hdri", file: string, role: "color" | "hdri") => ({
        version: 1,
        id,
        kind,
        source: "fixture",
        title: id,
        licence: "CC0-1.0",
        licenceUrl: "https://example.invalid/licence",
        attribution: "",
        sourcePage: "https://example.invalid/fixture",
        files: [{ path: file, role }],
        sha256: sha(readFileSync(path.join(library, file))),
        fetched: "2026-11-15T00:00:00Z",
        consent: { by: "Synthetic test", date: "2026-11-15", note: "Generated fixture" },
        tags: [],
      });
      const index = IndexSchema.parse({
        version: 1,
        assets: [
          asset("fixture:material", "materials", "colour.png", "color"),
          asset("fixture:studio", "hdri", "studio.exr", "hdri"),
        ],
      });
      writeFileSync(path.join(library, "index.json"), JSON.stringify(index));
      writeFileSync(
        path.join(dir, "blender-arsenal/collections/fixture.json"),
        JSON.stringify({
          version: 1,
          name: "fixture",
          items: ["fixture:material", "fixture:missing"],
          notes: "fixture",
        }),
      );
      const { record } = await startSession({
        workspace: dir,
        paths,
        executable,
        extensions: extension,
        idleMinutes: 2,
        ui: false,
      });
      const call = async (op: string, params: Record<string, unknown> = {}) => {
        const start = performance.now();
        const value = await liveRequest(record.port, record.token, op, params);
        timings[`${op}-${Object.keys(timings).length}`] = Number((performance.now() - start).toFixed(3));
        return value;
      };
      const beforeEnable = (await call("inspect")).scene;
      const enabledAgain = await call("enable-extension", { id: extension });
      assert.equal((enabledAgain.extensions as Array<{ enableMs: number }>)[0]!.enableMs, 0);
      assert.deepEqual(
        (await call("inspect")).scene,
        beforeEnable,
        "enabling an already-enabled stateful extension does not re-register it",
      );
      await call("add", { kind: "sphere", name: "Hero", location: [0, 0, 1] });
      const mat = await call("append-asset", { id: "fixture:material", target: "Hero", material_scale: 2 });
      assert.equal(mat.kind, "materials");
      await call("append-asset", { id: "fixture:studio" });
      const floor = await call("apply-recipe", { id: "studio-floor", params: {} });
      assert.ok((floor.objects as string[]).length);
      const baked = await call("apply-recipe", { id: "dust-burst", params: { count: 12, seed: 42 } });
      assert.equal((baked.bake as { reused: boolean }).reused, false);
      assert.ok(
        String((baked.bake as { path: string }).path).startsWith(path.join(dir, "blender-arsenal/local/bakes/")),
      );
      await call("add", { kind: "camera", name: "Camera", location: [5, -6, 4], target: [0, 0, 0.8] });
      await call("add", { kind: "light", name: "Key", location: [3, -3, 5], target: [0, 0, 1], energy: 600, size: 2 });
      const journalBefore = readFileSync(path.join(paths.outDir, "journal.live.json"));
      const usageBefore = readFileSync(path.join(library, "usage.jsonl"));
      const inventory = await call("arsenal", { limit: 1 });
      assert.deepEqual((inventory.assets as Record<string, object>).materials, { count: 1, ids: ["fixture:material"] });
      assert.deepEqual(inventory.collections, [
        { name: "fixture", present: ["fixture:material"], missing: ["fixture:missing"] },
      ]);
      assert.equal((inventory.recipes as unknown[]).length, 28);
      assert.equal((inventory.extensions as unknown[]).length, 1);
      assert.ok(readFileSync(path.join(paths.outDir, "journal.live.json")).equals(journalBefore));
      assert.ok(readFileSync(path.join(library, "usage.jsonl")).equals(usageBefore));
      await assert.rejects(call("apply-recipe", { id: "dust-burst", params: { typo: true } }), /Unknown params/);
      await assert.rejects(call("append-asset", { id: "fixture:missing" }), /pnpm blender:assets/);
      await assert.rejects(call("append-asset", { id: "fixture:material", target: "missing" }), /target/);
      const still = await call("still", {
        name: "proof",
        frame: 20,
        width: 160,
        height: 90,
        samples: 4,
        engine: "cycles",
      });
      const journal = LiveRecipeSchema.parse(
        JSON.parse(readFileSync(path.join(paths.outDir, "journal.live.json"), "utf8")),
      );
      const recipeFile = path.join(paths.outDir, "recipe.live.json");
      writeFileSync(recipeFile, JSON.stringify(journal));
      assert.ok(journal.ops.find((step) => step.op === "append-asset")!.pin!.files!.length);
      assert.deepEqual(journal.ops.find((step) => step.op === "apply-recipe")!.params.params, {
        colour: "#202930",
        shadow_catcher: false,
      });
      const fresh = await startSession({
        workspace: dir,
        paths: freshPaths,
        executable,
        extensions: extension,
        idleMinutes: 2,
        ui: false,
      });
      for (const step of journal.ops) {
        const result = await liveRequest(fresh.record.port, fresh.record.token, step.op, step.params);
        if (step.op === "apply-recipe" && step.params.id === "dust-burst")
          assert.equal((result.bake as { reused: boolean }).reused, true);
      }
      const freshStill = await liveRequest(fresh.record.port, fresh.record.token, "still", {
        name: "fresh-proof",
        frame: 20,
        width: 160,
        height: 90,
        samples: 4,
        engine: "cycles",
      });
      assert.ok(
        decodePng(readFileSync(String(freshStill.path)), 160, 90).equals(
          decodePng(readFileSync(String(still.path)), 160, 90),
        ),
        "a fresh live session replays the same pixels",
      );
      await stopSession(freshPaths);
      const replayCode = `import sys, runpy\nsys.path.insert(0, ${JSON.stringify(workers)})\nsys.argv = ['replay', '--', ${JSON.stringify(recipeFile)}]\nrunpy.run_path(${JSON.stringify(path.join(workers, "avc_live_replay.py"))}, run_name='__main__')\nimport bpy\ns=bpy.context.scene\ns.render.engine='CYCLES'\ns.cycles.device='CPU'\ns.cycles.samples=4\ns.render.resolution_x=160\ns.render.resolution_y=90\ns.render.resolution_percentage=100\ns.frame_set(20)\ns.render.filepath=${JSON.stringify(path.join(paths.outDir, "replayed.png"))}\nbpy.ops.render.render(write_still=True)`;
      const replay = () =>
        spawnSync(
          executable,
          [
            "--background",
            "--factory-startup",
            "--disable-autoexec",
            "--offline-mode",
            "--python-exit-code",
            "1",
            "--python-expr",
            replayCode,
          ],
          { cwd: dir, env: extensionEnvironment(dir), encoding: "utf8", timeout: 180000 },
        );
      const replayed = replay();
      assert.equal(replayed.status, 0, replayed.stdout.slice(-3000) + replayed.stderr);
      const original = decodePng(readFileSync(String(still.path)), 160, 90),
        copy = decodePng(readFileSync(path.join(paths.outDir, "replayed.png")), 160, 90);
      let maxAbsDiff = 0,
        squared = 0;
      for (let i = 0; i < original.length; i++) {
        const d = original[i]! - copy[i]!;
        maxAbsDiff = Math.max(maxAbsDiff, Math.abs(d));
        squared += d * d;
      }
      const psnr = squared === 0 ? null : 10 * Math.log10(255 ** 2 / (squared / original.length));
      t.diagnostic(JSON.stringify({ timingsMs: timings, pixels: original.length / 3, maxAbsDiff, psnr }));
      assert.equal(maxAbsDiff, 0, `PSNR ${psnr}`);
      const script = path.join(paths.outDir, "shot.py");
      writeFileSync(script, replayShotScript(journal));
      assert.match(readFileSync(script, "utf8"), /avc_assets.append/);
      assert.match(readFileSync(script, "utf8"), /avc_recipes.apply/);
      const scriptReplay = spawnSync(
        executable,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--offline-mode",
          "--python-exit-code",
          "1",
          "--python-expr",
          replayCode
            .replace(`sys.argv = ['replay', '--', ${JSON.stringify(recipeFile)}]`, "sys.argv = ['replay']")
            .replace(JSON.stringify(path.join(workers, "avc_live_replay.py")), JSON.stringify(script)),
        ],
        { cwd: dir, env: extensionEnvironment(dir), encoding: "utf8", timeout: 180000 },
      );
      assert.equal(scriptReplay.status, 0, scriptReplay.stdout.slice(-2000) + scriptReplay.stderr);
      assert.ok(
        original.equals(decodePng(readFileSync(path.join(paths.outDir, "replayed.png")), 160, 90)),
        "the exported shot script matches too",
      );
      const originalMap = readFileSync(path.join(library, "colour.png"));
      const beforeDrift = await call("inspect");
      writeFileSync(path.join(library, "colour.png"), "drift");
      await assert.rejects(call("delete", { name: "Hero" }), /refuses drift/);
      assert.deepEqual(
        await call("inspect"),
        beforeDrift,
        "preflight catches drift before a failed op can damage the live scene",
      );
      const drift = replay();
      assert.notEqual(drift.status, 0);
      assert.match(drift.stdout + drift.stderr, /refuses drift/);
      writeFileSync(path.join(library, "colour.png"), originalMap);
      const missing = path.join(library, "studio.exr");
      rmSync(missing);
      const filtered = await call("arsenal", { kind: "hdri", filter: "studio" });
      assert.deepEqual((filtered.assets as Record<string, unknown>).hdri, { count: 0, ids: [] });
      await call("reset");
      const helper = path.join(dir, "scripts/blender/recipes/_common.py");
      writeFileSync(helper, readFileSync(helper, "utf8") + "\n# Synthetic code drift after reset\n");
      await assert.rejects(call("apply-recipe", { id: "studio-floor", params: {} }), /restart the live session/);
      const baseSession = await startSession({
        workspace: dir,
        paths: basePaths,
        executable,
        blend: "base.blend",
        extensions: extension,
        idleMinutes: 2,
        ui: false,
      });
      const baseCall = (op: string, params: Record<string, unknown> = {}) =>
        liveRequest(baseSession.record.port, baseSession.record.token, op, params);
      assert.equal(((await baseCall("inspect")).scene as { fps: number }).fps, 37);
      const baseEnabled = await baseCall("enable-extension", { id: extension });
      assert.equal((baseEnabled.extensions as Array<{ enableMs: number }>)[0]!.enableMs, 0);
      assert.equal(
        ((await baseCall("inspect")).scene as { fps: number }).fps,
        37,
        "RNA is registered before loading the base and not re-registered afterwards",
      );
      const baseJournal = await baseCall("journal");
      delete baseJournal.lastStill;
      const baseScript = path.join(basePaths.outDir, "base-replay.py");
      writeFileSync(baseScript, replayShotScript(baseJournal));
      const checkedBase = spawnSync(
        executable,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--offline-mode",
          "--python-exit-code",
          "1",
          "--python-expr",
          `import sys,runpy\nsys.path.insert(0,${JSON.stringify(workers)})\nrunpy.run_path(${JSON.stringify(baseScript)},run_name='__main__')\nimport bpy\nassert bpy.context.scene.render.fps == 37, bpy.context.scene.render.fps\nassert sys.modules['bl_ext.user_default.avc_live_fixture'].registration_count == 1`,
        ],
        { cwd: dir, env: extensionEnvironment(dir), encoding: "utf8", timeout: 120000 },
      );
      assert.equal(checkedBase.status, 0, checkedBase.stdout.slice(-1500) + checkedBase.stderr);
      await assert.rejects(
        baseCall("apply-recipe", { id: "dissolve", params: { object: "missing-target" } }),
        /object must name an existing mesh/,
      );
      writeFileSync(helper, readFileSync(helper, "utf8") + "\n# More drift after first failed application\n");
      await assert.rejects(baseCall("apply-recipe", { id: "studio-floor", params: {} }), /restart the live session/);
    } finally {
      await stopSession(basePaths);
      await stopSession(freshPaths);
      await stopSession(paths);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
