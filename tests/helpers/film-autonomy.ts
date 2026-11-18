/** A film project in a temporary root, driven step by step, for the autonomy and guard tests. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { approveStep, deriveChain, openFilmProject, sealStep, type FilmProject } from "../../src/lib/film/state";
import { toConceptApproved, toScriptPicked } from "./film-studio";

export const REPO = path.resolve(import.meta.dirname, "../..");
export const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
export const ID = "film";

export function cli(root: string, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], { cwd: root, encoding: "utf8" });
  const line = result.stdout.trim().split("\n").at(-1) ?? "{}";
  return {
    status: result.status,
    stderr: result.stderr,
    json: JSON.parse(line) as { ok: boolean; error?: string; message?: string; metadata: Record<string, any> },
  };
}

export const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export function setup(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "film-autonomy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = cli(root, "scripts/film-init.ts", "--project", ID);
  assert.equal(init.status, 0, JSON.stringify(init.json));
  const dir = path.join(root, "public/projects", ID);
  const pipeline = path.join(dir, "pipeline");
  const project = (): FilmProject => openFilmProject(dir, { rootDir: root });
  const place = (...files: string[]) => {
    for (const file of files) copyFileSync(path.join(FIXTURES, file), path.join(pipeline, file));
  };
  const blob = (relative: string, content: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const edit = (file: string, change: (json: Record<string, any>) => void) => {
    const target = path.join(pipeline, file);
    const json = JSON.parse(readFileSync(target, "utf8")) as Record<string, any>;
    change(json);
    writeFileSync(target, JSON.stringify(json));
  };
  const status = (id: string) => deriveChain(project()).steps.find((step) => step.id === id)!.status;
  const seal = (id: string) => sealStep(project(), id);
  const approve = (id: string) => approveStep(project(), id, `yes to ${id}`);
  return { root, dir, pipeline, project, place, blob, edit, status, seal, approve };
}
export type Film = ReturnType<typeof setup>;

export function toIntakeApproved(film: Film) {
  film.place("brief.json");
  film.seal("intake");
  film.approve("intake");
  film.place("product-truth.json");
  film.seal("truth");
  film.place("film-targets.json");
  film.seal("reference");
}

export function toMusicShortlist(film: Film) {
  toIntakeApproved(film);
  toConceptApproved(film, ID);
  mkdirSync(path.join(film.dir, "music"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "track.wav"), path.join(film.dir, "music/track.wav"));
  film.place("music-shortlist.json");
}

export function toMusicApproved(film: Film) {
  toMusicShortlist(film);
  film.place("music-decision.json");
  film.seal("music");
  film.approve("music");
}

export const critique = (round: number, renderSha256: string, verdict: string, score = 3) => {
  const entry = { score, note: "AUTHOR-FREE", evidence: ["frame 10"] };
  return {
    schemaVersion: 1,
    round,
    renderSha256,
    framesReviewed: [{ path: "frame.png", note: "seen" }],
    scores: {
      idea: entry,
      hook: entry,
      motion: entry,
      rhythm: entry,
      typography: entry,
      composition: entry,
      ending: entry,
    },
    verdict,
    actions: verdict === "revise" ? ["Hold the first frame longer"] : [],
  };
};

export const writeCritique = (film: Film, name: string, value: unknown) => {
  mkdirSync(path.join(film.pipeline, "critique"), { recursive: true });
  writeFileSync(path.join(film.pipeline, "critique", name), JSON.stringify(value));
};

export function toMeasured(film: Film, renderText = "render-1") {
  toMusicApproved(film);
  film.place("audio-map.json");
  film.seal("audio-map");
  toScriptPicked(film, ID);
  film.seal("script");
  film.approve("script");
  film.place("design.json");
  film.blob(path.join(path.relative(film.root, film.pipeline), "look/styleframes.png"), "frames");
  film.seal("look");
  writeCritique(film, "look-round-1.json", critique(1, sha("frames"), "approve-for-human"));
  film.place("motion-plan.json", "cue-sheet.json", "plan-check.json");
  film.seal("beat-sheet");
  film.blob(`out/${ID}/animatic.mp4`, "animatic");
  film.seal("animatic");
  film.approve("animatic");
  film.place("build.json", "motion-check.json");
  film.seal("build");
  film.place("mix-plan.json", "mix-report.json");
  film.blob(path.join(path.relative(film.root, film.dir), "audio/master.wav"), "master");
  film.seal("sound");
  film.blob(`out/${ID}/film.mp4`, renderText);
  writeFileSync(
    path.join(film.pipeline, "film-measure.json"),
    JSON.stringify({ schemaVersion: 1, renderSha256: sha(renderText), verdict: "pass", legs: [] }),
  );
  film.seal("measure");
}
