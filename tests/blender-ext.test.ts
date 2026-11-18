import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExtensionEntrySchema, ExtensionsManifestSchema, type ExtensionEntry } from "../src/types/blender-extensions";
import {
  approveExtension,
  approvedExtensions,
  extensionEnvironment,
  extensionInstallArguments,
  fetchExtension,
  inspectExtension,
  installExtension,
  listExtensions,
  managedPath,
  proposeExtension,
  readExtensions,
  trialExtension,
  type BlenderExtensionProcess,
} from "../src/lib/blender-arsenal/extensions";
import {
  blenderArguments,
  planBlenderRun,
  runBlender,
  validateBlenderRun,
  type BlenderRunRequest,
} from "../src/lib/backends/blender-run";
import { arsenalPaths } from "../src/lib/blender-arsenal/paths";

const repo = process.cwd();
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function workspace(fn: (root: string) => void | Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), "blender-ext-"));
  mkdirSync(path.join(root, "blender-arsenal"));
  mkdirSync(path.join(root, "docs/blender-arsenal"), { recursive: true });
  writeFileSync(arsenalPaths(root).extensionsManifest, JSON.stringify({ note: "Test pins", extensions: [] }));
  copyFileSync(
    path.join(repo, "docs/blender-arsenal/_template.md"),
    path.join(root, "docs/blender-arsenal/_template.md"),
  );
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}
function fixture(root: string, extra = "", unsafe = false) {
  const file = path.join(root, "fixture.zip");
  const manifest = `schema_version = "1.0.0"\nid = "avc_fixture"\nversion = "1.0.0"\nname = "AVC fixture"\ntagline = "A harmless test extension"\nmaintainer = "AVC tests"\ntype = "add-on"\nblender_version_min = "4.2.0"\nlicense = ["SPDX:GPL-3.0-or-later"]\n${extra}`;
  const source = `import bpy\nclass AGENTBROS_OT_fixture(bpy.types.Operator):\n    bl_idname = "avc.fixture"\n    bl_label = "AVC fixture"\n    def execute(self, context):\n        context.scene["avc_fixture_called"] = True\n        return {"FINISHED"}\ndef register():\n    bpy.utils.register_class(AGENTBROS_OT_fixture)\ndef unregister():\n    bpy.utils.unregister_class(AGENTBROS_OT_fixture)\n`;
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); z.writestr("blender_manifest.toml",sys.argv[2]); z.writestr("__init__.py",sys.argv[3]); z.writestr(sys.argv[4],"fixture"); z.close()',
      file,
      manifest,
      source,
      unsafe ? "../escape" : "README.txt",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return file;
}
function proposal(root: string, extra = "") {
  return proposeExtension(root, fixture(root, extra), "A harmless operator to verify extension isolation");
}
function saveEntry(root: string, entry: ExtensionEntry) {
  writeFileSync(arsenalPaths(root).extensionsManifest, JSON.stringify({ note: "Test", extensions: [entry] }));
}
function approve(root: string, entry: ExtensionEntry) {
  writeFileSync(
    path.join(root, entry.evaluation),
    "## Verdict\n\nApproved for the fixture test.\n\n## Recipes that use it\n\nFixture only.\n",
  );
  return approveExtension(root, entry.id, "Test user, today, fixture validation");
}
const fakeInstall: BlenderExtensionProcess = (_executable, argv, env) => {
  assert.ok(argv.includes("--factory-startup"));
  assert.ok(argv.includes("--offline-mode"));
  assert.equal(argv.includes("-e"), false, "installation must not execute the candidate");
  assert.equal(env.HOME, env.BLENDER_USER_RESOURCES);
  assert.equal(env.BLENDER_USER_EXTENSIONS, path.join(env.BLENDER_USER_RESOURCES!, "extensions"));
  const directory = path.join(env.BLENDER_USER_EXTENSIONS!, "user_default/avc_fixture");
  mkdirSync(directory, { recursive: true });
  const unpacked = spawnSync(
    "python3",
    ["-I", "-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", argv.at(-1)!, directory],
    { encoding: "utf8" },
  );
  assert.equal(unpacked.status, 0, unpacked.stderr);
  return { elapsedMs: 12 };
};

