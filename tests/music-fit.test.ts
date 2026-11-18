import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AudioMap } from "../src/types/film";
import { stockFileName } from "../src/lib/music/acquire";
import { bpmFit, fitFromAudioMap, fitFromMetadata, parseMusicBrief } from "../src/lib/music/fit";
import { MusicHttp } from "../src/lib/music/http";
import { filterIncompetech, incompetechHit } from "../src/lib/music/incompetech";
import { recheckLicence } from "../src/lib/music/providers";
import { searchFreeStock } from "../src/lib/music/search";
import { snapToBeats, stitchCue } from "../src/lib/music/stitch";
import { MusicSearchFileSchema } from "../src/lib/music/types";

const NOW = "2026-11-11T00:00:00.000Z";
const pieces = JSON.parse(readFileSync("tests/fixtures/music/incompetech-pieces.json", "utf8"));
const genres = { "7": "Electronica", "8": "Funk", "23": "Stings", "5": "Contemporary" };
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

/** Only Incompetech answers; every other provider fails, so nothing reaches the network. */
const incompetechOnly = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("/pieces.json")) return json(pieces);
  if (url.endsWith("/genre.json"))
    return json(Object.entries(genres).map(([id, genre]) => ({ id: Number(id), genre })));
  throw new Error(`Unexpected request in a test: ${url}`);
}) as typeof fetch;

/** A 30 s map at 140 BPM: quiet until 10 s, loud after, one measured surge at 10 s. */
function syntheticMap(over: Partial<AudioMap> = {}, length = 30): AudioMap {
  const beat = 60 / 140;
  const beats = Array.from({ length: Math.floor(length / beat) }, (_, index) => Math.round(index * beat * 1000) / 1000);
  return {
    schemaVersion: 1,
    source: { path: "x.mp3", sha256: "a".repeat(64), durationSec: length },
    tempo: { bpm: 140, confidence: 0.8, gridTrust: "reliable" },
    beatsSec: beats,
    downbeatsSec: beats.filter((_, index) => index % 4 === 0),
    phrases: [],
    sections: [
      { startSec: 0, endSec: 10, level: "low", density: 2, feel: "sparse" },
      { startSec: 10, endSec: length, level: "high", density: 9, feel: "busy" },
    ],
    events: [],
    keyMoments: [{ timeSec: 10, kind: "surge", strength: 0.8 }],
    silences: [],
    risers: [],
    energyCurve: Array.from({ length: length * 10 }, (_, index) => ({
      timeSec: index / 10,
      rms: index / 10 < 10 ? 0.1 : 0.8,
      low: index / 10 < 10 ? 0.05 : 0.9,
      high: 0.3,
    })),
    ...over,
  };
}

test("a written brief reads tempo, drop, length, intro and ending; flags win", () => {
  assert.deepEqual(parseMusicBrief("140 BPM, quiet intro, drop around 4 s, hard ending, about 16 s"), {
    bpm: 140,
    bpmTolerance: 6,
    dropAtSec: 4,
    durationSec: 16,
    intro: "quiet",
    ending: "hard",
  });
  const flagged = parseMusicBrief("tech launch at 128bpm, fade out ending", { bpm: 140, bpmTolerance: 3 });
  assert.equal(flagged.bpm, 140);
  assert.equal(flagged.bpmTolerance, 3);
  assert.equal(flagged.ending, "fade");
  assert.equal(flagged.dropAtSec, undefined);
});

test("half and double tempo count with a penalty; a distant tempo is marked off", () => {
  const brief = parseMusicBrief("140 bpm");
  assert.equal(bpmFit(140, brief).relation, "exact");
  assert.equal(bpmFit(70, brief).relation, "half");
  assert.ok(bpmFit(70, brief).score < bpmFit(140, brief).score);
  assert.equal(bpmFit(100, brief).relation, "off");
  assert.ok(bpmFit(100, brief).score < 0);
});

test("the fit finds the start offset that lands the surge on the brief's drop", () => {
  const fit = fitFromAudioMap(syntheticMap(), parseMusicBrief("140 BPM, quiet intro, drop at 4 s, hard ending, 16 s"), {
    wholeTrack: true,
  });
  assert.equal(fit.analysed, true);
  assert.equal(fit.surgeSec, 10);
  assert.equal(fit.offsetSec, 6);
  assert.ok(fit.contrast! > 0.6, String(fit.contrast));
  assert.ok(fit.introLevel! < 0.2);
  assert.equal(fit.energy.length, 16);
  assert.ok(fit.energy[0]! < 0.2 && fit.energy[5]! > 0.7, fit.energy.join(","));
  assert.equal(fit.ending?.cueCutSec, 22);
  assert.equal(fit.ending?.track, "hard-stop");
  assert.equal(fit.loop, false);
  assert.equal(fit.bpm.relation, "exact");
});

