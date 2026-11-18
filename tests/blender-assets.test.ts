import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { arsenalPaths, ensureArsenalLayout } from "../src/lib/blender-arsenal/paths";
import {
  CollectionSchema,
  ManifestSchema,
  SourceSchema,
  type Asset,
  type Manifest,
} from "../src/lib/blender-arsenal/libraries/schemas";
import {
  LibraryAdapter,
  parseAmbient,
  validateAmbientParams,
  type Download,
} from "../src/lib/blender-arsenal/libraries/adapters";
import {
  addAsset,
  atomicJson,
  buildIndex,
  catalogUuid,
  collectionStatus,
  detectRole,
  fetchDownload,
  projectCredits,
  rank,
  searchAssets,
  unpackAsset,
} from "../src/lib/blender-arsenal/libraries/store";

const source = SourceSchema.parse({
  id: "ambientcg",
  name: "Test source",
  kinds: ["materials"],
  licence: "CC0-1.0",
  licenceUrl: "https://example.test/licence",
  attribution: { required: false, template: "{title} {url}" },
  redistribution: "No committed files",
  adapter: "ambientcg-api",
  config: { downloadHosts: ["example.test"] },
  status: "approved",
  notes: "",
  verified: null,
});
const item: Download = {
  id: "ambientcg:Test001",
  kind: "materials",
  title: "Test surface",
  tags: ["wood"],
  licence: "CC0-1.0",
  sourcePage: "https://example.test/asset",
  url: "https://example.test/asset.zip",
  size: 3,
  format: "zip",
  resolution: "2k",
};
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "avc-assets-"));
  const p = ensureArsenalLayout(root);
  atomicJson(p.librariesManifest, { version: 1, sources: [source], items: [] });
  mkdirSync(p.collections, { recursive: true });
  return { root, p, close: () => rmSync(root, { recursive: true, force: true }) };
}
function fakeAsset(root: string, id = "ambientcg:Test001"): Asset {
  const p = arsenalPaths(root),
    file = `materials/ambientcg/${id.split(":")[1]}/albedo.png`;
  mkdirSync(path.dirname(path.join(p.library, file)), { recursive: true });
  writeFileSync(path.join(p.library, file), "synthetic");
  const asset: Asset = {
    version: 1,
    id,
    source: "ambientcg",
    kind: "materials",
    title: "Test surface",
    licence: "CC0-1.0",
    licenceUrl: source.licenceUrl,
    attribution: "Test credit",
    sourcePage: item.sourcePage,
    files: [{ path: file, role: "color" }],
    sha256: digest("synthetic"),
    fetched: "2026-11-15T00:00:00Z",
    consent: { by: "fixture", date: "2026-11-15T00:00:00Z", note: "fixture only" },
    tags: ["wood"],
  };
  atomicJson(path.join(p.library, path.dirname(file), "asset.json"), asset);
  return asset;
}
const fakeFetch =
  (value: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(value));

test("tracked sources and collections validate; unknown fields and duplicate ids fail", () => {
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync("blender-arsenal/libraries.json", "utf8")));
  for (const id of ["polyhaven", "ambientcg", "kenney", "quaternius", "khronos-samples", "essentials"])
    assert.ok(manifest.sources.some((source) => source.id === id));
  for (const file of readdirSync("blender-arsenal/collections"))
    if (file.endsWith(".json"))
      CollectionSchema.parse(JSON.parse(readFileSync(`blender-arsenal/collections/${file}`, "utf8")));
  assert.throws(() => SourceSchema.parse({ ...source, surprise: true }));
  assert.throws(() => ManifestSchema.parse({ ...manifest, sources: [source, source] }));
});

test("ambientCG parser tolerates metadata additions and missing bundles, selects exact resolution", async () => {
  const raw = {
    assets: [
      {
        id: "Test001",
        title: "Wood",
        type: "material",
        extra: true,
        downloads: [
          {
            attributes: "2K-JPG",
            extension: "zip",
            url: "https://ambientcg.com/get?file=Test001_2K-JPG.zip",
            size: 100,
            extra: true,
          },
        ],
      },
      { id: "NoDownload" },
    ],
  };
  assert.throws(() => validateAmbientParams({ typ: "3d-model" }), /Unknown/);
  assert.throws(() => validateAmbientParams({ type: "3dmodel" }), /Invalid/);
  assert.throws(() => validateAmbientParams({ include: "bad" }), /Invalid/);
  assert.equal(parseAmbient(raw).length, 1);
  const adapter = new LibraryAdapter(source, fakeFetch(raw));
  assert.equal((await adapter.resolve(item.id)).size, 100);
  assert.equal((await adapter.search("wood")).length, 1);
  await assert.rejects(adapter.resolve(item.id, undefined, "4k"));
});