test("manifest validates proposals and approved consent; rejects unknown keys, duplicates, missing hashes and rejection reasons", () =>
  workspace((root) => {
    const { entry } = proposal(root);
    assert.equal(ExtensionEntrySchema.parse(entry).status, "proposed");
    for (const bad of [
      { ...entry, typo: true },
      { ...entry, status: "approved" },
      { ...entry, status: "rejected" },
      { ...entry, archive: { ...entry.archive, sha256: "" } },
      { ...entry, evaluation: "docs/../escape.md" },
      { ...entry, id: "../escape" },
    ])
      assert.equal(ExtensionEntrySchema.safeParse(bad).success, false);
    assert.equal(ExtensionsManifestSchema.safeParse({ note: "Test", extensions: [entry, entry] }).success, false);
    assert.equal(
      ExtensionEntrySchema.safeParse({ ...entry, status: "rejected", reason: "No headless support" }).success,
      true,
    );
    assert.equal(approve(root, entry).status, "approved");
  }));

test("inspect returns facts without executing the extension and flags permissions and native wheels", () =>
  workspace((root) => {
    const facts = inspectExtension(
      fixture(
        root,
        'wheels = ["./wheels/example.whl"]\nplatforms = ["macos-arm64"]\n[permissions]\nnetwork = "Asset search"\nfiles = "Import assets"\n',
      ),
    );
    assert.equal(facts.id, "avc_fixture");
    assert.equal(facts.version, "1.0.0");
    assert.deepEqual(facts.licence, ["SPDX:GPL-3.0-or-later"]);
    assert.deepEqual(facts.platforms, ["macos-arm64"]);
    assert.equal(facts.nativeCode, true);
    assert.equal(facts.risks.length, 3);
    assert.equal(facts.permissions.network, "Asset search");
  }));
test("inspect rejects traversal ZIP members without extraction", () =>
  workspace((root) => {
    assert.throws(() => inspectExtension(fixture(root, "", true)), /Unsafe ZIP/);
    assert.equal(existsSync(path.join(root, "escape")), false);
  }));
test("inspect rejects extraction aliases and case-insensitive member collisions", () =>
  workspace((root) => {
    for (const member of ["./blender_manifest.toml", "BLENDER_MANIFEST.TOML", "a//b"]) {
      const file = fixture(root);
      const added = spawnSync("python3", [
        "-I",
        "-c",
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"a"); z.writestr(sys.argv[2],"overwrite"); z.close()',
        file,
        member,
      ]);
      assert.equal(added.status, 0);
      assert.throws(() => inspectExtension(file), /Non-canonical|Duplicate/);
    }
  }));
