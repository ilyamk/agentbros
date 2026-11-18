/**
 * A real film project (film:init, then the chain's own seal and approve) brought to its paid gates, for the console's
 * quote and metrics tests: an explainer at its narration gate on the paid ElevenLabs route, or past narration at its
 * material gate with one generated item. Temporary root (realpath'd for the console server), removed after the test.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { approveStep, deriveChain, openFilmProject, sealStep, skipStep } from "../../src/lib/film/state";
import { NarrationDirectionSchema } from "../../src/types/narration";
import { ScriptSchema } from "../../src/types/pipeline";
import { toConceptApproved, toScriptPicked } from "./film-studio";

export const REPO = path.resolve(import.meta.dirname, "../..");
export const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
export const FILM = "film";
/** The console's CLIs journal (the decision's own run); the server, hooks and notifications stay off. */
export const ON = { ...process.env, AGENTBROS_EVENTS: "on", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" };

export function filmProject(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-console-film-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/film-init.ts"), "--project", FILM], {
    cwd: root,
    encoding: "utf8",
    env: ON,
  });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const dir = path.join(root, "public/projects", FILM);
  const pipeline = path.join(dir, "pipeline");
  const project = () => openFilmProject(dir, { rootDir: root });
  const film = {
    root,
    dir,
    pipeline,
    project,
    place: (...files: string[]) =>
      files.forEach((file) => copyFileSync(path.join(FIXTURES, file), path.join(pipeline, file))),
    edit: (file: string, change: (json: Record<string, any>) => void) => {
      const target = path.join(pipeline, file);
      const json = JSON.parse(readFileSync(target, "utf8")) as Record<string, any>;
      change(json);
      writeFileSync(target, JSON.stringify(json));
    },
    write: (file: string, value: unknown) => writeFileSync(path.join(pipeline, file), JSON.stringify(value, null, 2)),
    seal: (id: string) => sealStep(project(), id),
    approve: (id: string) => approveStep(project(), id, `yes to ${id}`),
    status: (id: string) => deriveChain(project()).steps.find((step) => step.id === id)!,
  };
  return film;
}
export type ConsoleFilm = ReturnType<typeof filmProject>;

/** The paid narration direction for the fixture script: every spoken beat directed, `maxCostUsd` per take. */
export function narrationDirection(film: ConsoleFilm, maxCostUsd: number, take = 1) {
  const script = ScriptSchema.parse(JSON.parse(readFileSync(path.join(film.pipeline, "script.json"), "utf8")));
  return NarrationDirectionSchema.parse({
    route: "elevenlabs",
    voiceWhy: "A calm teacher for a curious audience.",
    modelId: "eleven_v4",
    maxCostUsd,
    take,
    beats: script.beats.map((beat) => ({ beatId: beat.id, directedText: beat.text, emphasisWords: [] })),
  });
}

/** A voiced film (explainer by default) from intake to its approved script (the chain's own steps, fixture files). */
export function toScriptApproved(film: ConsoleFilm, filmType: "explainer" | "ai-video" = "explainer") {
  film.place("brief.json");
  film.edit("brief.json", (brief) => {
    brief["filmType"] = filmType;
  });
  film.seal("intake");
  film.approve("intake");
  film.place("product-truth.json");
  film.seal("truth");
  film.place("film-targets.json");
  film.seal("reference");
  toConceptApproved(film, FILM);
  mkdirSync(path.join(film.dir, "music"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "track.wav"), path.join(film.dir, "music/track.wav"));
  film.place("music-shortlist.json", "music-decision.json");
  film.seal("music");
  film.approve("music");
  film.place("audio-map.json");
  film.seal("audio-map");
  toScriptPicked(film, FILM);
  film.seal("script");
  film.approve("script");
}

/** The narration gate on the paid route: the direction written and sealed, waiting for the user's yes and its cost. */
export function toNarrationGate(film: ConsoleFilm, maxCostUsd = 0.25) {
  toScriptApproved(film);
  film.write("narrator-direction.json", narrationDirection(film, maxCostUsd));
  film.seal("narration");
  assert.equal(film.status("narration").status, "awaiting-gate");
}

/** One generated item waiting for the user's yes: the material quote. */
export const generatedItem = (maxCostUsd: number) => ({
  id: "hero-shot",
  shots: ["hook"],
  what: "the opening shot of the product",
  kind: "generated-video",
  route: "generated",
  status: "pending",
  provenance: "fal fal-ai/kling-video/v2",
  licence: "provider terms",
  maxCostUsd,
  referencePlan: { mode: "none", reason: "An abstract opening: no character, product or location to hold." },
});

/** An AI video's material gate: narration skipped with its reason, material.json with one paid item, sealed. */
export function toMaterialGate(film: ConsoleFilm, maxCostUsd = 1.5) {
  toScriptApproved(film, "ai-video");
  skipStep(film.project(), "narration", "The user records the voice later.");
  film.write("material.json", { schemaVersion: 1, filmType: "ai-video", items: [generatedItem(maxCostUsd)] });
  film.seal("material");
  assert.equal(film.status("material").status, "awaiting-gate", JSON.stringify(film.status("material").reasons));
}