test("Poly Haven adapter reuses existing parser and bounded transport", async () => {
  const request: typeof fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).endsWith("/assets")
          ? { studio: { name: "Studio", type: 0, tags: ["soft"] } }
          : String(input).includes("/info/")
            ? { name: "Studio", type: 0 }
            : {
                hdri: {
                  "2k": {
                    hdr: {
                      url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/studio_2k.hdr",
                      size: 10,
                      md5: "a".repeat(32),
                    },
                  },
                },
              },
      ),
    );
  const adapter = new LibraryAdapter(
    { ...source, id: "polyhaven", adapter: "polyhaven-api", kinds: ["hdri"] },
    request,
  );
  assert.equal((await adapter.search("studio", "hdri"))[0]!.id, "polyhaven:studio");
  assert.equal((await adapter.resolve("polyhaven:studio")).md5, "a".repeat(32));
});

test("download mismatch leaves no bytes, verified originals are content addressed", async () => {
  const w = workspace();
  try {
    const request: typeof fetch = async () => new Response("abc");
    await assert.rejects(fetchDownload({ ...item, format: "png" }, w.root, "", request), /consent/);
    await assert.rejects(
      fetchDownload({ ...item, format: "png", sha256: "0".repeat(64) }, w.root, "fixture", request),
      /mismatch/,
    );
    assert.deepEqual(readdirSync(w.p.downloads), []);
    const good = await fetchDownload({ ...item, format: "png", sha256: digest("abc") }, w.root, "fixture", request);
    assert.equal(path.basename(good.file), `${digest("abc")}.png`);
    assert.equal(readFileSync(good.file, "utf8"), "abc");
    assert.ok(!readdirSync(w.p.downloads).some((f) => f.endsWith(".part")));
  } finally {
    w.close();
  }
});

function zip(file: string, unsafe = false) {
  const result = spawnSync("python3", [
    "-c",
    'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr(sys.argv[2],b"synthetic"); z.writestr("roughness.png",b"synthetic"); z.writestr("preview.png",b"synthetic"); z.close()',
    file,
    unsafe ? "../escape.png" : "textures/wood_Color.png",
  ]);
  assert.equal(result.status, 0);
}

test("ZIP unpack writes provenance; rejects traversal before output and refuses overwrite", () => {
  const w = workspace();
  try {
    const archive = path.join(w.root, "archive.zip");
    zip(archive, true);
    assert.throws(
      () => unpackAsset(item, { file: archive, sha256: digest("zip") }, source, "fixture", w.root),
      /extraction failed/,
    );
    assert.deepEqual(readdirSync(path.join(w.p.library, "materials/ambientcg")), []);
    zip(archive);
    const asset = unpackAsset(item, { file: archive, sha256: digest("zip") }, source, "fixture", w.root);
    assert.equal(asset.files.length, 3);
    assert.ok(asset.preview?.endsWith("preview.png"));
    assert.equal(asset.files[0]!.role, "color");
    assert.match(asset.attribution, /Test surface/);
    assert.throws(
      () => unpackAsset(item, { file: archive, sha256: digest("zip") }, source, "fixture", w.root),
      /already present/,
    );
    assert.equal(buildIndex(w.root).assets.length, 1);
  } finally {
    w.close();
  }
});

test("PBR roles cover Poly Haven, ambientCG and naming variants", () => {
  for (const [name, role] of Object.entries({
    "Wood_Color.jpg": "color",
    "wood_diff_2k.jpg": "color",
    "Base_Color.png": "color",
    "Wood_NormalDX.png": "normal-dx",
    "Wood_NormalGL.png": "normal-gl",
    "wood_nor_gl_2k.exr": "normal-gl",
    "wood_rough_2k.exr": "roughness",
    "Wood_Displacement.png": "displacement",
    "Wood_AmbientOcclusion.jpg": "ao",
    "wood_ao.png": "ao",
    "Wood_Metalness.png": "metalness",
    "studio.hdr": "hdri",
    "scene.glb": "glb",
  }))
    assert.equal(detectRole(name), role, name);
});

