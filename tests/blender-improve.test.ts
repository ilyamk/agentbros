import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendImprovement,
  BlenderCritiqueSchema,
  buildImprovementPackets,
  improvementGaps,
  improvementHistory,
  ImprovementLogSchema,
  runImprovementHarness,
  scoreImprovement,
  validatePacket,
} from "../src/lib/blender-arsenal/improvements";
import { RgbImage } from "../src/lib/vision/image";
import { writeImage } from "../src/lib/vision/media";
import { arsenalCandidates, auditArsenal } from "../src/lib/blender-arsenal/overview";
import { addMemory } from "../src/lib/memory";
import { findRecipe, renderRecipe } from "../src/lib/blender-arsenal/recipes";

const axes = (n: number) => ({ composition: n, light: n, material: n, motion: n, realism: n });
const checks = {
  sensors: { pass: true, evidence: ["out/qa/sensors.json"] },
  tests: { pass: true, evidence: ["out/qa/tests.txt"] },
};
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "blender-improve-"));
  for (const side of ["old-source-secret", "new-source-secret"]) {
    mkdirSync(path.join(root, side));
    for (const f of [12, 28, 44])
      writeImage(
        RgbImage.filled(32, 18, side.startsWith("old") ? [80, 60, f] : [90, f, 60]),
        path.join(root, side, `frame-${f}.png`),
      );
  }
  const source = path.join(root, "old-source-secret/frame-12.png"),
    original = readFileSync(source);
  const kind = Buffer.from("tEXt"),
    comment = Buffer.from("Comment\0old-source-secret");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([kind, comment])) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(comment.length + 12);
  chunk.writeUInt32BE(comment.length);
  kind.copy(chunk, 4);
  comment.copy(chunk, 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  writeFileSync(source, Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]));
  const pack = buildImprovementPackets({
    baseline: path.join(root, "old-source-secret"),
    candidate: path.join(root, "new-source-secret"),
    reference: "Thin warm boundary, tactile metal, visible progression",
    output: path.join(root, "pack"),
    seed: "test",
  });
  mkdirSync(path.join(root, "out/qa"), { recursive: true });
  for (const name of ["sensors.json", "tests.txt"])
    writeFileSync(path.join(root, "out/qa", name), JSON.stringify({ pass: true }));
  const key = read(pack.key);
  const results = pack.packets.map((file, i) => {
    const p = validatePacket(file),
      m = key.packets[i];
    const result = BlenderCritiqueSchema.parse({
      packetId: p.id,
      winner: m.A === "candidate" ? "A" : "B",
      A: axes(m.A === "candidate" ? 4 : 2),
      B: axes(m.B === "candidate" ? 4 : 2),
      evidence: (["A", "B"] as const).map((label) => ({
        label,
        ...{ file: p[label][0].file, frame: p[label][0].frame },
        observation: "Visible boundary and material at this frame",
      })),
      motionEvidence: "sampled-frames",
      reason: "Closer to reference",
      gaps: ["Needs full motion proof"],
    });
    const out = path.join(root, `critic-${i}.json`);
    writeFileSync(out, JSON.stringify(result));
    return out;
  });
  return { root, pack, results };
}
const log = (ab: ReturnType<typeof scoreImprovement>, date = "2026-11-15", slug = "test") => ({
  version: 1,
  date,
  slug,
  target: "dissolve",
  reference: "Thin warm boundary on grounded metal",
  weakness: "Broad emission band",
  diagnosis: "Default edge too broad",
  cause: "system",
  change: { type: "recipe-default", description: "Narrow band", expectedEffect: "Thin ember boundary" },
  ab,
  decision: "kept",
  gaps: [
    {
      id: "motion-proof",
      target: "dissolve",
      summary: "Full motion unverified",
      capability: "materials",
      severity: 4,
      status: "open",
    },
  ],
});