test("propose caches exact original bytes, invents no URL, refuses duplicates and leaves approval pending", () =>
  workspace((root) => {
    const { entry, archive, evaluation } = proposal(root);
    assert.equal(entry.archive.url, null);
    assert.equal(entry.archive.sha256, digest(readFileSync(archive)));
    assert.match(readFileSync(evaluation, "utf8"), /## Trial results/);
    assert.throws(() => proposeExtension(root, path.join(root, "fixture.zip"), "Again"), /already exists/);
    assert.throws(() => approveExtension(root, entry.id, "User consent"), /completed Verdict/);
    assert.throws(() => approveExtension(root, entry.id, ""), /consent/);
  }));
test("approval requires an actual Verdict and explicit network/account consent", () =>
  workspace((root) => {
    const { entry } = proposal(root, '[permissions]\nnetwork = "Search"\n');
    for (const text of ["## Purpose\nReviewed", "## Verdict\n\n", "## Verdict\n\nPending"]) {
      writeFileSync(path.join(root, entry.evaluation), text);
      assert.throws(() => approveExtension(root, entry.id, "User consent"), /completed Verdict/);
    }
    writeFileSync(path.join(root, entry.evaluation), "## Verdict\n\nApproved for asset search.\n");
    assert.throws(() => approveExtension(root, entry.id, "User consent"), /Network\/account/);
    assert.equal(
      approveExtension(root, entry.id, "User explicitly approves network search", true).consent?.allowNetworkAccount,
      true,
    );
  }));

test("fetch refuses missing consent and rejected pins before calling injected fetch", () =>
  workspace(async (root) => {
    const { entry } = proposal(root);
    let called = 0;
    const fake: typeof fetch = async () => {
      called++;
      throw new Error("must not fetch");
    };
    await assert.rejects(fetchExtension(root, entry.id, "", fake), /consent/);
    entry.status = "rejected";
    entry.reason = "No use";
    saveEntry(root, entry);
    await assert.rejects(fetchExtension(root, entry.id, "User consent", fake), /Rejected/);
    assert.equal(called, 0);
  }));
test("fetch hash mismatch leaves no archive or partial and records consent before the request", () =>
  workspace(async (root) => {
    const { entry, archive } = proposal(root);
    rmSync(archive);
    entry.archive.url = "https://example.invalid/pinned.zip";
    saveEntry(root, entry);
    const fake: typeof fetch = async () => {
      const receipt = JSON.parse(readFileSync(archive + ".consent.json", "utf8")) as { note: string; by: string };
      assert.equal(receipt.note, "User, today, testing");
      assert.equal(receipt.by, "local user", "never the OS account name");
      return new Response(Buffer.alloc(entry.archive.size, 0));
    };
    await assert.rejects(fetchExtension(root, entry.id, "User, today, testing", fake), /hash\/size/);
    assert.equal(existsSync(archive), false);
    assert.equal(existsSync(archive + ".part"), false);
  }));
test("fetch verifies bytes and manifest before atomic rename; refuses size overrun and id mismatch", () =>
  workspace(async (root) => {
    const { entry, archive } = proposal(root);
    const bytes = readFileSync(archive);
    rmSync(archive);
    entry.archive.url = "https://example.invalid/pinned.zip";
    saveEntry(root, entry);
    await assert.rejects(
      fetchExtension(root, entry.id, "User testing", async () => new Response(Buffer.alloc(bytes.length + 1))),
      /exceeds/,
    );
    assert.equal(existsSync(archive), false);
    const file = await fetchExtension(root, entry.id, "User testing", async (url, init) => {
      assert.equal(url, entry.archive.url);
      assert.equal(init?.redirect, "error");
      return new Response(bytes);
    });
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(existsSync(file + ".part"), false);
    rmSync(file);
    entry.version = "2.0.0";
    saveEntry(root, entry);
    await assert.rejects(
      fetchExtension(root, entry.id, "User testing", async () => new Response(bytes)),
      /differs from pin/,
    );
    assert.equal(existsSync(file), false);
  }));

test("fetch leaves the tracked manifest alone and records download consent in a local receipt", () =>
  workspace(async (root) => {
    const { entry, archive } = proposal(root);
    const pin = approve(root, entry);
    const approval = pin.consent;
    const bytes = readFileSync(archive);
    rmSync(archive);
    pin.archive.url = "https://example.invalid/pinned.zip";
    saveEntry(root, pin);
    await fetchExtension(root, pin.id, "Separate download permission", async () => new Response(bytes));
    const current = readExtensions(root).extensions[0]!;
    assert.deepEqual(current.consent, approval);
    assert.deepEqual(current.downloadConsent, pin.downloadConsent);
    assert.equal(
      (JSON.parse(readFileSync(archive + ".consent.json", "utf8")) as { note: string }).note,
      "Separate download permission",
    );
  }));
test("install refuses a successful process that leaves an older installed manifest", () =>
  workspace((root) => {
    const { entry } = proposal(root);
    approve(root, entry);
    assert.throws(
      () =>
        installExtension(root, entry.id, "/fake", (executable, argv, env) => {
          const result = fakeInstall(executable, argv, env);
          const manifest = path.join(env.BLENDER_USER_EXTENSIONS!, "user_default/avc_fixture/blender_manifest.toml");
          writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/^version = "1.0.0"/m, 'version = "0.9.0"'));
          return result;
        }),
      /differs from pin/,
    );
    assert.equal(existsSync(path.join(arsenalPaths(root).blenderUser, "installed.json")), false);
  }));
