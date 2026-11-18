import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cueDefaults } from "../src/lib/film/music-cut";
import { DONE_CHECKS, baseTokens, openFilmProject, renderCommand } from "../src/lib/film/state";
import { FILM_CHAIN } from "../src/lib/film/chain";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const ID = "cut";
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function cli(root: string, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], { cwd: root, encoding: "utf8" });
  return {
    status: result.status,
    json: JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as {
      ok: boolean;
      message?: string;
      metadata: Record<string, any>;
    },
  };
}

function setup(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "film-cut-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(cli(root, "scripts/film-init.ts", "--project", ID).status, 0);
  const dir = path.join(root, "public/projects", ID);
  const write = (relative: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    writeFileSync(path.join(dir, relative), JSON.stringify(value, null, 2));
  };
  mkdirSync(path.join(dir, "music"), { recursive: true });
  assert.equal(
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=20",
      path.join(dir, "music/source.wav"),
    ]).status,
    0,
  );
  const map = JSON.parse(readFileSync(path.join(FIXTURES, "audio-map.json"), "utf8"));
  write("pipeline/music/candidates/stock-1.audio-map.json", {
    ...map,
    source: { path: "music/source.wav", sha256: sha(path.join(dir, "music/source.wav")), durationSec: 20 },
    downbeatsSec: [2, 4.1, 6, 8, 10.4, 12],
  });
  write("pipeline/music-shortlist.json", {
    schemaVersion: 1,
    brief: "calm, then a lift",
    candidates: [
      {
        id: "stock-1",
        route: "free-stock",
        provider: "fixture",
        title: "One",
        originalPath: "music/source.wav",
        audioMapPath: "pipeline/music/candidates/stock-1.audio-map.json",
        licence: { code: "CC0", commercial: "yes" },
      },
    ],
  });
  const project = () => openFilmProject(dir, { rootDir: root });
  return { root, dir, write, project };
}

const record = (root: string, ...extra: string[]) =>
  cli(
    root,
    "scripts/music.ts",
    "--action",
    "record",
    "--project",
    ID,
    "--route",
    "free-stock",
    "--candidate",
    "stock-1",
    "--answer",
    "the first one",
    "--reason",
    "it lifts",
    "--question",
    "Which track?",
    ...extra,
  );

test("record cuts the shortlist's excerpt to music/cue.wav, ends it on a downbeat, and the chain maps the cut", (t) => {
  const film = setup(t);
  film.write("pipeline/music/shortlist-fit.json", {
    schemaVersion: 1,
    musicBrief: { durationSec: 8 },
    candidates: [{ id: "stock-1", fit: { offsetSec: 2 } }],
  });
  const result = record(film.root);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  const decision = JSON.parse(readFileSync(path.join(film.dir, "pipeline/music-decision.json"), "utf8"));
  assert.equal(decision.cut.file, "music/cue.wav");
  assert.equal(decision.cut.startSec, 2);
  assert.equal(decision.cut.requestedDurationSec, 8);
  assert.equal(decision.cut.durationSec, 8.4, "the end moves from 10 s to the downbeat at 10.4 s");
  assert.equal(decision.cut.endsOn, "downbeat");
  assert.equal(decision.cut.from, "fit");
  const cue = path.join(film.dir, "music/cue.wav");
  assert.equal(decision.cut.sha256, sha(cue));
  const probed = Number(
    spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", cue], {
      encoding: "utf8",
    }).stdout,
  );
  assert.ok(Math.abs(probed - 8.4) < 0.01, `cue lasts ${probed} s`);
  assert.equal(sha(cue), (record(film.root), sha(cue)), "the cut is deterministic");

  const tokens = baseTokens(film.project());
  assert.equal(tokens["musicFile"], `public/projects/${ID}/music/cue.wav`);
  const audioMap = FILM_CHAIN.find((step) => step.id === "audio-map")!;
  assert.match(renderCommand(audioMap.commands[0]!, tokens), /--input public\/projects\/cut\/music\/cue\.wav/);

  const context = { project: film.project(), tokens, silence: false };
  const map = JSON.parse(readFileSync(path.join(FIXTURES, "audio-map.json"), "utf8"));
  film.write("pipeline/audio-map.json", {
    ...map,
    source: { path: "music/source.wav", sha256: sha(path.join(film.dir, "music/source.wav")), durationSec: 20 },
  });
  assert.match(DONE_CHECKS["map-matches-music"](context).join(" "), /another file than the chosen track's cut/);
  copyFileSync(path.join(FIXTURES, "script.json"), path.join(film.dir, "pipeline/script.json"));
  copyFileSync(path.join(FIXTURES, "script-music-map.json"), path.join(film.dir, "pipeline/script-music-map.json"));
  assert.match(
    DONE_CHECKS["script-on-music"](context).join(" "),
    /not the map of .*cue\.wav/,
    "the writers' map must be the cut's",
  );
  film.write("pipeline/audio-map.json", {
    ...map,
    source: { path: "music/cue.wav", sha256: sha(cue), durationSec: 12 },
  });
  assert.deepEqual(DONE_CHECKS["map-matches-music"](context), []);
  assert.deepEqual(DONE_CHECKS["script-on-music"](context), []);
  assert.deepEqual(DONE_CHECKS["music-resolved"](context), []);
});