test("packets hash/sanitise media, reverse labels and keep key/source names outside each packet", () => {
  const f = fixture();
  try {
    const key = read(f.pack.key);
    assert.notEqual(key.packets[0].A, key.packets[1].A);
    for (const file of f.pack.packets) {
      const p = validatePacket(file),
        directory = path.dirname(file),
        raw = readFileSync(file, "utf8");
      assert.ok(
        !raw.includes(f.root) &&
          !raw.includes("source-secret") &&
          !raw.includes("baseline") &&
          !raw.includes("candidate"),
      );
      assert.equal(readdirSync(directory).length, 7);
      assert.equal(existsSync(path.join(directory, "key.json")), false);
      for (const a of [...p.A, ...p.B]) {
        assert.match(a.file, /^[a-f0-9]{64}\.png$/);
        assert.ok(!readFileSync(path.join(directory, a.file)).includes(Buffer.from("source-secret")));
      }
    }
    assert.throws(() =>
      buildImprovementPackets({
        baseline: path.join(f.root, "old-source-secret"),
        candidate: path.join(f.root, "new-source-secret"),
        reference: "x",
        output: path.join(f.root, "pack"),
      }),
    );
    writeFileSync(
      path.join(path.dirname(f.pack.packets[0]!), validatePacket(f.pack.packets[0]!).A[0]!.file),
      "tampered",
    );
    assert.throws(() => scoreImprovement(f.pack.key, f.results, checks, f.root), /hash mismatch/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("packet coverage rejects mismatched image dimensions and video durations", () => {
  const f = fixture();
  try {
    writeImage(RgbImage.filled(64, 18, [10, 20, 30]), path.join(f.root, "new-source-secret/frame-12.png"));
    assert.throws(
      () =>
        buildImprovementPackets({
          baseline: path.join(f.root, "old-source-secret"),
          candidate: path.join(f.root, "new-source-secret"),
          reference: "x",
          output: path.join(f.root, "mismatch"),
        }),
      /dimensions/,
    );
    for (const [name, duration] of [
      ["a", "0.2"],
      ["b", "0.4"],
    ] as const) {
      const r = spawnSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=32x18:r=30:d=${duration}`,
        "-c:v",
        "libx264",
        "-threads",
        "1",
        path.join(f.root, `${name}.mp4`),
      ]);
      assert.equal(r.status, 0);
    }
    assert.throws(
      () =>
        buildImprovementPackets({
          baseline: path.join(f.root, "a.mp4"),
          candidate: path.join(f.root, "b.mp4"),
          reference: "x",
          output: path.join(f.root, "video-mismatch"),
        }),
      /duration/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("only both-order agreed candidate wins and passing checks permit keep; no last-vote overwrite", () => {
  const f = fixture();
  try {
    const win = scoreImprovement(f.pack.key, f.results, checks, f.root);
    assert.equal(win.verdict, "keep");
    assert.deepEqual(win.delta, axes(2));
    assert.equal(win.experimental, false);
    assert.throws(() => scoreImprovement(f.pack.key, [f.results[0]!], checks, f.root), /both orders/);
    assert.throws(() => scoreImprovement(f.pack.key, [f.results[0]!, f.results[0]!], checks, f.root), /Duplicate/);
    assert.equal(
      scoreImprovement(f.pack.key, f.results, { ...checks, sensors: { ...checks.sensors, pass: false } }, f.root)
        .verdict,
      "revert",
    );
    writeFileSync(path.join(f.root, "out/qa/sensors.json"), JSON.stringify({ pass: false }));
    assert.throws(() => scoreImprovement(f.pack.key, f.results, checks, f.root), /evidence failed/);
    rmSync(path.join(f.root, "out/qa/sensors.json"));
    assert.throws(() => scoreImprovement(f.pack.key, f.results, checks, f.root), /ENOENT/);
    writeFileSync(path.join(f.root, "out/qa/sensors.json"), JSON.stringify({ pass: true }));
    const c = read(f.results[1]!);
    c.winner = "tie";
    writeFileSync(f.results[1]!, JSON.stringify(c));
    assert.equal(scoreImprovement(f.pack.key, f.results, checks, f.root).agreed, false);
    c.winner = "B";
    writeFileSync(f.results[1]!, JSON.stringify(c));
    assert.equal(scoreImprovement(f.pack.key, f.results, checks, f.root).verdict, "revert");
    c.winner = "A";
    c.A.material = 2;
    writeFileSync(f.results[1]!, JSON.stringify(c));
    assert.equal(scoreImprovement(f.pack.key, f.results, checks, f.root).experimental, true);
    c.evidence[0].frame = 99;
    writeFileSync(f.results[1]!, JSON.stringify(c));
    assert.throws(() => scoreImprovement(f.pack.key, f.results, checks, f.root), /unknown frame/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("logs validate guard/date, append without overwrite and history includes reverted trials", () => {
  const f = fixture();
  try {
    const ab = scoreImprovement(f.pack.key, f.results, checks, f.root),
      entry = log(ab);
    const file = appendImprovement(entry, f.root);
    assert.ok(existsSync(file));
    assert.throws(() => appendImprovement(entry, f.root), /EEXIST/);
    assert.equal(ImprovementLogSchema.safeParse({ ...entry, date: "2026-02-30" }).success, false);
    assert.equal(ImprovementLogSchema.safeParse({ ...entry, ab: { ...ab, verdict: "revert" } }).success, false);
    appendImprovement({ ...entry, slug: "failed", decision: "reverted", ab: { ...ab, verdict: "revert" } }, f.root);
    assert.equal(improvementHistory(f.root, "dissolve").length, 2);
    assert.equal(improvementHistory(f.root, "dust-burst").length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("log containment is checked before creating directories and audit flags malformed logs", () => {
  const f = fixture(),
    outside = mkdtempSync(path.join(tmpdir(), "blender-log-outside-"));
  try {
    symlinkSync(outside, path.join(f.root, "blender-arsenal"));
    assert.throws(
      () => appendImprovement(log(scoreImprovement(f.pack.key, f.results, checks, f.root)), f.root),
      /symlink/,
    );
    assert.equal(existsSync(path.join(outside, "improvements")), false);
    rmSync(path.join(f.root, "blender-arsenal"));
    mkdirSync(path.join(f.root, "blender-arsenal/improvements"), { recursive: true });
    writeFileSync(path.join(f.root, "blender-arsenal/improvements/broken.json"), "{}");
    assert.ok(auditArsenal(f.root).problems.some((p) => p.file === "blender-arsenal/improvements"));
    const consolidate = spawnSync(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("scripts/memory.ts"), "--consolidate"],
      { cwd: f.root, env: { ...process.env, AGENTBROS_MEMORY_ROOT: path.join(f.root, "memory") }, encoding: "utf8" },
    );
    assert.equal(consolidate.status, 0);
    assert.equal(JSON.parse(consolidate.stdout).metadata.blenderWarnings.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("gaps merge repeated stable ids with active Blender memory, rank and honour resolution", () => {
  const f = fixture(),
    memory = path.join(f.root, "memory");
  try {
    const entry = log(scoreImprovement(f.pack.key, f.results, checks, f.root));
    appendImprovement(entry, f.root);
    for (const name of ["extensions.json", "libraries.json"])
      copyFileSync(path.join("blender-arsenal", name), path.join(f.root, "blender-arsenal", name));
    assert.ok(arsenalCandidates(f.root, "materials").some((c) => c.id === "motion-proof"));
    assert.ok(!arsenalCandidates(f.root, "terrain").some((c) => c.id === "motion-proof"));
    appendImprovement({ ...entry, date: "2026-11-16", slug: "second" }, f.root);
    addMemory(
      {
        type: "gap",
        summary: "Blender motion-proof lacks continuous motion",
        source: { kind: "agent", agent: "orchestrator", evidence: "out/qa/frame.png" },
        scope: { playbooks: [], steps: [], platforms: [] },
      },
      memory,
    );
    const gaps = improvementGaps(f.root, memory);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.occurrences, 3);
    appendImprovement(
      { ...entry, date: "2026-11-17", slug: "resolved", gaps: [{ ...entry.gaps[0], status: "resolved" }] },
      f.root,
    );
    assert.equal(improvementGaps(f.root, memory).length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fake critic harness receives only blind context and read-only fresh Codex flags", () => {
  const f = fixture(),
    before = process.env.BLENDER_IMPROVE_HARNESS_BIN;
  try {
    const executable = path.join(f.root, "fake-harness");
    writeFileSync(
      executable,
      `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{if(!args.includes('read-only')||!args.includes('gpt-6.1-sol')||s.includes('old-source-secret')||s.includes('key.json'))process.exit(2);process.stdout.write(fs.readFileSync(${JSON.stringify(f.results[0])},'utf8'));});\n`,
      { mode: 0o755 },
    );
    process.env.BLENDER_IMPROVE_HARNESS_BIN = executable;
    assert.equal(
      BlenderCritiqueSchema.parse(runImprovementHarness({ role: "critic", input: f.pack.packets[0]! })).packetId,
      read(f.results[0]!).packetId,
    );
    copyFileSync(f.results[0]!, path.join(f.root, "copy.json"));
    assert.throws(
      () => scoreImprovement(f.pack.key, [...f.results, path.join(f.root, "copy.json")], checks, f.root),
      /Duplicate critic response/,
    );
  } finally {
    if (before === undefined) delete process.env.BLENDER_IMPROVE_HARNESS_BIN;
    else process.env.BLENDER_IMPROVE_HARNESS_BIN = before;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test(
  "real Blender isolated dissolve frame makes a validated sanitised packet",
  { skip: process.env.RUN_BLENDER_TESTS !== "1" },
  async () => {
    const f = mkdtempSync(path.join(tmpdir(), "blender-improve-real-"));
    try {
      // The shared host permits only one Blender process. Do not launch alongside another test suite.
      assert.notEqual(
        spawnSync("pgrep", ["-x", "Blender"]).status,
        0,
        "Wait for the existing Blender process before this gated suite",
      );
      const render = await renderRecipe(findRecipe("dissolve"), {
        output: path.join(f, "render"),
        frames: [12, 12],
        samples: 8,
        resolution: [480, 270],
      });
      assert.equal(render.frames.length, 1);
      const packet = buildImprovementPackets({
        baseline: render.frames[0]!.path,
        candidate: render.frames[0]!.path,
        output: path.join(f, "packet"),
        reference: "Grounded metal transformation with thin warm edge",
      });
      assert.equal(validatePacket(packet.packets[0]!).A.length, 1);
    } finally {
      rmSync(f, { recursive: true, force: true });
    }
  },
);
