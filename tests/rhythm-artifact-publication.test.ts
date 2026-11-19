import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { prepareRhythmEvidenceForTrustedTests } from "../src/lib/audio/rhythm-preparation";
import { RhythmArtifactStage, RhythmArtifactStageCreationError } from "../src/lib/audio/rhythm-artifact-stage";
import {
  captureRhythmMetadataInstallationForTrustedTests,
  validateRhythmMetadataReceipt,
  artifactRoles,
  type TrustedRhythmMetadataService,
} from "../src/lib/audio/rhythm-artifact-metadata";
import { RhythmReadBudget, RhythmReadContext, rhythmDigest } from "../src/lib/audio/rhythm-files";
import { RhythmPublisher } from "../src/lib/audio/rhythm-publisher";
import { RhythmRuntimeSchema } from "../src/types/rhythm-evidence";
import { AssetRecordSchema } from "../src/types/assets";
import { readRhythmEvidence } from "../src/lib/audio/rhythm-evidence";

/** Rhythm analysis runs only on macOS (tools under sandbox-exec, workspace in /private/tmp); elsewhere these skip. */
const macOsOnly = (t: { skip(message?: string): void }) => {
  if (process.platform === "darwin") return false;
  t.skip("Rhythm runs only on macOS");
  return true;
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture(t: test.TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rhythm-artifact-pure-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "root"),
    temporary = path.join(base, "temporary"),
    tool = path.join(base, "tool");
  fs.mkdirSync(root);
  fs.mkdirSync(temporary);
  fs.writeFileSync(tool, "opaque tool DATA");
  const bytes = Buffer.from("opaque source DATA"),
    sha = hash(bytes),
    original = `projects/demo/assets/imported/${sha}.wav`,
    project = path.join(root, "public/projects/demo");
  fs.mkdirSync(path.join(project, "pipeline"), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, "public", original)), { recursive: true });
  fs.writeFileSync(path.join(root, "public", original), bytes);
  fs.writeFileSync(path.join(project, "project.json"), "{}");
  const asset = AssetRecordSchema.parse({
    schemaVersion: 1,
    id: `sha256:${sha}`,
    hash: sha,
    revision: 1,
    createdAt: "2026-10-12T00:00:00Z",
    kind: "audio",
    files: { original, bytes: bytes.length, mime: "audio/wav" },
    media: { durationSec: 1, timebase: "1/16000", sampleRate: 16000, channels: 1, codec: "pcm_s16le", hasAudio: true },
    provenance: { origin: "manual", tool: "opaque fake test" },
    rights: {},
    entityLinks: [],
    status: "candidate",
  });
  fs.writeFileSync(
    path.join(project, "pipeline/asset-registry.json"),
    JSON.stringify({ schemaVersion: 1, revision: 1, assets: [asset] }),
  );
  const request = {
    version: 1,
    contract: "source-rhythm-evidence-v1",
    projectId: "demo",
    assetId: asset.id,
    assetSha256: sha,
    profile: "rms-onset-v1-mono16k",
  };
  let stage: RhythmArtifactStage | undefined,
    calls = 0,
    metadataCalls = 0;
  const metadata: TrustedRhythmMetadataService = {
    identity: { version: "darwin-owned-generated-fd-v1", sha256: rhythmDigest("fake metadata test, not syscall") },
    assertUnchanged: () => {},
    initialize: async (input) => {
      metadataCalls++;
      input.budget.charge(input.bytes * 2);
      assert.ok(fs.fstatSync(input.fd).isFile());
      assert.equal(input.bounds.timeoutMs <= 3000, true);
      assert.equal(input.bounds.stdoutBytes <= 16384, true);
      assert.equal(input.bounds.stderrBytes <= 65536, true);
    },
  };
  const host = {
    artifactStage: (budget: RhythmReadBudget) => (stage = new RhythmArtifactStage(temporary, budget)),
    metadata: () => metadata,
    resolve: () => tool,
    run: async (_name: unknown, _file: unknown, args: string[]) => {
      calls++;
      const content = args.includes("-version")
        ? "FAKE DATA"
        : args.includes("-show_streams")
          ? JSON.stringify({
              streams: [
                {
                  index: 0,
                  codec_type: "audio",
                  codec_name: "pcm_s16le",
                  sample_rate: "16000",
                  channels: 1,
                  time_base: "1/16000",
                  duration_ts: 16000,
                },
              ],
            })
          : args.includes("-show_frames")
            ? JSON.stringify({ frames: [{ media_type: "audio", stream_index: 0, pts: 0, nb_samples: 16000 }] })
            : Buffer.alloc(64000);
      return { stdout: Buffer.isBuffer(content) ? content : Buffer.from(content), stderrBytes: 0 };
    },
  };
  return {
    base,
    root,
    temporary,
    tool,
    project,
    bytes,
    request,
    host,
    metadata,
    get stage() {
      return stage;
    },
    get calls() {
      return calls;
    },
    get metadataCalls() {
      return metadataCalls;
    },
  };
}
test("all generated roles initialized privately and retired before first persistent capture; strict delayed readback", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t),
    init = f.metadata.initialize,
    roles: string[] = [];
  f.metadata.initialize = async (input) => {
    assert.equal(
      fs.readdirSync(path.join(f.root, ".cache/rhythm-evidence/demo")).some((n) => /^[a-f0-9]{64}$/.test(n)),
      false,
    );
    assert.equal(fs.existsSync(path.join(f.project, "pipeline/rhythm")), false);
    roles.push(input.role);
    await init(input);
  };
  const read = RhythmReadContext.prototype.read;
  let captures = 0;
  RhythmReadContext.prototype.read = function (relative, maximum) {
    if (relative.startsWith(".cache/rhythm-evidence/demo/") && !relative.endsWith(".preparation-lock")) {
      assert.equal(f.stage?.retirementConfirmed, true);
      assert.equal(roles.length, 7);
      captures++;
    }
    return read.call(this, relative, maximum);
  };
  let result;
  try {
    result = await prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host);
  } finally {
    RhythmReadContext.prototype.read = read;
  }
  assert.equal(f.calls, 5);
  assert.equal(f.metadataCalls, 7);
  assert.equal(captures > 0, true);
  assert.deepEqual(roles, [
    "original.wav",
    "clock.json",
    "pcm.f32",
    "initial-config.json",
    "initial-registry.json",
    "commit.json",
    "evidence-staged.json",
  ]);
  assert.deepEqual(fs.readdirSync(f.temporary), []);
  const context = new RhythmReadContext(f.root);
  context.check(result.evidence.artifacts.clock, 4194304);
  await new Promise((resolve) => setTimeout(resolve, 500));
  context.assertUnchanged();
  assert.deepEqual(readRhythmEvidence(f.root, "demo", result.file, result.sha256, result.runtime), result.evidence);
  assert.deepEqual(fs.readFileSync(path.join(f.root, result.evidence.original.path)), f.bytes);
  assert.throws(
    () =>
      readRhythmEvidence(f.root, "demo", result.file, result.sha256, {
        ...result.runtime,
        artifactMetadata: { ...f.metadata.identity, sha256: "a".repeat(64) },
      }),
    /stale/,
  );
});
test("metadata failure preserves first object, retires own private bytes and makes no persistent artifact", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t),
    primary = Object.freeze({
      toString() {
        throw Error("FORMAT");
      },
    });
  f.metadata.initialize = async () => {
    throw primary;
  };
  let caught;
  try {
    await prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host);
  } catch (e) {
    caught = e;
  }
  assert.equal(caught, primary);
  assert.deepEqual(fs.readdirSync(f.temporary), []);
  assert.equal(fs.existsSync(path.join(f.project, "pipeline/rhythm")), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, ".cache/rhythm-evidence/demo")), []);
});
test("metadata cancellation refuses before any PRIMARY artifact and cleans own stage", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t),
    controller = new AbortController();
  f.metadata.initialize = async () => controller.abort();
  await assert.rejects(
    prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host, { signal: controller.signal }),
    /deadline\/cancelled/,
  );
  assert.deepEqual(fs.readdirSync(f.temporary), []);
  assert.equal(fs.existsSync(path.join(f.project, "pipeline/rhythm")), false);
});
test("lease replacement during metadata refuses all later calls/links and preserves foreign lease", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t);
  let calls = 0;
  f.metadata.initialize = async () => {
    calls++;
    const lease = path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock");
    const fd = fs.openSync(lease, "r");
    try {
      fs.unlinkSync(lease);
      fs.writeFileSync(lease, "foreign lease");
    } finally {
      fs.closeSync(fd);
    }
  };
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), /lease changed/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(f.project, "pipeline/rhythm")), false);
  assert.equal(
    fs.readFileSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock"), "utf8"),
    "foreign lease",
  );
  const before = f.calls;
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), /already exists/);
  assert.equal(f.calls, before);
});
test("partial initialization foreign private mutation retains lease and refuses second preparation", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t);
  f.metadata.initialize = async () => {
    fs.writeFileSync(path.join(f.stage!.directory, "clock.json"), "foreign");
    throw Error("PRIMARY metadata");
  };
  await assert.rejects(
    prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host),
    /PRIMARY metadata.*generated stage cleanup/,
  );
  assert.equal(fs.readFileSync(path.join(f.stage!.directory, "clock.json"), "utf8"), "foreign");
  assert.equal(fs.existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), true);
  assert.equal(fs.existsSync(path.join(f.project, "pipeline/rhythm")), false);
});
test("no-overwrite link conflict preserves foreign target and partial cache uncertainty", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t),
    link = fs.linkSync;
  let foreign: string | undefined;
  fs.linkSync = ((source: any, target: any) => {
    if (String(target).endsWith("/clock.json")) {
      fs.writeFileSync(target, "foreign target", { flag: "wx" });
      foreign = String(target);
    }
    return link(source, target);
  }) as typeof link;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host),
      /EEXIST.*installation occurred/,
    );
  } finally {
    fs.linkSync = link;
    syncBuiltinESMExports();
  }
  assert.ok(foreign);
  assert.equal(fs.readFileSync(foreign, "utf8"), "foreign target");
  assert.equal(
    fs.existsSync(path.join(f.project, "pipeline/rhythm")) &&
      fs.readdirSync(path.join(f.project, "pipeline/rhythm")).length > 0,
    false,
  );
});
test("stage retirement fault keeps owned lease and explicit durable output uncertainty", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t),
    factory = f.host.artifactStage;
  f.host.artifactStage = (budget) => {
    const stage = factory(budget);
    stage.cleanup = () => {
      throw Error("retirement failed");
    };
    return stage;
  };
  await assert.rejects(
    prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host),
    /retirement failed.*generated stage cleanup.*immutable output publication occurred/,
  );
  assert.equal(fs.readdirSync(path.join(f.project, "pipeline/rhythm")).length, 1);
  assert.equal(fs.existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), true);
  const before = f.calls;
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), /already exists/);
  assert.equal(f.calls, before);
});
test("creation outcomes release stage directory reservation only after confirmed retirement", async (t) => {
  if (macOsOnly(t)) return;
  for (const confirmed of [true, false]) {
    const f = fixture(t);
    f.host.artifactStage = () => {
      throw new RhythmArtifactStageCreationError(Error("creation fault"), confirmed);
    };
    await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), /creation fault/);
    assert.equal(fs.existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), !confirmed);
  }
});
test("stage role bounds and installation without initialization refuse", (t) => {
  const f = fixture(t),
    budget = new RhythmReadBudget(),
    stage = new RhythmArtifactStage(f.temporary, budget),
    context = new RhythmReadContext(f.root),
    publisher = new RhythmPublisher(context, "demo");
  publisher.directory(".cache/rhythm-evidence/demo");
  stage.write("clock.json", Buffer.from("{}"));
  assert.throws(() => stage.write("unknown", Buffer.alloc(1)), /fixed member\/byte bound/);
  assert.throws(
    () => stage.write("commit.json", Buffer.alloc(artifactRoles["commit.json"] + 1)),
    /fixed member\/byte bound/,
  );
  publisher.stageWrite(stage, "pcm.f32", Buffer.alloc(4));
  publisher.exclusiveDirectory(".cache/rhythm-evidence/demo/key");
  assert.throws(
    () => publisher.install(".cache/rhythm-evidence/demo/key/pcm.f32", stage, "pcm.f32", () => {}),
    /metadata state/,
  );
  assert.equal(publisher.installationOccurred, false, "uninitialized state refused before any link");
  stage.cleanup();
  publisher.retireStage(stage);
});
test("runtime absent-field schema preserves historical bytes and rejects invented metadata selectors", () => {
  const value = {
    ffmpeg: { version: "data", sha256: "a".repeat(64) },
    ffprobe: { version: "data", sha256: "b".repeat(64) },
  };
  assert.equal(JSON.stringify(RhythmRuntimeSchema.parse(value)), JSON.stringify(value));
  assert.equal(
    RhythmRuntimeSchema.safeParse({
      ...value,
      artifactMetadata: { version: "darwin-owned-generated-fd-v1", sha256: "a".repeat(64), library: "/foreign" },
    }).success,
    false,
  );
});
function installation(t: test.TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "metadata-install-pure-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const names = ["python", "ctypes", "extension", "shim", "helper", "sdk"] as const;
  const layout = Object.fromEntries(names.map((n) => [n, path.join(base, n)])) as Record<
    (typeof names)[number],
    string
  >;
  for (const n of names)
    fs.writeFileSync(
      layout[n],
      n === "sdk" ? "#define UF_TRACKED              0x00000040\nint     fchflags(int, __uint32_t);" : "opaque " + n,
    );
  const a = path.join(base, "alias-a"),
    b = path.join(base, "alias-b"),
    c = path.join(base, "alias-sdk");
  fs.symlinkSync("python", a);
  fs.symlinkSync("alias-a", b);
  fs.symlinkSync("sdk", c);
  return {
    base,
    layout: {
      ...layout,
      aliases: [
        [a, "python"],
        [b, "alias-a"],
        [c, "sdk"],
      ] as const,
    },
  };
}
test("actual readonly installation consumer pins exact aliases, ABI and physical bytes; late replacement refused", (t) => {
  const f = installation(t),
    captured = captureRhythmMetadataInstallationForTrustedTests(new RhythmReadBudget(), f.layout);
  captured.assertUnchanged();
  fs.unlinkSync(f.layout.aliases[0][0]);
  fs.symlinkSync("shim", f.layout.aliases[0][0]);
  assert.throws(() => captured.assertUnchanged(), /alias changed/);
});
test("installation consumer rejects unlisted ancestor alias, wrong ABI and changed installed image", (t) => {
  const f = installation(t);
  fs.writeFileSync(f.layout.sdk, "wrong ABI");
  assert.throws(
    () => captureRhythmMetadataInstallationForTrustedTests(new RhythmReadBudget(), f.layout),
    /ABI changed/,
  );
  fs.writeFileSync(f.layout.sdk, "#define UF_TRACKED              0x00000040\nint     fchflags(int, __uint32_t);");
  const captured = captureRhythmMetadataInstallationForTrustedTests(new RhythmReadBudget(), f.layout);
  fs.writeFileSync(f.layout.extension, "changed image");
  assert.throws(() => captured.assertUnchanged(), /pin changed/);
  const alias = path.join(f.base, "ancestor-alias");
  fs.symlinkSync(f.base, alias);
  assert.throws(
    () =>
      captureRhythmMetadataInstallationForTrustedTests(new RhythmReadBudget(), {
        ...f.layout,
        helper: path.join(alias, "helper"),
      }),
    /ancestor alias|parent alias|root/,
  );
});