test("effective spawned environment redirects all Blender and home paths; factory CLI uses local repo without enabling", () =>
  workspace((root) => {
    const { entry } = proposal(root);
    approve(root, entry);
    const result = installExtension(root, entry.id, "/fake/blender", (executable, argv, env) => {
      assert.equal(executable, "/fake/blender");
      for (const key of [
        "HOME",
        "USERPROFILE",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "BLENDER_USER_RESOURCES",
        "BLENDER_USER_CONFIG",
        "BLENDER_USER_SCRIPTS",
        "BLENDER_USER_EXTENSIONS",
        "BLENDER_SYSTEM_EXTENSIONS",
        "BLENDER_USER_DATAFILES",
      ])
        assert.ok(env[key]!.startsWith(arsenalPaths(root).blenderUser));
      assert.equal(env.PYTHONPATH, undefined);
      assert.equal(env.BLENDER_SYSTEM_SCRIPTS, undefined);
      assert.deepEqual(argv.slice(-7), [
        "--command",
        "extension",
        "install-file",
        "-r",
        "user_default",
        "--no-prefs",
        path.join(arsenalPaths(root).downloads, entry.archive.sha256 + ".zip"),
      ]);
      return fakeInstall(executable, argv, env);
    });
    assert.equal(result.elapsedMs, 12);
  }));
test("environment and managed paths reject escaping profiles and symlink ancestors", () =>
  workspace((root) => {
    assert.throws(() => extensionEnvironment(root, "/tmp/profile"), /escapes|under/);
    const local = arsenalPaths(root).local;
    mkdirSync(local);
    symlinkSync(tmpdir(), path.join(local, "blender-user"));
    assert.throws(() => extensionEnvironment(root), /symlink/);
    assert.throws(() => managedPath(root, path.join(root, "../other")), /escapes/);
  }));
test("effective run environment refuses symlinked profile children before Blender starts", () =>
  workspace((root) => {
    const profile = arsenalPaths(root).blenderUser;
    mkdirSync(path.join(profile, "scripts"), { recursive: true });
    symlinkSync(tmpdir(), path.join(profile, "scripts/startup"));
    assert.throws(() => extensionEnvironment(root), /Symlink/);
    rmSync(path.join(profile, "scripts/startup"));
    symlinkSync(tmpdir(), path.join(profile, "config"));
    assert.throws(() => extensionEnvironment(root), /Symlink/);
  }));
test("main install refuses unapproved or tampered archives before spawning", () =>
  workspace((root) => {
    const { entry, archive } = proposal(root);
    assert.throws(
      () =>
        installExtension(root, entry.id, "/fake", () => {
          throw new Error("unexpected spawn");
        }),
      /Only approved/,
    );
    approve(root, entry);
    writeFileSync(archive, "tampered");
    assert.throws(() => installExtension(root, entry.id, "/fake"), /hash\/size/);
  }));
