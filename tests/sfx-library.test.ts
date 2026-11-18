import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MusicHttp } from "../src/lib/music/http";
import {
  buildSfxIndex,
  describeSound,
  fetchSfxPack,
  parseSfxQuery,
  rankSfx,
  readSfxIndex,
  synthSfx,
  type SfxEntry,
} from "../src/lib/music/sfx";

const hasZip = spawnSync("zip", ["-v"]).status === 0;
const PAGE = "<html><a href='https://creativecommons.org/publicdomain/zero/1.0/'>CC0</a></html>";

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "sfx-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cache: path.join(root, "cache"), source: path.join(root, "source") };
}

function tone(file: string, seconds: number, frequency = 300) {
  mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=${seconds}`,
      file,
    ]).status,
    0,
  );
}

function packZip(source: string, licence?: string) {
  mkdirSync(source, { recursive: true });
  tone(path.join(source, "Audio/click_001.wav"), 0.1);
  if (licence) writeFileSync(path.join(source, "License.txt"), licence);
  const zip = path.join(source, "pack.zip");
  assert.equal(spawnSync("zip", ["-q", "-r", zip, "."], { cwd: source }).status, 0);
  return zip;
}

const http = (zip?: string, page = PAGE) => {
  const calls: string[] = [];
  const client = new MusicHttp({
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/content/")) return new Response(page);
      if (url.endsWith(".zip") && zip) return new Response(readFileSync(zip));
      throw new Error(`Unexpected request in a test: ${url}`);
    }) as typeof fetch,
    now: () => "2026-11-04T00:00:00.000Z",
  });
  return { client, calls };
};

test("a pack is fetched once, with licence evidence", { skip: !hasZip }, async (t) => {
  const { cache, source } = workspace(t);
  const { client, calls } = http(packZip(source, "License: Creative Commons Zero, CC0"));
  const first = await fetchSfxPack(client, "interface", { cache });
  assert.equal(first.status, "fetched");
  const manifest = JSON.parse(readFileSync(first.manifest, "utf8"));
  assert.equal(manifest.licence, "CC0");
  assert.equal(manifest.evidence.pageSaysCc0, true);
  assert.equal(manifest.evidence.licenceFile, "License.txt");
  assert.match(manifest.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
  const before = calls.length;
  assert.equal((await fetchSfxPack(client, "interface", { cache })).status, "cached");
  assert.equal(calls.length, before);
});

test("a pack is refused when its page or its licence file does not say CC0", { skip: !hasZip }, async (t) => {
  const { cache, source } = workspace(t);
  await assert.rejects(
    fetchSfxPack(http(undefined, "<html>All rights reserved</html>").client, "interface", { cache }),
    /no longer says CC0/,
  );
  const zip = packZip(source, "Licence: personal use only");
  await assert.rejects(fetchSfxPack(http(zip).client, "interface", { cache }), /does not say CC0/);
  assert.equal(existsSync(path.join(cache, "kenney/interface/pack.json")), false);
});

test("a zip that climbs out of its directory is not extracted", { skip: !hasZip }, async (t) => {
  const { cache, root } = workspace(t);
  const inner = path.join(root, "deep/inner");
  mkdirSync(inner, { recursive: true });
  tone(path.join(root, "deep/evil.wav"), 0.05);
  const zip = path.join(root, "bad.zip");
  assert.equal(spawnSync("zip", ["-q", zip, "../evil.wav"], { cwd: inner }).status, 0);
  await assert.rejects(fetchSfxPack(http(zip).client, "interface", { cache }), /unsafe path/);
});

test("a user's own kenney.nl download is accepted with the page as evidence", { skip: !hasZip }, async (t) => {
  const { cache, source } = workspace(t);
  const zip = packZip(source, "CC0");
  const result = await fetchSfxPack(http().client, "interface", { cache, fromZip: zip });
  assert.equal(result.files, 1);
  assert.match(JSON.parse(readFileSync(result.manifest, "utf8")).source, /local zip/);
});

test("names describe material and use, and queries parse", () => {
  assert.deepEqual(describeSound("impactWood_light_002.ogg"), {
    material: "wood",
    uses: ["impact", "thud"],
    weight: "light",
  });
  assert.equal(describeSound("impactPlank_medium_000.ogg").material, "wood");
  assert.equal(describeSound("impactSoft_heavy_001.ogg").material, "cloth");
  assert.ok(describeSound("click_003.ogg").uses.includes("type"));
  assert.deepEqual(describeSound("drop_002.ogg").uses, ["drop"]);
  const parsed = parseSfxQuery("a soft wood thud about 0.2 s");
  assert.equal(parsed.material, "wood");
  assert.equal(parsed.use, "thud");
  assert.equal(parsed.softness, "soft");
  assert.equal(parsed.durationSec, 0.2);
  assert.equal(parseSfxQuery("thud 200ms").durationSec, 0.2);
  assert.equal(parseSfxQuery("thud 0.2 s", 0.4).durationSec, 0.4, "an explicit flag wins");
  assert.equal(parseSfxQuery("soft whoosh").synth, "whoosh");
  assert.equal(parseSfxQuery("riser").synth, "riser");
});

test("a soft wood thud of about 0.2 s ranks first", () => {
  const entry = (
    id: string,
    material: string,
    weight: SfxEntry["weight"],
    active: number,
    rmsDb: number,
    uses = ["impact", "thud"],
  ): SfxEntry => ({
    id,
    pack: "impact",
    path: id,
    file: id,
    material,
    uses,
    ...(weight ? { weight } : {}),
    durationSec: active,
    activeDurationSec: active,
    peakDb: -3,
    rmsDb,
    lowShare: 0.2,
    licence: "CC0",
    evidenceUrl: "https://example.com",
  });
  const entries = [
    entry("metal", "metal", "light", 0.2, -22),
    entry("heavy", "wood", "heavy", 0.2, -10),
    entry("long", "wood", "light", 1, -22),
    entry("right", "wood", "light", 0.2, -22),
    entry("step", "wood", undefined, 0.2, -22, ["step", "thud"]),
  ];
  assert.equal(rankSfx(entries, parseSfxQuery("soft wood thud", 0.2), 1)[0]!.entry.id, "right");
});

test("the index measures real audio from packs with CC0 evidence only", (t) => {
  const { cache } = workspace(t);
  const write = (pack: string, name: string, licence: string, seconds: number) => {
    tone(path.join(cache, "kenney", pack, name), seconds);
    writeFileSync(
      path.join(cache, "kenney", pack, "pack.json"),
      JSON.stringify({ licence, evidenceUrl: "https://example.com/pack", files: [{ name }] }),
    );
  };
  write("impact", "impactWood_light_000.wav", "CC0", 0.2);
  write("other", "impactWood_heavy_000.wav", "unknown", 0.2);
  buildSfxIndex(cache);
  const index = readSfxIndex(cache)!;
  assert.deepEqual(
    index.entries.map((item) => item.id),
    ["impact/impactWood_light_000.wav"],
  );
  const [row] = index.entries;
  assert.ok(Math.abs(row!.durationSec - 0.2) < 0.02);
  assert.ok(row!.rmsDb < 0 && row!.peakDb <= 0.5);
});

test("whooshes and risers come from local synthesis, once per take", (t) => {
  const { cache } = workspace(t);
  const whoosh = synthSfx(cache, "whoosh", 0.5, 1);
  assert.ok(existsSync(whoosh.file));
  assert.match(whoosh.licence, /no third-party rights/);
  assert.equal(synthSfx(cache, "whoosh", 0.5, 1).file, whoosh.file);
  const riser = synthSfx(cache, "riser", 1, 1);
  assert.ok(Math.abs(riser.durationSec - 1) < 0.02);
  const samples = readFileSync(riser.file).subarray(44);
  const rms = (start: number, end: number) => {
    let sum = 0;
    for (let index = start; index < end; index += 2) sum += samples.readInt16LE(index) ** 2;
    return Math.sqrt(sum / ((end - start) / 2));
  };
  const half = Math.floor(samples.length / 4) * 2;
  assert.ok(rms(half, samples.length) > rms(0, half) * 2, "a riser ends louder than it starts");
});