test("unknown generated write FD closure keeps exact accounting and lease, first write fault preserved", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t),
    factory = f.host.artifactStage,
    write = fs.writeSync,
    close = fs.closeSync;
  let fd: number | undefined,
    closed = false;
  const primary = Object.freeze({
    toString() {
      throw Error("FORMAT");
    },
  });
  f.host.artifactStage = (budget) => {
    const stage = factory(budget),
      original = stage.write.bind(stage);
    stage.write = (name, bytes) => {
      if (name !== "clock.json") return original(name, bytes);
      fs.writeSync = ((handle: any, ...args: any[]) => {
        fd = handle;
        throw primary;
      }) as typeof write;
      fs.closeSync = ((handle: any) => {
        if (handle === fd && !closed) {
          closed = true;
          throw Error("injected close");
        }
        return close(handle);
      }) as typeof close;
      syncBuiltinESMExports();
      try {
        return original(name, bytes);
      } finally {
        fs.writeSync = write;
        fs.closeSync = close;
        syncBuiltinESMExports();
      }
    };
    return stage;
  };
  try {
    await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, primary);
      assert.match(error.message, /unprintable rhythm failure.*descriptor closure unconfirmed/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), true);
    assert.equal(fs.existsSync(path.join(f.project, "pipeline/rhythm")), false);
  } finally {
    if (fd !== undefined) close(fd);
  }
});
test("metadata shared verification and aggregate stdout/stderr reservations fail closed", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t);
  f.metadata.initialize = async (input) => {
    input.budget.consumed = 256 * 1024 * 1024;
    input.budget.charge(input.bytes * 2);
  };
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), /verification threshold/);
  assert.equal(fs.existsSync(path.join(f.project, "pipeline/rhythm")), false);
  const tight = fixture(t);
  await assert.rejects(
    prepareRhythmEvidenceForTrustedTests(
      tight.root,
      { ...tight.request, limits: { sharedMetadataBytes: 2048 } },
      tight.host,
    ),
    /shared generated metadata/,
  );
  assert.equal(tight.metadataCalls < 7, true);
  assert.equal(fs.existsSync(path.join(tight.project, "pipeline/rhythm")), false);
});
test("installation parent replacement above immediate context refuses identical bytes", (t) => {
  const f = installation(t),
    nested = path.join(f.base, "parent", "child");
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, "helper");
  fs.copyFileSync(f.layout.helper, file);
  const captured = captureRhythmMetadataInstallationForTrustedTests(new RhythmReadBudget(), {
    ...f.layout,
    helper: file,
  });
  fs.renameSync(path.join(f.base, "parent"), path.join(f.base, "old-parent"));
  fs.mkdirSync(path.join(f.base, "parent", "child"), { recursive: true });
  fs.linkSync(path.join(f.base, "old-parent/child/helper"), file);
  assert.throws(() => captured.assertUnchanged(), /ancestor changed/);
});