test("index is stable, catalogue uses UUIDv5, path escaping is rejected", () => {
  const w = workspace();
  try {
    fakeAsset(w.root);
    buildIndex(w.root);
    const cat = readFileSync(w.p.libraryCatalog, "utf8");
    buildIndex(w.root);
    assert.equal(readFileSync(w.p.libraryCatalog, "utf8"), cat);
    assert.match(catalogUuid("materials/ambientcg"), /^[a-f0-9-]{14}5[a-f0-9-]{21}$/);
    assert.equal(catalogUuid("python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
    const asset = fakeAsset(w.root);
    asset.files[0]!.path = "../../libraries.json";
    atomicJson(path.join(w.p.library, "materials/ambientcg/Test001/asset.json"), asset);
    assert.throws(() => buildIndex(w.root), /escapes/);
  } finally {
    w.close();
  }
});

test("search ranks exact ids and local results first, filters kind/source", async () => {
  const w = workspace();
  try {
    fakeAsset(w.root);
    buildIndex(w.root);
    assert.equal((await searchAssets("wood", { root: w.root, local: true })).local.length, 1);
    assert.equal((await searchAssets("wood", { root: w.root, local: true, kind: "hdri" })).local.length, 0);
    assert.equal(
      rank(
        [
          { id: "a:wood", title: "X", tags: [] },
          { id: "a:other", title: "Wood", tags: [] },
        ],
        "wood",
      )[0]!.id,
      "a:wood",
    );
  } finally {
    w.close();
  }
});

test("consent and approval gates happen before network; direct pins add and pin only explicitly", async () => {
  const w = workspace();
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    return new Response("abc");
  };
  try {
    await assert.rejects(addAsset(item.id, { root: w.root, fetch: request }), /consent/);
    assert.equal(requests, 0);
    const manifest: Manifest = {
      version: 1,
      sources: [{ ...source, status: "proposed", adapter: "direct-url" }],
      items: [
        {
          id: item.id,
          kind: item.kind,
          title: item.title,
          url: item.url,
          size: item.size,
          format: "png",
          sha256: digest("abc"),
          licence: item.licence,
          resolution: item.resolution,
          tags: item.tags,
        },
      ],
    };
    atomicJson(w.p.librariesManifest, manifest);
    await assert.rejects(addAsset(item.id, { root: w.root, consent: "fixture", fetch: request }), /proposed/);
    assert.equal(requests, 0);
    manifest.sources[0]!.status = "approved";
    atomicJson(w.p.librariesManifest, manifest);
    await addAsset(item.id, { root: w.root, consent: "fixture 2026-11-15 test", fetch: request });
    assert.equal(requests, 1);
    assert.equal(buildIndex(w.root).assets.length, 1);
  } finally {
    w.close();
  }
});

test("credits use usage logs, deduplicate assets and resolve collection status", () => {
  const w = workspace();
  try {
    fakeAsset(w.root);
    buildIndex(w.root);
    const entry = { id: item.id, script: "/project/shot.py", time: "2026-11-15T00:00:00Z", project: "demo" };
    writeFileSync(path.join(w.p.library, "usage.jsonl"), `${JSON.stringify(entry)}\n${JSON.stringify(entry)}\n`);
    assert.equal(projectCredits("demo", w.root).length, 1);
    assert.match(projectCredits("demo", w.root)[0]!.line, /Test credit/);
    assert.deepEqual(projectCredits("other", w.root), []);
    atomicJson(path.join(w.p.collections, "test.json"), {
      version: 1,
      name: "test",
      status: "proposed",
      verified: false,
      items: [item.id, "ambientcg:Missing"],
      notes: "",
    });
    const status = collectionStatus("test", w.root);
    assert.deepEqual(
      status.assets.map((a) => a.status),
      ["present", "missing"],
    );
    assert.match(status.assets[1]!.command, /--id ambientcg:Missing --consent/);
    assert.equal(status.assets[0]!.pinned, false);
  } finally {
    w.close();
  }
});

test("measure index and local search for 200 synthetic assets", async (t) => {
  const w = workspace();
  try {
    for (let i = 0; i < 200; i++) fakeAsset(w.root, `ambientcg:Test${i}`);
    const start = performance.now();
    assert.equal(buildIndex(w.root).assets.length, 200);
    const indexMs = performance.now() - start,
      search = performance.now();
    const result = await searchAssets("wood", { root: w.root, local: true });
    assert.equal(result.local.length, 200);
    t.diagnostic(`N=200 index=${indexMs.toFixed(2)}ms search=${(performance.now() - search).toFixed(2)}ms`);
  } finally {
    w.close();
  }
});

test("CLI emits one envelope and rejects unknown flags", () => {
  for (const args of [["--action", "sources"], ["sources"], ["--action", "sources", "--surprise", "x"]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/blender-assets.ts", ...args], {
      encoding: "utf8",
    });
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, args.length <= 2);
    assert.equal(result.status, args.length <= 2 ? 0 : 1);
  }
});

