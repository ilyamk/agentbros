import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assignLabels,
  bandDistance,
  corpusDistance,
  hashFile,
  heroTournamentProblems,
  judgeTournament,
  measureShot,
  motionCheckSensor,
  nearestTechnique,
  noteTournamentDecision,
  packetContent,
  parseVariants,
  prepareTournament,
  requiredPackets,
  tournamentFile,
  tournamentSeed,
  withTechniques,
  writePackets,
  type MeasuredVariant,
} from "../src/lib/film/tournament";
import { loadMemory } from "../src/lib/memory";
import { MotionPlanSchema, type MotionPlan } from "../src/types/creative";
import { ReferenceCorpusSchema, type ReferenceCorpus } from "../src/types/reference";
import type { ShotTournament, TournamentResults } from "../src/types/tournament";
import type { FilmEvidence } from "../src/lib/film/evidence";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const AT = "2026-11-15T10:00:00.000Z";
const sha = (char: string) => char.repeat(64);

const shot = (id: string, startFrame: number, durationFrames: number, extra: Record<string, unknown> = {}) => ({
  id,
  startFrame,
  durationFrames,
  intent: "i",
  subject: "s",
  framing: "f",
  camera: "push in",
  composition: "c",
  entrance: "e",
  exit: "e",
  curve: "expoOut",
  route: "remotion",
  ...extra,
});
const PLAN: MotionPlan = MotionPlanSchema.parse({
  schemaVersion: 1,
  projectId: "film",
  fps: 30,
  shots: [
    shot("open", 0, 30),
    shot("reveal", 30, 45, { function: "reveal", weight: "hero", blocks: ["mask-reveal"] }),
    shot("end", 75, 30),
  ],
});

/** Reveal techniques of 1.0, 1.4, 1.6 and 2.0 s, cut offsets 0.0-0.2 s. */
const CORPUS: ReferenceCorpus = ReferenceCorpusSchema.parse({
  schemaVersion: 1,
  libraryRoot: "lib",
  referenceIds: ["alpha", "beta"],
  definitions: {},
  metrics: {},
  easeNames: {},
  techniques: {
    count: 5,
    byFunction: {
      reveal: [
        {
          refId: "alpha",
          techniqueId: "t1",
          name: "Mask wipe reveal",
          spans: [{ startSec: 2, endSec: 3 }],
          route: "remotion",
          difficulty: "low",
          timing: { durationSec: 1, startOffsetFromCutSec: 0 },
        },
        {
          refId: "alpha",
          techniqueId: "t2",
          name: "Scale punch",
          spans: [{ startSec: 5, endSec: 6.4 }],
          route: "remotion",
          difficulty: "low",
          timing: { durationSec: 1.4, startOffsetFromCutSec: 0.1 },
        },
        {
          refId: "beta",
          techniqueId: "t3",
          name: "Shutter reveal",
          spans: [{ startSec: 1, endSec: 2.6 }],
          route: "remotion",
          difficulty: "medium",
          timing: { durationSec: 1.6, startOffsetFromCutSec: 0.2 },
        },
        {
          refId: "beta",
          techniqueId: "t4",
          name: "Slow push reveal",
          spans: [{ startSec: 8, endSec: 10 }],
          route: "remotion",
          difficulty: "low",
          timing: { durationSec: 2, startOffsetFromCutSec: 0.1 },
        },
      ],
      hook: [
        {
          refId: "beta",
          techniqueId: "h1",
          name: "Cold open",
          spans: [{ startSec: 0, endSec: 1.5 }],
          route: "remotion",
          difficulty: "low",
        },
      ],
    },
  },
  gaps: { missingPrimitives: [], signatureMoves: [], unnamedSignatureMoves: 0, techniqueNames: [] },
  references: [],
});

const pass = (id: string, value = 0) => ({ id, status: "pass" as const, value, message: `${id} ok` });
const fail = (id: string, value = 1) => ({ id, status: "fail" as const, value, message: `${id} failed` });

