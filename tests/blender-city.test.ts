import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fetchCity,
  CityAreaSchema,
  cityAreaKey,
  cityCoordinateKey,
  OSM_ATTRIBUTION,
} from "../src/lib/blender-arsenal/city";
import { arsenalCandidates } from "../src/lib/blender-arsenal/overview";
import { GeneratorManifestSchema } from "../src/lib/blender-arsenal/generators";
import { listRecipes, readRecipeFrame } from "../src/lib/blender-arsenal/recipes";
import { determinism } from "../src/lib/blender-arsenal/recipe-quality";
import { runBlender } from "../src/lib/backends/blender-run";

const area = { lat: 12, lon: 10, radius: 50 };
const source = {
  elements: [
    {
      type: "way",
      id: 1,
      tags: { building: "yes", height: "16" },
      geometry: [
        { lat: 12, lon: 10 },
        { lat: 12, lon: 10.0001 },
        { lat: 12.0001, lon: 10.0001 },
        { lat: 12.0001, lon: 10 },
        { lat: 12, lon: 10 },
      ],
    },
  ],
};
const temporary = (t: test.TestContext) => {
  const dir = mkdtempSync(path.join(tmpdir(), "avc-city-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const fakeFetch = (async () => new Response(JSON.stringify(source))) as typeof fetch;

test("city manifests expose dependency metadata and capability verdicts", () => {
  const manifest = GeneratorManifestSchema.parse(JSON.parse(readFileSync("blender-arsenal/generators.json", "utf8")));
  assert.ok(manifest.generators.find((g) => g.id === "native-city")?.consent);
  assert.equal(GeneratorManifestSchema.safeParse({ ...manifest, unknown: true }).success, false);
  for (const id of ["procedural-city", "osm-city", "window-lights"])
    assert.ok(listRecipes().find((r) => r.id === id)?.requires?.generators.length);
  const candidates = arsenalCandidates(process.cwd(), "city");
  for (const id of ["BlenderGIS", "buildify", "native-city", "osm-footprints"])
    assert.ok(candidates.some((c) => c.id === id && c.verdict));
  assert.deepEqual(arsenalCandidates(process.cwd(), "unknown-capability"), []);
});

test("bounded OSM acquisition caches exact source bytes, consent and credits", async (t) => {
  const root = temporary(t);
  let calls = 0;
  const fetcher = (async (_url, init) => {
    calls++;
    assert.match(String(init?.body), /building/);
    return fakeFetch("https://unused.test");
  }) as typeof fetch;
  const first = await fetchCity(area, "fixture owner / acquisition consent", root, fetcher);
  assert.equal(first.buildings, 1);
  assert.equal(first.reused, false);
  const second = await fetchCity(area, "fixture owner / acquisition consent", root, fetcher);
  assert.equal(second.reused, true);
  assert.equal(calls, 1);
  const receipt = JSON.parse(readFileSync(first.receipt, "utf8"));
  assert.equal(receipt.attribution, OSM_ATTRIBUTION);
  assert.equal(receipt.licence, "ODbL-1.0");
  assert.ok(existsSync(path.join(path.dirname(first.file), "credits.json")));
  writeFileSync(first.file, JSON.stringify({ elements: [] }));
  await assert.rejects(fetchCity(area, "fixture consent", root, fetcher), /hash differs/);
});

test("city area, consent and remote payload validation fail before geometry writes", async (t) => {
  const root = temporary(t);
  for (const invalid of [
    { ...area, radius: 2000 },
    { ...area, lat: Infinity },
    { ...area, lon: 181 },
  ])
    assert.equal(CityAreaSchema.safeParse(invalid).success, false);
  assert.equal(cityAreaKey(area), "12.000000_10.000000_50");
  assert.equal(cityCoordinateKey(12.0078125), "12.007813");
  assert.equal(cityCoordinateKey(-12.0078125), "-12.007812");
  assert.equal(cityCoordinateKey(-0.0000001), "0.000000");
  await assert.rejects(fetchCity(area, "", root, fakeFetch), /consent/);
  await assert.rejects(
    fetchCity(
      area,
      "fixture",
      root,
      (async () =>
        new Response(JSON.stringify({ ...source, remark: "runtime error: Query timed out" }))) as typeof fetch,
    ),
    /incomplete data/,
  );
  await assert.rejects(fetchCity(area, "fixture", root, (async () => new Response("{}")) as typeof fetch));
  await assert.rejects(
    fetchCity(area, "fixture", root, (async () => new Response("unavailable", { status: 503 })) as typeof fetch),
    /HTTP 503/,
  );
  await assert.rejects(
    fetchCity(area, "fixture", root, (async () => new Response(JSON.stringify({ elements: [] }))) as typeof fetch),
    /No closed OSM/,
  );
});

test("incomplete OSM publication is preserved and repaired on retry", async (t) => {
  const root = temporary(t),
    directory = path.join(root, "blender-arsenal/local/generated/osm-source", cityAreaKey(area));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "asset.json"), '{"partial":true}');
  const result = await fetchCity(area, "fixture consent", root, fakeFetch);
  assert.equal(result.reused, false);
  assert.equal(result.buildings, 1);
  assert.ok(existsSync(path.join(directory, "credits.json")));
  assert.equal((await fetchCity(area, "fixture consent", root, fakeFetch)).reused, true);
});

test("pure city plans, footprint heights/outlines and window frame functions", () => {
  const result = spawnSync("python3", ["tests/blender-city.test.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test(
  "real Blender: three city wrappers, cached blend reuse and exact alone/range CPU pixels",
  { skip: process.env.RUN_BLENDER_TESTS !== "1", timeout: 300000 },
  async (t) => {
    const root = temporary(t);
    mkdirSync(path.join(root, "scripts/blender"), { recursive: true });
    cpSync("scripts/blender/recipes", path.join(root, "scripts/blender/recipes"), { recursive: true });
    cpSync("scripts/blender/kit", path.join(root, "scripts/blender/kit"), { recursive: true });
    cpSync("blender-arsenal/generators.json", path.join(root, "blender-arsenal/generators.json"));
    await fetchCity(area, "fixture source acquisition; no real network", root, fakeFetch);
    const script = path.join(root, "city-proof.py");
    writeFileSync(
      script,
      `import os,sys,json,pathlib
import bpy,avc_export
os.environ['AGENTBROS_REPO_ROOT']=${JSON.stringify(root)}
sys.path[:0]=[${JSON.stringify(path.join(root, "scripts/blender"))},${JSON.stringify(path.join(root, "scripts/blender/recipes"))}]
from avc_recipes import apply
from kit import anim,camera,light,look
s=bpy.context.scene
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
s.frame_start=1;s.frame_end=32;s.render.fps=30
s.render.engine='CYCLES';s.cycles.seed=31;s.cycles.use_animated_seed=False;s.cycles.use_denoising=True
s.render.resolution_x=160;s.render.resolution_y=90;s.render.resolution_percentage=100
look.apply(s,'agx');light.world(strength=0.3,colour='#8297bc')
light.mood('golden-hour',size=60,target=(0,0,15),exposure=3,use_world=False,only=['sun','sky'])
tl=anim.Timeline(range(-2,35))
city=apply('procedural-city',{'blocks':1,'hero_height':48},timeline=tl)
osm=apply('osm-city',${JSON.stringify(area)},timeline=tl)
bpy.data.objects[osm['objects'][0]].location.x=35
windows=apply('window-lights',{'seed':44},timeline=tl)
for name in windows['objects']: bpy.data.objects[name].location.x=-30
r=camera.Rig({'width':160,'height':90},role='establishing',target=(0,0,20),subject=(100,70),distance=180,lens=48,pitch=20,yaw=15,fstop=0)
r.bake(tl);tl.bake()
pathlib.Path(avc_export.output_path('city-proof.json')).write_text(json.dumps({'city':city,'osm':osm,'windows':windows}))
`,
    );
    const base = {
      script,
      scriptArgs: [],
      device: "cpu" as const,
      engine: "cycles" as const,
      samples: 4,
      resolution: [160, 90] as [number, number],
      factoryStartup: true,
      noRender: false,
      overwrite: false,
      resume: false,
      format: "png" as const,
      timeoutSec: 120,
      userResources: path.join(root, "blender-arsenal/local/trials/profile"),
    };
    const range = await runBlender({ ...base, output: path.join(root, "range"), frames: [16, 18] });
    const alone = await runBlender({ ...base, output: path.join(root, "alone"), frames: [17, 17] });
    const result = determinism(
      readRecipeFrame(range.frames[1]!.path, [160, 90]),
      readRecipeFrame(alone.frames[0]!.path, [160, 90]),
    );
    assert.equal(result.exact, true, JSON.stringify(result));
    const first = JSON.parse(readFileSync(path.join(root, "range/city-proof.json"), "utf8"));
    const reused = JSON.parse(readFileSync(path.join(root, "alone/city-proof.json"), "utf8"));
    assert.equal(first.windows.objects.length, 2);
    assert.ok(first.city.materials.length >= 19);
    for (const id of ["city", "osm"]) {
      assert.equal(first[id].bake.reused, false);
      assert.equal(reused[id].bake.reused, true);
      const receipt = JSON.parse(readFileSync(path.join(path.dirname(reused[id].bake.path), "asset.json"), "utf8"));
      if (id === "osm") assert.equal(receipt.attribution, OSM_ATTRIBUTION);
    }
  },
);
