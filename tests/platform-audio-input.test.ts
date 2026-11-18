import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  capturePlatformAudioSelection,
  assertPlatformAudioSelection,
  bindPlatformAudioMovies,
} from "../src/lib/delivery/platform-audio";
import { readPlatformAudioPin } from "../src/lib/delivery/platform-audio-input";
import { platformAudioHash, finalizePlatformAudioEligibility } from "../src/lib/delivery/platform-audio-plan";
import { deliveryUseContext } from "../src/lib/delivery/use-context";
import { platformFixture, sha, zero, now } from "./platform-audio-fixtures";
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "native-input-pure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return platformFixture(root);
}
const capture = (f: ReturnType<typeof fixture>) =>
  capturePlatformAudioSelection(f.root, f.request, [{ props: f.props, identity: f.identity }]);
test("readonly capture pins same consumed journal, registry, exact source and all declaration evidence without changing project bytes", (t) => {
  const f = fixture(t),
    files = [f.journal, f.registryFile, f.config, f.originalFile, path.join(f.project, f.evidence.file)],
    before = files.map((file) => sha(fs.readFileSync(file)));
  const value = capture(f)!;
  assert.equal(value.result.localStatus, "eligible-awaiting-movie");
  assert.equal(value.selection.journalRevision, 0);
  assert.ok(value.selection.sources.some((source) => source.path.endsWith("asset-registry.json")));
  assertPlatformAudioSelection(value.selection, capture(f));
  assert.deepEqual(
    files.map((file) => sha(fs.readFileSync(file))),
    before,
  );
  assert.equal(
    capturePlatformAudioSelection(f.root, { ...f.request, platformAudioPlacement: undefined }, []),
    undefined,
  );
  assertPlatformAudioSelection(undefined, undefined);
});
test("current journal versus stale props/revision, duplicate source pins and stale originals/evidence all refuse", (t) => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.identity.editRevision = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.props.timeline!.tracks[1].clips[0].source.start = { num: 1, den: 1 };
      f.identity.propsHash = platformAudioHash(f.props);
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.sources.push({ ...f.identity.sources[0] });
    },
    (f: ReturnType<typeof fixture>) => {
      fs.writeFileSync(f.originalFile, "mutated");
    },
    (f: ReturnType<typeof fixture>) => {
      fs.writeFileSync(path.join(f.project, f.evidence.file), "changed evidence");
    },
    (f: ReturnType<typeof fixture>) => {
      fs.writeFileSync(f.config, '{"changed":true}');
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => capture(f));
  }
});
test("request/selection/evidence mutation after capture cannot reuse snapshot", (t) => {
  const f = fixture(t),
    first = capture(f)!;
  f.entry.account.identifier = "Changed account";
  assert.throws(() => assertPlatformAudioSelection(first.selection, capture(f)));
});
test("product-ad effective usage is derived from exact pinned marker and cannot be downgraded", (t) => {
  const f = fixture(t);
  const marker = path.join(f.project, "pipeline/workflow-render.json");
  fs.writeFileSync(
    marker,
    JSON.stringify({ version: 1, projectId: "demo", workflow: "product-ad", timelineRequired: true }),
  );
  f.identity.sources.push({
    path: path.relative(f.root, marker),
    sha256: sha(fs.readFileSync(marker)),
    role: "creative",
  });
  const use = deliveryUseContext(f.root, f.request, [f.identity]);
  assert.equal(use.effectiveUsage.advertising, true);
  assert.equal(f.request.usage.advertising, false);
  const value = capture(f)!;
  assert.equal(value.result.localStatus, "blocked");
  assert.ok(value.result.findings.some((finding) => finding.code === "NATIVE_REVIEW_STALE"));
  fs.writeFileSync(marker, "{}");
  assert.throws(() => capture(f));
});
test("strict FD pins reject empty/bounds, aliases and preserve digest of original byte fixture", (t) => {
  const f = fixture(t);
  assert.equal(readPlatformAudioPin(f.originalFile, f.project).sha256, sha(fs.readFileSync(f.originalFile)));
  assert.throws(() => readPlatformAudioPin(f.originalFile, f.project, 1));
  const alias = path.join(f.project, "aliased.bin");
  fs.symlinkSync(f.originalFile, alias);
  assert.throws(() => readPlatformAudioPin(alias, f.project));
  const aliasDirectory = path.join(f.project, "alias-dir");
  fs.symlinkSync(path.dirname(f.originalFile), aliasDirectory);
  assert.throws(() => readPlatformAudioPin(path.join(aliasDirectory, path.basename(f.originalFile)), f.project));
  const empty = path.join(f.project, "empty");
  fs.writeFileSync(empty, "");
  assert.throws(() => readPlatformAudioPin(empty, f.project));
  assert.throws(() => readPlatformAudioPin(f.originalFile, path.join(f.project, "other")));
});
test("writerless FIFO rejects in finite owned child for binary pins and selection evidence", (t) => {
  const f = fixture(t),
    fifo = path.join(f.project, "pipeline/evidence/pipe");
  const made = spawnSync("mkfifo", [fifo], { timeout: 1000, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const module = new URL("../src/lib/delivery/platform-audio-input.ts", import.meta.url).href,
    script = `const api=await import(process.argv[1]);try{api.readPlatformAudioPin(process.argv[2],process.argv[3]);console.log(JSON.stringify({returned:true}));}catch(e){console.log(JSON.stringify({refused:true,message:e.message}));}`;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, module, fifo, f.project],
    {
      timeout: SPAWN_TIMEOUT_MS,
      encoding: "utf8",
      env: Object.fromEntries(["PATH", "HOME", "TMPDIR"].map((key) => [key, process.env[key]!])),
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).refused, true);
  f.entry.evidence.licence.file = "pipeline/evidence/pipe";
  assert.throws(() => capture(f), /regular/);
});
test("movie binding only checks correspondence of opaque CPU bytes, retains pending and rejects human/stale/other identity", (t) => {
  const f = fixture(t),
    captured = capture(f)!;
  const outputDir = path.join(f.root, "out/demo");
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, "opaque.bin"),
    bytes = "not a movie: pure binding fixture";
  fs.writeFileSync(file, bytes);
  const outputSha = sha(bytes);
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
    output = { path: path.relative(f.root, file), sha256: outputSha, identity: f.identity, receipt };
  const result = bindPlatformAudioMovies(f.root, f.request, captured, [output]);
  assert.equal(result.localStatus, "eligible-awaiting-delivery-gates");
  assert.equal(result.status, "pending-manual");
  assert.equal(finalizePlatformAudioEligibility(result, true).localStatus, "blocked");
  assert.equal(finalizePlatformAudioEligibility(result, false).localStatus, "ready-for-manual-placement");
  assert.equal(result.movieBindings[0].reviewSha256, platformAudioHash(f.plan.outputReviews[0]));
  assert.ok(result.provenance.includes("unverified"));
  const manual = { ...receipt, evidence: "human-declared", reviewedBy: "Fixture", note: "Supplied fake binding" };
  assert.equal(
    bindPlatformAudioMovies(f.root, f.request, captured, [{ ...output, receipt: manual }]).localStatus,
    "blocked",
  );
  assert.equal(
    bindPlatformAudioMovies(f.root, f.request, captured, [
      { ...output, identity: { ...f.identity, sourceSnapshotHash: zero.replace(/^0/, "1") } },
    ]).localStatus,
    "blocked",
  );
  fs.writeFileSync(file, "mutated opaque bytes");
  assert.equal(bindPlatformAudioMovies(f.root, f.request, captured, [output]).localStatus, "blocked");
});