function variant(
  composition: string,
  hash: string,
  options: { failed?: boolean; durationSec?: number; cutOffsetSec?: number; technique?: string } = {},
): MeasuredVariant {
  return {
    composition,
    ...(options.technique ? { technique: options.technique } : {}),
    render: `out/film/tournament/reveal/${composition}.mp4`,
    renderSha256: sha(hash),
    sensors: [
      pass("motion:check"),
      options.failed ? fail("motion-spread", 0.8) : pass("motion-spread", 0.1),
      pass("fast-motion-sharp", 0.2),
    ],
    measured: {
      durationSec: options.durationSec ?? 1.5,
      cutOffsetSec: options.cutOffsetSec ?? 0.1,
      motionSpreadShare: 0.1,
    },
  };
}

const prepare = (variants: MeasuredVariant[], corpus: ReferenceCorpus | undefined = CORPUS) =>
  prepareTournament({
    projectId: "film",
    plan: PLAN,
    shotId: "reveal",
    variants,
    ...(corpus ? { corpus } : {}),
    packetDir: "out/film/tournament/reveal",
    at: AT,
  });

const label = (record: ShotTournament, composition: string) =>
  record.variants.find((item) => item.composition === composition)!.label;

/** Judgements in both orders where `prefer` wins every pair it is in; otherwise the alphabetically first label wins. */
function results(
  record: ShotTournament,
  decide: (first: string, second: string, pairId: string) => string,
): TournamentResults {
  return {
    schemaVersion: 1,
    shotId: record.shotId,
    seed: record.seed,
    judgements: record.packets.map((packet) => ({
      pairId: packet.pairId,
      order: packet.order,
      winner: decide(packet.first, packet.second, packet.pairId),
      reason: "reads better against the reference row",
    })),
  };
}

// --- Labels and packets ---

test("packets are deterministic: the same variants in any order get the same seed, labels and packets", () => {
  const variants = [variant("FilmA", "a"), variant("FilmB", "b"), variant("FilmC", "c")];
  const first = prepare(variants);
  const again = prepare(variants);
  const shuffled = prepare([variants[2]!, variants[0]!, variants[1]!]);
  assert.deepEqual(again, first);
  assert.equal(shuffled.seed, first.seed);
  for (const composition of ["FilmA", "FilmB", "FilmC"])
    assert.equal(label(shuffled, composition), label(first, composition));
  assert.deepEqual(shuffled.packets, first.packets);
  assert.deepEqual([...first.variants.map((item) => item.label)].sort(), ["A", "B", "C"]);
  assert.match(first.seed, /^[a-f0-9]{16}$/);
  assert.equal(first.seed, tournamentSeed("film", "reveal", variants));
  const other = prepare([variant("FilmA", "a"), variant("FilmB", "b"), variant("FilmC", "d")]);
  assert.notEqual(other.seed, first.seed, "a different render is a different tournament");
});

test("labels follow the seed, not the order the variants were named in", () => {
  const variants = [variant("X", "1"), variant("Y", "2")];
  const seed = tournamentSeed("p", "s", variants);
  assert.deepEqual(assignLabels(seed, variants), assignLabels(seed, variants));
  assert.deepEqual(assignLabels(seed, [...variants].reverse()), [...assignLabels(seed, variants)].reverse());
});