test("a flat track scores below one with a rise, and a short loop is marked and penalised", () => {
  const brief = parseMusicBrief("140 BPM, quiet intro, drop at 4 s, 16 s");
  const rising = fitFromAudioMap(syntheticMap(), brief, { wholeTrack: true });
  const flat = fitFromAudioMap(
    syntheticMap({
      keyMoments: [],
      energyCurve: syntheticMap().energyCurve.map((point) => ({ ...point, rms: 0.7, low: 0.7 })),
    }),
    brief,
    { wholeTrack: true },
  );
  assert.ok(rising.score > flat.score + 2, `${rising.score} vs ${flat.score}`);
  assert.ok(flat.notes.some((note) => /no clear rise/.test(note)));
  const loop = fitFromAudioMap(syntheticMap({}, 12), parseMusicBrief("140 BPM, 16 s"), { wholeTrack: true });
  assert.equal(loop.loop, true);
  assert.ok(loop.notes.some((note) => /stitch/.test(note)));
  const metadata = fitFromMetadata({ metadataBpm: 140, durationSec: 8 }, brief);
  assert.equal(metadata.analysed, false);
  assert.equal(metadata.bpm.source, "metadata");
  assert.equal(metadata.loop, true);
});

test("Incompetech pieces carry tempo, CC BY 4.0 and a direct file; tempo filters the catalogue", () => {
  const hits = pieces.map((piece: object) => incompetechHit(piece, genres, NOW));
  const first = hits[0]!;
  assert.equal(first.licence.code, "CC BY 4.0");
  assert.equal(first.licence.commercial, "yes");
  assert.equal(first.metadataBpm, 140);
  assert.equal(first.durationSec, 160);
  assert.equal(first.originalUrl, "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Fast%20Circuit.mp3");
  assert.ok(first.tags.includes("Electronica"));
  assert.equal(hits[4]!.metadataBpm, undefined);
  const kept = filterIncompetech(hits, ["electronic"], parseMusicBrief("140 BPM, 16 s"), 10);
  assert.deepEqual(
    kept.map((hit) => hit.title),
    ["Fast Circuit", "Half Time Pad"],
  );
  assert.deepEqual(
    filterIncompetech(hits, ["groove"], undefined, 10).map((hit) => hit.title),
    ["Mid Groove"],
  );
});

test("a search with a tempo brief ranks by fit and keeps the brief in the file", async () => {
  const http = new MusicHttp({ fetch: incompetechOnly, now: () => NOW });
  const result = await searchFreeStock(
    http,
    { query: "electronic launch", commercial: true, limit: 10, brief: parseMusicBrief("140 BPM, drop at 4 s, 16 s") },
    {},
  );
  assert.equal(result.providers.find((item) => item.provider === "incompetech")?.status, "ok");
  assert.equal(result.candidates[0]!.title, "Fast Circuit");
  assert.equal(result.candidates[0]!.fit?.bpm.source, "metadata");
  assert.match(result.candidates[0]!.why!, /states 140 BPM/);
  const parsed = MusicSearchFileSchema.parse(JSON.parse(JSON.stringify(result)));
  assert.equal(parsed.musicBrief?.bpm, 140);
  assert.ok(parsed.candidates[0]!.fit);
  const recheck = await recheckLicence(http, result.candidates[0]!, {});
  assert.ok(recheck.verified && recheck.licence.licence.code === "CC BY 4.0");
});

test("stitch builds a cue with ffmpeg alone and marks it stitched", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "music-stitch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const loop = path.join(root, "loop.wav");
  assert.equal(
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=1.714",
      loop,
    ]).status,
    0,
  );
  assert.equal(snapToBeats(4.1, 140), (60 / 140) * 10);
  const result = stitchCue({
    source: loop,
    output: path.join(root, "music/cue.mp3"),
    durationSec: 8,
    dropAtSec: 4,
    bpm: 140,
    ending: "hard",
  });
  assert.equal(result.stitched, true);
  assert.equal(result.dropAtSec, Math.round((60 / 140) * 9 * 1000) / 1000);
  const duration = Number(
    spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", result.output], {
      encoding: "utf8",
    }).stdout,
  );
  assert.ok(Math.abs(duration - 8) < 0.1, String(duration));
  assert.equal(JSON.parse(readFileSync(result.recordPath, "utf8")).stitched, true);
});

test("a stock file name is short and stable", () => {
  assert.equal(stockFileName("incompetech:USUAN1100078", ".mp3"), "stock-incompetech-usuan1100078.mp3");
});
