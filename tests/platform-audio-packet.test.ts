import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { platformFixture, sha, now } from "./platform-audio-fixtures";
import { capturePlatformAudioSelection, bindPlatformAudioMovies } from "../src/lib/delivery/platform-audio";
import { finalizePlatformAudioEligibility } from "../src/lib/delivery/platform-audio-plan";
import { DeliveryManifestSchema } from "../src/types/delivery";
import { checkDelivery } from "../src/lib/delivery/service";
import { nativePacket, type CheckedNativeDelivery } from "../src/lib/delivery/platform-audio-packet";
import {
  readPlatformAudioJson,
  writePlatformAudioBytes,
  copyPlatformAudioFile,
  readPlatformAudioPin,
} from "../src/lib/delivery/platform-audio-input";
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "native-packet-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = platformFixture(root),
    captured = capturePlatformAudioSelection(root, f.request, [{ props: f.props, identity: f.identity }])!;
  const directory = path.join(root, "out/demo");
  fs.mkdirSync(directory, { recursive: true });
  const movie = path.join(directory, "landscape-clean.mp4");
  fs.writeFileSync(movie, "Opaque movie fixture; NOT media or actual acceptance");
  const outputSha = sha(fs.readFileSync(movie));
  f.plan.outputReviews = [
    {
      ...f.review,
      musicContent: "declared-absent",
      entryId: f.entry.id,
      outputSha256: outputSha,
      sourceSnapshotHash: f.identity.sourceSnapshotHash,
      propsHash: f.identity.propsHash,
      selectionHash: captured.selection.entries[0].selectionHash,
    },
  ];
  const receipt = {
      version: 1,
      sourceSnapshotHash: f.identity.sourceSnapshotHash,
      propsHash: f.identity.propsHash,
      outputSha256: outputSha,
      format: "landscape",
      captions: "off",
      createdAt: now,
      sources: f.identity.sources,
      evidence: "renderer",
    },
    handoff = finalizePlatformAudioEligibility(
      bindPlatformAudioMovies(root, f.request, captured, [
        { path: path.relative(root, movie), sha256: outputSha, identity: f.identity, receipt },
      ]),
      false,
    );
  const manifest = DeliveryManifestSchema.parse({
    version: 1,
    projectId: "demo",
    snapshotId: "0".repeat(64),
    createdAt: now,
    state: "draft-needs-review",
    request: f.request,
    sourceIdentities: [f.identity],
    findings: [],
    outputs: [
      {
        path: "out/demo/landscape-clean.mp4",
        sha256: outputSha,
        format: "landscape",
        variant: "clean",
        sourceSnapshotHash: f.identity.sourceSnapshotHash,
        propsHash: f.identity.propsHash,
        durationSec: 3,
        fps: 30,
        width: 1920,
        height: 1080,
        integratedLufs: -16,
        truePeakDb: -2,
      },
    ],
    platformAudioPlacement: handoff,
    rights: [],
    costs: null,
    reviewEvidence: { fixture: "Injected only; not genuine delivery acceptance" },
    apiCalls: 0,
  });
  const report = path.join(f.project, "pipeline/report.json");
  const check = (): CheckedNativeDelivery => {
    fs.writeFileSync(report, JSON.stringify(manifest));
    return { manifest, report, subtitles: [] };
  };
  return { ...f, movie, manifest, report, check };
}
test("exact immutable packet preserves originals/native draft, retry ignores only observation date and readonly recovery never copies", (t) => {
  const f = fixture(t),
    original = [f.config, f.journal, f.registryFile, f.originalFile].map((file) => sha(fs.readFileSync(file)));
  const a = nativePacket(f.root, f.request, f.check);
  const marker = fs.readFileSync(a.marker),
    mtime = fs.statSync(a.marker).mtimeMs;
  assert.equal(a.productionReady, false);
  assert.equal(a.status, "pending-manual");
  assert.equal(fs.existsSync(path.join(path.dirname(a.marker), "release.json")), false);
  const packet = readPlatformAudioJson(a.marker, path.join(f.root, "out/demo"), 1024 * 1024).value as {
    files: { file: string; sha256: string }[];
  };
  assert.equal(packet.files.length, 3);
  assert.equal(packet.files[0].sha256, sha(fs.readFileSync(f.movie)));
  assert.deepEqual(
    original,
    [f.config, f.journal, f.registryFile, f.originalFile].map((file) => sha(fs.readFileSync(file))),
  );
  // Initial report immutable in real service; use another observation report for retry.
  const report2 = path.join(f.project, "pipeline/report2.json");
  f.manifest.createdAt = "2026-10-13T00:00:00.000Z";
  const fresh = () => {
    fs.writeFileSync(report2, JSON.stringify(f.manifest));
    return { manifest: f.manifest, report: report2, subtitles: [] };
  };
  const b = nativePacket(f.root, f.request, fresh, a.packetId);
  assert.equal(a.packetId, b.packetId);
  assert.equal(b.recovered, true);
  assert.deepEqual(fs.readFileSync(a.marker), marker);
  assert.equal(fs.statSync(a.marker).mtimeMs, mtime);
});
test("draft ok cannot publish blockers/production-ready/sticky native blocked or missing output", (t) => {
  for (const mode of ["error", "production", "native", "output"]) {
    const f = fixture(t);
    if (mode === "error") f.manifest.findings.push({ code: "QA", severity: "error", message: "No" });
    if (mode === "production") f.manifest.state = "production-ready";
    if (mode === "native") f.manifest.platformAudioPlacement!.localStatus = "blocked";
    if (mode === "output") f.manifest.outputs = [];
    assert.throws(() => nativePacket(f.root, f.request, f.check));
    assert.equal(fs.existsSync(path.join(f.root, "out/demo/handoffs")), false);
  }
});
test("late gate/source/use mutation refuses before final marker and preserves partial evidence", (t) => {
  for (const mode of ["gate", "source", "cost", "review"]) {
    const f = fixture(t);
    let calls = 0;
    assert.throws(() =>
      nativePacket(f.root, f.request, () => {
        if (++calls === 2) {
          if (mode === "gate") f.manifest.findings.push({ code: "STALE", severity: "error", message: "Changed gate" });
          if (mode === "source") fs.writeFileSync(f.config, "changed");
          if (mode === "cost") f.manifest.costs = { commitment: 1 };
          if (mode === "review") f.manifest.reviewEvidence.changed = true;
        }
        return f.check();
      }),
    );
    assert.equal(calls, 2);
    const directories = fs.readdirSync(path.join(f.root, "out/demo/handoffs"));
    assert.equal(directories.length, 1);
    assert.equal(fs.existsSync(path.join(f.root, "out/demo/handoffs", directories[0], "handoff.json")), false);
  }
});
test("packet corruption, forged ID/basis, historical report mutation and source changes refuse exact recovery", (t) => {
  for (const mode of ["copy", "sums", "marker", "report", "source"]) {
    const f = fixture(t),
      a = nativePacket(f.root, f.request, f.check);
    if (mode === "copy") fs.writeFileSync(path.join(path.dirname(a.marker), "landscape-clean.mp4"), "changed");
    if (mode === "sums") fs.writeFileSync(path.join(path.dirname(a.marker), "checksums.json"), "[]");
    if (mode === "marker") {
      const v = JSON.parse(fs.readFileSync(a.marker, "utf8"));
      v.manifest.costs = { forged: true };
      fs.writeFileSync(a.marker, JSON.stringify(v));
    }
    if (mode === "report") fs.writeFileSync(f.report, "{}");
    if (mode === "source") fs.writeFileSync(f.originalFile, "changed");
    const fresh = () => ({
      manifest: f.manifest,
      report: mode === "report" ? path.join(f.project, "pipeline/fresh.json") : f.report,
      subtitles: [],
    });
    if (mode === "report") fs.writeFileSync(path.join(f.project, "pipeline/fresh.json"), JSON.stringify(f.manifest));
    assert.throws(() => nativePacket(f.root, f.request, fresh, a.packetId));
  }
});
test("readonly missing marker never creates directory or resumes partially copied bytes", (t) => {
  const f = fixture(t);
  assert.throws(() => nativePacket(f.root, f.request, f.check, "1".repeat(64)), /changed/);
  assert.equal(fs.existsSync(path.join(f.root, "out/demo/handoffs")), false);
  let calls = 0;
  assert.throws(() =>
    nativePacket(f.root, f.request, () => {
      if (++calls === 2) throw Error("stop");
      return f.check();
    }),
  );
  const id = fs.readdirSync(path.join(f.root, "out/demo/handoffs"))[0];
  assert.throws(() => nativePacket(f.root, f.request, f.check, id), /absent/);
  assert.equal(fs.existsSync(path.join(f.root, "out/demo/handoffs", id, "handoff.json")), false);
});
test("exclusive copy/write refuses existing conflict and symlink without changing originals", (t) => {
  const f = fixture(t),
    target = path.join(f.root, "out/demo/target");
  fs.writeFileSync(target, "conflict");
  assert.throws(
    () =>
      copyPlatformAudioFile(
        f.movie,
        path.join(f.root, "out/demo"),
        target,
        path.join(f.root, "out/demo"),
        sha(fs.readFileSync(f.movie)),
      ),
    /conflict/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "conflict");
  fs.unlinkSync(target);
  fs.symlinkSync(f.movie, target);
  assert.throws(() => writePlatformAudioBytes(target, path.join(f.root, "out/demo"), Buffer.from("new")), /regular/);
  assert.equal(fs.readFileSync(f.movie, "utf8"), "Opaque movie fixture; NOT media or actual acceptance");
});
test("same FD copy detects growth/replacement and retains failed partial without publishing target", (t) => {
  for (const mode of ["growth", "replace"]) {
    const f = fixture(t),
      target = path.join(f.root, "out/demo/copy"),
      original = fs.readSync;
    let reads = 0;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      const n = (original as (...a: Parameters<typeof fs.readSync>) => number)(...args);
      if (++reads === 3) {
        if (mode === "growth") fs.appendFileSync(f.movie, "grow");
        else {
          fs.renameSync(f.movie, f.movie + ".old");
          fs.writeFileSync(f.movie, "Opaque movie fixture; NOT media or actual acceptance");
        }
      }
      return n;
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try {
      assert.throws(
        () =>
          copyPlatformAudioFile(
            f.movie,
            path.join(f.root, "out/demo"),
            target,
            path.join(f.root, "out/demo"),
            sha("Opaque movie fixture; NOT media or actual acceptance"),
          ),
        /changed/,
      );
      assert.equal(fs.existsSync(target), false);
    } finally {
      fs.readSync = original;
      syncBuiltinESMExports();
    }
  }
});
test("sparse oversize JSON is rejected before first read/allocation", (t) => {
  const f = fixture(t),
    file = path.join(f.project, "oversized"),
    fd = fs.openSync(file, "w");
  fs.ftruncateSync(fd, 1024 * 1024 + 1);
  fs.closeSync(fd);
  const original = fs.readSync;
  let reads = 0;
  fs.readSync = (() => {
    reads++;
    throw Error("Unexpected read");
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => readPlatformAudioJson(file, f.project, 1024 * 1024), /regular/);
    assert.equal(reads, 0);
  } finally {
    fs.readSync = original;
    syncBuiltinESMExports();
  }
});
test("movie hash mismatch and duplicate cross-output alias cannot borrow checked correspondence", (t) => {
  const f = fixture(t);
  f.manifest.outputs[0].sha256 = "f".repeat(64);
  assert.throws(() => nativePacket(f.root, f.request, f.check), /stale/);
  const g = fixture(t);
  g.manifest.sourceIdentities[0].sources.push({ ...g.identity.sources[0], sha256: "f".repeat(64) });
  assert.throws(() => nativePacket(g.root, g.request, g.check), /conflict/);
});