test("list and selection detect missing installations, modified files and changed pins", () =>
  workspace((root) => {
    const { entry } = proposal(root);
    const pin = approve(root, entry);
    assert.equal(listExtensions(root)[0]!.drift, "not installed");
    assert.throws(() => approvedExtensions(root, entry.id), /not approved and installed/);
    installExtension(root, entry.id, "/fake", fakeInstall);
    assert.deepEqual(approvedExtensions(root, "approved"), [{ id: entry.id, version: "1.0.0" }]);
    assert.equal(listExtensions(root)[0]!.drift, null);
    writeFileSync(
      path.join(arsenalPaths(root).blenderUser, "extensions/user_default/avc_fixture/__init__.py"),
      "changed",
    );
    assert.equal(listExtensions(root)[0]!.drift, "installed files changed");
    assert.throws(() => approvedExtensions(root, entry.id), /drift|changed/);
    pin.version = "2.0.0";
    saveEntry(root, pin);
    assert.equal(listExtensions(root)[0]!.drift, "pin changed");
  }));
test("authoring-only pins are excluded from approved render sets and require no-render when explicit", () =>
  workspace((root) => {
    const { entry } = proposal(root);
    const pin = approve(root, entry);
    pin.usage = "authoring";
    saveEntry(root, pin);
    installExtension(root, entry.id, "/fake", fakeInstall);
    assert.deepEqual(approvedExtensions(root, "approved", true), []);
    assert.throws(() => approvedExtensions(root, entry.id, true), /authoring-only/);
    assert.deepEqual(approvedExtensions(root, entry.id, false), [{ id: entry.id, version: entry.version }]);
  }));
test("trial confines install and smoke to a fresh candidate profile", () =>
  workspace((root) => {
    const file = fixture(root);
    let count = 0;
    const result = trialExtension(root, file, "candidate-01", "/fake", (executable, argv, env) => {
      count++;
      assert.ok(env.BLENDER_USER_RESOURCES!.startsWith(arsenalPaths(root).trials));
      if (env.AGENTBROS_EXTENSION_SMOKE_ID) {
        writeFileSync(
          env.AGENTBROS_EXTENSION_SMOKE_RESULT!,
          JSON.stringify({
            enableOk: true,
            enabled: [{ id: "avc_fixture", version: "1.0.0", enableMs: 2 }],
            operators: ["avc.fixture"],
            nodeGroups: [],
          }),
        );
        return { elapsedMs: 3 };
      }
      return fakeInstall(executable, argv, env);
    });
    assert.equal(count, 2);
    assert.equal(result.enableOk, true);
    assert.equal(existsSync(arsenalPaths(root).blenderUser), false);
    assert.throws(() => trialExtension(root, file, "candidate-01", "/fake"), /already exists/);
    assert.throws(() => trialExtension(root, file, "../escape", "/fake"), /safe lowercase/);
  }));
test("runner extension option preserves factory startup, safe argument ordering and approved metadata", () =>
  workspace((root) => {
    const { entry } = proposal(root);
    approve(root, entry);
    installExtension(root, entry.id, "/fake", fakeInstall);
    const req: BlenderRunRequest = {
      script: path.join(repo, "package.json"),
      output: path.join(root, "out"),
      extensions: entry.id,
      factoryStartup: true,
      format: "png",
      device: "cpu",
      noRender: true,
      overwrite: false,
      resume: false,
      timeoutSec: 60,
      scriptArgs: [],
    };
    assert.throws(() => validateBlenderRun({ ...req, factoryStartup: false }), /factory-startup/);
    const argv = blenderArguments(req);
    assert.ok(argv.includes("--factory-startup"));
    assert.ok(argv.includes("--disable-autoexec"));
    assert.ok(argv.includes("--offline-mode"));
    assert.deepEqual(approvedExtensions(root, entry.id), [{ id: entry.id, version: "1.0.0" }]);
    assert.throws(() => approvedExtensions(root, "avc_fixture,avc_fixture"), /Duplicate/);
    assert.throws(() => approvedExtensions(root, "unknown"), /Unknown/);
    assert.throws(() => approvedExtensions(root, ""), /needs ids/);
    assert.ok(extensionInstallArguments("/tmp/a.zip").includes("install-file"));
    assert.equal(
      blenderArguments({
        blend: "/tmp/scene.blend",
        factoryStartup: true,
        scriptArgs: [],
        extensions: entry.id,
      }).includes("/tmp/scene.blend"),
      false,
      "Extension runs open the blend from the request after enabling RNA types",
    );
  }));

