import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCorpus, distribution, flowStills, textAppearances } from "../src/lib/reference/corpus";
import { targetsFromCorpus } from "../src/lib/film/targets";
import { readLayer } from "../src/lib/reference/library";
import { FilmTargetsSchema } from "../src/types/film";
import { ReferenceCorpusSchema, ReferenceTechniquesSchema, typographyEntries } from "../src/types/reference";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");
const library = path.join(repo, "tests/fixtures/reference-corpus");

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "corpus-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [tsx, path.join(repo, "scripts", script), ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return {
    status: result.status,
    json: JSON.parse(line) as { ok: boolean; outputs?: string[]; metadata?: Record<string, unknown>; error?: string },
  };
}

test("distribution gives n, extremes and percentiles", () => {
  assert.deepEqual(distribution([1, 2, 3, 4, 5]), {
    n: 5,
    min: 1,
    p10: 1.4,
    p25: 2,
    median: 3,
    p75: 4,
    p90: 4.6,
    max: 5,
  });
  assert.equal(distribution([]), undefined);
});

test("the corpus reads every reference, skips inbox and _ directories, and builds distributions", () => {
  const corpus = buildCorpus({ libraryRoot: library });
  assert.deepEqual(corpus.referenceIds, ["alpha", "beta", "gamma"]);
  ReferenceCorpusSchema.parse(corpus);
  // alpha: judged cuts (a merge removes 25 s) give 4 cuts in 30 s; beta 4 in 20 s; gamma the detector's 2 in 12 s.
  const byId = Object.fromEntries(corpus.references.map((row) => [row.id, row]));
  assert.equal(byId.alpha!.metrics.cutsPerMinute, 8);
  assert.equal(byId.alpha!.cutsFrom, "judged");
  assert.equal(byId.gamma!.cutsFrom, "detector");
  assert.deepEqual(corpus.metrics.cutsPerMinute, {
    n: 3,
    min: 8,
    p10: 8.4,
    p25: 9,
    median: 10,
    p75: 11,
    p90: 11.6,
    max: 12,
  });
  assert.equal(corpus.metrics.medianShotSec!.median, 2);
  assert.equal(corpus.metrics.shotLengthVariety!.n, 2, "gamma has too few shots for a variety");
  assert.equal(byId.alpha!.metrics.shotLengthVariety, 1.6);
  assert.equal(corpus.metrics.integratedLufs!.n, 2);
  assert.equal(byId.alpha!.metrics.cutsOnBeatRatio, 1);
  assert.equal(byId.alpha!.metrics.onsetsPerCut, 1.25);
  assert.equal(byId.beta!.metrics.onsetsPerCut, 0.25);
  // Screen text: "Hello" merged across three samples and centred; "World" left; "x" and low-confidence noise dropped.
  assert.equal(byId.alpha!.metrics.screenTextDwellSec, 1);
  assert.equal(byId.alpha!.metrics.centredTextShare, 0.5);
  assert.equal(byId.alpha!.metrics.flowStillShare, 0.067);
  assert.equal(byId.alpha!.metrics.flowLongestStillSec, 2);
  assert.deepEqual(corpus.easeNames, { "power2.out": 1 });
  assert.deepEqual(corpus.easeFamilies?.motion, { "out:2": 1 }, "fits are also counted by family");
  assert.deepEqual(corpus.excludedEaseFits, []);
});

test("techniques are indexed by function, old files land in unclassified", () => {
  const corpus = buildCorpus({ libraryRoot: library });
  assert.equal(corpus.techniques.count, 3);
  assert.deepEqual(
    corpus.techniques.byFunction.hook!.map((row) => `${row.refId}/${row.techniqueId}`),
    ["alpha/t1"],
  );
  assert.equal(corpus.techniques.byFunction.hook![0]!.ease?.name, "power2.out");
  assert.equal(corpus.techniques.byFunction.hook![0]!.timing?.onBeat, true);
  assert.equal(corpus.techniques.byFunction.hook![0]!.sound?.kind, "sfx");
  assert.deepEqual(
    corpus.techniques.byFunction.transition!.map((row) => row.techniqueId),
    ["t2"],
  );
  assert.deepEqual(
    corpus.techniques.byFunction.unclassified!.map((row) => `${row.refId}/${row.techniqueId}`),
    ["beta/whip"],
  );
  assert.deepEqual(corpus.techniques.byFunction.cta, []);
});