test(
  "real Blender: append PBR/model, render against flat, enumerate and append Essentials",
  { skip: process.env.RUN_BLENDER_TESTS !== "1" },
  (t) => {
    const w = workspace();
    try {
      const script = path.join(w.root, "shot.py"),
        output = path.join(w.root, "render");
      const wrapper = path.join(w.root, "blender-isolated");
      // The runner intentionally strips environment variables; the executable wrapper restores isolation.
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(
        wrapper,
        `#!/bin/sh\nexport BLENDER_USER_RESOURCES=${quote(w.p.blenderUser)}\nexport BLENDER_USER_CONFIG=${quote(path.join(w.p.blenderUser, "config"))}\nexport BLENDER_USER_SCRIPTS=${quote(path.join(w.p.blenderUser, "scripts"))}\nexport BLENDER_USER_EXTENSIONS=${quote(path.join(w.p.blenderUser, "extensions"))}\nexport BLENDER_SYSTEM_EXTENSIONS=${quote(path.join(w.p.blenderUser, "system-extensions"))}\nexec /Applications/Blender.app/Contents/MacOS/Blender "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        script,
        `
import bpy, json, os, time
from pathlib import Path
import avc_assets
os.environ['AGENTBROS_REPO_ROOT'] = ${JSON.stringify(w.root)}
base = avc_assets.library_path()
bpy.ops.wm.read_factory_settings(use_empty=True)
def receipt(ident, kind, files):
    folder = base / kind / 'ambientcg' / ident
    folder.mkdir(parents=True, exist_ok=True)
    asset = ${JSON.stringify({ version: 1, source: "ambientcg", title: "Synthetic", licence: "CC0-1.0", licenceUrl: source.licenceUrl, attribution: "Synthetic fixture", sourcePage: item.sourcePage, sha256: digest("synthetic"), fetched: "2026-11-15T00:00:00Z", consent: { by: "fixture", date: "2026-11-15T00:00:00Z", note: "fixture" }, tags: [] })}
    asset.update(id='ambientcg:' + ident, kind=kind, files=files)
    (folder / 'asset.json').write_text(json.dumps(asset))
    return asset
files=[]
for role, colour in [('color',(0.2,0.4,0.8,1)),('roughness',(0.3,0.3,0.3,1)),('normal-gl',(0.5,0.5,1,1)),('displacement',(0.5,0.5,0.5,1))]:
    folder = base / 'materials/ambientcg/PBR'
    folder.mkdir(parents=True, exist_ok=True)
    image = bpy.data.images.new(role, width=2, height=2)
    image.pixels[:] = list(colour) * 4
    image.filepath_raw = str(folder / (role + '.png'))
    image.file_format = 'PNG'
    image.save()
    files.append(dict(path=image.filepath_raw.removeprefix(str(base) + '/'), role=role))
material_asset = receipt('PBR', 'materials', files)
folder = base / 'models/ambientcg/Tiny'
folder.mkdir(parents=True, exist_ok=True)
bpy.ops.mesh.primitive_cube_add(size=0.4)
bpy.ops.export_scene.gltf(filepath=str(folder / 'tiny.glb'), export_format='GLB')
bpy.data.objects.remove(bpy.context.object, do_unlink=True)
model_asset = receipt('Tiny', 'models', [dict(path='models/ambientcg/Tiny/tiny.glb', role='glb')])
(base / 'index.json').write_text(json.dumps(dict(version=1,assets=[material_asset,model_asset])))
avc_assets.register_library()
started=time.perf_counter()
material=avc_assets.append('ambientcg:PBR', displacement=True, project='demo')
material_ms=(time.perf_counter()-started)*1000
assert {'ShaderNodeTexCoord','ShaderNodeMapping','ShaderNodeNormalMap','ShaderNodeDisplacement'} <= {node.bl_idname for node in material.node_tree.nodes}
for node in material.node_tree.nodes:
    if node.type=='TEX_IMAGE':
        assert node.image.colorspace_settings.name == ('sRGB' if node.label=='color' else 'Non-Color')
started=time.perf_counter()
model=avc_assets.append('ambientcg:Tiny', name='tiny.glb', normalise_scale=0.5, project='demo')
model_ms=(time.perf_counter()-started)*1000
model.location=(1,0,0)
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8)
sphere=bpy.context.object
sphere.data.materials.append(material)
bpy.ops.object.camera_add(location=(3,-5,3))
camera=bpy.context.object
camera.rotation_euler=((sphere.location-camera.location).to_track_quat('-Z','Y').to_euler())
bpy.context.scene.camera=camera
bpy.ops.object.light_add(type='AREA', location=(0,-3,4))
bpy.context.object.data.energy=800
scene=bpy.context.scene
scene.render.engine='CYCLES'
scene.cycles.device='CPU'
scene.cycles.samples=2
scene.render.resolution_x=160
scene.render.resolution_y=90
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
started=time.perf_counter()
scene.render.filepath=${JSON.stringify(path.join(w.root, "pbr.png"))}
bpy.ops.render.render(write_still=True)
pbr_ms=(time.perf_counter()-started)*1000
flat=bpy.data.materials.new('Flat')
flat.diffuse_color=(0.2,0.4,0.8,1)
sphere.data.materials[0]=flat
scene.render.filepath=${JSON.stringify(path.join(w.root, "flat.png"))}
started=time.perf_counter()
bpy.ops.render.render(write_still=True)
flat_ms=(time.perf_counter()-started)*1000
bundled=avc_assets.bundled_assets()
assert bundled, 'No bundled Essentials in this Blender distribution'
avc_assets.append(bundled[0]['id'], project='demo')
Path(${JSON.stringify(path.join(w.root, "measurements.json"))}).write_text(json.dumps(dict(materialMs=material_ms,modelMs=model_ms,pbrRenderMs=pbr_ms,flatRenderMs=flat_ms,essentials=bundled)))
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/blender-run.ts",
          "--script",
          script,
          "--output",
          output,
          "--no-render",
          "--executable",
          wrapper,
        ],
        { encoding: "utf8", timeout: 240000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout.trim()).ok, true);
      assert.ok(existsSync(path.join(w.root, "pbr.png")));
      assert.ok(existsSync(path.join(w.root, "flat.png")));
      const measured = JSON.parse(readFileSync(path.join(w.root, "measurements.json"), "utf8"));
      t.diagnostic(JSON.stringify(measured));
      buildIndex(w.root);
      assert.ok(projectCredits("demo", w.root).length >= 3);
    } finally {
      w.close();
    }
  },
);