test("runner passes isolated environment and pinned versions to the spawned process", () =>
  workspace(async (root) => {
    const { entry } = proposal(root);
    approve(root, entry);
    installExtension(root, entry.id, "/fake", fakeInstall);
    writeFileSync(path.join(root, "scene.py"), "# Trusted fixture");
    const executable = path.join(root, "fake-blender.mjs");
    writeFileSync(
      executable,
      `#!${process.execPath}
import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('Blender 5.2.3 LTS'); process.exit(0); }
const req = JSON.parse(fs.readFileSync(process.env.AGENTBROS_BLENDER_REQUEST, 'utf8'));
fs.writeFileSync(${JSON.stringify(path.join(root, "spawn-env.json"))}, JSON.stringify(process.env));
fs.writeFileSync(req.resultFile, JSON.stringify({ blenderVersion: '5.2.3', engine: 'CYCLES', device: 'cpu', samples: 1, width: 32, height: 32, fps: 30, filmTransparent: false, viewTransform: 'AgX', look: 'None', motionBlur: false, frameStart: 1, frameEnd: 1, rendered: false, extensions: req.extensions }));
`,
    );
    chmodSync(executable, 0o755);
    const previous = process.cwd();
    process.chdir(root);
    try {
      const run = await runBlender({
        script: path.join(root, "scene.py"),
        output: path.join(root, "out"),
        extensions: entry.id,
        factoryStartup: true,
        format: "png",
        device: "cpu",
        noRender: true,
        overwrite: false,
        resume: false,
        timeoutSec: 30,
        scriptArgs: [],
        executable,
      });
      assert.deepEqual(run.extensions, [{ id: entry.id, version: entry.version }]);
      assert.deepEqual(run.render.extensions, run.extensions);
      const env = JSON.parse(readFileSync(path.join(root, "spawn-env.json"), "utf8")) as Record<string, string>;
      for (const key of [
        "HOME",
        "BLENDER_USER_RESOURCES",
        "BLENDER_USER_CONFIG",
        "BLENDER_USER_SCRIPTS",
        "BLENDER_USER_EXTENSIONS",
        "BLENDER_SYSTEM_EXTENSIONS",
        "BLENDER_USER_DATAFILES",
      ])
        assert.ok(env[key]!.startsWith(arsenalPaths(process.cwd()).blenderUser));
      assert.equal(env.BLENDER_SYSTEM_SCRIPTS, undefined);
      assert.equal(env.PATH, process.env.PATH);
      assert.equal(existsSync(path.join(root, process.env.PATH!)), false);
      assert.equal(existsSync(path.join(root, "1")), false); // PYTHONDONTWRITEBYTECODE is a value, not a directory.
    } finally {
      process.chdir(previous);
    }
  }));

test("CLI keeps one-line envelopes for positional actions, help and rejected arguments", () =>
  workspace((root) => {
    for (const args of [["list"], ["--action", "list"], ["--help"], ["list", "--unknown", "value"]]) {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          path.join(repo, "node_modules/tsx/dist/loader.mjs"),
          path.join(repo, "scripts/blender-ext.ts"),
          ...args,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            AGENTBROS_NO_DOTENV: "1",
            PATH: process.env.PATH!,
            HOME: root,
            NODE_PATH: path.join(repo, "node_modules"),
          },
        },
      );
      assert.equal(child.stdout.trim().split("\n").length, 1, child.stderr);
      const envelope = JSON.parse(child.stdout);
      assert.equal(envelope.ok, !args.includes("--unknown"));
      assert.equal(child.status, envelope.ok ? 0 : 1);
    }
  }));