test("every pair is packed in both orders, and a packet names labels only", (t: TestContext) => {
  assert.deepEqual(
    requiredPackets(["B", "A", "C"]).map(
      (packet) => `${packet.pairId}-${packet.order}:${packet.first}${packet.second}`,
    ),
    ["AB-ab:AB", "AB-ba:BA", "AC-ab:AC", "AC-ba:CA", "BC-ab:BC", "BC-ba:CB"],
  );
  const record = prepare([variant("SecretProductHeroA", "a"), variant("SecretProductHeroB", "b")]);
  assert.equal(record.packets.length, 2);
  const contents = record.packets.map((packet) => packetContent(record, packet));
  for (const content of contents)
    for (const side of [content.first, content.second])
      assert.match(side.clip, /\.mp4$/, "every side has something to watch");
  const content = JSON.stringify(contents);
  assert.doesNotMatch(content, /SecretProduct/);
  assert.match(content, /"seed"/);
  const root = mkdtempSync(path.join(tmpdir(), "tournament-packets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const written = writePackets(record, root);
  assert.equal(written.length, 2);
  for (const file of written) {
    assert.match(path.basename(file), /^packet-AB-(ab|ba)\.json$/);
    assert.doesNotMatch(readFileSync(file, "utf8"), /SecretProduct/);
  }
});

test("a variant's motion:check row names the failing codes and counts, and the findings an --allow rule took out", () => {
  const failed = motionCheckSensor({
    failing: true,
    counters: { textOffStage: 2, fadedFinal: 1, textOverlap: 0, loopSeam: null },
    allowed: [{ code: "TEXT_OUTSIDE_SAFE_ZONE", matched: 3 }],
  });
  assert.deepEqual([failed.ok, failed.problems], [false, 3]);
  assert.equal(failed.message, "motion:check failed: textOffStage 2, fadedFinal 1; 3 finding(s) allowed by --allow");
  const passed = motionCheckSensor({ failing: false, counters: {}, allowed: [{ code: "TEXT_OFF_STAGE", matched: 4 }] });
  assert.deepEqual(passed, { ok: true, problems: 0, message: "motion:check passed; 4 finding(s) allowed by --allow" });
  const script = readFileSync(path.join(import.meta.dirname, "../scripts/shot-tournament.ts"), "utf8");
  assert.match(
    script,
    /allow: parseAllow\(args\.allow\)|const allow = parseAllow\(args\.allow\)/,
    "--allow is parsed as motion:check parses it",
  );
  assert.doesNotMatch(script, /allow: \[\]/, "no hard-coded empty allow list");
});

test("parseVariants takes 2-3 compositions, optional props, and refuses repeats; --techniques names each", () => {
  assert.deepEqual(parseVariants("A, B:props/b.json"), [
    { composition: "A" },
    { composition: "B", propsFile: "props/b.json" },
  ]);
  assert.throws(() => parseVariants("A"), /2 or 3/);
  assert.throws(() => parseVariants("A,B,C,D"), /2 or 3/);
  assert.throws(() => parseVariants("A,A"), /twice/);
  assert.deepEqual(
    withTechniques(parseVariants("A,B"), "mask-reveal, scale-punch").map((item) => item.technique),
    ["mask-reveal", "scale-punch"],
  );
  assert.throws(() => withTechniques(parseVariants("A,B"), "only-one"), /one technique per variant/);
});

// --- Sensors ---

test("a variant that fails a sensor is excluded: no packet, and the sole survivor wins without a critic", () => {
  const record = prepare([variant("FilmA", "a", { failed: true }), variant("FilmB", "b")]);
  const failed = record.variants.find((item) => item.composition === "FilmA")!;
  assert.equal(failed.failed, true);
  assert.equal(record.packets.length, 0);
  assert.equal(record.decision?.composition, "FilmB");
  assert.equal(record.decision?.decidedBy, "sole-survivor");
  assert.deepEqual(record.decision?.excluded, [failed.label]);
  assert.match(record.decision!.rationale, /motion-spread/);
});

test("with three variants, a sensor failure leaves one pair, and judging the excluded label is refused", () => {
  const record = prepare([variant("FilmA", "a"), variant("FilmB", "b", { failed: true }), variant("FilmC", "c")]);
  const excluded = label(record, "FilmB");
  assert.equal(record.packets.length, 2);
  assert.ok(record.packets.every((packet) => packet.first !== excluded && packet.second !== excluded));
  const bad: TournamentResults = {
    ...results(record, (first) => first),
    judgements: [
      ...results(record, (first) => first).judgements,
      { pairId: [excluded, label(record, "FilmA")].sort().join(""), order: "ab", winner: excluded, reason: "x" },
    ],
  };
  assert.throws(() => judgeTournament(record, bad, AT), /No packet/);
});

test("when every variant fails a sensor the shot is undecided, with the reason", () => {
  const record = prepare([variant("FilmA", "a", { failed: true }), variant("FilmB", "b", { failed: true })]);
  assert.equal(record.decision, undefined);
  assert.match(record.undecided!, /Every variant failed a sensor/);
});

// --- Judging ---

test("both orders must agree: a pair won in both orders scores, a split pair does not", () => {
  const record = prepare([variant("FilmA", "a"), variant("FilmB", "b"), variant("FilmC", "c")]);
  const favourite = label(record, "FilmC");
  const judged = judgeTournament(
    record,
    results(record, (first, second) => (first === favourite || second === favourite ? favourite : first)),
    AT,
  );
  assert.equal(judged.decision?.composition, "FilmC");
  assert.equal(judged.decision?.decidedBy, "pairwise");
  assert.equal(judged.decision?.net[favourite], 2);
  const others = ["A", "B", "C"].filter((item) => item !== favourite);
  // Between the other two, the first shown always wins: a split, so neither scores.
  assert.deepEqual(
    others.map((item) => judged.decision!.net[item]),
    [-1, -1],
  );
  assert.match(judged.decision!.rationale, /split/);
  assert.equal(judged.judgements?.length, 6);
});

test("judge refuses a missing order, a packet judged twice, a winner outside the pair, and another preparation's seed", () => {
  const record = prepare([variant("FilmA", "a"), variant("FilmB", "b")]);
  const full = results(record, (first) => first);
  assert.throws(
    () => judgeTournament(record, { ...full, judgements: full.judgements.slice(0, 1) }, AT),
    /missing: AB-ba/,
  );
  assert.throws(
    () => judgeTournament(record, { ...full, judgements: [...full.judgements, full.judgements[0]!] }, AT),
    /judged twice/,
  );
  assert.throws(
    () =>
      judgeTournament(
        record,
        { ...full, judgements: [{ ...full.judgements[0]!, winner: "C" }, full.judgements[1]!] },
        AT,
      ),
    /the winner is C/,
  );
  assert.throws(() => judgeTournament(record, { ...full, seed: "0".repeat(16) }, AT), /seed/);
  assert.throws(() => judgeTournament(record, { ...full, shotId: "open" }, AT), /shot open/);
});

test("a tie on agreed wins goes to the variant nearer the corpus, and the rationale gives the numbers", () => {
  // FilmA runs 3.0 s, outside the reveal band; FilmB 1.5 s, inside it.
  const record = prepare([variant("FilmA", "a", { durationSec: 3 }), variant("FilmB", "b", { durationSec: 1.5 })]);
  const near = record.variants.find((item) => item.composition === "FilmB")!;
  const far = record.variants.find((item) => item.composition === "FilmA")!;
  assert.ok(far.corpus.distance! > near.corpus.distance!, `${far.corpus.distance} > ${near.corpus.distance}`);
  // Each order prefers the variant shown first: the pair is split.
  const judged = judgeTournament(
    record,
    results(record, (first) => first),
    AT,
  );
  assert.equal(judged.decision?.composition, "FilmB");
  assert.equal(judged.decision?.decidedBy, "corpus-distance");
  assert.deepEqual(Object.values(judged.decision!.net), [0, 0]);
  const rationale = judged.decision!.rationale;
  assert.match(rationale, new RegExp(`${near.label} wins shot reveal \\(reveal\\), decided by corpus-distance`));
  assert.match(rationale, new RegExp(`${far.label} ${far.corpus.distance}`));
  assert.match(rationale, /Net agreed wins: A 0, B 0/);
  assert.match(rationale, /motion:check pass/);
});

test("the same inputs and judgements give the same decision", () => {
  const record = prepare([variant("FilmA", "a"), variant("FilmB", "b"), variant("FilmC", "c")]);
  const answers = results(record, (first, second) => [first, second].sort()[0]!);
  const one = judgeTournament(record, answers, AT);
  const two = judgeTournament(
    prepare([variant("FilmC", "c"), variant("FilmA", "a"), variant("FilmB", "b")]),
    answers,
    AT,
  );
  assert.deepEqual(two.decision, one.decision);
});

// --- Corpus ---

test("corpus distance: 0 inside p25-p75, scaled outside, and features with no band in the same unit are left out", () => {
  assert.equal(bandDistance(1.5, { p25: 1, p75: 2 }), 0);
  assert.equal(bandDistance(3, { p25: 1, p75: 2 }), 1);
  assert.equal(bandDistance(0.5, { p25: 1, p75: 2 }), 0.5);
  const inside = corpusDistance(
    { durationSec: 1.5, cutOffsetSec: 0.1, motionEnergy: 9, motionSpreadShare: 0.2 },
    CORPUS,
    "reveal",
  );
  assert.equal(inside.distance, 0);
  assert.deepEqual(
    inside.features.map((row) => row.feature),
    ["durationSec", "cutOffsetSec"],
  );
  assert.deepEqual(inside.unavailable, ["motionEnergy", "motionSpreadShare", "fastSharpShare"]);
  const withMetric = corpusDistance(
    { durationSec: 1.5, motionSpreadShare: 0.9 },
    {
      ...CORPUS,
      metrics: { motionSpreadShare: { n: 3, min: 0, p10: 0, p25: 0.1, median: 0.2, p75: 0.3, p90: 0.4, max: 0.5 } },
    },
    "reveal",
  );
  assert.ok(withMetric.distance! > 0);
  assert.equal(corpusDistance({ durationSec: 1 }, undefined, "reveal").distance, null);
  assert.equal(
    corpusDistance({ durationSec: 1 }, CORPUS, "hook").features.length,
    0,
    "one hook technique is too few for a band",
  );
});

test("the nearest reference technique is of the shot's function, closest in length, ties broken by ids", () => {
  assert.equal(nearestTechnique(CORPUS, "reveal", 1.5)?.techniqueId, "t2");
  assert.equal(nearestTechnique(CORPUS, "reveal", 1.95)?.techniqueId, "t4");
  assert.equal(nearestTechnique(CORPUS, "hook", 5)?.techniqueId, "h1");
  assert.equal(nearestTechnique(CORPUS, "cta", 1), undefined);
  assert.equal(nearestTechnique(CORPUS, undefined, 1), undefined);
  assert.equal(prepare([variant("FilmA", "a"), variant("FilmB", "b")]).reference?.techniqueId, "t2");
});

test("measureShot reads duration, the first motion after the cut, energy and spread from a render's evidence", () => {
  const evidence = {
    video: { width: 1080, height: 1920, fps: 30, frameCount: 45, durationSec: 1.5, hasAudio: false },
    boundaries: [],
    motion: [0.1, 0.2, 0.3, 0.4].map((timeSec, index) => ({
      timeSec,
      energy: index ? 4 : 0,
      changed: index ? 0.05 : 0,
    })),
    spread: [0, 0.9, 0.2, 0.1],
  } as unknown as FilmEvidence;
  const measured = measureShot(evidence);
  assert.equal(measured.durationSec, 1.5);
  assert.equal(measured.cutOffsetSec, 0.2);
  assert.equal(measured.motionEnergy, 3);
  assert.equal(measured.motionSpreadShare, 0.25);
  assert.equal(measured.fastSharpShare, undefined, "no sharpness samples, no sharp share");
});

// --- The build's done check ---

function project(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "tournament-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/film");
  mkdirSync(path.join(dir, "pipeline/tournament"), { recursive: true });
  return { root, dir };
}

test("tournament-decided: a hero shot needs a decided tournament whose winner the build mounts, props by hash", (t) => {
  const { root, dir } = project(t);
  const build = { composition: "Film" };
  assert.deepEqual(heroTournamentProblems(dir, root, PLAN, build), [
    "hero shot reveal has no tournament: run shot:tournament --action prepare with 2-3 variants",
  ]);
  const prepared = prepare([variant("FilmA", "a"), variant("FilmB", "b")]);
  writeFileSync(tournamentFile(dir, "reveal"), JSON.stringify(prepared));
  assert.match(
    heroTournamentProblems(dir, root, PLAN, build)[0]!,
    /is not decided: dispatch a fresh creative-critic with the 2 packets in out\/film\/tournament\/reveal; it writes results naming seed [a-f0-9]{16}; then run shot:tournament --action judge/,
  );
  const winner = label(prepared, "FilmB");
  writeFileSync(
    tournamentFile(dir, "reveal"),
    JSON.stringify(
      judgeTournament(
        prepared,
        results(prepared, () => winner),
        AT,
      ),
    ),
  );
  assert.match(heroTournamentProblems(dir, root, PLAN, build)[0]!, /the build mounts Film, the tournament chose/);
  assert.deepEqual(
    heroTournamentProblems(dir, root, PLAN, { composition: "Film", shots: { reveal: { composition: "FilmB" } } }),
    [],
  );
  assert.deepEqual(heroTournamentProblems(dir, root, PLAN, { composition: "FilmB" }), []);
  assert.deepEqual(
    heroTournamentProblems(
      dir,
      root,
      { ...PLAN, shots: PLAN.shots.map((item) => ({ ...item, weight: undefined })) },
      build,
    ),
    [],
    "no hero shot, nothing to decide",
  );

  // A winner run with props: the build names the same props, unchanged since the decision.
  const props = path.join(root, "props-b.json");
  writeFileSync(props, JSON.stringify({ accent: "#f00" }));
  const withProps = prepare([
    variant("FilmA", "a"),
    { ...variant("Film", "b"), propsFile: "props-b.json", propsSha256: hashFile(props) },
  ]);
  const propsWinner = label(withProps, "Film");
  writeFileSync(
    tournamentFile(dir, "reveal"),
    JSON.stringify(
      judgeTournament(
        withProps,
        results(withProps, () => propsWinner),
        AT,
      ),
    ),
  );
  assert.match(
    heroTournamentProblems(dir, root, PLAN, { composition: "Film" })[0]!,
    /name it in build.json shots.reveal.props/,
  );
  const mounted = { composition: "Film", shots: { reveal: { composition: "Film", props: "props-b.json" } } };
  assert.deepEqual(heroTournamentProblems(dir, root, PLAN, mounted), []);
  writeFileSync(props, JSON.stringify({ accent: "#0f0" }));
  assert.match(heroTournamentProblems(dir, root, PLAN, mounted)[0]!, /differ from the winner's/);
});

// --- Memory ---

test("judge records an observation scoped to the build step; the same win in another film is a sighting, a re-judge is not", (t) => {
  const { root } = project(t);
  const previous = process.env.AGENTBROS_MEMORY_ROOT;
  process.env.AGENTBROS_MEMORY_ROOT = path.join(root, "memory");
  t.after(() =>
    previous === undefined ? delete process.env.AGENTBROS_MEMORY_ROOT : (process.env.AGENTBROS_MEMORY_ROOT = previous),
  );
  const tournament = (projectId: string, winnerTechnique: string, loserTechnique: string) => {
    const record = prepareTournament({
      projectId,
      plan: PLAN,
      shotId: "reveal",
      variants: [
        variant("SecretA", "a", { technique: winnerTechnique }),
        variant("SecretB", "b", { technique: loserTechnique }),
      ],
      corpus: CORPUS,
      packetDir: "out/x",
      at: AT,
    });
    return judgeTournament(
      record,
      results(record, () => label(record, "SecretA")),
      AT,
    );
  };
  const judged = tournament("film", "mask-reveal", "scale-punch");
  const first = noteTournamentDecision(judged, root);
  assert.equal(first.warning, undefined);
  const entry = () => loadMemory(root).entries.find((item) => item.id === first.id)!;
  assert.equal(entry().type, "observation");
  assert.equal(entry().summary, "Shot tournament: a reveal hero shot was won by mask-reveal");
  assert.doesNotMatch(entry().summary, /Secret|scale-punch/, "no product names; the losers are in the body");
  assert.deepEqual(entry().scope.steps, ["build"]);
  assert.equal(entry().scope.project, undefined, "no project scope, so another film's same win is the same entry");
  assert.match(entry().body, /corpus distance/);
  assert.match(entry().body, /SecretB, scale-punch/);
  assert.deepEqual(
    noteTournamentDecision(judged, root),
    { id: first.id, seen: false },
    "judging the same tournament again counts nothing",
  );
  assert.equal(entry().occurrences, 1);
  const elsewhere = noteTournamentDecision(tournament("other-film", "mask-reveal", "whip-in"), root);
  assert.deepEqual(elsewhere, { id: first.id, seen: true });
  assert.equal(entry().occurrences, 2);
  const reversed = noteTournamentDecision(tournament("third-film", "scale-punch", "mask-reveal"), root);
  assert.notEqual(reversed.id, first.id, "the opposite outcome is another observation");
  const unnamed = prepare([variant("FilmA", "a"), variant("FilmB", "b")]);
  assert.match(
    noteTournamentDecision(
      judgeTournament(
        unnamed,
        results(unnamed, () => "A"),
        AT,
      ),
      root,
    ).warning!,
    /--techniques/,
  );
});

// --- CLI ---

function cli(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/shot-tournament.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AGENTBROS_MEMORY_ROOT: path.join(root, "memory") },
  });
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as {
    ok: boolean;
    error?: string;
    message?: string;
    metadata: Record<string, any>;
  };
}

