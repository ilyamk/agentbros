/**
 * The film panels' material in the console's read model (RFC 0004 G2, §5.2, WP10b): `view.film` reads the chain's real
 * artefacts (the film-chain fixtures and the creative-studio helpers), stays blind (no pool key, no lane files, no
 * author), sets `chosen` only after the user's step, drops claims about sound, degrades with an advisory on a malformed
 * file, and the final verdict is a `verdict` decision with no approve option, on the project's frozen rubric.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FilmMaterialSchema, ProjectViewSchema } from "../src/types/console";
import { scaffoldFilmProject } from "../src/lib/film/project";
import { IDEA_AXES, SCRIPT_AXES } from "../src/lib/film/creative-rubric";
import { approveStep, openFilmProject, sealStep } from "../src/lib/film/state";
import { buildPool, pickIdeas, rankLatest } from "../src/lib/film/studio";
import { buildProjectView } from "../src/lib/console/view/build";
import { readFilmMaterial } from "../src/lib/console/view/film-material";
import { projectPaths } from "../src/lib/console/view/files";
import {
  skipDiscovery,
  toConceptApproved,
  writeBoards,
  writeCategoryScan,
  writeReview,
  writeStrategy,
  writeTeams,
} from "./helpers/film-studio";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const ID = "film";
const SHA = "a".repeat(64);
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function film() {
  const root = mkdtempSync(path.join(tmpdir(), "console-film-material-"));
  roots.push(root);
  const dir = path.join(root, "public/projects", ID);
  scaffoldFilmProject(dir, ID, []);
  const pipeline = path.join(dir, "pipeline");
  const project = () => openFilmProject(dir, { rootDir: root });
  const write = (relative: string, value: unknown) => {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  };
  const place = (...files: string[]) => {
    for (const file of files) copyFileSync(path.join(FIXTURES, file), path.join(pipeline, file));
  };
  return {
    root,
    dir,
    write,
    place,
    seal: (step: string) => sealStep(project(), step),
    approve: (step: string) => approveStep(project(), step, `yes to ${step}`),
    view: () => {
      const view = buildProjectView(root, ID, { now: Date.parse("2026-11-17T12:00:00Z") });
      assert.ok(view);
      ProjectViewSchema.parse(view);
      return view;
    },
  };
}
type Film = ReturnType<typeof film>;

function toIdeasReviewed(f: Film) {
  f.place("brief.json");
  f.seal("intake");
  f.approve("intake");
  f.place("product-truth.json");
  f.seal("truth");
  f.place("film-targets.json");
  f.seal("reference");
  writeStrategy(f.dir);
  f.seal("strategy");
  f.approve("strategy");
  skipDiscovery(f.dir);
  writeTeams(f.dir, 1);
  f.seal("ideas");
  buildPool(f.dir, ID, "ideas");
  f.seal("idea-review");
  writeReview(f.dir, "ideas", 1, (index) => (index % 2 ? 4 : 5), {
    pairWinner: (first, second) => (first < second ? first : second),
  });
  rankLatest(f.dir, "ideas");
  pickIdeas(f.dir);
  writeBoards(f.dir);
  f.seal("concept");
}

const critique = (round: number, actions: string[], frames: string[]) => ({
  schemaVersion: 1,
  round,
  renderSha256: SHA,
  framesReviewed: frames.map((file, index) => ({ path: file, timeSec: index * 1.5, note: `frame ${index}` })),
  scores: Object.fromEntries(
    ["idea", "hook", "motion", "rhythm", "typography", "composition", "ending"].map((axis) => [
      axis,
      { score: Math.min(5, round + 2), note: "n", evidence: ["e"] },
    ]),
  ),
  verdict: round > 1 ? "approve-for-human" : "revise",
  actions,
});

describe("film material in the project view", () => {
  test("a fresh film carries the frozen rubric and nothing it has not written", () => {
    const f = film();
    const view = f.view();
    assert.deepEqual(view.film?.human?.rubric, {
      version: 2,
      axes: [...new Set<string>([...IDEA_AXES, ...SCRIPT_AXES])],
    });
    assert.equal(view.film?.ideas, undefined);
    assert.equal(view.film?.critic, undefined);
  });

  test("the brief and strategy: excerpts, the strategy's fields and both documents", () => {
    const f = film();
    f.place("brief.json");
    f.write("pipeline/brief.md", `# Brief\n\n${"long ".repeat(2000)}`);
    writeStrategy(f.dir);
    const brief = f.view().film?.brief;
    assert.ok(brief);
    assert.ok(brief.excerpt!.startsWith("# Brief"));
    assert.ok(brief.excerpt!.length <= 4096);
    assert.equal(brief.strategy?.proposition, "One list that empties itself as you work.");
    assert.deepEqual(brief.strategy?.forbidden, ["naming competitors"]);
    assert.equal(brief.strategy?.hook?.mechanic, "result first");
    assert.match(brief.strategyExcerpt ?? "", /^# Strategy/);
    assert.equal(brief.strategyDoc?.path, "pipeline/strategy.md");
    assert.equal(brief.strategyDoc?.kind, "document");
  });

  test("discovery: clichés, white space and the product's claims with their status", () => {
    const f = film();
    f.place("product-truth.json");
    writeCategoryScan(f.dir);
    const discovery = f.view().film?.discovery;
    assert.ok(discovery);
    assert.equal(discovery.cliches.length, 8);
    assert.equal(discovery.cliches[0]?.cliche, "CLICHE_0");
    assert.deepEqual(discovery.whiteSpace, ["WHITE_SPACE_the client's side of the chat"]);
    assert.equal(discovery.docs, undefined);
    assert.ok(discovery.claims.length > 0);
    for (const claim of discovery.claims)
      assert.ok(["working", "in-development", "horizon", "unverified"].includes(claim.status));
  });

  test("the idea pool is blind: anonymous ids, per-axis scores, pairwise, top three; chosen only after the concept", () => {
    const f = film();
    toIdeasReviewed(f);
    const ideas = f.view().film?.ideas;
    assert.ok(ideas);
    assert.equal(ideas.kind, "ideas");
    assert.ok(ideas.items.length >= 12);
    for (const item of ideas.items) {
      assert.match(item.id, /^I\d+$/);
      assert.deepEqual(Object.keys(item.scores ?? {}).sort(), [...IDEA_AXES].sort());
      assert.ok(item.text.length > 0 && item.text.length <= 2048);
    }
    const ids = ideas.items.map((item) => item.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
    );
    assert.equal(ideas.top.length, 3);
    assert.ok(ideas.pairs.length > 0);
    assert.ok(ideas.pairs.some((pair) => pair.agreed && pair.winner));
    assert.ok(ideas.against.every((entry) => ideas.top.includes(entry.id)));
    assert.equal(ideas.chosen, undefined, "nothing chosen before the user decides");
    assert.deepEqual(
      ideas.docs?.map((doc) => doc.path),
      ["pipeline/boards/boards.jpg"],
    );
    const json = JSON.stringify(ideas);
    assert.doesNotMatch(json, /ideas-key|concepts\/|"author"|sourceId/);

    f.approve("concept");
    const chosen = f.view().film?.ideas?.chosen;
    assert.ok(chosen && ideas.top.includes(chosen));
  });

  test("a later, unreviewed round shows its items without the old round's scores", () => {
    const f = film();
    const flow = { dir: f.dir, seal: f.seal, approve: f.approve };
    f.place("brief.json");
    f.seal("intake");
    f.approve("intake");
    f.place("product-truth.json");
    f.seal("truth");
    f.place("film-targets.json");
    f.seal("reference");
    toConceptApproved(flow, ID);
    // A reopened pool: round 2 written, not reviewed yet.
    const poolPath = path.join(f.dir, "pipeline/pools/ideas.json");
    f.write("pipeline/pools/ideas.json", { ...JSON.parse(readFileSync(poolPath, "utf8")), round: 2 });
    const ideas = f.view().film?.ideas;
    assert.equal(ideas?.round, 2);
    assert.ok(ideas?.items.every((item) => item.scores === undefined));
    assert.deepEqual(ideas?.top, []);
  });

  test("beats: shots, cues on the film's and the music's clock, the track and its sections", () => {
    const f = film();
    f.place("motion-plan.json", "cue-sheet.json", "audio-map.json");
    mkdirSync(path.join(f.dir, "music"), { recursive: true });
    copyFileSync(path.join(FIXTURES, "track.wav"), path.join(f.dir, "music/track.wav"));
    const beats = f.view().film?.beats;
    assert.ok(beats);
    assert.equal(beats.shots.length, 2);
    assert.equal(beats.shots[0]?.id, "hook");
    assert.deepEqual(beats.cues[0], { id: "c1", kind: "cut", frame: 150, sec: 5, trackSec: 5, snap: "beat" });
    assert.equal(beats.track?.path, "music/track.wav");
    assert.equal(beats.track?.kind, "audio");
    assert.equal(beats.sections?.length, 2);
  });

  test("narration: direction, takes with durations and caption words", () => {
    const f = film();
    f.write("pipeline/narrator-direction.json", {
      route: "local",
      voiceWhy: "calm and close",
      beats: [{ beatId: "hook", directedText: "Words [pause] matter.", emphasisWords: ["matter"] }],
    });
    f.write("voiceover/hook.mp3", "mp3");
    f.write("voiceover/hook.words.edited.json", {
      words: [
        { text: "Words", start: 0, end: 0.4, emphasis: false },
        { text: "matter", start: 0.6, end: 1, emphasis: true },
        { text: "", start: 1, end: 2 },
      ],
    });
    const before = f.view().film?.narration;
    assert.equal(before?.takes[0]?.media.path, "voiceover/hook.mp3", "the take on disk before narration:check");
    f.write("pipeline/narration.json", {
      schemaVersion: 1,
      route: "local",
      take: 1,
      direction: { file: "pipeline/narrator-direction.json", sha256: SHA },
      language: "en",
      beats: [
        {
          beatId: "hook",
          file: "voiceover/hook.mp3",
          sha256: SHA,
          durationSec: 1.2,
          receipt: "voiceover/hook.receipt.json",
          words: "voiceover/hook.words.json",
          captions: "voiceover/hook.words.edited.json",
          wordCount: 2,
          emphasisCount: 1,
          startSec: 0,
        },
      ],
      totalSec: 1.2,
    });
    const narration = f.view().film?.narration;
    assert.ok(narration);
    assert.equal(narration.voiceWhy, "calm and close");
    assert.deepEqual(narration.direction, [{ beatId: "hook", text: "Words [pause] matter.", emphasis: ["matter"] }]);
    assert.equal(narration.takes[0]?.media.durationSec, 1.2);
    assert.deepEqual(
      narration.words.map((word) => [word.text, word.emphasis ?? false]),
      [
        ["Words", false],
        ["matter", true],
      ],
    );
  });

  test("look: styleframes with the user's latest rating", () => {
    const f = film();
    f.write("pipeline/design.json", { notes: "Styleframe source" });
    f.write("pipeline/look/frame-2.png", "png");
    f.write("pipeline/look/styleframes.png", "png");
    f.write("pipeline/ratings.json", {
      v: 1,
      ratings: [
        {
          id: "r1",
          target: { path: "pipeline/look/styleframes.png" },
          kind: "styleframe",
          score: 2,
          by: "user",
          channel: "console",
          at: "2026-11-17T09:00:00Z",
        },
        {
          id: "r2",
          target: { path: "pipeline/look/styleframes.png" },
          kind: "styleframe",
          score: 5,
          by: "user",
          channel: "console",
          at: "2026-11-17T10:00:00Z",
        },
      ],
    });
    const look = f.view().film?.look;
    assert.equal(look?.design, undefined);
    assert.deepEqual(
      look?.styleframes.map((frame) => [frame.media.path, frame.rating]),
      [
        ["pipeline/look/styleframes.png", 5],
        ["pipeline/look/frame-2.png", undefined],
      ],
    );
  });

  test("critic rounds: scores, ranked fixes without sound claims, frames and the round's sheet", () => {
    const f = film();
    f.write("pipeline/critic-pack/round-1/frames/a.jpg", "jpg");
    f.write("pipeline/critic-pack/round-1/phone-sheet.jpg", "jpg");
    f.write("pipeline/critic-pack/round-2/frames/a.jpg", "jpg");
    const actions = ["Tighten the hook", "The mix sounds great", ...Array.from({ length: 8 }, (_, i) => `fix ${i}`)];
    f.write("pipeline/critique/round-1.json", critique(1, actions, ["pipeline/critic-pack/round-1/frames/a.jpg"]));
    f.write(
      "pipeline/critique/round-2.json",
      critique(2, [], [`public/projects/${ID}/pipeline/critic-pack/round-2/frames/a.jpg`, "missing/frame.jpg"]),
    );
    f.write(
      "pipeline/critique/look-round-1.json",
      critique(1, ["warmer palette"], ["pipeline/critic-pack/round-1/frames/a.jpg"]),
    );
    const rounds = f.view().film?.critic?.rounds ?? [];
    assert.deepEqual(
      rounds.map((round) => [round.step, round.round, round.verdict]),
      [
        ["look", 1, "revise"],
        ["critic", 1, "revise"],
        ["critic", 2, "approve-for-human"],
      ],
    );
    const first = rounds[1]!;
    assert.equal(first.total, 21);
    assert.equal(first.fixes.length, 7);
    assert.equal(first.fixes[0], "Tighten the hook");
    assert.ok(!first.fixes.some((fix) => /sounds great/.test(fix)));
    assert.equal(first.sheet?.path, "pipeline/critic-pack/round-1/phone-sheet.jpg");
    assert.deepEqual(
      rounds[2]!.frames.map((frame) => frame.media.path),
      ["pipeline/critic-pack/round-2/frames/a.jpg"],
    );
  });

  test("a malformed artefact drops only its section, with an advisory; the view still parses", () => {
    const f = film();
    writeStrategy(f.dir);
    f.write("pipeline/category-scan.json", "{ not json");
    f.write("pipeline/critique/round-1.json", { schemaVersion: 1, round: "one" });
    const view = f.view();
    assert.ok(view.film?.brief?.strategy);
    assert.equal(view.film?.discovery, undefined);
    assert.equal(view.film?.critic, undefined);
    assert.ok(view.advisories.some((line) => line.includes("category-scan.json")));
    assert.ok(view.advisories.some((line) => line.includes("round-1.json")));
  });

  test("the reader never throws and every section it returns validates", () => {
    const f = film();
    toIdeasReviewed(f);
    // §4.4: the material is a small share of a view's budget (measured, warn only: the CPU is shared in CI).
    const timed = (work: () => unknown) => {
      const started = performance.now();
      work();
      return performance.now() - started;
    };
    const view = timed(() => f.view());
    const cold = timed(() => readFilmMaterial(projectPaths(f.root, ID), new Map(), []));
    const warm = timed(() => readFilmMaterial(projectPaths(f.root, ID), new Map(), []));
    process.stderr.write(
      `view ${view.toFixed(1)} ms; film material ${cold.toFixed(1)} ms, again ${warm.toFixed(1)} ms\n`,
    );
    const advisories: string[] = [];
    const material = readFilmMaterial(projectPaths(f.root, ID), new Map(), advisories);
    FilmMaterialSchema.parse(material);
    const missing = readFilmMaterial(projectPaths(f.root, "nothing-here"), new Map(), advisories);
    assert.deepEqual(Object.keys(missing ?? {}), ["human"]);
  });
});

describe("the final verdict decision", () => {
  test("verdict kind, no approve option, the rubric axes in its summary", async () => {
    const { filmWaiting, readFilm } = await import("../src/lib/console/view/film");
    const f = film();
    toIdeasReviewed(f);
    const read = readFilm(projectPaths(f.root, ID));
    const human = read.chain.steps.find((step) => step.id === "human");
    assert.ok(human);
    // Force the human step's question: the projector asks only when nextAction does; here we check the builder directly.
    const fake = {
      ...read,
      next: { ...read.next, action: "ask", step: "human", thenRun: ["pnpm film:approve --project film --step human"] },
    } as typeof read;
    const found = filmWaiting(fake, projectPaths(f.root, ID), { reservedUsd: 0, spentUsd: 0, maxAdmissibleUsd: null });
    const decision = found.decisions[0];
    assert.equal(decision?.kind, "verdict");
    // No approve or accept option: only asking for changes (WP3) stays on the card.
    assert.deepEqual(
      (decision?.options ?? []).map((option) => option.id),
      ["changes"],
    );
    for (const axis of IDEA_AXES) assert.ok(decision?.summary?.includes(axis), axis);
  });
});
