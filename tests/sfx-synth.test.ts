import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readSynthPack,
  SHARED_SYNTH_PACK,
  SYNTH_SFX_AUTHOR,
  synthFileName,
  writeSynthSfx,
} from "../src/lib/audio/sfx-pack";
import {
  encodeWav,
  measureSamples,
  spectralCentroid,
  synthesiseSfx,
  SYNTH_SFX_KINDS,
} from "../src/lib/audio/sfx-synth";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("every kind is deterministic per seed and differs across seeds", () => {
  for (const kind of SYNTH_SFX_KINDS) {
    const a = hash(encodeWav(synthesiseSfx({ kind, seed: 3 }).samples));
    assert.equal(hash(encodeWav(synthesiseSfx({ kind, seed: 3 }).samples)), a, kind);
    assert.notEqual(hash(encodeWav(synthesiseSfx({ kind, seed: 4 }).samples)), a, `${kind} varies by seed`);
  }
});

test("a riser is an exact number of frames and peaks at its end", () => {
  const riser = synthesiseSfx({ kind: "riser", lengthFrames: 45, fps: 30 });
  assert.equal(riser.samples.length, 45 * 1600);
  assert.equal(riser.alignSec, 1.5);
  const tail = measureSamples(riser.samples.subarray(-4800, -48)).rmsDb;
  const head = measureSamples(riser.samples.subarray(0, 4800)).rmsDb;
  assert.ok(tail - head > 20, `rises: head ${head}, tail ${tail}`);
});

test("sounds sit where their names say: sub low, glass and click bright, whoosh peaks mid-file", () => {
  assert.ok(spectralCentroid(synthesiseSfx({ kind: "sub-drop" }).samples) < 200);
  assert.ok(spectralCentroid(synthesiseSfx({ kind: "click" }).samples) > 2000);
  assert.ok(spectralCentroid(synthesiseSfx({ kind: "glass" }).samples) > 800);
  const whoosh = synthesiseSfx({ kind: "whoosh" });
  assert.ok(whoosh.alignSec > 0.2 && whoosh.alignSec < whoosh.durationSec - 0.1);
  for (const kind of SYNTH_SFX_KINDS) assert.ok(measureSamples(synthesiseSfx({ kind }).samples).peakDb <= -1.9, kind);
});

test("writing is idempotent and refuses to overwrite a different take without force", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sfx-pack-"));
  try {
    assert.equal(writeSynthSfx(dir, { kind: "pop" }).status, "written");
    assert.equal(writeSynthSfx(dir, { kind: "pop" }).status, "unchanged");
    assert.equal(synthFileName({ kind: "riser", lengthFrames: 45 }), "riser-45f30.wav");
    assert.equal(synthFileName({ kind: "pop", seed: 2 }), "pop-s2.wav");
    assert.equal(readSynthPack(dir)!.entries.length, 1);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "pack.json"), "utf8")).author, SYNTH_SFX_AUTHOR);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-kind manifests credit locally synthesised sounds consistently", () => {
  for (const kind of ["chime", "click", "glass", "impact", "pop", "riser", "sub-drop", "tick", "whoosh"]) {
    const manifest = JSON.parse(readFileSync(path.join("public/shared/sfx", kind, "manifest.json"), "utf8")) as {
      entries: { source: string; author?: string }[];
    };
    for (const entry of manifest.entries.filter((item) => item.source === "synth"))
      assert.equal(entry.author, SYNTH_SFX_AUTHOR, kind);
  }
});

test("the committed default pack matches the generator and stays small", () => {
  const pack = readSynthPack(SHARED_SYNTH_PACK);
  assert.ok(pack, "public/shared/sfx/synth/pack.json is committed");
  assert.deepEqual(new Set(pack.entries.map((entry) => entry.kind)), new Set(SYNTH_SFX_KINDS));
  for (const entry of pack.entries) {
    const file = path.join(SHARED_SYNTH_PACK, entry.file);
    // The WAVs are not in a fresh clone (pnpm assets:sync --family synth writes them); the generator check below covers it.
    if (existsSync(file)) {
      assert.ok(statSync(file).size < 300 * 1024, entry.file);
      assert.equal(hash(readFileSync(file)), entry.sha256, `${entry.file} matches its manifest`);
    }
    const fresh = synthesiseSfx({
      kind: entry.kind,
      seed: entry.seed,
      rootHz: entry.rootHz,
      ...(entry.lengthFrames ? { lengthFrames: entry.lengthFrames, fps: entry.fps } : {}),
    });
    assert.equal(
      hash(encodeWav(fresh.samples)),
      entry.sha256,
      `${entry.file} is what the generator writes today: rerun sfx:synth --force`,
    );
  }
});