test("shot:tournament --action status and judge on a prepared record", (t) => {
  const { root, dir } = project(t);
  writeFileSync(path.join(dir, "pipeline/brief.json"), JSON.stringify({ renderMode: "bespoke" }));
  writeFileSync(path.join(dir, "pipeline/motion-plan.json"), JSON.stringify(PLAN));
  assert.equal(cli(root, "--action", "status", "--project", "film").metadata["shots"][0].state, "not-prepared");
  const record = prepare([
    variant("FilmA", "a", { technique: "mask-reveal" }),
    variant("FilmB", "b", { technique: "scale-punch" }),
  ]);
  writeFileSync(tournamentFile(dir, "reveal"), JSON.stringify(record));
  const status = cli(root, "--action", "status", "--project", "film");
  assert.equal(status.metadata["decided"], 0);
  assert.equal(status.metadata["shots"][0].state, "undecided");
  const answers = path.join(root, "results.json");
  writeFileSync(answers, JSON.stringify(results(record, () => label(record, "FilmA"))));
  const judged = cli(root, "--action", "judge", "--project", "film", "--shot", "reveal", "--results", answers);
  assert.equal(judged.ok, true, judged.message ?? "");
  assert.equal(judged.metadata["decision"].composition, "FilmA");
  assert.ok(judged.metadata["memory"]?.id, "the decision is in memory");
  assert.equal(cli(root, "--action", "status", "--project", "film").metadata["decided"], 1);
  assert.equal(cli(root, "--action", "judge", "--project", "film", "--shot", "reveal").error, "INVALID_INPUT");
});