test("Poly Haven PBR downloads pin every map only with --pin", async () => {
  for (const pin of [false, true]) {
    const w = workspace();
    try {
      atomicJson(w.p.librariesManifest, {
        version: 1,
        sources: [{ ...source, id: "polyhaven", adapter: "polyhaven-api", config: {} }],
        items: [],
      });
      const request: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes("/info/")) return new Response(JSON.stringify({ name: "Wood", type: 1, tags: ["wood"] }));
        if (url.includes("/files/"))
          return new Response(
            JSON.stringify(
              Object.fromEntries(
                ["diff", "rough", "nor_gl"].map((role) => [
                  role,
                  {
                    "2k": {
                      png: {
                        url: `https://dl.polyhaven.org/file/ph-assets/Textures/png/2k/wood_${role}_2k.png`,
                        size: 3,
                        md5: createHash("md5").update("abc").digest("hex"),
                      },
                    },
                  },
                ]),
              ),
            ),
          );
        return new Response("abc");
      };
      const asset = await addAsset("polyhaven:wood", { root: w.root, consent: "fixture only", pin, fetch: request });
      assert.equal(asset.files.length, 3);
      assert.deepEqual(asset.files.map((file) => file.role).sort(), ["color", "normal-gl", "roughness"]);
      const manifest = ManifestSchema.parse(JSON.parse(readFileSync(w.p.librariesManifest, "utf8")));
      assert.equal(manifest.items.length, pin ? 1 : 0);
      if (pin) {
        assert.equal(manifest.items[0]!.dependencies!.length, 2);
        assert.ok(manifest.items[0]!.dependencies!.every((file) => file.sha256 === digest("abc")));
      }
    } finally {
      w.close();
    }
  }
});