test("an old techniques.json still validates, and the new typed fields are checked", () => {
  const old = readLayer(path.join(library, "beta"), "techniques.json");
  assert.equal(old?.techniques[0]?.function, undefined);
  const typed = readLayer(path.join(library, "alpha"), "techniques.json");
  assert.equal(typographyEntries(typed?.techniques[0]?.typography)[0]?.alignment, "centre");
  assert.equal(typed?.techniques[1]?.toShot, 1);
  const bad = { schemaVersion: 1, referenceId: "x", techniques: [{ ...typed!.techniques[0]!, function: "climax" }] };
  assert.equal(ReferenceTechniquesSchema.safeParse(bad).success, false);
  const badEase = {
    schemaVersion: 1,
    referenceId: "x",
    techniques: [{ ...typed!.techniques[0]!, ease: { name: "linear" } }],
  };
  assert.equal(ReferenceTechniquesSchema.safeParse(badEase).success, false, "an ease must say where it came from");
});

test("the gap list counts missing primitives, named signature moves and technique names by reference", () => {
  const { gaps } = buildCorpus({ libraryRoot: library });
  assert.deepEqual(gaps.missingPrimitives[0], { name: "foo-bar", count: 2, refs: ["alpha", "beta"] });
  assert.deepEqual(gaps.signatureMoves, [{ name: "whip-to-ui", count: 2, refs: ["alpha", "beta"] }]);
  assert.equal(gaps.unnamedSignatureMoves, 1);
  assert.deepEqual(gaps.techniqueNames, [{ name: "whip to ui", count: 2, refs: ["alpha", "beta"] }]);
});

test("a missing or invalid layer is reported, never fatal", () => {
  const corpus = buildCorpus({ libraryRoot: library });
  const gamma = corpus.references.find((row) => row.id === "gamma")!;
  assert.deepEqual(
    gamma.invalid.map((row) => row.file),
    ["audio.json"],
  );
  assert.ok(gamma.missing.includes("motion.json") && gamma.missing.includes("techniques.json"));
  assert.ok(gamma.present.includes("shots.json"));
  assert.equal(gamma.metrics.integratedLufs, undefined);
  assert.ok(corpus.warnings.some((warning) => warning.startsWith("gamma/audio.json is invalid")));
});

test("--exclude and --playbook narrow the corpus; an unused playbook is an error", () => {
  assert.deepEqual(buildCorpus({ libraryRoot: library, exclude: ["beta"] }).referenceIds, ["alpha", "gamma"]);
  assert.deepEqual(buildCorpus({ libraryRoot: library, playbook: "product-promo" }).referenceIds, ["alpha", "gamma"]);
  assert.deepEqual(buildCorpus({ libraryRoot: library, playbook: "explainer" }).referenceIds, ["gamma"]);
  assert.throws(
    () => buildCorpus({ libraryRoot: library, playbook: "localise" }),
    /No reference .* tagged for playbook localise/,
  );
});

test("text appearances merge touching samples of the same text; flow stills need a flow layer", () => {
  const rows = textAppearances([
    { startSec: 0, endSec: 0.5, text: "Go now" },
    { startSec: 0.5, endSec: 1, text: "go  now." },
    { startSec: 2, endSec: 2.5, text: "Go now" },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.startSec, row.endSec]),
    [
      [0, 1],
      [2, 2.5],
    ],
  );
  assert.equal(
    flowStills(
      {
        schemaVersion: 1,
        referenceId: "x",
        method: "ffmpeg frame difference",
        shots: [],
        energyCurve: [
          { timeSec: 0, energy: 0 },
          { timeSec: 1, energy: 0 },
        ],
      },
      2,
    ),
    undefined,
  );
});

