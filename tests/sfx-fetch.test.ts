import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchSfx, freezeProjectSfx, missingSfx } from "../src/lib/audio/sfx-fetch";
import { encodeWav } from "../src/lib/audio/sfx-synth";

const process1 = { trimStartDb: null, peakDb: -1, channels: 1 };

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "sfx-fetch-test-"));
  mkdirSync(path.join(root, "tick"), { recursive: true });
  const entries = [
    {
      file: "synth-tick.mp3",
      source: "synth",
      licence: "generated",
      recipe: { type: "synth", kind: "tick", seed: 1, rootHz: 55 },
      process: process1,
    },
    {
      file: "freesound-1-gone.mp3",
      source: "freesound",
      sourceId: "1",
      licence: "CC0-1.0",
      recipe: { type: "freesound", id: 1, url: "https://cdn.example/1.mp3" },
      process: process1,
    },
    {
      file: "freesound-2-ok.mp3",
      source: "freesound",
      sourceId: "2",
      licence: "CC-BY-4.0",
      attribution: "x by y",
      recipe: { type: "freesound", id: 2, url: "https://cdn.example/2.wav" },
      process: process1,
    },
    {
      file: "elevenlabs-01-tick.mp3",
      source: "elevenlabs",
      sourceId: "01",
      licence: "generated",
      recipe: {
        type: "elevenlabs",
        endpoint: "POST /v1/sound-generation",
        model: "default",
        prompt: "tiny tick",
        durationSeconds: 0.5,
      },
      process: process1,
    },
  ];
  writeFileSync(path.join(root, "tick", "manifest.json"), JSON.stringify({ schemaVersion: 1, kind: "tick", entries }));
  return root;
}

const tone = encodeWav(Float32Array.from({ length: 4800 }, (_, index) => Math.sin(index / 5) * Math.exp(-index / 800)));
const download = async (url: string) => (url.endsWith("2.wav") ? { status: 200, bytes: tone } : { status: 404 });

test("fetchSfx rebuilds synth, downloads, names a deleted source and leaves paid takes pending", async () => {
  const root = fixture();
  assert.equal(missingSfx(root, "tick").length, 4);
  const result = await fetchSfx({ kind: "tick", root, download, freesoundKey: "k" });
  const by = Object.fromEntries(result.items.map((item) => [item.file, item]));
  assert.equal(by["tick/synth-tick.mp3"]!.status, "fetched");
  assert.equal(by["tick/freesound-2-ok.mp3"]!.status, "fetched");
  assert.equal(by["tick/freesound-1-gone.mp3"]!.status, "source-gone");
  assert.equal(by["tick/elevenlabs-01-tick.mp3"]!.status, "needs-generation");
  assert.match(by["tick/elevenlabs-01-tick.mp3"]!.message!, /consent/);
  assert.ok(by["tick/elevenlabs-01-tick.mp3"]!.fallback);
  assert.equal(result.ok, false, "a deleted source is not ok");
  const again = await fetchSfx({ kind: "tick", root, download, freesoundKey: "k", id: "synth-tick" });
  assert.deepEqual(
    again.items.map((item) => item.status),
    ["present"],
  );
});

test("freezeProjectSfx copies used library sounds into the project with provenance", () => {
  const publicDir = mkdtempSync(path.join(tmpdir(), "sfx-freeze-test-"));
  const root = path.join(publicDir, "shared", "sfx");
  mkdirSync(path.join(root, "tick"), { recursive: true });
  writeFileSync(path.join(root, "tick", "a.mp3"), "audio");
  writeFileSync(
    path.join(root, "tick", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "tick",
      entries: [
        {
          file: "a.mp3",
          source: "freesound",
          sourceUrl: "https://freesound.org/s/9/",
          licence: "CC-BY-4.0",
          attribution: "a by b",
        },
      ],
    }),
  );
  const moved = freezeProjectSfx(["shared/sfx/tick/a.mp3", "shared/sfx/tick/a.mp3"], {
    publicDir,
    projectDir: path.join(publicDir, "projects", "p"),
  });
  assert.equal(moved["shared/sfx/tick/a.mp3"], "projects/p/assets/sfx/library/tick/a.mp3");
  assert.ok(existsSync(path.join(publicDir, "projects/p/assets/sfx/library/tick/a.mp3")));
  const provenance = JSON.parse(
    readFileSync(path.join(publicDir, "projects/p/assets/sfx/library/provenance.json"), "utf8"),
  );
  assert.equal(provenance["projects/p/assets/sfx/library/tick/a.mp3"].attribution, "a by b");
});