test("writes refuse existing symlink destinations before extraction", () => {
  const w = workspace();
  try {
    const destination = path.join(w.root, "outside");
    mkdirSync(destination);
    const result = spawnSync("ln", ["-s", destination, path.join(w.p.library, "materials/ambientcg")]);
    assert.equal(result.status, 0);
    const archive = path.join(w.root, "archive.zip");
    zip(archive);
    assert.throws(
      () => unpackAsset(item, { file: archive, sha256: digest("zip") }, source, "fixture", w.root),
      /Symlink/,
    );
    assert.deepEqual(readdirSync(destination), []);
  } finally {
    w.close();
  }
});

test("ambientCG stable URLs follow only allowlisted redirects; pins never capture tokens", async () => {
  const w = workspace();
  try {
    atomicJson(w.p.librariesManifest, {
      version: 1,
      sources: [{ ...source, config: { downloadHosts: ["ambientcg.com", "acg-download.struffelproductions.com"] } }],
      items: [],
    });
    const selected = {
      ...item,
      format: "zip",
      url: "https://ambientcg.com/get?file=Test001_1K-JPG.zip",
      sha256: digest("abc"),
    };
    const calls: string[] = [];
    const request: typeof fetch = async (input) => {
      calls.push(String(input));
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://acg-download.struffelproductions.com/file/token/file.zip" },
          })
        : new Response("abc");
    };
    await fetchDownload(selected, w.root, "fixture", request);
    assert.equal(calls.length, 2);
    assert.equal(selected.url, "https://ambientcg.com/get?file=Test001_1K-JPG.zip");
    const bad: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: "https://ihdri.com/payload.zip" } });
    await assert.rejects(fetchDownload({ ...selected, sha256: undefined }, w.root, "fixture", bad), /Unapproved/);
    await assert.rejects(
      fetchDownload({ ...selected, url: "https://ambientcg.com/get?token=secret" }, w.root, "fixture", request),
      /credentials/,
    );
  } finally {
    w.close();
  }
});

test("CDN files retain original numeric indices, compatible asset types and licensed name/category views", async () => {
  const { parseLibraryPage, readLibraryServer } = await import("../src/lib/blender-arsenal/libraries/server");
  const cdn = {
    ...source,
    id: "bradley",
    adapter: "blender-library-server" as const,
    config: { baseUrl: "https://cdn.extensions.blender.org/asset-libraries/test/" },
  };
  const file = (name: string) => ({
    path: name,
    size_in_bytes: 3,
    hash: `SHA256:${digest("abc")}`,
    blender_version: [5, 2, 0],
  });
  const asset = (name: string, id_type: string, license: string, files: (number | string)[], min = [5, 2, 0]) => ({
    name,
    id_type,
    files,
    bl_versions: { min },
    meta: { license },
  });
  const page = {
    files: [file("thumbnail.png"), file("groups.blend"), file("future.blend"), file("brush.blend")],
    assets: [
      asset("A", "NODETREE", "CC0 - Public Domain", [1]),
      asset("B", "MATERIAL", "CC0 - Public Domain", [1]),
      asset("B", "NODETREE", "CC-BY-NC-4.0", [1]),
      asset("Future", "NODETREE", "CC0 - Public Domain", [2], [5, 3, 0]),
      asset("Brush", "BRUSH", "CC0 - Public Domain", [3]),
    ],
  };
  const result = parseLibraryPage(page, cdn);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.allowedCategory, "node_groups");
  assert.deepEqual(result[0]!.allowedAssets, ["A"]);
  const pageBytes = JSON.stringify(page),
    indexBytes = JSON.stringify({ pages: [{ url: "_v1/page.json", hash: `SHA256:${digest(pageBytes)}` }] });
  const request: typeof fetch = async (input) =>
    new Response(
      String(input).endsWith("_asset-library-meta.json")
        ? JSON.stringify({ api_versions: { v1: { url: "_v1/index.json", hash: `SHA256:${digest(indexBytes)}` } } })
        : String(input).endsWith("index.json")
          ? indexBytes
          : pageBytes,
    );
  assert.equal((await readLibraryServer(cdn, request)).length, 1);
  await assert.rejects(
    readLibraryServer(cdn, async (input) =>
      String(input).endsWith("page.json") ? new Response("{}") : request(input),
    ),
    /SHA256/,
  );
});