test("targets from the corpus gate at p10 and p90 widened, keep the middle half as the aim, and record their references", () => {
  const { targets, warnings } = targetsFromCorpus(buildCorpus({ libraryRoot: library }));
  FilmTargetsSchema.parse(targets);
  assert.equal(targets.source, "corpus");
  assert.deepEqual(targets.corpus?.referenceIds, ["alpha", "beta", "gamma"]);
  // p10 8.4 / 1.5 and p90 11.6 x 1.5; median shot p90 4.4 x 1.5 (CORPUS_PACE_SLACK).
  assert.deepEqual(targets.cutsPerMinute, { min: 5.6, max: 17.4 });
  assert.deepEqual(
    targets.medianShotSec,
    { min: 0.1, max: 6.6 },
    "the low side never asks for slower than three frames",
  );
  assert.deepEqual([targets.measuredFrom.corpusCutsPerMinuteP25, targets.measuredFrom.corpusCutsPerMinuteP75], [9, 11]);
  assert.deepEqual(
    [targets.measuredFrom.corpusMedianShotSecP25, targets.measuredFrom.corpusMedianShotSecP75],
    [1.5, 3.5],
  );
  // Variety p10 1.84 x 0.75 sits under the uniform floor 1.5, so the floor holds.
  assert.deepEqual(targets.shotLengthVariety, { min: 1.5 });
  assert.equal(targets.measuredFrom.corpusCutsPerMinuteMedian, 10);
  assert.equal(targets.measuredFrom.corpusReferences, 3);
  assert.equal(targets.audioRequired, true);
  // p10 -15.8 less 2 LU, and the always-acceptable -11 above p90 -14.2 plus 2.
  assert.deepEqual(targets.loudnessLufs, { min: -17.8, max: -11 });
  assert.deepEqual(targets.stillShare, {});
  assert.deepEqual(targets.longestStillSec, {});
  assert.equal(targets.climax, undefined);
  assert.ok(warnings.some((warning) => /no still-share/.test(warning)));
  const few = targetsFromCorpus(buildCorpus({ libraryRoot: library, exclude: ["beta", "gamma"] }));
  assert.ok(few.warnings.some((warning) => /Only 1 reference/.test(warning)));
});

test("ref:add --playbooks with only --id tags an existing reference, keeping its tags", (t) => {
  const root = workspace(t);
  cpSync(path.join(library, "gamma"), path.join(root, "gamma"), { recursive: true });
  const result = run("ref-add.ts", [
    "--id",
    "gamma",
    "--playbooks",
    "teaser-trailer,explainer",
    "--library-root",
    root,
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  const source = JSON.parse(readFileSync(path.join(root, "gamma/source.json"), "utf8")) as { playbooks: string[] };
  assert.deepEqual(source.playbooks, ["explainer", "product-promo", "teaser-trailer"]);
  assert.equal(
    run("ref-add.ts", ["--id", "nobody", "--playbooks", "explainer", "--library-root", root]).json.error,
    "FILE_NOT_FOUND",
  );
});

test("ref:corpus and film:targets --corpus print one JSON line and write their files", (t) => {
  const root = workspace(t);
  const corpusFile = path.join(root, "corpus.json");
  const corpus = run("ref-corpus.ts", ["--library-root", library, "--output", corpusFile, "--exclude", "gamma"]);
  assert.equal(corpus.status, 0, JSON.stringify(corpus.json));
  assert.deepEqual(corpus.json.outputs, [corpusFile]);
  assert.equal(corpus.json.metadata?.references, 2);
  assert.deepEqual(ReferenceCorpusSchema.parse(JSON.parse(readFileSync(corpusFile, "utf8"))).referenceIds, [
    "alpha",
    "beta",
  ]);

  const targetsFile = path.join(root, "targets.json");
  const targets = run("film-targets.ts", [
    "--corpus",
    "--library-root",
    library,
    "--playbook",
    "product-promo",
    "--output",
    targetsFile,
  ]);
  assert.equal(targets.status, 0, JSON.stringify(targets.json));
  const written = FilmTargetsSchema.parse(JSON.parse(readFileSync(targetsFile, "utf8")));
  assert.equal(written.source, "corpus");
  assert.deepEqual(written.corpus, { referenceIds: ["alpha", "gamma"], playbook: "product-promo" });

  const mixed = run("film-targets.ts", [
    "--corpus",
    "--reference",
    "alpha",
    "--library-root",
    library,
    "--output",
    targetsFile,
  ]);
  assert.equal(mixed.status, 1);
  assert.equal(mixed.json.error, "INVALID_INPUT");
  const unused = run("ref-corpus.ts", ["--library-root", library, "--playbook", "localise", "--output", corpusFile]);
  assert.equal(unused.json.error, "INVALID_INPUT");
});
