import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  IDEA_AXES,
  SCRIPT_AXES,
  pairwiseIds,
  requiredOrders,
  type ReviewKind,
} from "../../src/lib/film/creative-rubric";
import {
  buildPool,
  laneFile,
  lanesFor,
  pickIdeas,
  pickScript,
  poolFile,
  rankLatest,
  reviewFile,
} from "../../src/lib/film/studio";

/** Drives the creative department's steps with hand-written artefacts, as the agents would write them. */

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/film-chain");
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};

export const strategyFixture = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  language: "en",
  audience: { who: "people with too many tasks", moment: "first look at the phone in the morning" },
  platform: { name: "Reels", aspect: "vertical", sound: "off" },
  proposition: "One list that empties itself as you work.",
  hook: { mechanic: "result first", firstTwoSeconds: "an empty list, then the day it replaced" },
  tone: ["calm"],
  mandatories: ["product name on the end card"],
  forbidden: ["naming competitors"],
  successCriteria: ["a viewer on mute can say what it does", "the hook frame asks a question within 2 s"],
  filmType: "motion-graphics",
  ...overrides,
});

export function writeStrategy(dir: string, overrides: Record<string, unknown> = {}) {
  const brief = JSON.parse(readFileSync(path.join(dir, "pipeline/brief.json"), "utf8")) as {
    filmType?: string;
    secondaryFilmType?: string;
  };
  const types = {
    ...(brief.filmType ? { filmType: brief.filmType } : {}),
    ...(brief.secondaryFilmType ? { secondaryFilmType: brief.secondaryFilmType } : {}),
  };
  writeJson(path.join(dir, "pipeline/strategy.json"), strategyFixture({ ...types, ...overrides }));
  writeFileSync(path.join(dir, "pipeline/strategy.md"), "# Strategy\n\nOne list that empties itself.\n");
}

export function writeTeams(
  dir: string,
  round: number,
  count = 4,
  options: { stimuli?: number; killed?: number; proof?: string; proofFrames?: number } = {},
) {
  for (const team of lanesFor(dir, "ideas")) {
    const ideas = Array.from({ length: count }, (_, index) => ({
      id: `${index + 1}`,
      title: `${team} ${index + 1}`,
      premise: `TEAM_SECRET_${team}`,
      coreImage: `${team} picture ${index + 1} round ${round}`,
      openingFrame: `${team} opening ${index + 1}`,
      whyWatch: "w",
      ...(options.stimuli !== undefined
        ? {
            stimulus:
              index < options.stimuli
                ? { method: "zwicky", seed: `x:${team}`, prompt: `STIMULUS_SECRET_${team}_${index}` }
                : null,
          }
        : {}),
      ...(options.stimuli !== undefined && index === 0
        ? { subverts: { cliche: `CLICHE_SECRET_${team}`, how: "turns it" } }
        : {}),
      ...(options.proof !== undefined && index < (options.proofFrames ?? count)
        ? { proofFrame: { proof: options.proof, where: index % 2 ? "turn" : "hook" } }
        : {}),
    }));
    const killedObvious = options.killed
      ? Array.from({ length: options.killed }, (_, index) => `KILLED_SECRET_${team}_${index}`)
      : undefined;
    writeJson(laneFile(dir, "ideas", team), {
      schemaVersion: 1,
      team,
      round,
      ideas,
      ...(killedObvious ? { killedObvious } : {}),
    });
  }
}

/** A valid category scan: eight examples and eight clichés. */
export const categoryScanFixture = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  category: "AI assistants for small-business chat",
  examples: Array.from({ length: 8 }, (_, index) => ({
    url: `https://example.org/ad-${index}`,
    brand: `Brand ${index}`,
    hookFirst2s: "a phone buzzes at night",
    coreVisualDevice: "chat bubbles",
    productRole: "hero",
    structure: "problem, demo, CTA",
    evidence: index % 2 ? "inferred" : "read",
  })),
  conventions: [
    { convention: "the owner asleep while the bot works", seenIn: "Brand 1, Brand 3", why: "shows time saved" },
  ],
  cliches: Array.from({ length: 8 }, (_, index) => ({
    cliche: `CLICHE_${index}`,
    description: `obvious picture ${index}`,
    seenIn: `Brand ${index}`,
  })),
  learn: ["show the reply landing"],
  dontTake: ["DONT_TAKE_robot mascot"],
  whiteSpace: ["WHITE_SPACE_the client's side of the chat"],
  ...overrides,
});

export function writeCategoryScan(dir: string, overrides: Record<string, unknown> = {}) {
  writeJson(path.join(dir, "pipeline/category-scan.json"), categoryScanFixture(overrides));
}

