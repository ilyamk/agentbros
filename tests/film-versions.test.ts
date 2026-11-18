import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyFilmVersionPrune,
  bestFilmVersion,
  critiqueTotal,
  listFilmVersions,
  planFilmVersionPrune,
  rankFilmVersions,
  readFilmVersionsIndex,
  snapshotFilmVersion,
  type FilmVersionProject,
} from "../src/lib/film/versions";
import type { FilmVersion } from "../src/types/film";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const scores = (each: number) => ({
  idea: { score: each, note: "n", evidence: ["e"] },
  hook: { score: each, note: "n", evidence: ["e"] },
  motion: { score: each, note: "n", evidence: ["e"] },
  rhythm: { score: each, note: "n", evidence: ["e"] },
  typography: { score: each, note: "n", evidence: ["e"] },
  composition: { score: each, note: "n", evidence: ["e"] },
  ending: { score: each, note: "n", evidence: ["e"] },
});
const version = (id: string, createdAt: string, extra: Partial<FilmVersion> = {}): FilmVersion => ({
  sha256: sha(id),
  file: `out/p/versions/${sha(id).slice(0, 16)}.mp4`,
  sizeBytes: 1,
  steps: ["render"],
  createdAt,
  draft: false,
  ...extra,
});

function workspace(t: test.TestContext): FilmVersionProject {
  const rootDir = mkdtempSync(path.join(tmpdir(), "film-versions-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = { id: "p", rootDir, projectDir: path.join(rootDir, "public/projects/p") };
  mkdirSync(path.join(project.projectDir, "pipeline/critique"), { recursive: true });
  mkdirSync(path.join(rootDir, "out/p"), { recursive: true });
  return project;
}

test("critiqueTotal sums every scored dimension, as the chain's no-progress rule does", () => {
  assert.equal(critiqueTotal({ scores: scores(3) } as never), 21);
  assert.equal(
    critiqueTotal({ scores: { ...scores(2), referenceMatch: { score: 4, note: "n", evidence: ["e"] } } } as never),
    18,
  );
});

test("rank: measure pass first, then the highest critic total for that sha, ties newest; drafts and missing copies last", () => {
  const a = version("a", "2026-11-16T10:00:00.000Z", { measure: { verdict: "fail", failing: ["x"] } });
  const b = version("b", "2026-11-16T11:00:00.000Z", { measure: { verdict: "pass", failing: [] } });
  const c = version("c", "2026-11-16T12:00:00.000Z", { measure: { verdict: "pass", failing: [] } });
  const d = version("d", "2026-11-16T13:00:00.000Z");
  const draft = version("draft", "2026-11-16T14:00:00.000Z", {
    draft: true,
    measure: { verdict: "pass", failing: [] },
  });
  const critiques = [
    { renderSha256: b.sha256, round: 1, scores: scores(4) },
    { renderSha256: c.sha256, round: 2, scores: scores(3) },
    { renderSha256: d.sha256, round: 3, scores: scores(5) },
  ];
  assert.deepEqual(
    rankFilmVersions([a, b, c, d, draft], critiques).map((v) => v.sha256),
    [b, c, d, a, draft].map((v) => v.sha256),
  );
  // The current film-measure.json overrides the verdict kept at render time for its own sha.
  assert.equal(rankFilmVersions([a, b], [], { renderSha256: a.sha256, verdict: "pass" })[0]!.sha256, b.sha256);
  assert.equal(
    rankFilmVersions(
      [a, b],
      critiques.slice(0, 1).map((c) => ({ ...c, renderSha256: a.sha256, scores: scores(5) })),
      { renderSha256: a.sha256, verdict: "pass" },
    )[0]!.sha256,
    a.sha256,
  );
  // Equal measure and critic: the newest wins. Several rounds on one sha: the highest total counts.
  const same = rankFilmVersions(
    [b, c],
    [
      { renderSha256: b.sha256, round: 1, scores: scores(2) },
      { renderSha256: b.sha256, round: 2, scores: scores(4) },
      { renderSha256: c.sha256, round: 3, scores: scores(4) },
    ],
  );
  assert.deepEqual(
    same.map((v) => [v.sha256, v.criticTotal]),
    [
      [c.sha256, 28],
      [b.sha256, 28],
    ],
  );
  assert.equal(rankFilmVersions([{ ...b, exists: false }, a], [])[0]!.sha256, a.sha256);
});

test("snapshot keeps a content-addressed copy that survives the film being rewritten in place", (t) => {
  const project = workspace(t);
  const film = path.join(project.rootDir, "out/p/film.mp4");
  writeFileSync(film, "first render");
  const first = snapshotFilmVersion(project, film, {
    step: "render",
    composition: "Film",
    measure: { verdict: "fail", failing: ["pace"] },
    now: new Date("2026-11-16T10:00:00Z"),
  });
  assert.equal(first.sha256, sha("first render"));
  assert.equal(first.file, `out/p/versions/${sha("first render").slice(0, 16)}.mp4`);
  // ffmpeg -y and the renderer truncate and rewrite film.mp4: the kept copy must not follow.
  writeFileSync(film, "second render, better");
  assert.equal(readFileSync(path.join(project.rootDir, first.file), "utf8"), "first render");
  const second = snapshotFilmVersion(project, film, {
    step: "render",
    measure: { verdict: "pass", failing: [] },
    now: new Date("2026-11-16T11:00:00Z"),
  });
  // Idempotent by sha: a later step tags the same entry and keeps its createdAt.
  const tagged = snapshotFilmVersion(project, film, { step: "critic" });
  assert.deepEqual(tagged.steps, ["render", "critic"]);
  assert.equal(tagged.createdAt, second.createdAt);
  assert.equal(tagged.measure?.verdict, "pass");
  assert.equal(readFilmVersionsIndex(project).versions.length, 2);
  assert.throws(
    () => snapshotFilmVersion(project, film, { step: "render", sha256: sha("not this file") }),
    /changed while it was kept/,
  );
  assert.equal(readFilmVersionsIndex(project).versions.length, 2);
});

test("list and best join the index, the current measurement and the critiques of each exact render", (t) => {
  const project = workspace(t);
  const film = path.join(project.rootDir, "out/p/film.mp4");
  writeFileSync(film, "v1");
  snapshotFilmVersion(project, film, {
    step: "render",
    measure: { verdict: "pass", failing: [] },
    now: new Date("2026-11-16T10:00:00Z"),
  });
  writeFileSync(film, "v2");
  snapshotFilmVersion(project, film, {
    step: "render",
    measure: { verdict: "pass", failing: [] },
    now: new Date("2026-11-16T11:00:00Z"),
  });
  writeFileSync(film, "v3");
  snapshotFilmVersion(project, film, {
    step: "render",
    measure: { verdict: "fail", failing: ["pace"] },
    now: new Date("2026-11-16T12:00:00Z"),
  });
  // With no critic, the newest passing render is best.
  assert.equal(bestFilmVersion(project)?.sha256, sha("v2"));
  const critique = (round: number, render: string, each: number) =>
    writeFileSync(
      path.join(project.projectDir, `pipeline/critique/round-${round}.json`),
      JSON.stringify({
        schemaVersion: 1,
        round,
        renderSha256: sha(render),
        framesReviewed: [{ path: "f.png", note: "n" }],
        scores: scores(each),
        verdict: "revise",
        actions: [],
      }),
    );
  critique(1, "v1", 4);
  critique(2, "v2", 3);
  critique(3, "v3", 5);
  writeFileSync(path.join(project.projectDir, "pipeline/critique/round-4.json"), "{ not json");
  const listed = listFilmVersions(project);
  assert.deepEqual(
    listed.map((v) => v.sha256),
    [sha("v1"), sha("v2"), sha("v3")],
  );
  assert.deepEqual(
    listed.map((v) => v.criticTotal),
    [28, 21, 35],
  );
  assert.equal(bestFilmVersion(project)?.sha256, sha("v1"));
  // A newer film-measure.json of v3 that passes lifts it to the top.
  writeFileSync(
    path.join(project.projectDir, "pipeline/film-measure.json"),
    JSON.stringify({ schemaVersion: 1, renderSha256: sha("v3"), verdict: "pass", legs: [] }),
  );
  assert.equal(bestFilmVersion(project)?.sha256, sha("v3"));
  rmSync(path.join(project.rootDir, listed[2]!.file));
  assert.equal(bestFilmVersion(project)?.sha256, sha("v1"));
  assert.equal(listFilmVersions(project)[2]!.exists, false);
  assert.ok(existsSync(path.join(project.rootDir, listed[0]!.file)));
});

test("an empty project has no versions and no best", (t) => {
  const project = workspace(t);
  assert.deepEqual(listFilmVersions(project), []);
  assert.equal(bestFilmVersion(project), undefined);
});

/** Keep seven renders r0..r6, an hour apart, oldest first; only r1 passes its measure. film.mp4 ends as r6. */
function sevenRenders(project: FilmVersionProject): string {
  const film = path.join(project.rootDir, "out/p/film.mp4");
  for (let index = 0; index < 7; index++) {
    writeFileSync(film, `r${index}`);
    snapshotFilmVersion(project, film, {
      step: "render",
      measure: index === 1 ? { verdict: "pass", failing: [] } : { verdict: "fail", failing: ["pace"] },
      now: new Date(Date.UTC(2026, 10, 16, index)),
    });
  }
  return film;
}
const keptFile = (project: FilmVersionProject, text: string) =>
  path.join(project.rootDir, `out/p/versions/${sha(text).slice(0, 16)}.mp4`);

test("prune keeps the newest N, the best, the current film and every approved, recorded or delivered render", (t) => {
  const project = workspace(t);
  const film = sevenRenders(project);
  writeFileSync(film, "r3"); // film.mp4 restored to an older render
  const pipeline = path.join(project.projectDir, "pipeline");
  mkdirSync(path.join(pipeline, "approvals"), { recursive: true });
  writeFileSync(
    path.join(pipeline, "approvals/human.json"),
    JSON.stringify({
      schemaVersion: 1,
      step: "human",
      events: [{ answer: "yes", at: "x", artefacts: { "out/p/film.mp4": sha("r0") } }],
    }),
  );
  mkdirSync(path.join(pipeline, "delivery/snapshots"), { recursive: true });
  writeFileSync(path.join(pipeline, "delivery/snapshots/s1.json"), JSON.stringify({ render: { sha256: sha("r2") } }));

  const plan = planFilmVersionPrune(project, { keep: 2 });
  const reasons = Object.fromEntries(plan.kept.map((entry) => [entry.sha256, entry.reasons]));
  assert.deepEqual(reasons[sha("r6")], ["newest"]);
  assert.deepEqual(reasons[sha("r5")], ["newest"]);
  assert.deepEqual(reasons[sha("r1")], ["best"]);
  assert.deepEqual(reasons[sha("r3")], ["current"]);
  assert.deepEqual(reasons[sha("r0")], ["approved"]);
  assert.deepEqual(reasons[sha("r2")], ["delivered"]);
  assert.deepEqual(
    plan.remove.map((entry) => entry.sha256),
    [sha("r4")],
  );
  assert.equal(plan.bytesFreed, 2);
  // A plan deletes nothing.
  assert.ok(existsSync(keptFile(project, "r4")));
  assert.equal(readFilmVersionsIndex(project).versions.length, 7);

  // A chain receipt and a render receipt protect too.
  mkdirSync(path.join(pipeline, "chain"), { recursive: true });
  writeFileSync(path.join(pipeline, "chain/render.json"), JSON.stringify({ outputs: { "out/p/film.mp4": sha("r4") } }));
  assert.deepEqual(planFilmVersionPrune(project, { keep: 2 }).remove, []);
  rmSync(path.join(pipeline, "chain"), { recursive: true });
  writeFileSync(path.join(project.rootDir, "out/p/film.mp4.receipt.json"), JSON.stringify({ outputSha256: sha("r4") }));
  assert.deepEqual(planFilmVersionPrune(project, { keep: 2 }).remove, []);
  assert.throws(() => planFilmVersionPrune(project, { keep: -1 }), /whole number/);
});

test("apply deletes the planned copies and drops only their entries, keeping a render kept after the plan", (t) => {
  const project = workspace(t);
  const film = sevenRenders(project);
  const plan = planFilmVersionPrune(project, { keep: 2 });
  assert.deepEqual(
    plan.remove.map((entry) => entry.sha256),
    [sha("r0"), sha("r2"), sha("r3"), sha("r4")],
  );
  writeFileSync(film, "r7");
  snapshotFilmVersion(project, film, { step: "render", now: new Date(Date.UTC(2026, 10, 16, 7)) });
  assert.deepEqual(applyFilmVersionPrune(project, plan).length, 4);
  for (const text of ["r0", "r2", "r3", "r4"]) assert.equal(existsSync(keptFile(project, text)), false, text);
  for (const text of ["r1", "r5", "r6", "r7"]) assert.ok(existsSync(keptFile(project, text)), text);
  assert.deepEqual(
    readFilmVersionsIndex(project).versions.map((version) => version.sha256),
    [sha("r1"), sha("r5"), sha("r6"), sha("r7")],
  );
});

test("apply refuses a file outside the versions folder and deletes nothing", (t) => {
  const project = workspace(t);
  sevenRenders(project);
  for (const file of ["out/p/film.mp4", "out/p/versions/index.json", "out/p/versions/../film.mp4"])
    assert.throws(
      () => applyFilmVersionPrune(project, { remove: [{ sha256: sha("x"), file, bytes: 1, exists: true }] }),
      /Refusing to delete/,
      file,
    );
  assert.ok(existsSync(path.join(project.rootDir, "out/p/film.mp4")));
  assert.equal(readFilmVersionsIndex(project).versions.length, 7);
});

test("film:versions lists, plans by default and deletes only with --apply, one JSON line each", (t) => {
  const project = workspace(t);
  sevenRenders(project);
  const repo = path.resolve(import.meta.dirname, "..");
  const run = (...args: string[]) => {
    const result = spawnSync(
      path.join(repo, "node_modules/.bin/tsx"),
      [path.join(repo, "scripts/film-versions.ts"), "--project", "p", ...args],
      { cwd: project.rootDir, encoding: "utf8" },
    );
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, result.stdout);
    const envelope = JSON.parse(lines[0]!);
    assert.equal(result.status, envelope.ok ? 0 : 1);
    return envelope;
  };
  const listed = run();
  assert.equal(listed.metadata.versions.length, 7);
  assert.equal(listed.metadata.best, sha("r1"));
  // Kept: r6, r5, r4 (newest three), r1 (best); r6 is also the current film.
  const planned = run("--prune", "--keep", "3");
  assert.equal(planned.metadata.dryRun, true);
  assert.equal(planned.metadata.remove.length, 3);
  assert.deepEqual(planned.outputs, []);
  assert.ok(existsSync(keptFile(project, "r0")));
  assert.equal(run("--prune", "--keep", "two").error, "INVALID_INPUT");
  const applied = run("--apply", "--keep", "3");
  assert.equal(applied.metadata.dryRun, false);
  assert.equal(applied.outputs.length, 3);
  assert.equal(existsSync(keptFile(project, "r0")), false);
  assert.equal(readFilmVersionsIndex(project).versions.length, 4);
});