test("Khronos excludes restricted licences and Smithsonian requires CC0 on both metadata and media", async () => {
  const { allowedKhronosLegal, cc0Smithsonian } = await import("../src/lib/blender-arsenal/libraries/catalogues");
  assert.equal(allowedKhronosLegal([{ spdx: "CC0-1.0" }, { spdx: "LicenseRef-LegalMark-Khronos" }]), true);
  for (const spdx of ["CC-BY-NC-4.0", "LicenseRef-CRYENGINE", "LicenseRef-SCEA"])
    assert.equal(allowedKhronosLegal([{ spdx }]), false);
  assert.equal(allowedKhronosLegal([]), false);
  const record = (metadata: string, media: string) => ({
    content: {
      descriptiveNonRepeating: {
        metadata_usage: { access: metadata },
        online_media: { media: [{ type: "3d_voyager", usage: { access: media } }] },
      },
    },
  });
  assert.equal(cc0Smithsonian(record("CC0", "CC0")), true);
  assert.equal(cc0Smithsonian(record("CC0", "Restricted")), false);
  assert.equal(cc0Smithsonian(record("Restricted", "CC0")), false);
});

test("manual ZIP import records licence and exact consent; signed and hijacked URLs fail closed", async () => {
  const { importArchive } = await import("../src/lib/blender-arsenal/libraries/store");
  const { assertStableDownloadUrl, assertDownloadHost } = await import("../src/lib/blender-arsenal/libraries/network");
  const w = workspace();
  try {
    atomicJson(w.p.librariesManifest, {
      version: 1,
      sources: [{ ...source, id: "kenney", adapter: "manual" }],
      items: [],
    });
    const archive = path.join(w.root, "pack.zip");
    zip(archive);
    const consent = { by: "repo owner", date: "2026-11-15", note: "fixture only" };
    const result = importArchive(archive, "kenney", {
      root: w.root,
      kind: "materials",
      licence: "CC0-1.0",
      sourcePage: "https://kenney.nl/assets/test",
      consent: JSON.stringify(consent),
    });
    assert.equal(result.sha256, digest(readFileSync(archive)));
    assert.deepEqual(result.consent, consent);
    assert.equal(buildIndex(w.root).assets.length, 1);
    for (const query of ["token=x", "sig=x", "X-Goog-Credential=x", "Policy=x", "Key-Pair-Id=x"])
      assert.throws(() => assertStableDownloadUrl(`https://static.poly.pizza/a.glb?${query}`), /credentials/);
    assert.throws(
      () => assertDownloadHost("https://ihdri.com/a.zip", { ...source, config: { downloadHosts: ["ihdri.com"] } }),
      /Unapproved/,
    );
  } finally {
    w.close();
  }
});