import { syncBuiltinESMExports } from "node:module";
test("same-FD size and final lexical identity refuse growth/shrink/replacement during read", (t) => {
  const f = fixture(t),
    originalRead = fs.readSync;
  for (const mode of ["growth", "shrink", "replacement"]) {
    const file = path.join(f.project, "race.bin");
    fs.writeFileSync(file, "initial bytes");
    let changed = false;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      const result = (originalRead as (...values: Parameters<typeof fs.readSync>) => number)(...args);
      if (!changed) {
        changed = true;
        if (mode === "growth") fs.appendFileSync(file, "grown");
        else if (mode === "shrink") fs.truncateSync(file, 1);
        else {
          fs.renameSync(file, file + ".old");
          fs.writeFileSync(file, "initial bytes");
        }
      }
      return result;
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => readPlatformAudioPin(file, f.project), /changed|shrank/);
    } finally {
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    }
  }
});
test("missing/listening evidence or other prospective snapshot cannot become local ready", (t) => {
  const f = fixture(t),
    captured = capture(f)!;
  assert.equal(bindPlatformAudioMovies(f.root, f.request, captured, []).localStatus, "blocked");
  const updated = structuredClone(captured.selection);
  updated.entries[0].propsHash = zero;
  assert.throws(() => assertPlatformAudioSelection(updated, capture(f)));
});

