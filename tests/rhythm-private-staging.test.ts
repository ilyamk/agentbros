import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
  lstatSync,
  renameSync,
  symlinkSync,
  chmodSync,
  openSync,
  closeSync,
  ftruncateSync,
  unlinkSync,
} from "node:fs";
import {
  RhythmWorkspace,
  createRhythmWorkspace,
  RhythmWorkspaceCreationError,
} from "../src/lib/audio/rhythm-workspace";
import { RhythmReadContext, RhythmReadBudget } from "../src/lib/audio/rhythm-files";
import { RhythmPublisher } from "../src/lib/audio/rhythm-publisher";
import { prepareRhythmEvidenceForTrustedTests } from "../src/lib/audio/rhythm-preparation";
import { readRhythmEvidence, currentRhythmImplementations } from "../src/lib/audio/rhythm-evidence";
import { RhythmAnalysisRequestSchema } from "../src/types/rhythm-evidence";
import { AssetRecordSchema } from "../src/types/assets";

/** Rhythm analysis runs only on macOS (tools under sandbox-exec, workspace in /private/tmp); elsewhere these skip. */
const macOsOnly = (t: { skip(message?: string): void }) => {
  if (process.platform === "darwin") return false;
  t.skip("Rhythm runs only on macOS");
  return true;
};
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const MiB = 1024 * 1024;
function folder(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rhythm-private-pure-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t: test.TestContext) {
  const parent = folder(t),
    root = path.join(parent, "project-root"),
    base = path.join(parent, "temp-base"),
    tools = path.join(parent, "tools");
  for (const p of [root, base, tools]) mkdirSync(p);
  writeFileSync(path.join(tools, "tool"), "opaque tool DATA; no executable");
  const bytes = Buffer.from("opaque original DATA; not decoded WAV"),
    sha = hash(bytes),
    original = `projects/demo/assets/imported/${sha}.wav`,
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  mkdirSync(path.dirname(path.join(root, "public", original)), { recursive: true });
  writeFileSync(path.join(root, "public", original), bytes);
  writeFileSync(path.join(project, "project.json"), "{}");
  const asset = AssetRecordSchema.parse({
    schemaVersion: 1,
    id: `sha256:${sha}`,
    hash: sha,
    revision: 1,
    createdAt: "2026-10-12T00:00:00Z",
    kind: "audio",
    files: { original, bytes: bytes.length, mime: "audio/wav" },
    media: { durationSec: 1, timebase: "1/16000", sampleRate: 16000, channels: 1, codec: "pcm_s16le", hasAudio: true },
    provenance: { origin: "manual", tool: "explicit opaque DATA test" },
    rights: {},
    entityLinks: [],
    status: "candidate",
  });
  writeFileSync(
    path.join(project, "pipeline/asset-registry.json"),
    JSON.stringify({ schemaVersion: 1, revision: 1, assets: [asset] }),
  );
  const request = RhythmAnalysisRequestSchema.parse({
    version: 1,
    contract: "source-rhythm-evidence-v1",
    projectId: "demo",
    assetId: asset.id,
    assetSha256: sha,
    profile: "rms-onset-v1-mono16k",
  });
  let workspace: RhythmWorkspace | undefined,
    calls = 0;
  const host = {
    workspace: (b: Buffer, e: "wav" | "flac", budget: RhythmReadBudget) =>
      (workspace = new RhythmWorkspace(base, b, e, budget)),
    resolve: () => path.join(tools, "tool"),
    run: async (_name: unknown, _file: unknown, args: string[]) => {
      calls++;
      if (!args.includes("-version")) {
        assert.ok(workspace);
        assert.equal(args.includes(workspace.source), true);
        assert.deepEqual(readFileSync(workspace.source), bytes);
        assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
        assert.equal(args[args.indexOf("-f") + 1], "wav");
      }
      const data = args.includes("-version")
        ? "FAKE version DATA"
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
      return { stdout: Buffer.isBuffer(data) ? data : Buffer.from(data), stderrBytes: 0 };
    },
  };
  return {
    root,
    base,
    project,
    bytes,
    request,
    host,
    get workspace() {
      return workspace;
    },
    get calls() {
      return calls;
    },
  };
}
test("shipped preparation awaits only private original, then preserves canonical evidence and strict readback", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t),
    run = f.host.run;
  let finalSeen = false;
  f.host.run = async (...args) => {
    assert.equal(
      readdirSync(path.join(f.root, ".cache/rhythm-evidence/demo")).some((n) => /^[a-f0-9]{64}$/.test(n)),
      false,
    );
    await new Promise((r) => setTimeout(r, 10));
    return run(...args);
  };
  const result = await prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host);
  finalSeen = existsSync(path.join(f.root, result.evidence.artifacts.clock.path));
  assert.equal(f.calls, 5);
  assert.equal(finalSeen, true);
  assert.deepEqual(readFileSync(path.join(f.root, result.evidence.artifacts.originalSnapshot!.path)), f.bytes);
  assert.deepEqual(readdirSync(f.base), []);
  assert.equal(existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), false);
  assert.deepEqual(readRhythmEvidence(f.root, "demo", result.file, result.sha256, result.runtime), result.evidence);
  assert.equal(JSON.stringify(result.evidence).includes(f.base), false);
  assert.deepEqual(result.evidence.implementations, currentRhythmImplementations());
  const stale = { ...result.evidence.implementations, evidence: "a".repeat(64) };
  assert.notDeepEqual(stale, result.evidence.implementations);
});
test("original/config/registry changes during async work refuse and cleanup workspace plus lease", async (t) => {
  for (const target of ["project.json", "pipeline/asset-registry.json", "original"]) {
    const f = fixture(t);
    f.host.run = async () => {
      const file =
        target === "original"
          ? path.join(f.root, "public/projects/demo/assets/imported", f.request.assetSha256 + ".wav")
          : path.join(f.project, target);
      writeFileSync(file, "changed");
      return { stdout: Buffer.from("FAKE"), stderrBytes: 0 };
    };
    await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), /pin changed/);
    assert.equal(f.calls, 0);
    assert.deepEqual(readdirSync(f.base), []);
    assert.equal(existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), false);
    assert.equal(existsSync(path.join(f.project, "pipeline/rhythm")), false);
  }
});
test("workspace corruption retains changed bytes and own lease to contain unaccounted orphans", async (t) => {
  const f = fixture(t);
  f.host.run = async () => {
    writeFileSync(f.workspace!.source, "foreign DATA");
    return { stdout: Buffer.from("FAKE"), stderrBytes: 0 };
  };
  await assert.rejects(
    prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host),
    /pin changed.*workspace cleanup.*SHA refused/,
  );
  assert.equal(readFileSync(f.workspace!.source, "utf8"), "foreign DATA");
  assert.equal(existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), true);
  let invoked = false;
  f.host.run = async () => {
    invoked = true;
    throw Error("must not run");
  };
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), /already exists/);
  assert.equal(invoked, false);
});
test("expected cancellation keeps first failure and independently retires temp and lease", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  f.host.run = async () => {
    controller.abort();
    return { stdout: Buffer.from("FAKE"), stderrBytes: 0 };
  };
  await assert.rejects(
    prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host, { signal: controller.signal }),
    /deadline\/cancelled/,
  );
  assert.deepEqual(readdirSync(f.base), []);
  assert.equal(existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), false);
});
test("analysis failure plus workspace cleanup fault retains primary cause and attempts lease/publisher cleanup", async (t) => {
  const f = fixture(t);
  f.host.run = async () => {
    writeFileSync(path.join(f.workspace!.directory, "foreign"), "keep");
    throw Error("PRIMARY analysis error");
  };
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /PRIMARY analysis error.*workspace cleanup.*membership/);
    assert.equal((error.cause as Error).message, "PRIMARY analysis error");
    return true;
  });
  assert.equal(readFileSync(path.join(f.workspace!.directory, "foreign"), "utf8"), "keep");
  assert.equal(existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), true);
});
test("post-publication cleanup failure retains output and explicit immutable uncertainty", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t),
    factory = f.host.workspace;
  f.host.workspace = (...args) => {
    const workspace = factory(...args);
    workspace.cleanup = () => {
      throw Error("injected own cleanup fault");
    };
    return workspace;
  };
  await assert.rejects(
    prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host),
    /workspace cleanup.*injected own cleanup fault.*immutable output publication occurred/,
  );
  const files = readdirSync(path.join(f.project, "pipeline/rhythm"));
  assert.equal(files.length, 1);
  const bytes = readFileSync(path.join(f.project, "pipeline/rhythm", files[0]));
  const evidence = JSON.parse(bytes.toString());
  assert.deepEqual(
    readRhythmEvidence(f.root, "demo", "pipeline/rhythm/" + files[0], hash(bytes), {
      artifactMetadata: evidence.runtime.artifactMetadata,
      ffmpeg: { file: f.host.resolve(), version: "FAKE version DATA" },
      ffprobe: { file: f.host.resolve(), version: "FAKE version DATA" },
    }),
    evidence,
  );
  assert.equal(existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), true);
});
test("workspace regular identity, mode, SHA and full membership enforce fail-closed owned cleanup", (t) => {
  for (const mutation of ["replacement", "mode", "alias", "member", "growth"]) {
    const base = folder(t),
      workspace = new RhythmWorkspace(base, Buffer.from("owned"), "wav", new RhythmReadBudget());
    if (mutation === "replacement") {
      renameSync(workspace.source, path.join(workspace.directory, "old"));
      writeFileSync(workspace.source, "foreign");
      unlinkSync(path.join(workspace.directory, "old"));
    }
    if (mutation === "mode") chmodSync(workspace.source, 0o644);
    if (mutation === "alias") {
      unlinkSync(workspace.source);
      symlinkSync("/missing", workspace.source);
    }
    if (mutation === "member") writeFileSync(path.join(workspace.directory, "foreign"), "keep");
    if (mutation === "growth") writeFileSync(workspace.source, "owned+changed");
    assert.throws(() => workspace.assertUnchanged());
    assert.throws(() => workspace.cleanup());
    assert.equal(existsSync(workspace.directory), true);
  }
});
test("workspace ancestor and owned directory swaps refuse even when source bytes remain exact", (t) => {
  const base = folder(t),
    parent = path.join(base, "parent");
  mkdirSync(parent);
  const workspace = new RhythmWorkspace(parent, Buffer.from("owned"), "flac", new RhythmReadBudget());
  renameSync(parent, path.join(base, "old-parent"));
  mkdirSync(parent);
  assert.throws(() => workspace.assertUnchanged(), /ancestor replaced/);
  assert.throws(() => workspace.cleanup(), /ancestor replaced/);
  assert.equal(
    readFileSync(path.join(base, "old-parent", path.basename(workspace.directory), "original.flac"), "utf8"),
    "owned",
  );
  const second = folder(t),
    owned = new RhythmWorkspace(second, Buffer.from("owned"), "wav", new RhythmReadBudget());
  renameSync(owned.directory, path.join(second, "old-owned"));
  mkdirSync(owned.directory, { mode: 0o700 });
  writeFileSync(owned.source, "owned", { mode: 0o600 });
  assert.throws(() => owned.assertUnchanged(), /directory replaced/);
  assert.throws(() => owned.cleanup(), /directory replaced/);
  assert.equal(readFileSync(owned.source, "utf8"), "owned");
});
test("workspace does not capture unrelated OS temp siblings and ordinary cleanup is idempotent", (t) => {
  const base = folder(t),
    workspace = new RhythmWorkspace(base, Buffer.from("owned"), "wav", new RhythmReadBudget());
  writeFileSync(path.join(base, "unrelated"), "keep");
  workspace.assertUnchanged();
  workspace.cleanup();
  workspace.cleanup();
  assert.equal(readFileSync(path.join(base, "unrelated"), "utf8"), "keep");
  assert.equal(existsSync(workspace.directory), false);
});
test("private workspace verifies consumed bytes against same shared budget and never ignores exhaustion", (t) => {
  const base = folder(t),
    budget = new RhythmReadBudget();
  budget.consumed = 256 * MiB;
  assert.throws(() => new RhythmWorkspace(base, Buffer.from("owned"), "wav", budget), /verification threshold/);
  assert.ok(budget.consumed > 256 * MiB);
  assert.equal(
    readdirSync(base).length,
    1,
    "failed cleanup with exhausted verification budget preserves owned uncertain file",
  );
});
test("transient reservation charges BOTH copies at exact lifetime boundary after peak retirement", (t) => {
  const root = folder(t),
    publisher = new RhythmPublisher(new RhythmReadContext(root), "demo", 10);
  publisher.directory(".cache/rhythm-evidence/demo/key");
  const retire = publisher.reserveTransient(5);
  assert.deepEqual(publisher.checkCapacity(), { total: 5, count: 2 });
  publisher.write(".cache/rhythm-evidence/demo/key/original", Buffer.alloc(5));
  assert.deepEqual(publisher.checkCapacity(), { total: 10, count: 2 });
  retire();
  assert.deepEqual(publisher.checkCapacity(), { total: 5, count: 1 });
  assert.throws(() => publisher.write(".cache/rhythm-evidence/demo/key/extra", Buffer.alloc(1)), /artifact byte bound/);
  assert.throws(retire, /already retired/);
  publisher.cleanup();
});
test("live transient reservation counts toward exact project peak bytes and directory capacity", (t) => {
  const root = folder(t),
    cache = path.join(root, ".cache/rhythm-evidence/demo");
  mkdirSync(cache, { recursive: true });
  for (let i = 0; i < 4; i++) {
    const fd = openSync(path.join(cache, "existing-" + i), "wx");
    ftruncateSync(fd, 64 * MiB - (i === 0 ? 1 : 0));
    closeSync(fd);
  }
  const publisher = new RhythmPublisher(new RhythmReadContext(root), "demo");
  const release = publisher.reserveTransient(1);
  assert.equal(publisher.checkCapacity().total, 256 * MiB);
  assert.throws(() => publisher.checkCapacity(1), /capacity/);
  release();
  assert.equal(publisher.checkCapacity(1).total, 256 * MiB - 1);
  for (let i = 0; i < 31; i++) mkdirSync(path.join(cache, String(i)));
  const retire = publisher.reserveTransient(0);
  assert.equal(publisher.checkCapacity().count, 32);
  assert.throws(() => publisher.checkCapacity(0, 1), /capacity/);
  retire();
  assert.equal(publisher.checkCapacity(0, 1).count, 31);
});
test("production workspace ignores ambient TMPDIR and request schema rejects any temp selector", (t) => {
  const f = fixture(t);
  assert.equal(RhythmAnalysisRequestSchema.safeParse({ ...f.request, tempDirectory: f.base }).success, false);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = "/missing-untrusted";
  try {
    if (process.platform !== "darwin") {
      assert.throws(() => createRhythmWorkspace(Buffer.from("owned"), "wav", new RhythmReadBudget()), /unavailable/);
      return;
    }
    const workspace = createRhythmWorkspace(Buffer.from("owned"), "wav", new RhythmReadBudget());
    assert.equal(path.dirname(workspace.directory), "/private/tmp");
    assert.equal(lstatSync(workspace.directory).mode & 0o777, 0o700);
    workspace.cleanup();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test("workspace creation reports confirmed retirement after partial write fault, and unconfirmed close fault retains first cause", async (t) => {
  const fs = (await import("node:fs")).default,
    write = fs.writeSync,
    close = fs.closeSync,
    open = fs.openSync;
  for (const closeFault of [false, true]) {
    const base = folder(t);
    let target: number | undefined,
      partial = false;
    const primary = Error("FIRST write failure"),
      secondary = Error("SECOND close failure");
    fs.openSync = ((...args: Parameters<typeof open>) => {
      const fd = Reflect.apply(open, fs, args);
      if (String(args[0]).startsWith(base + "/ai-video-rhythm-") && Number(args[1]) & fs.constants.O_WRONLY)
        target = fd;
      return fd;
    }) as typeof open;
    fs.writeSync = ((...args: any[]) => {
      if (args[0] === target) {
        if (partial) throw primary;
        partial = true;
        return write(args[0], args[1], args[2], 2);
      }
      return Reflect.apply(write, fs, args);
    }) as typeof write;
    fs.closeSync = ((fd: number) => {
      close(fd);
      if (fd === target) {
        target = undefined;
        if (closeFault) throw secondary;
      }
    }) as typeof close;
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => new RhythmWorkspace(base, Buffer.from("owned"), "wav", new RhythmReadBudget()),
        (error: unknown) => {
          assert.ok(error instanceof RhythmWorkspaceCreationError);
          assert.equal(error.cause, primary);
          assert.equal(error.retirementConfirmed, !closeFault);
          if (closeFault) assert.match(error.message, /FIRST write failure.*SECOND close failure/);
          return true;
        },
      );
      assert.deepEqual(readdirSync(base), []);
    } finally {
      fs.openSync = open;
      fs.writeSync = write;
      fs.closeSync = close;
      syncBuiltinESMExports();
    }
  }
});
test("creation outcome releases lease only for proven retirement; arbitrary factory fault and orphan stay contained", async (t) => {
  for (const confirmed of [false, true]) {
    const f = fixture(t);
    f.host.workspace = () => {
      throw new RhythmWorkspaceCreationError(Error("creation failed"), confirmed);
    };
    await assert.rejects(
      prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host),
      confirmed ? /creation failed/ : /creation failed.*manual reconciliation/,
    );
    assert.equal(existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), !confirmed);
    assert.equal(f.calls, 0);
  }
  const f = fixture(t);
  f.host.workspace = () => {
    throw Error("unknown factory outcome");
  };
  await assert.rejects(
    prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host),
    /unknown factory outcome.*manual reconciliation/,
  );
  assert.equal(existsSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock")), true);
});
test("uncertain workspace retirement never claims a replaced foreign lease as owned or deletes it", async (t) => {
  const f = fixture(t);
  f.host.run = async () => {
    writeFileSync(path.join(f.workspace!.directory, "foreign"), "keep");
    const lock = path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock");
    renameSync(lock, path.join(f.root, ".cache/rhythm-evidence/demo/own-old-lock"));
    writeFileSync(lock, "FOREIGN lease");
    throw Error("FIRST analysis");
  };
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /FIRST analysis.*workspace cleanup.*lease cleanup.*lease changed/);
    assert.equal(error.message.includes("own preparation lease retained"), false);
    return true;
  });
  assert.equal(
    readFileSync(path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock"), "utf8"),
    "FOREIGN lease",
  );
});
test("installed tool bytes remain strictly guarded during awaits, and final copy cannot evade lifetime quota", async (t) => {
  if (macOsOnly(t)) return;
  const tool = fixture(t);
  tool.host.run = async () => {
    writeFileSync(tool.host.resolve(), "changed tool DATA");
    return { stdout: Buffer.from("FAKE"), stderrBytes: 0 };
  };
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(tool.root, tool.request, tool.host), /pin changed/);
  assert.deepEqual(readdirSync(tool.base), []);
  const limited = fixture(t);
  await assert.rejects(
    prepareRhythmEvidenceForTrustedTests(
      limited.root,
      { ...limited.request, limits: { artifactBytes: limited.bytes.length * 2 - 1 } },
      limited.host,
    ),
    /artifact byte bound/,
  );
  assert.equal(limited.calls, 5);
  assert.deepEqual(readdirSync(limited.base), []);
  assert.equal(existsSync(path.join(limited.project, "pipeline/rhythm")), false);
  assert.equal(existsSync(path.join(limited.root, ".cache/rhythm-evidence/demo/.preparation-lock")), false);
});
test("same-name lease replacement in first awaited call refuses before later callbacks or evidence publication", async (t) => {
  const f = fixture(t),
    run = f.host.run,
    lock = path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock");
  f.host.run = async (...args) => {
    const result = await run(...args);
    renameSync(lock, path.join(f.base, "old-owned-lease"));
    writeFileSync(lock, "FOREIGN same-name lease");
    return result;
  };
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /lease changed/);
    assert.equal(error.message.includes("immutable output publication occurred"), false);
    return true;
  });
  assert.equal(f.calls, 1);
  assert.equal(existsSync(path.join(f.project, "pipeline/rhythm")), false);
  assert.deepEqual(readdirSync(f.base), ["old-owned-lease"]);
  assert.equal(readFileSync(lock, "utf8"), "FOREIGN same-name lease");
});
test("lease birth guard immediately before immutable link refuses a change during staged evidence write", async (t) => {
  if (macOsOnly(t)) return;
  const f = fixture(t),
    fs = (await import("node:fs")).default,
    open = fs.openSync,
    write = fs.writeSync;
  const lock = path.join(f.root, ".cache/rhythm-evidence/demo/.preparation-lock");
  let staged: number | undefined,
    changed = false;
  fs.openSync = ((...args: Parameters<typeof open>) => {
    const fd = Reflect.apply(open, fs, args);
    if (String(args[0]).endsWith("/evidence-staged.json") && Number(args[1]) & fs.constants.O_WRONLY) staged = fd;
    return fd;
  }) as typeof open;
  fs.writeSync = ((...args: any[]) => {
    const result = Reflect.apply(write, fs, args);
    if (args[0] === staged && !changed) {
      changed = true;
      renameSync(lock, path.join(f.base, "old-owned-lease"));
      writeFileSync(lock, "FOREIGN pre-link lease");
    }
    return result;
  }) as typeof write;
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareRhythmEvidenceForTrustedTests(f.root, f.request, f.host), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /lease changed/);
      assert.equal(error.message.includes("immutable output publication occurred"), false);
      return true;
    });
  } finally {
    fs.openSync = open;
    fs.writeSync = write;
    syncBuiltinESMExports();
  }
  assert.equal(changed, true);
  assert.equal(f.calls, 5);
  assert.equal(readFileSync(lock, "utf8"), "FOREIGN pre-link lease");
  const folder = path.join(f.project, "pipeline/rhythm");
  assert.equal(existsSync(folder) ? readdirSync(folder).length : 0, 0);
  assert.deepEqual(readdirSync(f.base), ["old-owned-lease"]);
});