test("with no offset the whole file is the cut, flags override, and a decision without a cut does not resolve", (t) => {
  const film = setup(t);
  const whole = record(film.root);
  assert.equal(whole.json.ok, true, JSON.stringify(whole.json));
  assert.deepEqual(
    [whole.json.metadata["cut"].from, whole.json.metadata["cut"].startSec, whole.json.metadata["cut"].durationSec],
    ["whole", 0, 20],
    "no fit and no flags: the whole file is the cut",
  );
  const result = record(film.root, "--start", "13", "--duration", "5");
  assert.equal(result.status, 0, JSON.stringify(result.json));
  const decision = JSON.parse(readFileSync(path.join(film.dir, "pipeline/music-decision.json"), "utf8"));
  assert.equal(decision.cut.from, "flags");
  assert.equal(decision.cut.endsOn, "requested", "no downbeat within a second of 18 s");
  delete decision.cut;
  film.write("pipeline/music-decision.json", decision);
  const tokens = baseTokens(film.project());
  assert.equal(tokens["musicFile"], `public/projects/${ID}/music/source.wav`);
  assert.match(
    DONE_CHECKS["music-resolved"]({ project: film.project(), tokens, silence: false }).join(" "),
    /carries no cut/,
  );
});

test("a shortlist map of the preview's first stretch still places the end on a downbeat when it covers it", (t) => {
  const film = setup(t);
  const mapFile = path.join(film.dir, "pipeline/music/candidates/stock-1.audio-map.json");
  const map = JSON.parse(readFileSync(mapFile, "utf8"));
  writeFileSync(mapFile, JSON.stringify({ ...map, source: { ...map.source, durationSec: 12.5 } }));
  assert.equal(record(film.root, "--start", "2", "--duration", "8").status, 0);
  assert.equal(
    JSON.parse(readFileSync(path.join(film.dir, "pipeline/music-decision.json"), "utf8")).cut.endsOn,
    "downbeat",
  );
  assert.equal(record(film.root, "--start", "13", "--duration", "5").status, 0);
  assert.equal(
    JSON.parse(readFileSync(path.join(film.dir, "pipeline/music-decision.json"), "utf8")).cut.endsOn,
    "requested",
    "past the map's end there is nothing to snap to",
  );
});

test("the listening file's name gives the cut when the fit has none", (t) => {
  const film = setup(t);
  mkdirSync(path.join(film.dir, "pipeline/music/listen"), { recursive: true });
  writeFileSync(path.join(film.dir, "pipeline/music/listen/1-cue6s-from-3.5s.wav"), "");
  assert.deepEqual(cueDefaults(film.dir, "stock-1"), { startSec: 3.5, durationSec: 6, from: "listen" });
  assert.ok(!existsSync(path.join(film.dir, "music/cue.wav")));
});