test("caption-clean, format/duration identity, exact output coverage and arbitrary source paths cannot be coerced", (t) => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.props.captionsEnabled = true;
      f.identity.propsHash = platformAudioHash(f.props);
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.durationInFrames = 91;
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.format = "square";
    },
    (f: ReturnType<typeof fixture>) => {
      f.request.formats.push("square");
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.sources.push({ path: "src/../private-probe", sha256: zero, role: "code" });
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => capture(f));
  }
});

test("every requested output master/embedded eligibility is retained in either job order", (t) => {
  for (const kind of ["master", "embedded"] as const)
    for (const reverse of [false, true]) {
      const f = fixture(t);
      f.request.formats.push("vertical");
      const props = structuredClone(f.props);
      props.format = "vertical";
      if (kind === "master")
        props.audioMaster = {
          source: "opaque-master.bin",
          sourceSha256: zero,
          durationSec: 3,
          integratedLufs: -16,
          truePeakDb: -2,
          targetLufs: -16,
          createdAt: now,
        };
      else
        props.talkingHead = {
          enabled: true,
          presenterVideo: "opaque-presenter.bin",
          audioSource: "embedded",
        } as typeof props.talkingHead;
      const identity = {
          ...structuredClone(f.identity),
          format: "vertical" as const,
          propsHash: platformAudioHash(props),
        },
        jobs = [
          { props: f.props, identity: f.identity },
          { props, identity },
        ];
      if (reverse) jobs.reverse();
      const before = sha(fs.readFileSync(f.journal));
      const result = capturePlatformAudioSelection(f.root, f.request, jobs)!;
      assert.equal(result.result.localStatus, "blocked");
      assert.ok(
        result.result.findings.some(
          (finding) =>
            finding.code === (kind === "master" ? "NATIVE_MIXED_MASTER" : "NATIVE_EMBEDDED_AUDIO") &&
            finding.message.startsWith("vertical/off:"),
        ),
      );
      assert.equal(sha(fs.readFileSync(f.journal)), before);
    }
});
test("stale-first/stale-last SHA and conflicting source roles refuse in both prospective job orders", (t) => {
  for (const mutation of ["first-stale", "second-stale", "first-role", "second-role"] as const)
    for (const reverse of [false, true]) {
      const f = fixture(t);
      f.request.formats.push("vertical");
      const props = { ...structuredClone(f.props), format: "vertical" as const },
        identity = { ...structuredClone(f.identity), format: "vertical" as const, propsHash: platformAudioHash(props) };
      const selected = mutation.startsWith("first") ? f.identity : identity,
        source = selected.sources.find((source) => source.role === "config")!;
      if (mutation.endsWith("stale")) source.sha256 = zero;
      else source.role = "creative";
      const jobs = [
        { props: f.props, identity: f.identity },
        { props, identity },
      ];
      if (reverse) jobs.reverse();
      assert.throws(() => capturePlatformAudioSelection(f.root, f.request, jobs), /source pin conflict/);
    }
});
test("valid shared multi-format source declarations pass without modifying original/journal/registry", (t) => {
  const f = fixture(t);
  f.request.formats.push("vertical");
  const props = { ...structuredClone(f.props), format: "vertical" as const },
    identity = { ...structuredClone(f.identity), format: "vertical" as const, propsHash: platformAudioHash(props) },
    jobs = [
      { props: f.props, identity: f.identity },
      { props, identity },
    ],
    files = [f.originalFile, f.journal, f.registryFile, f.config],
    before = files.map((file) => sha(fs.readFileSync(file)));
  for (const order of [jobs, [...jobs].reverse()]) {
    const result = capturePlatformAudioSelection(f.root, f.request, order)!;
    assert.equal(result.result.localStatus, "eligible-awaiting-movie");
    assert.deepEqual(result.result.findings, []);
    assert.equal(new Set(result.selection.sources.map((source) => source.path)).size, result.selection.sources.length);
  }
  assert.deepEqual(
    files.map((file) => sha(fs.readFileSync(file))),
    before,
  );
});
test("conflicting metadata evidence ownership never uses a last role", (t) => {
  const f = fixture(t),
    evidencePath = path.relative(f.root, path.join(f.project, f.evidence.file));
  f.identity.sources.push({ path: evidencePath, sha256: f.evidence.sha256, role: "config" });
  assert.throws(() => capture(f), /evidence changed between consumers/);
});