test("multi-output exact movie copies and requested subtitle bytes remain separate with full source pins", (t) => {
  const f = fixture(t);
  f.request.variants.push("captioned");
  f.manifest.request = f.request;
  const movie = path.join(f.root, "out/demo/landscape.mp4");
  fs.writeFileSync(movie, "Second opaque variant");
  f.manifest.outputs.push({
    ...f.manifest.outputs[0],
    path: "out/demo/landscape.mp4",
    variant: "captioned",
    sha256: sha(fs.readFileSync(movie)),
  });
  f.manifest.sourceIdentities.push({ ...f.identity, captions: "on" });
  f.request.subtitles = ["srt", "vtt"];
  f.manifest.request = f.request;
  const subtitles = [
    { name: "captions.srt", content: "1\n00:00:00,000 --> 00:00:01,000\nProtected speech\n" },
    { name: "captions.vtt", content: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nProtected speech\n" },
  ];
  const result = nativePacket(f.root, f.request, () => ({ ...f.check(), subtitles }));
  const directory = path.dirname(result.marker);
  assert.equal(
    readPlatformAudioPin(path.join(directory, "landscape-captioned.mp4"), directory).sha256,
    sha(fs.readFileSync(movie)),
  );
  for (const s of subtitles) assert.equal(fs.readFileSync(path.join(directory, s.name), "utf8"), s.content);
  assert.equal(fs.readdirSync(directory).length, 8);
});
test("packet/subtitle names cannot shadow movies or metadata and declared subtitles cannot disappear", (t) => {
  for (const names of [["credits.md"], ["captions.srt", "CAPTIONS.srt"], ["../captions.srt"]]) {
    const f = fixture(t);
    f.request.subtitles = ["srt"];
    f.manifest.request = f.request;
    assert.throws(() =>
      nativePacket(f.root, f.request, () => ({
        ...f.check(),
        subtitles: names.map((name) => ({ name, content: "Fixture" })),
      })),
    );
    assert.equal(fs.existsSync(path.join(f.root, "out/demo/handoffs")), false);
  }
  const f = fixture(t);
  f.request.subtitles = ["srt"];
  f.manifest.request = f.request;
  assert.throws(() => nativePacket(f.root, f.request, f.check), /correspondence/);
});
test("exclusive publication loses race without overwriting competitor or rolling back partial evidence", (t) => {
  const f = fixture(t),
    target = path.join(f.root, "out/demo/race"),
    original = fs.linkSync;
  fs.linkSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    fs.writeFileSync(destination, "competing bytes");
    return original(source, destination);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writePlatformAudioBytes(target, path.join(f.root, "out/demo"), Buffer.from("owned bytes")),
      /conflict/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "competing bytes");
    assert.ok(fs.readdirSync(path.dirname(target)).some((name) => name.startsWith(".pending-")));
  } finally {
    fs.linkSync = original;
    syncBuiltinESMExports();
  }
});
test("source or destination aliases and writerless FIFO never authorize a packet copy", (t) => {
  const f = fixture(t),
    scope = path.join(f.root, "out/demo"),
    alias = path.join(scope, "alias");
  fs.symlinkSync(f.movie, alias);
  assert.throws(
    () => copyPlatformAudioFile(alias, scope, path.join(scope, "copy"), scope, sha(fs.readFileSync(f.movie))),
    /regular/,
  );
  const original = fs.readSync;
  let reads = 0;
  fs.readSync = (() => {
    reads++;
    throw Error("unexpected read");
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => readPlatformAudioJson(alias, scope, 1024), /regular/);
    assert.equal(reads, 0);
  } finally {
    fs.readSync = original;
    syncBuiltinESMExports();
  }
  const fifo = path.join(scope, "fifo");
  assert.equal(cp.spawnSync("/usr/bin/mkfifo", [fifo], { timeout: 1000 }).status, 0);
  assert.throws(
    () => copyPlatformAudioFile(fifo, scope, path.join(scope, "fifo-copy"), scope, sha("anything")),
    /regular/,
  );
  const dir = path.join(scope, "alias-directory");
  fs.symlinkSync(path.dirname(f.originalFile), dir);
  assert.throws(
    () => copyPlatformAudioFile(f.movie, scope, path.join(dir, "new"), scope, sha(fs.readFileSync(f.movie))),
    /alias/,
  );
});