test(
  "real Blender: isolated install, operator, trial and decoded-pixel equality with measured launch-inclusive overhead",
  { skip: process.env.RUN_BLENDER_TESTS !== "1" },
  () =>
    workspace(async (root) => {
      const executable = process.env.BLENDER_PATH ?? "/Applications/Blender.app/Contents/MacOS/Blender";
      const { entry } = proposal(root);
      approve(root, entry);
      const installation = installExtension(root, entry.id, executable);
      const script = path.join(root, "scene.py");
      writeFileSync(
        script,
        `import bpy\nimport os\nfrom avc_export import render_request\nreq = render_request()\nif req.get("extensions"):\n    import avc_extensions\n    avc_extensions.require("avc_fixture", "1.0.0")\n    assert bpy.ops.avc.fixture() == {"FINISHED"}\n    assert bpy.context.scene["avc_fixture_called"]\nbpy.context.scene.cycles.seed = 42\nbpy.context.scene.render.engine = "CYCLES"\n`,
      );
      const base: BlenderRunRequest = {
        script,
        output: path.join(root, "baseline"),
        frames: [1, 1],
        engine: "cycles",
        samples: 1,
        resolution: [32, 32],
        format: "png",
        device: "cpu",
        factoryStartup: true,
        noRender: false,
        overwrite: false,
        resume: false,
        timeoutSec: 120,
        scriptArgs: [],
        executable,
      };
      // The production runner roots its arsenal in cwd; this test owns that cwd temporarily.
      const previous = process.cwd();
      process.chdir(root);
      try {
        const plan = planBlenderRun({ ...base, extensions: entry.id });
        assert.equal(
          realpathSync(plan.environment!.BLENDER_USER_RESOURCES!),
          realpathSync(arsenalPaths(root).blenderUser),
        );
        const measurements: Array<{ withoutMs: number; withMs: number; enableMs: number }> = [];
        const pixels = (file: string) => {
          const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
            maxBuffer: 1024 * 1024,
          });
          assert.equal(decoded.status, 0, decoded.stderr.toString());
          return decoded.stdout;
        };
        for (let index = 0; index < 3; index++) {
          const baseline = async () => {
            saveEntry(root, { ...readExtensions(root).extensions[0]!, status: "proposed" });
            const started = performance.now();
            const result = await runBlender({
              ...base,
              output: path.join(root, `baseline-${index}`),
              extensions: "approved",
            });
            return { result, elapsedMs: performance.now() - started };
          };
          const extended = async () => {
            approve(root, entry);
            const started = performance.now();
            const result = await runBlender({
              ...base,
              output: path.join(root, `extension-${index}`),
              extensions: entry.id,
            });
            return { result, elapsedMs: performance.now() - started };
          };
          let without, withExtension;
          if (index % 2 === 0) {
            without = await baseline();
            withExtension = await extended();
          } else {
            withExtension = await extended();
            without = await baseline();
          }
          assert.deepEqual(pixels(withExtension.result.frames[0]!.path), pixels(without.result.frames[0]!.path));
          measurements.push({
            withoutMs: without.elapsedMs,
            withMs: withExtension.elapsedMs,
            enableMs: withExtension.result.render.extensions![0]!.enableMs,
          });
        }
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
        const trial = trialExtension(root, path.join(root, "fixture.zip"), "real-trial", executable);
        assert.equal(trial.enableOk, true);
        assert.ok((trial.operators as string[]).includes("avc.fixture"));
        console.error(
          JSON.stringify({
            installMs: installation.elapsedMs,
            enableMs: median(measurements.map((item) => item.enableMs)),
            withoutMs: median(measurements.map((item) => item.withoutMs)),
            withMs: median(measurements.map((item) => item.withMs)),
            overheadMs: median(measurements.map((item) => item.withMs - item.withoutMs)),
            differentPixels: 0,
            comparedPixels: 1024,
            pairs: measurements.length,
            measurements,
            samples: 1,
            trial,
          }),
        );
      } finally {
        process.chdir(previous);
      }
    }),
);