test("exact installed caller receipt checks full ns identity, flags and closed runtime fields", (t) => {
  const f = fixture(t),
    fd = fs.openSync(f.tool, "r"),
    s = fs.fstatSync(fd, { bigint: true });
  fs.closeSync(fd);
  const stats = {
    st_dev: Number(s.dev),
    st_ino: Number(s.ino),
    st_size: Number(s.size),
    st_mode: Number(s.mode),
    st_uid: Number(s.uid),
    st_gid: Number(s.gid),
    st_nlink: Number(s.nlink),
    st_mtime_ns: s.mtimeNs.toString(),
    st_ctime_ns: s.ctimeNs.toString(),
    st_flags: 0,
  };
  const expected = {
      sha256: "a".repeat(64),
      python: "/fixed/python",
      ctypes: "/fixed/ctypes",
      extension: "/fixed/extension",
    },
    value = {
      ok: true,
      before: stats,
      after: { ...stats, st_flags: 64 },
      sha256: expected.sha256,
      semanticClaim: "owned-generated-metadata-only",
      runtime: {
        executable: expected.python,
        ctypes: expected.ctypes,
        _ctypes: expected.extension,
        systemImage: "/usr/lib/libSystem.B.dylib",
        symbol: "fchflags",
        ABI: "int(int,uint32_t)",
        flag: 64,
      },
    };
  validateRhythmMetadataReceipt(value, s, s, expected);
  for (const mutate of [
    (v: any) => v.before.st_ino++,
    (v: any) => (v.after.st_ctime_ns = (BigInt(v.after.st_ctime_ns) + 1n).toString()),
    (v: any) => (v.after.st_flags = 0),
    (v: any) => (v.runtime.executable = "/other/python"),
    (v: any) => (v.runtime.flag = 128),
    (v: any) => (v.runtime.selector = "foreign"),
    (v: any) => (v.sha256 = "b".repeat(64)),
    (v: any) => (v.ok = false),
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => validateRhythmMetadataReceipt(changed, s, s, expected));
  }
});
test("actual owned runner inherited FD/input/env seam uses closed stdio; fake callbacks never launch tools", async (t) => {
  const cp = await import("node:child_process"),
    { PassThrough } = await import("node:stream"),
    { EventEmitter } = await import("node:events"),
    { runRhythmOwnedProcess } = await import("../src/lib/audio/rhythm-process"),
    originalSpawn = cp.default.spawn,
    originalSync = cp.default.spawnSync,
    originalKill = process.kill;
  const f = fixture(t),
    fd = fs.openSync(f.tool, "r"),
    input = Buffer.from('{"closed":"DATA-only"}');
  let calls = 0;
  const signals: number[] = [];
  cp.default.spawn = ((file: any, args: any, options: any) => {
    calls++;
    assert.equal(file, "/fixed/python");
    assert.deepEqual(args, ["-I", "-S", "/fixed/helper.py"]);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe", fd]);
    assert.deepEqual(options.env, { PATH: "/usr/bin:/bin" });
    const child: any = new EventEmitter();
    child.pid = 987654;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.unref = () => {};
    child.kill = () => true;
    child.stdin.on("data", (bytes: Buffer) => {
      assert.deepEqual(bytes, input);
      queueMicrotask(() => {
        child.stdout.write('{"owned":true}');
        child.emit("exit", 0);
        child.emit("close", 0);
      });
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as typeof originalSpawn;
  cp.default.spawnSync = ((file: any, args: any) => {
    assert.equal(file, "/bin/ps");
    assert.deepEqual(args, ["-axo", "pid=,ppid=,lstart=,comm="]);
    return { status: 0, stdout: `987654 ${process.pid} Mon Oct 12 08:00:00 2026 /fixed/python`, stderr: "" };
  }) as typeof originalSync;
  process.kill = ((pid: number) => {
    assert.equal(pid, 987654);
    signals.push(pid);
    return true;
  }) as typeof originalKill;
  syncBuiltinESMExports();
  try {
    const result = await runRhythmOwnedProcess(
      "/fixed/python",
      ["-I", "-S", "/fixed/helper.py"],
      { timeoutMs: 1000, stallMs: 1000, stdoutBytes: 16384, stderrBytes: 65536 },
      { inheritedFd: fd, input, env: { PATH: "/usr/bin:/bin" } },
    );
    assert.deepEqual(JSON.parse(result.stdout.toString()), { owned: true });
    assert.equal(result.stderrBytes, 0);
    assert.equal(calls, 1);
    assert.deepEqual(signals, [987654]);
    assert.throws(
      () =>
        runRhythmOwnedProcess(
          "/fixed/python",
          [],
          { timeoutMs: 1000, stallMs: 1000, stdoutBytes: 16384, stderrBytes: 65536 },
          { inheritedFd: fd, input: Buffer.alloc(2049), env: { PATH: "/usr/bin:/bin" } },
        ),
      /FD\/input bounds/,
    );
    assert.equal(calls, 1);
  } finally {
    cp.default.spawn = originalSpawn;
    cp.default.spawnSync = originalSync;
    process.kill = originalKill;
    syncBuiltinESMExports();
    fs.closeSync(fd);
  }
});

test("successful public link marks durable publication before linked/enroll/fsync faults", async (t) => {
  if (macOsOnly(t)) return;
  for (const fault of ["linked", "enroll", "fsync"]) {
    const f = fixture(t),
      factory = f.host.artifactStage,
      cleanup = RhythmPublisher.prototype.cleanup,
      enroll = RhythmReadContext.prototype.enrollCreated,
      link = fs.linkSync,
      sync = fs.fsyncSync,
      primary = Error("PUBLIC " + fault);
    let published: string | undefined,
      cleanupCalls = 0;
    RhythmPublisher.prototype.cleanup = function () {
      cleanupCalls++;
      return cleanup.call(this);
    };
    if (fault === "linked")
      f.host.artifactStage = (budget) => {
        const stage = factory(budget),
          linked = stage.linked.bind(stage);
        stage.linked = (name, target) => {
          if (name === "evidence-staged.json") {
            assert.equal(fs.existsSync(target), true);
            published = target;
            throw primary;
          }
          return linked(name, target);
        };
        return stage;
      };
    if (fault === "enroll")
      RhythmReadContext.prototype.enrollCreated = function (relative) {
        if (relative.startsWith("public/projects/demo/pipeline/rhythm/") && relative.endsWith(".evidence.json")) {
          published = path.join(this.root, relative);
          assert.equal(fs.existsSync(published), true);
          throw primary;
        }
        return enroll.call(this, relative);
      };
    if (fault === "fsync") {
      fs.linkSync = ((from: any, to: any) => {
        link(from, to);
        if (String(to).startsWith(f.project) && String(to).endsWith(".evidence.json")) published = String(to);
      }) as typeof link;
      fs.fsyncSync = ((fd: number) => {
        if (
          published &&
          fs.fstatSync(fd).isDirectory() &&
          fs.fstatSync(fd).ino === fs.lstatSync(path.dirname(published)).ino
        )
          throw primary;
        return sync(fd);
      }) as typeof sync;
      syncBuiltinESMExports();
    }
    try {
      await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, primary);
        assert.match(error.message, /immutable output publication occurred, verify pinned output before retry/);
        return true;
      });
      assert.ok(published);
      const bytes = fs.readFileSync(published);
      const evidence = JSON.parse(bytes.toString());
      assert.equal(evidence.request.assetSha256, f.request.assetSha256);
      assert.equal(cleanupCalls, 0, "no prepublication publisher cleanup selected");
      assert.deepEqual(
        readRhythmEvidence(f.root, "demo", path.relative(f.project, published), hash(bytes), {
          artifactMetadata: f.metadata.identity,
          ffmpeg: { file: f.tool, version: "FAKE DATA" },
          ffprobe: { file: f.tool, version: "FAKE DATA" },
        }),
        evidence,
      );
    } finally {
      RhythmPublisher.prototype.cleanup = cleanup;
      RhythmReadContext.prototype.enrollCreated = enroll;
      fs.linkSync = link;
      fs.fsyncSync = sync;
      syncBuiltinESMExports();
    }
  }
});
test("public install flag rejects cache role and wrong project path before any link", (t) => {
  const f = fixture(t),
    stage = new RhythmArtifactStage(f.temporary, new RhythmReadBudget()),
    publisher = new RhythmPublisher(new RhythmReadContext(f.root), "demo");
  for (const [relative, role] of [
    [".cache/rhythm-evidence/demo/key/evidence-staged.json", "evidence-staged.json"],
    ["public/projects/foreign/pipeline/rhythm/" + "a".repeat(64) + ".evidence.json", "evidence-staged.json"],
    ["public/projects/demo/pipeline/rhythm/" + "a".repeat(64) + ".evidence.json", "pcm.f32"],
  ])
    assert.throws(
      () =>
        publisher.install(
          relative,
          stage,
          role,
          () => {
            throw Error("beforelink must not run");
          },
          { publicEvidence: true },
        ),
      /closed public evidence role\/path/,
    );
  assert.equal(publisher.publicationOccurred, false);
  assert.equal(publisher.installationOccurred, false);
  stage.cleanup();
});
