/**
 * `pnpm ref:rate` (RFC 0004 WP9, A16): the user's 1-5 rating of a project file lands in pipeline/ratings.json under a
 * lock, with the file's hash; a note becomes a memory preference in the user's words; invalid input writes nothing;
 * concurrent raters lose no record.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RatingsFileSchema } from "../src/types/console";
import { consoleGrantEnv } from "../src/lib/console/grant";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { CONTROL_ALIASES } from "../src/lib/step-lease/lease";
import {
  inferKind,
  latestRatings,
  ratingSummary,
  RATINGS_LOCK_STALE_MS,
  withRatingsLock,
} from "../src/lib/console/ratings";
import { tryFileLock } from "../src/lib/console/file-lock";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const SCRIPT = path.join(REPO, "scripts/ref-rate.ts");
const PROJECT = "rate-film";
const FRAME = "pipeline/look/sf-1.png";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Envelope = {
  ok: boolean;
  error?: string;
  message?: string;
  outputs?: string[];
  metadata?: Record<string, any>;
};

function setup(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ref-rate-"));
  const memory = path.join(root, "memory-root");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects", PROJECT);
  const put = (relative: string, content: string) => {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  put(FRAME, "frame one");
  put("pipeline/look/sf-2.png", "frame two");
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTBROS_NO_DOTENV: "1",
    AGENTBROS_EVENTS: "off",
    AGENTBROS_CONSOLE: "off",
    AGENTBROS_HOOKS: "off",
    AGENTBROS_MEMORY_ROOT: memory,
    ...extra,
  });
  const run = (args: string[], extra?: NodeJS.ProcessEnv | "console") => {
    // "console": what the console's spawn adds — the user on the console, signed for exactly this argv.
    const consoleEnv = (): NodeJS.ProcessEnv => {
      loadOrCreateSessionToken(root);
      const argv = ["--project", PROJECT, ...args];
      return { AGENTBROS_ACTOR: "user", AGENTBROS_CHANNEL: "console", ...consoleGrantEnv(root, PROJECT, argv) };
    };
    const result = spawnSync(process.execPath, [TSX, SCRIPT, "--project", PROJECT, ...args], {
      cwd: root,
      encoding: "utf8",
      env: env(extra === "console" ? consoleEnv() : extra),
    });
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `one JSON line: ${result.stdout}${result.stderr}`);
    const json = JSON.parse(lines[0]!) as Envelope;
    assert.equal(result.status, json.ok ? 0 : 1);
    return json;
  };
  const runAsync = (args: string[]) =>
    new Promise<Envelope>((resolve, reject) => {
      const child = spawn(process.execPath, [TSX, SCRIPT, "--project", PROJECT, ...args], {
        cwd: root,
        env: env(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(JSON.parse(out.trim()) as Envelope));
    });
  const ratingsFile = path.join(dir, "pipeline/ratings.json");
  const ratings = () => RatingsFileSchema.parse(JSON.parse(readFileSync(ratingsFile, "utf8")));
  const preferences = () => {
    const folder = path.join(memory, "preferences");
    return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".md")) : [];
  };
  return { root, dir, memory, put, run, runAsync, ratingsFile, ratings, preferences };
}

test("ref:rate: a score alone lands in ratings.json with the file's hash, kind and step; nothing goes to memory", (t) => {
  const f = setup(t);
  const result = f.run(["--path", FRAME, "--score", "4"]);
  assert.ok(result.ok, result.message ?? "");
  assert.deepEqual(result.outputs, [`public/projects/${PROJECT}/pipeline/ratings.json`]);
  const [rating] = f.ratings().ratings;
  assert.deepEqual(
    { target: rating!.target, kind: rating!.kind, score: rating!.score, step: rating!.step, by: rating!.by },
    { target: { path: FRAME, sha256: sha("frame one") }, kind: "styleframe", score: 4, step: "look", by: "user" },
  );
  assert.equal(rating!.channel, "cli");
  assert.equal(rating!.note, undefined);
  assert.equal(result.metadata!["memory"], undefined);
  assert.deepEqual(f.preferences(), []);
  // A later rating of the same file wins when read.
  assert.ok(f.run(["--path", FRAME, "--score", "2"]).ok);
  assert.equal(f.ratings().ratings.length, 2);
  assert.equal(latestRatings(f.ratings()).get(FRAME)!.score, 2);
});

test("ref:rate: a note is the user's words, saved as a memory preference; the same note again is not repeated", (t) => {
  const f = setup(t);
  const note = "-h this one feels like us: warm light, real hands";
  // Env words alone are not the console: the channel stays the CLI's.
  const claimed = f.run(["--path", FRAME, "--score", "4", "--note=claimed only"], {
    AGENTBROS_ACTOR: "user",
    AGENTBROS_CHANNEL: "console",
  });
  assert.ok(claimed.ok, claimed.message ?? "");
  assert.notEqual(f.ratings().ratings[0]!.channel, "console");
  rmSync(f.ratingsFile);
  for (const file of f.preferences()) rmSync(path.join(f.memory, "preferences", file));
  const result = f.run(["--path", FRAME, "--score", "5", `--note=${note}`], "console");
  assert.ok(result.ok, result.message ?? "");
  const [rating] = f.ratings().ratings;
  assert.equal(rating!.note, note);
  assert.equal(rating!.channel, "console");
  const memory = result.metadata!["memory"] as { id: string; file: string };
  assert.match(memory.id, /^preference-/);
  assert.equal(result.outputs!.length, 2);
  const [entry] = f.preferences();
  const text = readFileSync(path.join(f.memory, "preferences", entry!), "utf8");
  assert.ok(text.includes(note), "the quote, verbatim");
  assert.match(text, /channel: "?console"?/);
  assert.match(text, /project: "?rate-film"?/);
  assert.match(text, /Rating: 5\/5/);
  assert.ok(text.includes(`${FRAME} (sha256 ${sha("frame one")})`));

  const again = f.run(["--path", FRAME, "--score", "5", `--note=${note}`]);
  assert.ok(again.ok, again.message ?? "");
  assert.deepEqual(again.metadata!["memory"], { id: memory.id, existing: true });
  assert.equal(f.preferences().length, 1, "a near-duplicate preference is not written twice");
  assert.equal(f.ratings().ratings.length, 2, "the rating itself is recorded again");
});

test("ref:rate: invalid input is refused with one JSON line and writes nothing", (t) => {
  const f = setup(t);
  const cases: [string[], string, RegExp][] = [
    [["--path", FRAME, "--score", "0"], "INVALID_INPUT", /integer from 1 to 5/],
    [["--path", FRAME, "--score", "6"], "INVALID_INPUT", /integer from 1 to 5/],
    [["--path", FRAME, "--score", "2.5"], "INVALID_INPUT", /integer from 1 to 5/],
    [["--path", FRAME], "INVALID_INPUT", /score/],
    [["--path", "../other/x.png", "--score", "3"], "INVALID_INPUT", /inside the project/],
    [["--path", "/etc/hosts", "--score", "3"], "INVALID_INPUT", /inside the project/],
    [["--path", "pipeline/look/missing.png", "--score", "3"], "INVALID_INPUT", /not a file of the project/],
    [["--path", "pipeline/look", "--score", "3"], "INVALID_INPUT", /not a file of the project/],
    [["--path", FRAME, "--score", "3", "--note=<the user's words>"], "INVALID_INPUT", /placeholder/],
    [["--path", FRAME, "--score", "3", "--note=  "], "INVALID_INPUT", /empty/],
    [["--path", FRAME, "--score", "3", "--step", "nope"], "INVALID_INPUT", /not a film chain step/],
    [["--path", FRAME, "--score", "3", "--kind", "song"], "INVALID_INPUT", /song/],
    [["--path", FRAME, "--score", "3", "--expect", "abc"], "INVALID_INPUT", /SHA-256/],
    [["--path", FRAME, "--score", "3", "--expect", sha("frame zero")], "VALIDATION", /changed since the user saw it/],
  ];
  for (const [args, error, message] of cases) {
    const result = f.run(args);
    assert.equal(result.ok, false, args.join(" "));
    assert.equal(result.error, error, `${args.join(" ")}: ${result.message}`);
    assert.match(result.message!, message, args.join(" "));
  }
  assert.equal(existsSync(f.ratingsFile), false);
  assert.deepEqual(f.preferences(), []);
  const missing = spawnSync(process.execPath, [TSX, SCRIPT, "--project", "no-such", "--path", FRAME, "--score", "3"], {
    cwd: f.root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, AGENTBROS_EVENTS: "off", AGENTBROS_NO_DOTENV: "1" },
  });
  assert.equal(JSON.parse(missing.stdout).error, "PROJECT_NOT_FOUND");
  // A corrupt ratings file is refused, never overwritten.
  writeFileSync(f.ratingsFile, "{ not json");
  const corrupt = f.run(["--path", FRAME, "--score", "3", "--note=warm and honest"]);
  assert.equal(corrupt.error, "VALIDATION");
  assert.equal(readFileSync(f.ratingsFile, "utf8"), "{ not json");
  assert.deepEqual(f.preferences(), [], "a refused rating writes no memory either");
});

test("ref:rate: concurrent raters each land one record, under the lock", async (t) => {
  const f = setup(t);
  const runs = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      f.runAsync(["--path", index % 2 ? "pipeline/look/sf-2.png" : FRAME, "--score", String((index % 5) + 1)]),
    ),
  );
  for (const result of runs) assert.ok(result.ok, result.message ?? "");
  const file = f.ratings();
  assert.equal(file.ratings.length, 6);
  assert.equal(new Set(file.ratings.map((rating) => rating.id)).size, 6);
  assert.equal(existsSync(`${f.ratingsFile}.lock`), false, "the lock is released");
});

test("ratings lock: a fresh lock held by another writer times out, a stale one is broken", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ratings-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "pipeline/ratings.json.lock");
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, "");
  assert.throws(
    () => withRatingsLock(dir, () => "ran", 50),
    (error: { code?: string }) => error.code === "TIMEOUT",
  );
  const old = (Date.now() - RATINGS_LOCK_STALE_MS - 1000) / 1000;
  utimesSync(lock, old, old);
  assert.equal(
    withRatingsLock(dir, () => "ran", 200),
    "ran",
  );
  assert.equal(existsSync(lock), false);
});

test("ratings: kinds from paths, a bounded summary, and ref:rate is a control command of every lease", () => {
  assert.equal(inferKind("pipeline/look/sf-1.png"), "styleframe");
  assert.equal(inferKind("design/styleframes/a.png"), "styleframe");
  assert.equal(inferKind("references/hero.mp4"), "reference");
  assert.equal(inferKind("renders/film.mp4"), "render");
  assert.equal(inferKind("images/logo.png"), "asset");
  const summary = ratingSummary({ score: 3, kind: "styleframe", target: { path: FRAME } }, "x ".repeat(400));
  assert.ok(summary.length <= 160 && summary.startsWith("Rated styleframe sf-1.png 3/5: "));
  assert.ok((CONTROL_ALIASES as readonly string[]).includes("ref:rate"));
});

test("file lock: an owner token; a dead holder's lock is taken over; release never removes another owner's lock", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "file-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  const release = tryFileLock(lock, 60_000)!;
  const token = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; id: string };
  assert.equal(token.pid, process.pid);
  assert.match(token.id, /^[0-9a-f]{16}$/);
  assert.equal(tryFileLock(lock, 60_000), undefined, "held: a second caller waits");
  // Our lock was broken and another writer holds it now: our release leaves theirs in place.
  const theirs = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), id: "feedfacefeedface" });
  writeFileSync(lock, theirs);
  release();
  assert.equal(readFileSync(lock, "utf8"), theirs);
  rmSync(lock);
  // A fresh lock of a dead process is stale: the first try moves it aside, the next one takes the lock.
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString(), id: "0000000000000000" }));
  assert.equal(tryFileLock(lock, 60_000), undefined);
  const mine = tryFileLock(lock, 60_000);
  assert.ok(mine, "taken over");
  mine!();
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(dir), [], "no stale copies left behind");
});

test("ref:rate: concurrent raters behind a stale lock each land one record, and only one breaks it", async (t) => {
  const f = setup(t);
  const lock = `${f.ratingsFile}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: "2026-01-01T00:00:00.000Z", id: "0123456789abcdef" }));
  const old = (Date.now() - RATINGS_LOCK_STALE_MS - 5000) / 1000;
  utimesSync(lock, old, old);
  const runs = await Promise.all(
    Array.from({ length: 6 }, (_, index) => f.runAsync(["--path", FRAME, "--score", String((index % 5) + 1)])),
  );
  for (const result of runs) assert.ok(result.ok, result.message ?? "");
  assert.equal(f.ratings().ratings.length, 6);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(
    readdirSync(path.dirname(lock)).filter((name) => name.includes(".lock") || name.endsWith(".tmp")),
    [],
  );
});