test("clean-machine pinned dependency acquisition never inherits the primary file hashes", async () => {
  for (const legacyPin of [false, true]) {
    const w = workspace();
    try {
      const primary = {
        id: "polyhaven:wood",
        title: "Wood",
        kind: "materials",
        tags: [],
        licence: "CC0-1.0",
        url: "https://example.test/color.png",
        sha256: digest("abc"),
        md5: createHash("md5").update("abc").digest("hex"),
        size: 3,
        format: "png",
        name: "wood_Color.png",
        resolution: "1k",
        dependencies: [
          {
            url: "https://example.test/roughness.png",
            name: "wood_Roughness.png",
            format: "png",
            sha256: digest("def"),
            size: 3,
            ...(!legacyPin ? { md5: createHash("md5").update("def").digest("hex") } : {}),
          },
        ],
      };
      atomicJson(w.p.librariesManifest, {
        version: 1,
        sources: [{ ...source, id: "polyhaven", adapter: "direct-url" }],
        items: [primary],
      });
      let requests = 0;
      const request: typeof fetch = async (input) => {
        requests++;
        return new Response(String(input).includes("roughness") ? "def" : "abc");
      };
      const asset = await addAsset(primary.id, { root: w.root, consent: "fixture only", fetch: request });
      assert.equal(requests, 2);
      assert.equal(asset.files.length, 2);
      assert.equal(asset.files.find((file) => file.role === "roughness")?.path.endsWith("wood_Roughness.png"), true);
    } finally {
      w.close();
    }
  }
});

test("Smithsonian file search is joined to a CC0 media package, never licensed by file rows alone", async () => {
  const { KeyCatalogue } = await import("../src/lib/blender-arsenal/libraries/catalogues");
  const smithsonian = { ...source, id: "smithsonian", adapter: "smithsonian-api" as const, config: {} };
  const record = {
    title: "Prop",
    content: {
      descriptiveNonRepeating: {
        metadata_usage: { access: "CC0" },
        online_media: {
          media: [
            {
              id: "3d_package:good",
              type: "3d_voyager",
              usage: { access: "CC0" },
              resources: [{ name: "Prop low", url: "https://3d-api.si.edu/good.ply" }],
            },
            {
              id: "3d_package:bad",
              type: "3d_voyager",
              usage: { access: "Restricted" },
              resources: [{ url: "https://3d-api.si.edu/bad.glb" }],
            },
          ],
        },
      },
    },
  };
  let headUrl = "";
  const request: typeof fetch = async (input, init) => {
    if (init?.method === "HEAD") {
      headUrl = String(input);
      return new Response(null, { headers: { "content-length": "4" } });
    }
    if (String(input).includes("/content/file/search"))
      return new Response(
        JSON.stringify({
          rows: [
            {
              content: {
                uri: "https://3d-api.si.edu/bad.glb",
                model_url: "3d_package:bad",
                quality: "Thumb",
                file_type: "glb",
              },
            },
            {
              content: {
                uri: "https://3d-api.si.edu/good.glb",
                model_url: "3d_package:good",
                quality: "Low",
                file_type: "glb",
              },
            },
          ],
        }),
      );
    return new Response(JSON.stringify({ response: record }));
  };
  const selected = await new KeyCatalogue(smithsonian, request).resolve("smithsonian:record");
  assert.equal(selected.url, "https://3d-api.si.edu/good.glb");
  assert.equal(headUrl, selected.url);
  assert.equal(selected.licence, "CC0-1.0");
});

test("Poly Haven glTF include dependencies keep relative paths and independent published MD5 values", async () => {
  const request: typeof fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).includes("/info/")
          ? { name: "Prop", type: 2 }
          : {
              gltf: {
                "1k": {
                  gltf: {
                    url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/prop.gltf",
                    size: 3,
                    md5: "a".repeat(32),
                    include: {
                      "textures/prop_diff_1k.jpg": {
                        url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/prop_diff_1k.jpg",
                        size: 4,
                        md5: "b".repeat(32),
                      },
                      "prop.bin": {
                        url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/prop.bin",
                        size: 5,
                        md5: "c".repeat(32),
                      },
                    },
                  },
                },
              },
            },
      ),
    );
  const resolved = await new LibraryAdapter(
    { ...source, id: "polyhaven", kinds: ["models"], adapter: "polyhaven-api", config: {} },
    request,
  ).resolve("polyhaven:prop", "models", "1k");
  assert.equal(resolved.format, "gltf");
  assert.equal(resolved.md5, "a".repeat(32));
  assert.deepEqual(
    resolved.dependencies?.map((file) => [file.name, file.md5, file.size]),
    [
      ["textures/prop_diff_1k.jpg", "b".repeat(32), 4],
      ["prop.bin", "c".repeat(32), 5],
    ],
  );
});