test("successful and rejected recovery have zero filesystem writes and keep exact historical report/marker hashes", (t) => {
  const f = fixture(t),
    published = nativePacket(f.root, f.request, f.check),
    before = [published.marker, f.report].map((file) => sha(fs.readFileSync(file)));
  const current = { ...f.manifest, createdAt: "2026-10-14T00:00:00.000Z" };
  const checked = { manifest: current, report: f.report, subtitles: [] };
  const originals = {
    writeFileSync: fs.writeFileSync,
    writeSync: fs.writeSync,
    mkdirSync: fs.mkdirSync,
    linkSync: fs.linkSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
  };
  let writes = 0;
  for (const key of Object.keys(originals) as (keyof typeof originals)[])
    (fs as unknown as Record<string, unknown>)[key] = () => {
      writes++;
      throw Error("Recovery write forbidden");
    };
  syncBuiltinESMExports();
  try {
    assert.equal(nativePacket(f.root, f.request, () => checked, published.packetId).recovered, true);
    assert.throws(
      () =>
        nativePacket(
          f.root,
          f.request,
          () => ({ ...checked, manifest: { ...current, costs: { changed: 1 } } }),
          published.packetId,
        ),
      /Checked report bytes differ/,
    );
    assert.equal(writes, 0);
    assert.deepEqual(
      [published.marker, f.report].map((file) => sha(fs.readFileSync(file))),
      before,
    );
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
});
test("trusted native recovery check suppresses report writes even rejected gates; absent option still preserves ordinary API", (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.movie);
  const originalWrite = fs.writeFileSync,
    originalMkdir = fs.mkdirSync,
    originalSpawn = cp.spawnSync;
  let writes = 0,
    tools = 0;
  fs.writeFileSync = (() => {
    writes++;
    throw Error("Report write forbidden");
  }) as typeof fs.writeFileSync;
  fs.mkdirSync = (() => {
    writes++;
    throw Error("Directory write forbidden");
  }) as typeof fs.mkdirSync;
  cp.spawnSync = (() => {
    tools++;
    throw Error("Media execution forbidden");
  }) as typeof cp.spawnSync;
  syncBuiltinESMExports();
  try {
    const result = checkDelivery(
      f.request,
      { version: 1, projectId: "demo", id: "0".repeat(64), createdAt: now, identities: [f.identity] },
      { rootDir: f.root, persistReport: false },
    );
    assert.ok(result.blockers.length);
    assert.equal(result.productionReady, false);
    assert.deepEqual(result.outputs, []);
    assert.equal(writes, 0);
    assert.equal(tools, 0);
    const { platformAudioPlacement: _, ...legacy } = f.request;
    assert.throws(
      () =>
        checkDelivery(
          legacy,
          { version: 1, projectId: "demo", id: "0".repeat(64), createdAt: now, identities: [f.identity] },
          { rootDir: f.root, persistReport: false },
        ),
      /restricted/,
    );
  } finally {
    fs.writeFileSync = originalWrite;
    fs.mkdirSync = originalMkdir;
    cp.spawnSync = originalSpawn;
    syncBuiltinESMExports();
  }
});

test("JSON byte identity refuses malformed UTF8 and source roles conflict even when SHA matches", (t) => {
  const f = fixture(t),
    file = path.join(f.project, "invalid.json");
  fs.writeFileSync(file, Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
  assert.throws(() => readPlatformAudioJson(file, f.project, 1024));
  f.manifest.sourceIdentities[0].sources.push({ ...f.identity.sources[0], role: "creative" });
  assert.throws(() => nativePacket(f.root, f.request, f.check), /conflict/);
});