export function writeVariants(
  dir: string,
  round: number,
  overrides: Record<string, (script: Record<string, any>) => void> = {},
) {
  const script = JSON.parse(readFileSync(path.join(FIXTURES, "script.json"), "utf8")) as Record<string, any>;
  const map = JSON.parse(readFileSync(path.join(FIXTURES, "script-music-map.json"), "utf8"));
  for (const variant of lanesFor(dir, "scripts")) {
    const own = structuredClone(script);
    own["beats"][1]["text"] = `Variant ${variant} line, round ${round}.`;
    overrides[variant]?.(own);
    writeJson(laneFile(dir, "scripts", variant), {
      schemaVersion: 1,
      variant,
      round,
      hookLine: `hook ${variant}`,
      density: "sparse",
      script: own,
      musicMap: map,
      markdown: `# Variant ${variant}\n`,
    });
  }
}

/** A review in the director's shape: every item scored, every ordered pair among the top judged; scores from `score(id, index)`. */
export function writeReview(
  dir: string,
  kind: ReviewKind,
  round: number,
  score: (index: number) => number,
  options: { pairWinner?: (first: string, second: string) => string; notes?: string[]; rubricVersion?: number } = {},
) {
  const pool = JSON.parse(readFileSync(poolFile(dir, kind), "utf8")) as {
    rubricVersion: number;
    items: { id: string }[];
  };
  const axes = kind === "ideas" ? IDEA_AXES : SCRIPT_AXES;
  const scores = pool.items.map((item, index) => ({
    id: item.id,
    axes: Object.fromEntries(axes.map((axis) => [axis, { score: score(index), note: `${axis} note` }])),
  }));
  const scored = scores.map((entry, order) => ({
    id: entry.id,
    order,
    axes: Object.fromEntries(Object.entries(entry.axes).map(([axis, value]) => [axis, value.score])),
  }));
  const pairs = requiredOrders(pairwiseIds(scored)).map(([first, second]) => ({
    first,
    second,
    winner: options.pairWinner?.(first, second) ?? "tie",
  }));
  const against = pool.items.map((item) => ({ id: item.id, argument: `against ${item.id}` }));
  writeJson(reviewFile(dir, kind, round), {
    schemaVersion: 1,
    rubricVersion: options.rubricVersion ?? pool.rubricVersion,
    kind,
    round,
    targetSha256: sha(poolFile(dir, kind)),
    scores,
    pairs,
    against,
    notes: options.notes ?? ["show the product working sooner"],
  });
}

export function writeBoards(dir: string) {
  const concept = JSON.parse(readFileSync(path.join(dir, "pipeline/concept.json"), "utf8")) as {
    candidates: { id: string }[];
  };
  const candidates = concept.candidates.map((candidate) => ({
    id: candidate.id,
    frames: (["hook", "last"] as const).map((role) => ({
      role,
      itemId: "type-hero-word",
      props: {},
      caption: `${candidate.id} ${role}`,
    })),
  }));
  writeJson(path.join(dir, "pipeline/concept-boards.json"), { candidates });
  for (const candidate of candidates)
    for (const frame of candidate.frames) {
      const file = path.join(dir, "pipeline/boards", `${candidate.id}-${frame.role}.jpg`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `jpg ${candidate.id} ${frame.role}`);
    }
  writeFileSync(path.join(dir, "pipeline/boards/boards.jpg"), "sheet");
  writeFileSync(path.join(dir, "pipeline/concept.md"), "# Three ideas\n");
}

/** Discovery is skippable: fixtures that are not about it skip it with a reason. */
export function skipDiscovery(dir: string, reason = "fixture: no category scan") {
  writeJson(path.join(dir, "pipeline/skips/discovery.json"), { reason, at: "2026-11-12T00:00:00.000Z" });
}

type Film = { dir: string; seal: (id: string) => unknown; approve: (id: string) => unknown };

/** Strategy approved, teams written, pool reviewed and passing, concept picked with boards, approved. */
export function toConceptApproved(film: Film, projectId: string) {
  writeStrategy(film.dir);
  film.seal("strategy");
  film.approve("strategy");
  skipDiscovery(film.dir);
  writeTeams(film.dir, 1);
  film.seal("ideas");
  buildPool(film.dir, projectId, "ideas");
  film.seal("idea-review");
  writeReview(film.dir, "ideas", 1, () => 4);
  rankLatest(film.dir, "ideas");
  pickIdeas(film.dir);
  writeBoards(film.dir);
  film.seal("concept");
  film.approve("concept");
}

/** Variants written, pooled, reviewed and passing, the winner picked. Leaves the script step for the caller to seal and approve. */
export function toScriptPicked(film: Film, projectId: string) {
  writeVariants(film.dir, 1);
  film.seal("script-variants");
  buildPool(film.dir, projectId, "scripts");
  film.seal("script-review");
  writeReview(film.dir, "scripts", 1, (index) => 5 - index);
  rankLatest(film.dir, "scripts");
  pickScript(film.dir);
}
