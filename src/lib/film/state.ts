import { assertVizMotionPlan } from "../viz/integrity";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Critique } from "../../types/creative";
import { CritiqueSchema, MotionPlanSchema } from "../../types/creative";
import type { AudioMap, CueSheet, FilmMeasure, FilmTargets, MusicDecision } from "../../types/film";
import { AudioMapSchema, CueSheetSchema, MusicDecisionSchema, MusicShortlistSchema } from "../../types/film";
import { PipelineStateSchema } from "../../types/pipeline";
import { DEFAULT_LIBRARY_ROOT, validateReference } from "../reference/library";
import { appendUserWords } from "./spine";
import { wordsChannel } from "../cli/channel";
import { userWordsProblem } from "../cli/user-words";
import { autonomousPolicy, musicRecordCommand, policyBasis, POLICY_ANSWER_PREFIX } from "./autonomy";
import { currentPolicy } from "../autonomy/policy";
import { ledgerLines, readDecisions, revokedDecisionIds } from "./decisions";
import { guardCheck, raiseCommand, stopping, type CrossedLimit, type GuardCheck } from "./guard";
import { bestFilmVersion, critiqueTotal } from "./versions";
import { repeatedAspects, revisionSince, settleOpenFeedback } from "../feedback/store";
import { SAFE_ZONE_PROFILES } from "../sensors/text-checks";
import { UNSCORED_PLAN_DIMENSIONS } from "./plan-check";
import { heroTournamentProblems } from "./tournament";
import { selectionProblems } from "../audio/sfx-selection-check";
import { SfxSelectionSchema } from "../../types/sfx-selection";
import { formatFinding, lintProjectCode } from "../verification/lint";
import {
  captureFields,
  filmRead,
  memoryFields,
  withPlaybook,
  type CaptureFields,
  type MemoryFields,
  type PlaybookAnswer,
} from "../pipeline/route";
import type { CaptureMoment } from "../pipeline/memory";
import {
  absentOutputs,
  chainFor,
  DEFAULT_FILM_TYPE,
  filmTypeOf,
  resolveRoute,
  stepEnabled,
  toolLines,
  toolsFor,
} from "./routes";
import { ReplicaRightsSchema, ReplicaSpecSchema } from "../../types/reference-replica";
import type { MeasureCount } from "../reference/replica";
import { replicaPublicationBlock } from "../delivery/replica-rights";
import { directionProblems, narrationFileProblems } from "./narration";
import { NarrationDirectionSchema, NarrationSchema } from "../../types/narration";
import { ScriptSchema } from "../../types/pipeline";
import { preparationAdmission, validatePreparation } from "../model-preparation/approval";
import { checkPack } from "../references/packs/check";
import { packProducedOutput } from "../references/packs/outputs";
import { packState } from "../references/pack-status";
import { StrategySchema } from "../../types/studio";
import { ConceptBoardsSchema, CreativePoolSchema } from "../../types/studio";
import {
  conceptFromReviewProblems,
  judgedRecord,
  laneStates,
  latestReviewPath,
  planReopen,
  poolProblems,
  rescoreLines,
  reviewOutcome,
  reviewProblems,
  reviewRounds,
  roundsStart,
  scriptFromReviewProblems,
} from "./studio";
import type { FilmType } from "../../types/pipeline";
import {
  ARTEFACT_SCHEMAS,
  AUDIO_MAP,
  BOARDS,
  BOARDS_SHEET,
  BRIEF,
  BUILD,
  BuildRecordSchema,
  CONCEPT,
  CRITIC_AGENT,
  CUE_SHEET,
  MOTION_PLAN,
  DECISION,
  FILM_CHAIN,
  FIXER_AGENT,
  FORBIDDEN_FOR_ALL,
  FORBIDDEN_UNDER_POLICY,
  MATERIAL,
  MEASURE,
  MIX_REPORT,
  NARRATION,
  NARRATION_DIRECTION,
  MOTION_CHECK,
  PLAN_CHECK,
  RENDER,
  REPLICA_CHECK,
  REPLICA_COMPARE,
  REPLICA_SPEC,
  RIGHTS,
  SCRIPT,
  SCRIPT_MAP,
  SFX_SELECTION,
  SHORTLIST,
  SOUND_CUES,
  STRATEGY,
  stepById,
  stepOwnerKind,
  TARGETS,
  TRUTH,
  type ChainCommand,
  type ChainStep,
  type DoneCheckId,
} from "./chain";
import { REFERENCES_FILE, referencesReadyFailures } from "../references/plan";
import type { FileMemo } from "../file-memo";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

// --- Project context ---

export type FilmProject = {
  id: string;
  projectDir: string;
  /** What root-relative paths resolve against: the working directory for a CLI run. */
  rootDir: string;
  libraryRoot: string;
  /** Where agent definitions and rule files live. */
  repoRoot: string;
  hashes: Map<string, string>;
  /** A long-lived reader's hash memo (path, size, mtime, inode) kept across derivations; a CLI run has none. */
  hashMemo?: FileMemo<string>;
};

export type FilmProjectOptions = {
  rootDir?: string;
  libraryRoot?: string;
  repoRoot?: string;
  hashMemo?: FileMemo<string>;
};

export function openFilmProject(projectDir: string, options: FilmProjectOptions = {}): FilmProject {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  return {
    id: path.basename(projectDir),
    projectDir: path.resolve(rootDir, projectDir),
    rootDir,
    libraryRoot: path.resolve(rootDir, options.libraryRoot ?? DEFAULT_LIBRARY_ROOT),
    repoRoot: options.repoRoot ?? REPO_ROOT,
    hashes: new Map(),
    ...(options.hashMemo ? { hashMemo: options.hashMemo } : {}),
  };
}

export const projectDirFor = (id: string, rootDir: string = process.cwd()): string =>
  path.join(rootDir, "public", "projects", id);

const abs = (project: FilmProject, file: string) => path.resolve(project.rootDir, file);
const chainDir = (project: FilmProject) => path.join(project.projectDir, "pipeline", "chain");
const approvalFile = (project: FilmProject, stepId: string) =>
  path.join(project.projectDir, "pipeline", "approvals", `${stepId}.json`);
const receiptFile = (project: FilmProject, stepId: string) => path.join(chainDir(project), `${stepId}.json`);
const fixerRoundsFile = (project: FilmProject) => path.join(chainDir(project), "fixer-rounds.json");
const skipFile = (project: FilmProject, stepId: string) =>
  path.join(project.projectDir, "pipeline", "skips", `${stepId}.json`);

/** The recorded reason a skippable step was skipped, if it was. Delete the file to run the step after all. */
export function readSkip(project: FilmProject, stepId: string): { reason: string; at: string } | undefined {
  const record = readJson(skipFile(project, stepId)) as { reason?: unknown; at?: unknown } | undefined;
  return typeof record?.reason === "string" && record.reason.trim()
    ? { reason: record.reason, at: String(record.at ?? "") }
    : undefined;
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile() && statSync(file).size > 0;

function hashOf(project: FilmProject, relative: string): string | undefined {
  const file = abs(project, relative);
  if (!isFile(file)) return undefined;
  let hash = project.hashes.get(file);
  if (!hash) {
    const digest = (target: string) => createHash("sha256").update(readFileSync(target)).digest("hex");
    hash = project.hashMemo ? project.hashMemo.get(file, digest) : digest(file);
    project.hashes.set(file, hash);
  }
  return hash;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read from the raw file: BriefSchema strips keys it does not know. */
export function isBespokeProject(projectDir: string): boolean {
  const brief = readJson(path.join(projectDir, "pipeline", "brief.json"));
  return isRecord(brief) && brief["renderMode"] === "bespoke";
}

// --- Tokens ---

export type Tokens = Record<string, string | undefined>;

function parsed<T>(project: FilmProject, tokens: Tokens, template: string, schema: z.ZodType<T>): T | undefined {
  const relative = fill(template, tokens);
  if (!relative) return undefined;
  const result = schema.safeParse(readJson(abs(project, relative)));
  return result.success ? result.data : undefined;
}

/** A template with every token known, or undefined. */
export function fill(template: string, tokens: Tokens): string | undefined {
  let missing = false;
  const value = template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => {
    const token = tokens[name];
    if (token === undefined) missing = true;
    return token ?? "";
  });
  return missing ? undefined : value;
}

/** The music the film uses, root-relative: the decision's cut when it has one, else the candidate's file. */
function musicFile(project: FilmProject, tokens: Tokens, decision: MusicDecision | undefined): string | undefined {
  if (decision?.cut)
    return path.isAbsolute(decision.cut.file)
      ? path.relative(project.rootDir, decision.cut.file)
      : path.join(tokens["dir"] ?? "", decision.cut.file);
  return candidateFile(project, tokens, decision);
}

/** The chosen candidate's own file, root-relative. */
function candidateFile(project: FilmProject, tokens: Tokens, decision: MusicDecision | undefined): string | undefined {
  if (!decision?.candidateId) return undefined;
  const shortlist = parsed(project, tokens, SHORTLIST, MusicShortlistSchema);
  const candidate = shortlist?.candidates.find((item) => item.id === decision.candidateId);
  const file = candidate?.originalPath ?? candidate?.previewPath;
  if (!file) return undefined;
  if (path.isAbsolute(file)) return path.relative(project.rootDir, file);
  const inProject = path.join(tokens["dir"] ?? "", file);
  return existsSync(abs(project, inProject)) ? inProject : file;
}

export function baseTokens(project: FilmProject): Tokens {
  const tokens: Tokens = {
    id: project.id,
    dir: path.relative(project.rootDir, project.projectDir),
    library: path.relative(project.rootDir, project.libraryRoot) || ".",
  };
  const targets = readJson(abs(project, fill(TARGETS, tokens)!));
  if (isRecord(targets) && typeof targets["referenceId"] === "string") tokens["referenceId"] = targets["referenceId"];
  const rights = parsed(project, tokens, RIGHTS, ReplicaRightsSchema);
  if (rights) {
    tokens["rightsStatus"] = rights.status;
    tokens["rightsStatement"] = rights.userStatement;
  }
  const decision = parsed(project, tokens, DECISION, MusicDecisionSchema);
  tokens["musicFile"] = musicFile(project, tokens, decision);
  if (decision?.route !== "silence") {
    tokens["audioMap"] = fill(AUDIO_MAP, tokens);
    tokens["cueSheet"] = fill(CUE_SHEET, tokens);
    // sfx:cues checks every cut's sound decision against the plan only where a cue sheet can hold the decisions.
    tokens["decidedPlan"] = fill(MOTION_PLAN, tokens);
    // sfx:cues places sfx:audition's choices once the selection exists.
    const selection = fill(SFX_SELECTION, tokens);
    if (selection && existsSync(abs(project, selection))) tokens["sfxSelection"] = selection;
  }
  for (const kind of ["ideas", "scripts"] as const) {
    const review = latestReviewPath(project.projectDir, kind);
    if (review) tokens[`${kind}Review`] = path.relative(project.rootDir, review);
  }
  const brief = readJson(abs(project, fill(BRIEF, tokens)!));
  // motion:check holds text inside this format's safe zone.
  if (
    isRecord(brief) &&
    typeof brief["format"] === "string" &&
    (SAFE_ZONE_PROFILES as readonly string[]).includes(brief["format"])
  )
    tokens["format"] = brief["format"];
  const build = readJson(abs(project, fill(BUILD, tokens)!));
  if (isRecord(build)) {
    if (typeof build["composition"] === "string") tokens["composition"] = build["composition"];
    if (typeof build["entry"] === "string") tokens["entry"] = build["entry"];
  }
  return tokens;
}

const isSilence = (project: FilmProject, tokens: Tokens) =>
  parsed(project, tokens, DECISION, MusicDecisionSchema)?.route === "silence";

// --- Done checks ---

/** Mirrors BLOCKING_RISK in plan-check.ts. */
const PLAN_BLOCKING_RISK = 2.5;
const round2 = (value: number) => Math.round(value * 100) / 100;

type CheckContext = {
  project: FilmProject;
  tokens: Tokens;
  silence: boolean;
  promo?: boolean;
  advisories?: string[];
  /** The step being checked, and whether film:done has sealed it. */ step?: string;
  sealed?: boolean;
};

/** plan:check dimensions and film:measure legs that compare with the reference's numbers. Advisory in the promo profile. */
export const REFERENCE_PLAN_DIMENSIONS = ["shot-length", "shot-count", "shot-variety"] as const;
export const REFERENCE_MEASURE_LEGS = [
  "shot-length-median",
  "shot-length-variety",
  "cuts-per-minute",
  "still-share",
  "longest-still",
] as const;
/** Film-level demands that a promo may waive: advisory there, blocking in a full film. */
export const PROMO_ADVISORY_PLAN_DIMENSIONS = ["signature-element"] as const;
export const PROMO_ADVISORY_CHECKS = ["tournament-decided", "hero-sounds-selected"] as const;

/** The brief's type, read raw so a stub brief at intake still routes. */
export function filmTypes(project: FilmProject, tokens: Tokens): { type?: FilmType; secondary?: FilmType } {
  const brief = raw({ project, tokens, silence: false }, BRIEF) as Record<string, unknown> | undefined;
  const type = filmTypeOf(brief?.["filmType"]);
  const secondary = filmTypeOf(brief?.["secondaryFilmType"]);
  return { ...(type ? { type } : {}), ...(secondary ? { secondary } : {}) };
}

export const isPromo = (project: FilmProject, tokens: Tokens) =>
  (raw({ project, tokens, silence: false }, BRIEF) as { profile?: string } | undefined)?.profile === "promo";

/** Keeps the failures that block; in promo, reference-number failures go to the advisories instead. */
function splitAdvisory(
  context: CheckContext,
  failures: { id: string; text: string }[],
  reference: readonly string[],
): string[] {
  if (!context.promo) return failures.map((failure) => failure.text);
  const advisory = failures.filter((failure) => reference.includes(failure.id));
  context.advisories?.push(...advisory.map((failure) => `advisory (promo): ${failure.text}`));
  return failures.filter((failure) => !reference.includes(failure.id)).map((failure) => failure.text);
}

const raw = (context: CheckContext, template: string): unknown => {
  const relative = fill(template, context.tokens);
  return relative ? readJson(abs(context.project, relative)) : undefined;
};

function lanesNotReady(projectDir: string, kind: "ideas" | "scripts"): string[] {
  return laneStates(projectDir, kind)
    .filter((lane) => lane.status !== "ready")
    .map(
      (lane) =>
        `${kind === "ideas" ? "team" : "variant"} ${lane.lane}: ${lane.status}${lane.reason ? ` (${lane.reason})` : ""}`,
    );
}

const NO_PRODUCT = /^(none|n\/?a|-+|—|нет)$/i;

/** Writers, the director and the motion plan read one map: the map of the decision's cut. */
function mapOfCut(context: CheckContext, map: AudioMap): string[] {
  const file = context.tokens["musicFile"];
  const hash = file ? hashOf(context.project, file) : undefined;
  return hash === map.source.sha256
    ? []
    : [`the audio map is not the map of ${file ?? "the music cut"}: rebuild it at the audio-map step`];
}

/** Each product-only proof cites a product-truth claim, by its text verbatim or its id, whose status is working. */
export function proofClaimProblems(proofs: { proof: string; claim: string }[], truth: unknown): string[] {
  const claims = (
    (truth as { claims?: { id?: unknown; text?: unknown; status?: unknown }[] } | undefined)?.claims ?? []
  ).filter((claim) => typeof claim.text === "string");
  return proofs.flatMap((item, index) => {
    const wanted = item.claim.trim();
    const claim = claims.find(
      (entry) => (typeof entry.id === "string" && entry.id === wanted) || String(entry.text).trim() === wanted,
    );
    if (!claim)
      return [
        `productOnlyProofs[${index}] "${item.proof}" cites "${item.claim}", which is not a claim in product-truth.json: quote a claim's text verbatim or give its id`,
      ];
    return claim.status === "working"
      ? []
      : [
          `productOnlyProofs[${index}] "${item.proof}" cites "${item.claim}", whose status is ${String(claim.status)}; a proof needs a working claim`,
        ];
  });
}

/** The film's code directories under src/projects/: its own id, and the one build.json's entry lives in. */
function projectCodeIds(context: CheckContext): string[] {
  const ids = new Set([context.project.id]);
  const entry = parsed(context.project, context.tokens, BUILD, BuildRecordSchema)?.entry;
  if (entry) {
    const relative = path
      .relative(path.join(context.project.rootDir, "src/projects"), path.resolve(context.project.rootDir, entry))
      .split(path.sep);
    if (relative.length > 1 && relative[0] && relative[0] !== ".." && !path.isAbsolute(relative[0]))
      ids.add(relative[0]);
  }
  return [...ids].filter(
    (id) =>
      /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id) &&
      !id.includes("..") &&
      existsSync(path.join(context.project.rootDir, "src/projects", id)),
  );
}

/** One lint per directory state in a process: deriveChain checks the animatic and the build together. */
const projectLintMemo = new Map<string, string[]>();
const MAX_LINT_LINES = 20;
function projectLintProblems(rootDir: string, id: string): string[] {
  const directory = path.join(rootDir, "src/projects", id);
  const stamp: string[] = [];
  const visit = (current: string, depth: number) => {
    if (depth > 20) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (/\.tsx?$/.test(entry.name)) {
        const stat = statSync(file);
        stamp.push(`${file}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  visit(directory, 0);
  const key = `${directory}\n${stamp.sort().join("\n")}`;
  const cached = projectLintMemo.get(key);
  if (cached) return cached;
  let lines: string[];
  try {
    lines = lintProjectCode(rootDir, id).findings.map(formatFinding);
  } catch (error) {
    return [
      `the project lint of src/projects/${id} could not run: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const problems =
    lines.length > MAX_LINT_LINES
      ? [...lines.slice(0, MAX_LINT_LINES), `and ${lines.length - MAX_LINT_LINES} more: run pnpm lint --project ${id}`]
      : lines;
  projectLintMemo.set(key, problems);
  return problems;
}

export const DONE_CHECKS: Record<DoneCheckId, (context: CheckContext) => string[]> = {
  // The animatic's code grows into the build: once sealed, the build's own check carries the lint, so the approved animatic does not reopen.
  "project-lint-clean": (context) =>
    context.step === "animatic" && context.sealed
      ? []
      : projectCodeIds(context).flatMap((id) => projectLintProblems(context.project.rootDir, id)),
  "brief-filled": (context) => {
    const brief = raw(context, BRIEF) as Record<string, unknown>;
    const failures = ["topic", "audience", "tone", "productName"]
      .filter((key) => !String(brief[key] ?? "").trim())
      .map((key) => `brief.${key} is empty`);
    if (brief["renderMode"] !== "bespoke") failures.push('brief.renderMode must stay "bespoke"');
    return failures;
  },
  "truth-sourced": (context) => {
    const brief = raw(context, BRIEF) as Record<string, unknown> | undefined;
    if (NO_PRODUCT.test(String(brief?.["productName"] ?? "").trim())) return [];
    const truth = raw(context, TRUTH) as { sources: string[]; claims: { status: string }[] };
    return [
      ...(truth.sources.length ? [] : ["no source listed"]),
      ...(truth.claims.some((claim) => claim.status === "working") ? [] : ["no claim is marked working"]),
    ];
  },
  "reference-usable": (context) => {
    const targets = raw(context, TARGETS) as FilmTargets;
    if (targets.source === "manual") return targets.reason?.trim() ? [] : ["manual targets need a reason"];
    if (targets.source === "corpus") {
      const ids = targets.corpus?.referenceIds ?? [];
      if (!ids.length) return ["corpus targets must list their references"];
      return ids.flatMap((id) =>
        existsSync(path.join(context.project.libraryRoot, id))
          ? []
          : [`no corpus reference at ${path.join(context.project.libraryRoot, id)}`],
      );
    }
    if (!targets.referenceId) return ["targets from a reference must name it"];
    const directory = path.join(context.project.libraryRoot, targets.referenceId);
    if (!existsSync(directory)) return [`no reference at ${directory}`];
    const report = validateReference(directory);
    return [
      ...report.invalid.map((item) => `${item.file}: ${item.issues[0] ?? "invalid"}`),
      ...report.missingMeasured.map((file) => `measured layer ${file} is missing`),
    ];
  },
  "strategy-filled": (context) => {
    const strategy = StrategySchema.parse(raw(context, STRATEGY));
    const { type, secondary } = filmTypes(context.project, context.tokens);
    const failures: string[] = [];
    if (strategy.filmType !== (type ?? DEFAULT_FILM_TYPE))
      failures.push(
        `strategy.filmType is ${strategy.filmType}, the brief's is ${type ?? `unset (routed as ${DEFAULT_FILM_TYPE})`}`,
      );
    if ((strategy.secondaryFilmType ?? null) !== (secondary ?? null))
      failures.push("strategy.secondaryFilmType differs from the brief's");
    if (strategy.creativeTeams && new Set(strategy.creativeTeams).size !== strategy.creativeTeams.length)
      failures.push("strategy.creativeTeams repeats a stance");
    failures.push(...proofClaimProblems(strategy.productOnlyProofs ?? [], raw(context, TRUTH)));
    return failures;
  },
  "teams-ready": (context) => lanesNotReady(context.project.projectDir, "ideas"),
  "variants-ready": (context) => lanesNotReady(context.project.projectDir, "scripts"),
  "idea-pool-current": (context) => poolProblems(context.project.projectDir, "ideas"),
  "script-pool-current": (context) => poolProblems(context.project.projectDir, "scripts"),
  "concept-from-review": (context) => conceptFromReviewProblems(context.project.projectDir),
  "boards-rendered": (context) => {
    const boards = ConceptBoardsSchema.parse(raw(context, BOARDS));
    const concept = raw(context, CONCEPT) as { candidates: { id: string }[] };
    const failures: string[] = [];
    const ids = concept.candidates.map((candidate) => candidate.id);
    for (const id of ids) {
      const board = boards.candidates.find((candidate) => candidate.id === id);
      if (!board) {
        failures.push(`idea ${id} has no board`);
        continue;
      }
      for (const role of ["hook", "last"] as const)
        if (!board.frames.some((frame) => frame.role === role)) failures.push(`idea ${id} has no ${role} frame`);
      for (const frame of board.frames) {
        const still = path.join(context.project.projectDir, "pipeline", "boards", `${id}-${frame.role}.jpg`);
        if (!isFile(still))
          failures.push(`${path.relative(context.project.rootDir, still)} is not rendered: run concept:boards`);
      }
    }
    for (const board of boards.candidates)
      if (!ids.includes(board.id)) failures.push(`board ${board.id} is not one of the ideas`);
    const sheet = fill(BOARDS_SHEET, context.tokens);
    if (sheet && isFile(abs(context.project, sheet)) && failures.length === 0) {
      const newest = Math.max(
        ...boards.candidates.flatMap((board) =>
          board.frames.map(
            (frame) =>
              statSync(path.join(context.project.projectDir, "pipeline", "boards", `${board.id}-${frame.role}.jpg`))
                .mtimeMs,
          ),
        ),
      );
      if (statSync(abs(context.project, sheet)).mtimeMs + 1000 < newest)
        failures.push("the contact sheet is older than its frames: run concept:boards");
    }
    return failures;
  },
  "script-from-review": (context) => scriptFromReviewProblems(context.project.projectDir),
  "ideas-differ": (context) => {
    const concept = raw(context, CONCEPT) as { candidates: { id: string; coreImage: string; openingFrame: string }[] };
    const distinct = (values: string[]) => new Set(values.map((value) => value.trim().toLowerCase())).size;
    const review = reviewRounds(context.project.projectDir, "ideas").at(-1)?.review;
    const ids = concept.candidates.map((item) => item.id);
    const twins = (review?.sameImage ?? [])
      .map((group) => group.filter((id) => ids.includes(id)))
      .filter((group) => group.length > 1);
    return [
      ...twins.map(
        (group) =>
          `${group.join(" and ")} are one image (the director's sameImage): run creative:pick, which takes the next idea`,
      ),
      ...(distinct(concept.candidates.map((item) => item.coreImage)) >= 3
        ? []
        : ["fewer than three different core images"]),
      ...(distinct(concept.candidates.map((item) => item.openingFrame)) >= 3
        ? []
        : ["fewer than three different opening frames"]),
    ];
  },
  "music-resolved": (context) => {
    const decision = raw(context, DECISION) as MusicDecision;
    if (decision.route === "silence") return decision.reason.trim() ? [] : ["silence needs a reason"];
    if (!decision.candidateId) return ["the decision names no candidate"];
    const shortlist = parsed(context.project, context.tokens, SHORTLIST, MusicShortlistSchema);
    const candidate = shortlist?.candidates.find((item) => item.id === decision.candidateId);
    if (!candidate) return [`candidate ${decision.candidateId} is not on a valid shortlist`];
    const source = candidateFile(context.project, context.tokens, decision);
    const failures =
      source && isFile(abs(context.project, source)) ? [] : [`candidate ${candidate.id} has no file on disk`];
    const cut = decision.cut;
    if (!cut)
      failures.push(
        "the decision carries no cut: run music --action record again; it cuts music/cue.wav from the shortlist's offset, or from --start and --duration",
      );
    else {
      const file = context.tokens["musicFile"];
      if (!file || hashOf(context.project, file) !== cut.sha256)
        failures.push(`${cut.file} is not the cut the decision recorded: record the decision again`);
      if (cut.from !== "file" && source && hashOf(context.project, source) !== cut.source.sha256)
        failures.push(`the cut was made from another file than candidate ${candidate.id}'s: record the decision again`);
    }
    if (decision.delivery === "embedded") {
      if (!candidate.originalPath) failures.push("an embedded track needs its original, a preview is never delivered");
      if (candidate.licence.commercial !== "yes")
        failures.push(
          `an embedded track needs a licence allowing commercial use, this one says ${candidate.licence.commercial}`,
        );
    }
    return failures;
  },
  "map-matches-music": (context) => {
    const map = raw(context, AUDIO_MAP) as AudioMap;
    const file = context.tokens["musicFile"];
    const hash = file ? hashOf(context.project, file) : undefined;
    return hash === map.source.sha256 ? [] : ["the audio map was built from another file than the chosen track's cut"];
  },
  "narration-ready": (context) => {
    const direction = NarrationDirectionSchema.parse(raw(context, NARRATION_DIRECTION));
    const script = ScriptSchema.parse(raw(context, SCRIPT));
    const problems = directionProblems(direction, script);
    if (problems.length) return problems;
    // Paid takes wait for the user's yes on this direction, or a standing policy spend decision; never a proxy (as on material).
    const relative = fill(NARRATION_DIRECTION, context.tokens)!;
    const hash = hashOf(context.project, relative);
    const approved =
      hash !== undefined &&
      spendApprovalEvents(context.project, "narration").some((event) => event.artefacts[relative] === hash);
    // Takes measured from an earlier direction (a rejected take) do not count: the revised direction is asked first.
    const narrationFile = fill(NARRATION, context.tokens);
    const narration =
      narrationFile && isFile(abs(context.project, narrationFile))
        ? NarrationSchema.parse(raw(context, NARRATION))
        : undefined;
    if (!narration || narration.direction.sha256 !== hash)
      return direction.route === "elevenlabs" && !approved
        ? []
        : [
            direction.route === "elevenlabs"
              ? `the user approved this direction: make take ${direction.take} with generate:voiceover --directed --take ${direction.take} within its maxCostUsd, then run narration:check`
              : `make the ${direction.route} takes and their word timings, then run narration:check`,
          ];
    return narrationFileProblems(context.project.rootDir, narration, script);
  },
  "material-sourced": (context) => {
    const material = raw(context, MATERIAL) as z.infer<(typeof ARTEFACT_SCHEMAS)["material"]>;
    // Once the user has approved this plan, what waited for that yes must be made: the step goes back to its owner.
    const relative = fill(MATERIAL, context.tokens)!;
    const hash = hashOf(context.project, relative);
    const approved =
      hash !== undefined &&
      spendApprovalEvents(context.project, "material").some((event) => event.artefacts[relative] === hash);
    return material.items.flatMap((item) => {
      const preparationIssues: string[] = [];
      if (item.modelPreparation && (approved || item.status === "acquired")) {
        try {
          const prepared = validatePreparation(context.project.id, item.modelPreparation, context.project.rootDir);
          preparationIssues.push(
            ...preparationAdmission(
              context.project.id,
              item.modelPreparation,
              prepared.receipt.endpoint,
              prepared.plan.input,
              context.project.rootDir,
            ).blockers.map((issue) => `${item.id}: ${issue}`),
          );
        } catch (error) {
          preparationIssues.push(`${item.id}: ${String(error)}`);
        }
      }
      // RFC 0003 §6.5: a made item stays bound to the revision it was made from (cheap state: approval bound to the
      // receipt digest) and its file is among that pack's outputs; a later profile or schema refresh does not reopen it.
      if (item.referencePack && item.status === "acquired") {
        try {
          const state = packState(context.project.id, item.referencePack.id, context.project.rootDir);
          if (state.status === "missing")
            preparationIssues.push(`${item.id}: pack ${item.referencePack.id} is missing`);
          else if (state.packSha256 !== item.referencePack.sha256)
            preparationIssues.push(`${item.id}: binds pack ${item.referencePack.id} at another revision`);
          else if (state.status !== "approved")
            preparationIssues.push(`${item.id}: pack ${item.referencePack.id} is not approved`);
          const made = item.path ? hashOf(context.project, item.path) : undefined;
          if (made && !packProducedOutput(context.project.id, item.referencePack, made, context.project.rootDir))
            preparationIssues.push(
              `${item.id}: ${item.path} is not among pack ${item.referencePack.id}'s outputs (outputs.json); generate it from the pack's request`,
            );
        } catch (error) {
          preparationIssues.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (item.referencePack && approved) {
        // Not made yet: the bound pack is current, this revision, and approved (full check).
        try {
          const pack = checkPack(context.project.id, item.referencePack.id, context.project.rootDir);
          if (pack.packSha256 !== item.referencePack.sha256)
            preparationIssues.push(`${item.id}: binds pack ${item.referencePack.id} at another revision`);
          preparationIssues.push(...pack.approvalStatus.problems.map((issue) => `${item.id}: ${issue}`));
        } catch (error) {
          preparationIssues.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return [
        ...preparationIssues,
        ...(approved && item.status === "pending" && (item.route === "generated" || item.route === "recorded")
          ? [
              `${item.id} is approved and still pending: ${item.route === "generated" ? "generate it within its maxCostUsd" : "record it"}, import it and mark it acquired`,
            ]
          : []),
        ...(item.status === "acquired" && (!item.path || !existsSync(abs(context.project, item.path)))
          ? [`${item.id} is marked acquired but ${item.path ?? "no path"} is not on disk`]
          : []),
        ...(item.route === "generated" && item.status !== "acquired" && item.maxCostUsd === undefined
          ? [`${item.id} is generated and has no maxCostUsd the user authorised`]
          : []),
        ...(item.route === "generated" && item.status === "acquired" && item.costUsd === null
          ? [`${item.id} was generated and records no costUsd`]
          : []),
      ];
    });
  },
  // RFC 0003 §10.1, AC16: each generated image or video has ready reference requirements and an approved pack, or
  // referencePlan "none" with a reason. Each failure names the requirement and the command that resolves it.
  "references-ready": (context) => {
    const material = raw(context, MATERIAL) as z.infer<(typeof ARTEFACT_SCHEMAS)["material"]>;
    // Two phases (§10.1): before the material approval only planned requirements; after it, ready inputs and approved packs.
    const relative = fill(MATERIAL, context.tokens)!;
    const hash = hashOf(context.project, relative);
    const approved =
      hash !== undefined &&
      spendApprovalEvents(context.project, "material").some((event) => event.artefacts[relative] === hash);
    const failures = referencesReadyFailures(context.project.id, material.items, context.project.rootDir, {
      approved,
    });
    // A film whose material was sealed or approved before reference packs existed (no references.json, no item bound
    // to a pack or a referencePlan) is grandfathered: advisories, not failures, and its approval is not voided.
    const legacy =
      failures.length > 0 &&
      !existsSync(path.join(context.project.projectDir, REFERENCES_FILE)) &&
      !material.items.some((item) => item.referencePack || item.referencePlan) &&
      (readReceipt(context.project, "material") !== undefined ||
        spendApprovalEvents(context.project, "material").length > 0);
    if (!legacy) return failures;
    context.advisories?.push(...failures.map((text) => `advisory (made before reference packs): ${text}`));
    return [];
  },
  "script-on-music": (context) => {
    if (context.silence) return [];
    const script = raw(context, SCRIPT) as { beats: { id: string; durationSec: number }[] };
    const links = raw(context, SCRIPT_MAP) as { beats: { beatId: string; sectionIndex: number }[] };
    const map = parsed(context.project, context.tokens, AUDIO_MAP, AudioMapSchema);
    if (!map) return ["no valid audio map"];
    const failures = mapOfCut(context, map);
    for (const beat of script.beats) {
      const link = links.beats.find((item) => item.beatId === beat.id);
      if (!link) failures.push(`beat ${beat.id} is tied to no section`);
      else if (link.sectionIndex >= map.sections.length)
        failures.push(`beat ${beat.id} names section ${link.sectionIndex}, the map has ${map.sections.length}`);
    }
    const total = script.beats.reduce((sum, beat) => sum + beat.durationSec, 0);
    if (total > map.source.durationSec)
      failures.push(`the beats run ${total} s, the track ${map.source.durationSec} s`);
    return failures;
  },
  "cues-on-map": (context) => {
    if (context.silence) return [];
    const sheet = raw(context, CUE_SHEET) as CueSheet;
    const map = parsed(context.project, context.tokens, AUDIO_MAP, AudioMapSchema);
    if (!map) return ["no valid audio map"];
    if (path.basename(sheet.audioMapPath) !== "audio-map.json")
      return [`the cue sheet was snapped to ${sheet.audioMapPath}`];
    const other = mapOfCut(context, map);
    if (other.length) return other;
    const late = sheet.cues.filter((cue) => cue.snappedSec + sheet.musicOffsetSec > map.source.durationSec);
    return late.length ? [`${late.length} cue(s) fall after the end of the track`] : [];
  },
  "plan-passed": (context) => {
    const vizPlan = parsed(context.project, context.tokens, MOTION_PLAN, MotionPlanSchema);
    if (vizPlan)
      try {
        assertVizMotionPlan(context.project.rootDir, context.project.id, vizPlan);
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
    const report = raw(context, PLAN_CHECK) as {
      verdict: string;
      findings?: { dimension: string; status: string; score: number; message: string }[];
    };
    if (report.verdict === "pass") return [];
    if (!context.promo || !report.findings?.length) return ["plan:check did not pass; read its report"];
    const waivable: readonly string[] = [...REFERENCE_PLAN_DIMENSIONS, ...PROMO_ADVISORY_PLAN_DIMENSIONS];
    const reference = report.findings.filter((finding) => waivable.includes(finding.dimension));
    const rest = report.findings.filter((finding) => !reference.includes(finding));
    const scored = rest.filter((finding) => !UNSCORED_PLAN_DIMENSIONS.includes(finding.dimension));
    const risk = scored.reduce((sum, finding) => sum + finding.score, 0) / Math.max(1, scored.length);
    const blocking = rest
      .filter((finding) => finding.status === "fail")
      .map((finding) => ({ id: finding.dimension, text: `${finding.dimension}: ${finding.message}` }));
    const advisory = reference
      .filter((finding) => finding.status === "fail")
      .map((finding) => ({ id: finding.dimension, text: `${finding.dimension}: ${finding.message}` }));
    const kept = splitAdvisory(context, [...blocking, ...advisory], waivable);
    if (kept.length) return kept;
    return risk >= PLAN_BLOCKING_RISK
      ? [`plan:check risk ${round2(risk)} without the reference's numbers is still too high; read its report`]
      : [];
  },
  "tournament-decided": (context) => {
    const plan = parsed(context.project, context.tokens, MOTION_PLAN, MotionPlanSchema);
    const build = parsed(context.project, context.tokens, BUILD, BuildRecordSchema);
    if (!plan || !build) return [];
    const problems = heroTournamentProblems(context.project.projectDir, context.project.rootDir, plan, build);
    return splitAdvisory(
      context,
      problems.map((text) => ({ id: "tournament-decided", text })),
      PROMO_ADVISORY_CHECKS,
    );
  },
  "motion-check-passed": (context) =>
    (raw(context, MOTION_CHECK) as { ok: boolean }).ok ? [] : ["motion:check did not pass; read its result"],
  "mix-passed": (context) => {
    const report = raw(context, MIX_REPORT) as {
      ok: boolean;
      metadata?: { analysis?: { integratedLufs?: number | null } };
    };
    if (!report.ok) return ["audio:mix did not succeed; read its result"];
    const value = report.metadata?.analysis?.integratedLufs;
    const range = (raw(context, TARGETS) as FilmTargets | undefined)?.loudnessLufs;
    if (typeof value !== "number" || !range) return [];
    return (range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max)
      ? [`the mix measures ${value} LUFS, outside the target`]
      : [];
  },
  "hero-sounds-selected": (context) => {
    if (context.silence) return [];
    const sheet = parsed(context.project, context.tokens, CUE_SHEET, CueSheetSchema);
    if (!sheet) return [];
    const sheetPath = fill(CUE_SHEET, context.tokens);
    const placed = raw(context, SOUND_CUES) as
      { events?: { label?: string; file: string; layerOf?: string }[] } | undefined;
    const publicDir = path.join(context.project.rootDir, "public");
    const { problems, advisories } = selectionProblems({
      sheet,
      sheetSha256: sheetPath ? hashOf(context.project, sheetPath) : undefined,
      selection: parsed(context.project, context.tokens, SFX_SELECTION, SfxSelectionSchema),
      ...(Array.isArray(placed?.events) ? { placed: placed.events } : {}),
      hashOf: (file) => hashOf(context.project, path.relative(context.project.rootDir, path.join(publicDir, file))),
    });
    context.advisories?.push(...advisories.map((text) => `advisory: ${text}`));
    return splitAdvisory(
      context,
      problems.map((text) => ({ id: "hero-sounds-selected", text })),
      PROMO_ADVISORY_CHECKS,
    );
  },
  "measure-passed": (context) => {
    const measure = raw(context, MEASURE) as FilmMeasure;
    const render = fill(RENDER, context.tokens);
    const hash = render ? hashOf(context.project, render) : undefined;
    if (hash !== measure.renderSha256) return ["the measurement is of another render"];
    if (measure.verdict === "pass") return [];
    return splitAdvisory(
      context,
      measure.legs
        .filter((leg) => leg.status === "fail")
        .map((leg) => ({ id: leg.id, text: `${leg.id}: ${leg.message}` })),
      REFERENCE_MEASURE_LEGS,
    );
  },
  "replica-reference-ready": (context) => {
    const targets = raw(context, TARGETS) as FilmTargets;
    if (targets.source !== "reference" || !targets.referenceId)
      return ["a replica's targets come from the reference: run film:targets --reference"];
    const directory = path.join(context.project.libraryRoot, targets.referenceId);
    if (!existsSync(directory)) return [];
    const report = validateReference(directory);
    const source = readJson(path.join(directory, "source.json")) as { rights?: { status?: string } } | undefined;
    const rights = parsed(context.project, context.tokens, RIGHTS, ReplicaRightsSchema);
    return [
      ...report.missingJudged.map((file) => `judged layer ${file} is missing: the reference-analyst writes it`),
      ...(rights && source?.rights?.status !== rights.status
        ? [
            `the reference's rights are ${source?.rights?.status ?? "unset"}, the user said ${rights.status}: run ref:add again with --rights ${rights.status}`,
          ]
        : []),
    ];
  },
  "replica-spec-passed": (context) => {
    const check = raw(context, REPLICA_CHECK) as {
      ok: boolean;
      message?: string;
      metadata?: { passed?: boolean; specSha256?: string; issues?: string[] };
    };
    if (!check.ok) return [`ref:replica-check failed: ${check.message ?? "read its result"}`];
    const spec = fill(REPLICA_SPEC, context.tokens);
    if (!spec || hashOf(context.project, spec) !== check.metadata?.specSha256)
      return ["the check is of another spec: run ref:replica-check again"];
    const failures = check.metadata?.passed
      ? []
      : check.metadata?.issues?.length
        ? check.metadata.issues.slice(0, 10)
        : ["ref:replica-check did not pass; read its result"];
    const parsedSpec = ReplicaSpecSchema.parse(raw(context, REPLICA_SPEC));
    const rights = parsed(context.project, context.tokens, RIGHTS, ReplicaRightsSchema);
    if (rights && parsedSpec.rights.status !== rights.status)
      failures.push(`the spec's rights are ${parsedSpec.rights.status}, the user said ${rights.status}`);
    if (context.tokens["referenceId"] && parsedSpec.reference !== context.tokens["referenceId"])
      failures.push(
        `the spec replicates ${parsedSpec.reference}, the targets measure ${context.tokens["referenceId"]}`,
      );
    return failures;
  },
  "replica-within-tolerance": (context) => {
    const result = raw(context, REPLICA_COMPARE) as {
      ok: boolean;
      message?: string;
      metadata?: { renderSha256?: string; summary?: { withinTolerance?: Record<string, MeasureCount> } };
    };
    if (!result.ok) return [`ref:compare failed: ${result.message ?? "read its result"}`];
    const within = result.metadata?.summary?.withinTolerance;
    if (!within) return ["ref:compare ran without --tolerance replica"];
    const render = fill(RENDER, context.tokens);
    if (!render || hashOf(context.project, render) !== result.metadata?.renderSha256)
      return ["the comparison is of another render"];
    return Object.entries(within)
      .filter(([, count]) => count.failed > 0)
      .map(
        ([measure, count]) =>
          `${measure}: ${count.failed} shot(s) outside the replica tolerance; its findings are in the result`,
      );
  },
};

// --- Receipts and approvals ---

const HashMap = z.record(z.string(), z.string());
const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  step: z.string(),
  inputs: HashMap,
  outputs: HashMap,
  at: z.string(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

/** A benchmark run's stand-in decision: it lets the chain advance for evaluation and never counts as the user's. */
export const PROXY_KINDS = { benchmark: "orchestrator-benchmark", policy: "user-policy" } as const;
export type ProxyKind = keyof typeof PROXY_KINDS;
/** A choice a benchmark proxy recorded in a file the user would answer in (music-decision.json): approved only as a proxy. */
export const PROXY_ANSWER_PREFIX = "proxy (benchmark): ";
/** Steps a proxy may never pass: the user's verdict on the film and the rights to copy one. A benchmark proxy on material advances the chain but never authorises spending; a policy does only through a standing spend decision (spendApprovalEvents). */
export const PROXY_REFUSED = ["human", "rights"] as const;

const ApprovalEventSchema = z.object({
  answer: z.string().min(1),
  at: z.string(),
  artefacts: HashMap,
  proxy: z.enum([PROXY_KINDS.benchmark, PROXY_KINDS.policy]).optional(),
  reason: z.string().optional(),
  decisionId: z.string().optional(),
  /** `console` when the studio console applied the user's decision (RFC 0004 D9). */
  channel: z.enum(["cli", "console"]).optional(),
});
const ApprovalFileSchema = z.object({
  schemaVersion: z.literal(1),
  step: z.string(),
  events: z.array(ApprovalEventSchema),
});

const readReceipt = (project: FilmProject, stepId: string): Receipt | undefined => {
  const result = ReceiptSchema.safeParse(readJson(receiptFile(project, stepId)));
  return result.success ? result.data : undefined;
};

const sameHashes = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

export const approvalEvents = (project: FilmProject, stepId: string) => {
  const result = ApprovalFileSchema.safeParse(readJson(approvalFile(project, stepId)));
  return result.success ? result.data.events : [];
};

/** The user's own approvals; a proxy's (benchmark or policy) are left out. */
export const userApprovalEvents = (project: FilmProject, stepId: string) =>
  approvalEvents(project, stepId).filter((event) => !event.proxy);

/** A policy approval stands only while its decision is in the ledger and the user has not revoked it. */
function standingPolicyIds(project: FilmProject): Set<string> {
  const entries = readDecisions(project.projectDir);
  const revoked = revokedDecisionIds(entries);
  return new Set(entries.flatMap((entry) => (entry.kind !== "revoked" && !revoked.has(entry.id) ? [entry.id] : [])));
}

/**
 * The approvals that authorise this step's spending: the user's own, and a policy's whose `spend` decision still
 * stands (film:policy --spend-usd). A benchmark proxy and a policy's judge or pre-answer approval never do.
 */
export function spendApprovalEvents(project: FilmProject, stepId: string) {
  const events = approvalEvents(project, stepId);
  if (!events.some((event) => event.proxy === PROXY_KINDS.policy)) return events.filter((event) => !event.proxy);
  const entries = readDecisions(project.projectDir);
  const revoked = revokedDecisionIds(entries);
  const spend = new Set(
    entries.flatMap((entry) =>
      entry.kind === "spend" && entry.step === stepId && !revoked.has(entry.id) ? [entry.id] : [],
    ),
  );
  return events.filter(
    (event) =>
      !event.proxy ||
      (event.proxy === PROXY_KINDS.policy && event.decisionId !== undefined && spend.has(event.decisionId)),
  );
}

/** Which approvals open this step's gate: a proxy's only where a proxy is allowed, a policy's only while it stands. */
const gateEvents = (project: FilmProject, stepId: string) => {
  if ((PROXY_REFUSED as readonly string[]).includes(stepId)) return userApprovalEvents(project, stepId);
  const events = approvalEvents(project, stepId);
  if (!events.some((event) => event.proxy === PROXY_KINDS.policy)) return events;
  const standing = standingPolicyIds(project);
  return events.filter(
    (event) => event.proxy !== PROXY_KINDS.policy || (event.decisionId !== undefined && standing.has(event.decisionId)),
  );
};

type ApprovedBy = { by: "user" | "proxy" | "policy"; reason?: string; decisionId?: string };

function approvedBy(project: FilmProject, stepId: string, outputs: Record<string, string>): ApprovedBy | undefined {
  const matching = gateEvents(project, stepId).filter((event) => sameHashes(event.artefacts, outputs));
  if (!matching.length) return undefined;
  if (matching.some((event) => !event.proxy)) return { by: "user" };
  const last = matching.at(-1)!;
  return {
    by: last.proxy === PROXY_KINDS.policy ? "policy" : "proxy",
    ...(last.reason ? { reason: last.reason } : {}),
    ...(last.decisionId ? { decisionId: last.decisionId } : {}),
  };
}

const proxyNote = (approval: ApprovedBy) =>
  approval.by === "proxy"
    ? `Passed by a benchmark proxy, not by the user${approval.reason ? `: ${approval.reason}` : ""}.`
    : approval.by === "policy"
      ? `Passed under the policy the user granted (decision ${approval.decisionId}${approval.reason ? `: ${approval.reason}` : ""}); revocable with film:revert.`
      : undefined;

/** The old state machine's approve entry carries no hash, so it counts only if it is newer than the artefact. */
function legacyApproved(project: FilmProject, step: ChainStep, artefacts: Record<string, string>): boolean {
  if (!step.legacyApprovalStage) return false;
  const state = PipelineStateSchema.safeParse(
    readJson(path.join(project.projectDir, "pipeline", "pipeline-state.json")),
  );
  if (!state.success) return false;
  const entries = state.data.history.filter(
    (entry) => entry.stage === step.legacyApprovalStage && entry.action === "approve",
  );
  const newest = Math.max(0, ...Object.keys(artefacts).map((file) => statSync(abs(project, file)).mtimeMs));
  return entries.some((entry) => Date.parse(entry.timestamp) >= newest);
}

// --- Step states ---

export type StepStatus =
  "done" | "skipped" | "ready" | "blocked" | "invalid" | "failing" | "unsealed" | "stale" | "awaiting-gate";

export type CriticGate = {
  /** The next critic's round. */
  round: number;
  latest?: Critique;
  latestPath?: string;
  action: "review" | "fix" | "ask" | "closed";
  why: string;
};

export type StepState = {
  id: string;
  status: StepStatus;
  reasons: string[];
  /** Root-relative path to hash, for every input present. */
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  missingInputs: string[];
  /** Earlier steps feeding this one that are not closed. */
  openUpstream: string[];
  critic?: CriticGate;
  firstAsk?: boolean;
  /** Promo profile: reference-number failures reported, not blocking. */
  advisories?: string[];
  /** Closed by a benchmark proxy's decision, not the user's. */
  proxied?: boolean;
};

const closed = (state: StepState | undefined) => state?.status === "done" || state?.status === "skipped";

/** Steps whose outputs feed this one, plus any it names. */
export function upstreamOf(step: ChainStep): string[] {
  const own = FILM_CHAIN.indexOf(step);
  const upstream = FILM_CHAIN.slice(0, own).filter((earlier) =>
    earlier.outputs.some((output) => step.inputs.some((input) => input.path === output.path)),
  );
  return [...new Set([...upstream.map((earlier) => earlier.id), ...(step.requires ?? [])])];
}

function evaluateCritic(
  project: FilmProject,
  step: ChainStep,
  tokens: Tokens,
): { gate?: CriticGate; invalid?: string } {
  if (step.critic!.review) return evaluateReview(project, step, tokens);
  const critic = step.critic!;
  const target = fill(critic.target, tokens);
  const targetHash = target ? hashOf(project, target) : undefined;
  const directory = path.join(project.projectDir, "pipeline", "critique");
  const pattern = new RegExp(`^${critic.prefix}(\\d+)\\.json$`);
  const rounds: { round: number; file: string; value: Critique }[] = [];
  for (const name of existsSync(directory) ? readdirSync(directory).sort() : []) {
    const match = pattern.exec(name);
    if (!match) continue;
    const file = path.join(directory, name);
    const result = CritiqueSchema.safeParse(readJson(file));
    if (!result.success)
      return {
        invalid: `${path.relative(project.rootDir, file)} does not match CritiqueSchema: ${result.error.issues[0]?.message ?? "invalid"}`,
      };
    if (result.data.round !== Number(match[1])) return { invalid: `${name} says round ${result.data.round}` };
    rounds.push({ round: result.data.round, file, value: result.data });
  }
  rounds.sort((a, b) => a.round - b.round);
  const latest = rounds.at(-1);
  const count = latest?.round ?? 0;
  const base = {
    round: count + 1,
    ...(latest ? { latest: latest.value, latestPath: path.relative(project.rootDir, latest.file) } : {}),
  };
  if (!latest) return { gate: { ...base, action: "review", why: "No critic has judged this yet." } };
  const onTarget = latest.value.renderSha256 === targetHash;
  if (onTarget && latest.value.verdict === "approve-for-human")
    return {
      gate: { ...base, action: "closed", why: "The latest critic approved this exact artefact for the human." },
    };
  if (onTarget && latest.value.verdict === "rethink-idea")
    return {
      gate: { ...base, action: "ask", why: "The critic asks to rethink the idea: that decision is the user's." },
    };
  if (count >= step.stop.maxRounds)
    return {
      gate: { ...base, action: "ask", why: `${count} critic rounds used, the limit is ${step.stop.maxRounds}.` },
    };
  const total = critiqueTotal;
  const previous = rounds.at(-2);
  if (onTarget && previous && total(latest.value) <= total(previous.value))
    return {
      gate: {
        ...base,
        action: "ask",
        why: `No progress: round ${latest.round} scores ${total(latest.value)}, round ${previous.round} scored ${total(previous.value)}.`,
      },
    };
  if (onTarget)
    return {
      gate: { ...base, action: "fix", why: `Round ${latest.round} says revise; its actions are not done yet.` },
    };
  return {
    gate: {
      ...base,
      action: "review",
      why: `The artefact changed since round ${latest.round}: a new critic judges it.`,
    },
  };
}

/** A creative director's rounds: ranked by code, bound to the pool's hash, sent back below the threshold. */
function evaluateReview(
  project: FilmProject,
  step: ChainStep,
  tokens: Tokens,
): { gate?: CriticGate; invalid?: string } {
  const kind = step.critic!.review!;
  const target = fill(step.critic!.target, tokens);
  const targetHash = target ? hashOf(project, target) : undefined;
  const rounds = reviewRounds(project.projectDir, kind);
  for (const round of rounds) {
    if (!round.review)
      return {
        invalid: `${path.relative(project.rootDir, round.file)} does not match CreativeReviewSchema: ${round.error}`,
      };
    if (round.review.round !== round.round)
      return { invalid: `${path.basename(round.file)} says round ${round.review.round}` };
  }
  const latest = rounds.at(-1);
  const count = latest?.round ?? 0;
  const base = { round: count + 1, ...(latest ? { latestPath: path.relative(project.rootDir, latest.file) } : {}) };
  if (!latest) return { gate: { ...base, action: "review", why: "No creative director has judged this pool yet." } };
  const review = latest.review!;
  const onTarget = review.targetSha256 === targetHash;
  if (!onTarget)
    return {
      gate: {
        ...base,
        action: "review",
        why: `The pool changed since round ${latest.round}: a new creative director judges it.`,
      },
    };
  const pool = CreativePoolSchema.safeParse(readJson(abs(project, target!)));
  const problems = pool.success
    ? reviewProblems(review, pool.data, judgedRecord(project.projectDir, kind, latest.round))
    : ["the pool does not validate"];
  if (problems.length) return { invalid: `${path.relative(project.rootDir, latest.file)}: ${problems.join("; ")}` };
  const outcome = reviewOutcome(rounds, roundsStart(project.projectDir, kind));
  if (outcome.action === "pass") return { gate: { ...base, round: count, action: "closed", why: outcome.why } };
  if (outcome.action === "stop") return { gate: { ...base, action: "ask", why: outcome.why } };
  return { gate: { ...base, action: "fix", why: outcome.why } };
}

type Routing = { type: FilmType; secondary?: FilmType; absent: Set<string> };

function evaluate(
  project: FilmProject,
  step: ChainStep,
  tokens: Tokens,
  prior: Map<string, StepState>,
  routing: Routing,
): StepState {
  const silence = isSilence(project, tokens);
  const base: StepState = {
    id: step.id,
    status: "ready",
    reasons: [],
    inputs: {},
    outputs: {},
    missingInputs: [],
    openUpstream: [],
  };
  if (step.skipWhenSilence && silence) return { ...base, status: "skipped", reasons: ["The user chose silence."] };
  if (!stepEnabled(step.id, routing.type, routing.secondary))
    return { ...base, status: "skipped", reasons: [`Not in the ${routing.type} route.`] };
  const skip = step.skippable ? readSkip(project, step.id) : undefined;
  if (skip) return { ...base, status: "skipped", reasons: [`Skipped: ${skip.reason}`] };

  const stepTokens: Tokens = { ...tokens };
  for (const input of step.inputs) {
    if (
      input.untracked ||
      (input.optional && input.path.includes("{previous")) ||
      (input.onlyFor && !input.onlyFor.includes(routing.type))
    )
      continue;
    const relative = fill(input.path, stepTokens);
    const hash = relative ? hashOf(project, relative) : undefined;
    if (relative && hash) base.inputs[relative] = hash;
    else if (!input.optional && !(input.unlessSilence && silence) && !routing.absent.has(input.path))
      base.missingInputs.push(relative ?? input.path);
  }
  base.openUpstream = upstreamOf(step).filter((id) => !closed(prior.get(id)));

  const blockedReasons = [
    ...base.openUpstream.map((id) => `Waits for step ${id}.`),
    ...base.missingInputs
      .filter((file) => !base.openUpstream.length || !file.includes("{"))
      .map((file) => `Input ${file} is missing.`),
  ];
  const blocked = base.openUpstream.length > 0 || base.missingInputs.length > 0;

  if (step.selfSealing) {
    if (blocked) return { ...base, status: "blocked", reasons: blockedReasons };
    for (const output of step.outputs) {
      const relative = fill(output.path, tokens);
      const hash = relative ? hashOf(project, relative) : undefined;
      if (relative && hash) base.outputs[relative] = hash;
    }
    if (step.critic) {
      const { gate, invalid } = evaluateCritic(project, step, tokens);
      if (invalid) return { ...base, status: "invalid", reasons: [invalid] };
      return gate?.action === "closed"
        ? { ...base, status: "done", critic: gate, reasons: [gate.why] }
        : { ...base, status: "awaiting-gate", critic: gate!, reasons: [gate!.why] };
    }
    const approval = approvedBy(project, step.id, base.outputs);
    // The user's later revise verdict on this exact render withdraws their acceptance of it.
    const accepted = gateEvents(project, step.id)
      .filter((event) => sameHashes(event.artefacts, base.outputs))
      .map((event) => event.at)
      .sort()
      .at(-1);
    const revision =
      step.id === "human" && approval
        ? revisionSince(project.projectDir, Object.values(base.outputs), accepted)
        : undefined;
    if (revision)
      return {
        ...base,
        status: "awaiting-gate",
        reasons: [
          `The user asked for changes (${revision.id}) after accepting this film: ask for their verdict again.`,
        ],
      };
    if (approval)
      return {
        ...base,
        status: "done",
        reasons: [proxyNote(approval) ?? "The user approved this exact artefact."],
        ...(approval.by !== "user" ? { proxied: true } : {}),
      };
    return { ...base, status: "awaiting-gate", reasons: ["Needs the user's verdict."] };
  }

  const present: string[] = [];
  const invalid: string[] = [];
  for (const output of step.outputs) {
    const relative = fill(output.path, tokens);
    const hash = relative ? hashOf(project, relative) : undefined;
    const required = !output.optional && !(output.unlessSilence && silence);
    if (!relative || !hash) {
      if (required) invalid.push(`${relative ?? output.path} is missing or empty.`);
      continue;
    }
    base.outputs[relative] = hash;
    present.push(relative);
    if (output.schema) {
      const result = ARTEFACT_SCHEMAS[output.schema].safeParse(readJson(abs(project, relative)));
      if (!result.success)
        invalid.push(
          `${relative} does not match the ${output.schema} schema: ${result.error.issues[0]?.path.join(".") || "root"}: ${result.error.issues[0]?.message ?? "invalid"}.`,
        );
    }
  }

  const receipt = readReceipt(project, step.id);
  if (!present.length && !receipt)
    return {
      ...base,
      status: blocked ? "blocked" : "ready",
      reasons: blocked ? blockedReasons : ["Nothing has been produced yet."],
    };
  if (receipt && base.openUpstream.length)
    return {
      ...base,
      status: "stale",
      reasons: base.openUpstream.map((id) => `Upstream step ${id} is not closed, so this result no longer stands.`),
    };
  if (blocked) return { ...base, status: "blocked", reasons: blockedReasons };

  if (step.firstAsk && !invalid.some((reason) => !reason.startsWith(fill(step.firstAsk!.until, tokens)!))) {
    const after = fill(step.firstAsk.after, tokens);
    const until = fill(step.firstAsk.until, tokens);
    if (after && until && base.outputs[after] && !base.outputs[until])
      return {
        ...base,
        status: "awaiting-gate",
        firstAsk: true,
        reasons: ["The shortlist is ready: the user chooses by ear."],
      };
  }
  if (invalid.length) return { ...base, status: "invalid", reasons: invalid };

  const context: CheckContext = {
    project,
    tokens,
    silence,
    promo: isPromo(project, tokens),
    advisories: [],
    step: step.id,
    sealed: Boolean(receipt),
  };
  const failures = step.done.checks.flatMap((check) => DONE_CHECKS[check](context));
  if (context.advisories!.length) base.advisories = context.advisories;
  if (failures.length) return { ...base, status: "failing", reasons: failures };

  if (!receipt)
    return { ...base, status: "unsealed", reasons: ["Outputs are valid; film:done has not recorded them."] };
  const inputsSame = sameHashes(receipt.inputs, base.inputs);
  const outputsSame = sameHashes(receipt.outputs, base.outputs);
  if (!outputsSame)
    return {
      ...base,
      status: "unsealed",
      reasons: [
        inputsSame
          ? "Outputs changed since film:done."
          : "Outputs were rebuilt after an input changed; film:done has not recorded them.",
      ],
    };
  if (!inputsSame) {
    const changed = [...new Set([...Object.keys(receipt.inputs), ...Object.keys(base.inputs)])].filter(
      (file) => receipt.inputs[file] !== base.inputs[file],
    );
    return {
      ...base,
      status: "stale",
      reasons: changed.map((file) => `Input ${file} changed since this step finished.`),
    };
  }

  if (step.gate === "user") {
    const approval =
      approvedBy(project, step.id, base.outputs) ??
      (legacyApproved(project, step, base.outputs) ? { by: "user" as const } : undefined);
    if (approval)
      return {
        ...base,
        status: "done",
        reasons: [proxyNote(approval) ?? "The user approved this exact artefact."],
        ...(approval.by !== "user" ? { proxied: true } : {}),
      };
    return { ...base, status: "awaiting-gate", reasons: ["Needs the user's approval of this exact artefact."] };
  }
  if (step.gate === "critic") {
    const { gate, invalid: bad } = evaluateCritic(project, step, tokens);
    if (bad) return { ...base, status: "invalid", reasons: [bad] };
    const approval = approvedBy(project, step.id, base.outputs);
    if (approval)
      return {
        ...base,
        status: "done",
        critic: gate,
        reasons: [proxyNote(approval) ?? "The user decided to go on with this exact artefact, past the critic."],
        ...(approval.by !== "user" ? { proxied: true } : {}),
      };
    return gate?.action === "closed"
      ? { ...base, status: "done", critic: gate, reasons: [gate.why] }
      : { ...base, status: "awaiting-gate", critic: gate!, reasons: [gate!.why] };
  }
  return { ...base, status: "done", reasons: [] };
}

export type ChainState = {
  tokens: Tokens;
  steps: StepState[];
  current?: StepState;
  filmType: FilmType;
  secondaryFilmType?: FilmType;
  typeDefaulted: boolean;
};

/** Derives every step from files, validation and hashes. Reads only. */
export function deriveChain(project: FilmProject): ChainState {
  project.hashes.clear();
  const tokens = baseTokens(project);
  const prior = new Map<string, StepState>();
  const { type, secondary } = filmTypes(project, tokens);
  const route = resolveRoute(type, secondary);
  const routing: Routing = {
    type: route.type,
    ...(route.secondary ? { secondary: route.secondary } : {}),
    absent: absentOutputs(route.type, route.secondary),
  };
  for (const step of FILM_CHAIN) prior.set(step.id, evaluate(project, step, tokens, prior, routing));
  const steps = chainFor(route.type).map((step) => prior.get(step.id)!);
  const current = steps.find((state) => !closed(state));
  return {
    tokens,
    steps,
    ...(current ? { current } : {}),
    filmType: route.type,
    ...(route.secondary ? { secondaryFilmType: route.secondary } : {}),
    typeDefaulted: route.defaulted,
  };
}

// --- Commands as text ---

const quote = (value: string) =>
  /^[\w./:,=@%+-]+$/.test(value) || /^<[^<>]*>$/.test(value) ? value : JSON.stringify(value);

const showPlaceholders = (template: string, tokens: Tokens) =>
  template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => tokens[name] ?? `<${name}>`);

export function renderCommand(command: ChainCommand, tokens: Tokens): string {
  const parts = [`pnpm ${command.alias}`];
  for (const [flag, value] of Object.entries(command.args)) {
    if (value === true) {
      parts.push(`--${flag}`);
      continue;
    }
    if (value.startsWith("?") && fill(value.slice(1), tokens) === undefined) continue;
    parts.push(`--${flag}`, quote(showPlaceholders(value.replace(/^\?/, ""), tokens)));
  }
  if (command.stdoutTo) parts.push(">", showPlaceholders(command.stdoutTo, tokens));
  return parts.join(" ");
}

export const doneCommand = (stepId: string): ChainCommand => ({
  alias: "film:done",
  purpose: "Record this step: it checks the done rule against the files.",
  args: { project: "{id}", step: stepId },
});

export const commandsFor = (step: ChainStep): ChainCommand[] =>
  step.selfSealing || step.sealedBy ? step.commands : [...step.commands, doneCommand(step.id)];

// --- Next action ---

export type NextAction = {
  action: "dispatch" | "run" | "ask" | "stop";
  step?: string;
  /** The route this film follows (src/lib/film/routes.ts). */
  filmType?: string;
  /** This step's tools for the film's type, also in the owner's brief. */
  tools?: string[];
  /** Promo profile: reference-number failures to tell the user; they do not block. */
  advisories?: string[];
  /** A study-only replica: never production-ready, whatever the user's verdict; delivery refuses it. */
  publication?: string;
  title?: string;
  why: string;
  agent?: string;
  definition?: { path: string; exists: boolean };
  briefCommand?: string;
  /** Several authors at once, one brief each: dispatch them in parallel. */
  dispatches?: { agent: string; lane: string; briefCommand: string }[];
  /** A new agent, never a resumed one. */
  fresh?: boolean;
  commands?: string[];
  question?: string;
  show?: string[];
  thenRun?: string[];
  /** Benchmark runs only: stands in for the user so the chain can be evaluated; never counts as their approval. */
  benchmarkProxy?: string;
  /** The guard's stop (step present-best): the crossed limits, the best kept version, what is unresolved, the spend, and the commands that raise a limit on the user's words. */
  limits?: { name: string; used: number; max: number; where?: string }[];
  best?: {
    file: string;
    sha256: string;
    measurePassed: boolean;
    criticTotal?: number;
    criticRound?: number;
    failingLegs?: string[];
  };
  unresolved?: { step: string; status: string; why: string }[];
  spend?: { usedUsd: number; ceilingUsd?: number; limitUsd?: number };
  raise?: string[];
  /** Autonomous projects: the policy decision this run records (pipeline/decisions.jsonl), revocable with film:revert. */
  policy?: { basis: string; evidence: Record<string, string> };
  orchestratorChecks?: ChainStep["orchestratorChecks"];
  forbidden?: string[];
  /** Guides, skills and AGENTS.md files for this step (src/lib/pipeline/route.ts), the bound playbook's first. */
  read?: string[];
  playbook?: PlaybookAnswer["playbook"];
  playbookHint?: string;
} & MemoryFields &
  CaptureFields;

const definitionOf = (project: FilmProject, agent: string) => {
  const file = `.agents/agents/${agent}.md`;
  return { path: file, exists: existsSync(path.join(project.repoRoot, file)) };
};

export function latestFixerRounds(project: FilmProject, stepId: string): string[] {
  const value = readJson(fixerRoundsFile(project));
  return isRecord(value) && Array.isArray(value[stepId]) ? (value[stepId] as string[]) : [];
}

/** One fixer round per distinct artefact hash. */
export function recordFixerRound(project: FilmProject, stepId: string, hash: string): void {
  const value = readJson(fixerRoundsFile(project));
  const rounds = isRecord(value) ? value : {};
  const list = Array.isArray(rounds[stepId]) ? (rounds[stepId] as string[]) : [];
  if (!list.includes(hash)) writeJsonAtomic(fixerRoundsFile(project), { ...rounds, [stepId]: [...list, hash] });
}

/** What the orchestrator does now, with what to read for it. Reads only. */
export function nextAction(project: FilmProject): NextAction {
  const decided = decideAction(project);
  const { captureMoment, ...action }: NextAction & { captureMoment?: CaptureMoment } =
    guardStop(project, decided) ?? decided;
  const { type, secondary } = filmTypes(project, baseTokens(project));
  const types = [type, secondary].filter((name): name is FilmType => name !== undefined);
  return {
    ...action,
    ...withPlaybook(project.projectDir, filmRead(action.step, types), action.step),
    ...memoryFields(project.projectDir, action.step),
    ...captureFields(project.projectDir, captureMoment, action.step),
  };
}

/**
 * The global safeguard (src/lib/film/guard.ts): a crossed limit turns the next action into a stop that presents the
 * best kept version, what is unresolved and the spend, with the command that raises the limit on the user's words.
 * Round limits stop only a dispatch; re-entries, active hours and spend stop everything. Silent while nothing is crossed.
 */
export function guardStop(
  project: FilmProject,
  decided: Pick<NextAction, "action" | "step">,
  check?: GuardCheck,
): NextAction | undefined {
  let guard: GuardCheck;
  try {
    guard = check ?? guardCheck(project.projectDir);
  } catch (error) {
    return {
      action: "stop",
      step: "present-best",
      why: `The project's policy cannot be read, so its limits are unknown: ${error instanceof Error ? error.message : String(error)} Fix pipeline/policy.json or ask the user to grant it again with film:policy.`,
    };
  }
  const crossed = stopping(guard, decided.action);
  if (!crossed.length) return undefined;
  const best = bestFilmVersion(project);
  const measure = parsed(project, baseTokens(project), MEASURE, ARTEFACT_SCHEMAS["film-measure"]);
  const failingLegs =
    best && measure?.renderSha256 === best.sha256
      ? measure.legs.filter((leg) => leg.status === "fail").map((leg) => leg.id)
      : [];
  const chain = deriveChain(project);
  const unresolved = chain.steps
    .filter((state) => !closed(state))
    .slice(0, 5)
    .map((state) => ({ step: state.id, status: state.status, why: state.reasons.join(" ") }));
  const policy = (() => {
    try {
      return currentPolicy(project.projectDir);
    } catch {
      return undefined;
    }
  })();
  const label = (limit: CrossedLimit) =>
    `${limit.name} ${limit.used}/${limit.max}${limit.where ? ` (step ${limit.where})` : ""}`;
  return {
    action: "stop",
    step: "present-best",
    title: "Present the best version",
    why: `A limit is reached: ${crossed.map(label).join("; ")}. Nothing more runs until the user decides: show them the best version so far, what is unresolved and the spend, and ask whether to raise the limit. Raising needs their own words; the counts are never reset.`,
    limits: crossed.map(({ name, used, max, where }) => ({ name, used, max, ...(where ? { where } : {}) })),
    ...(best
      ? {
          best: {
            file: best.file,
            sha256: best.sha256,
            measurePassed: best.measurePassed,
            ...(best.criticTotal !== undefined ? { criticTotal: best.criticTotal, criticRound: best.criticRound } : {}),
            ...(failingLegs.length ? { failingLegs } : {}),
          },
          show: [best.file],
        }
      : {}),
    unresolved,
    spend: {
      usedUsd: guard.usage.providerSpendUsd,
      ...(policy?.budget ? { ceilingUsd: policy.budget.ceilingUsd } : {}),
      ...(guard.limits.maxProviderSpendUsd !== undefined ? { limitUsd: guard.limits.maxProviderSpendUsd } : {}),
    },
    raise: crossed.map((limit) => raiseCommand(project.id, limit)),
  };
}

/** Steps whose question is a pick among options rather than a yes or no on one artefact. */
const CHOICE_STEPS = new Set(["concept", "music"]);

/** decideAction tags what the user's answer would be: a choice (a pick, or how to go on past a critic or fixer), a verdict, or the delivery once the chain is closed. */
function decideAction(project: FilmProject): NextAction & { captureMoment?: CaptureMoment } {
  const { tokens, current, steps, filmType, secondaryFilmType, typeDefaulted } = deriveChain(project);
  const advisories = [
    ...(typeDefaulted
      ? [`intake: brief.filmType is not set, so the film is routed as ${filmType}. Ask the user for the type.`]
      : []),
    ...steps.flatMap((state) => (state.advisories ?? []).map((line) => `${state.id}: ${line}`)),
  ];
  const studyOnly = replicaPublicationBlock(project.projectDir);
  const noted = {
    filmType: secondaryFilmType ? `${filmType}+${secondaryFilmType}` : filmType,
    ...(advisories.length ? { advisories } : {}),
    ...(studyOnly ? { publication: studyOnly } : {}),
  };
  if (!current)
    return {
      ...noted,
      ...(studyOnly ? {} : { captureMoment: "delivery" as const }),
      action: "stop",
      why: studyOnly
        ? `Every step is closed and the user accepted the film for study. ${studyOnly}`
        : "Every step is closed and the user accepted the film.",
    };
  const step = stepById(current.id)!;
  const why = current.reasons.join(" ");
  const policy = autonomousPolicy(project.projectDir);
  const forbiddenShared = policy ? FORBIDDEN_UNDER_POLICY : FORBIDDEN_FOR_ALL;
  const tools = toolLines(toolsFor(step.id, filmType, secondaryFilmType));
  const shared = {
    ...noted,
    step: step.id,
    title: step.title,
    why,
    ...(tools.length ? { tools } : {}),
    orchestratorChecks: step.orchestratorChecks,
    forbidden: [...forbiddenShared, ...step.forbidden],
  };
  const flags = `--project ${project.id} --step ${step.id}`;
  const approve = `pnpm film:approve ${flags} --answer "<the user's words>"`;
  /** A pre-answer the artefact no longer matches: ignored, said to the agent, and the user is asked. */
  let policyWarning: string | undefined;
  /** An autonomous policy passes this open gate: run film:approve --policy, which records the decision in the ledger. */
  const underPolicy = (): NextAction | undefined => {
    if (!policy) return undefined;
    const { basis, warning } = policyBasis(
      { projectDir: project.projectDir, rootDir: project.rootDir, tokens, steps },
      step.id,
      policy,
    );
    policyWarning = warning;
    if (!basis) return undefined;
    return {
      ...shared,
      action: "run",
      why: `${why} The user's policy covers it (${basis.kind}: ${basis.judgeVerdict}); the decision goes to pipeline/decisions.jsonl and the user can revoke it with film:revert.`,
      commands: [`pnpm film:approve ${flags} --policy --expect ${basis.expect}`],
      policy: { basis: basis.kind, evidence: basis.evidence },
    };
  };
  /** The music the policy pre-answered, recorded before anyone is asked; then the step is sealed. */
  const policyMusic = (): NextAction | undefined => {
    if (step.id !== "music") return undefined;
    const shortlist = parsed(project, tokens, SHORTLIST, MusicShortlistSchema);
    const record = musicRecordCommand(
      project.id,
      policy,
      shortlist?.candidates.map((candidate) => candidate.id),
    );
    if (!record) return undefined;
    return {
      ...shared,
      action: "run",
      why: `${why} The user pre-answered the music in their policy: record it, then seal the step.`,
      commands: [record, renderCommand(doneCommand(step.id), tokens)],
      policy: { basis: "preAnswer", evidence: { preAnswer: `musicRoute=${policy!.preAnswers.musicRoute}` } },
    };
  };
  const proxy = (PROXY_REFUSED as readonly string[]).includes(step.id)
    ? {}
    : { benchmarkProxy: `pnpm film:approve ${flags} --proxy benchmark --reason "<why the benchmark goes on>"` };
  const dispatch = (agent: string, role?: "critic" | "fixer"): NextAction => ({
    ...shared,
    action: "dispatch",
    agent,
    definition: definitionOf(project, agent),
    briefCommand: `pnpm film:brief ${flags}${role ? ` --role ${role}` : ""}`,
    ...(role === "critic" ? { fresh: true } : {}),
  });
  const fanOut = (target: ChainStep, why?: string, reopen = false): NextAction => {
    const due = laneStates(project.projectDir, target.fanOut!.kind).filter((lane) => lane.status !== "ready");
    // A stale pool reopens: every lane writes the new round (film:brief records it), not none of them.
    const lanes = due.length || !reopen ? due : laneStates(project.projectDir, target.fanOut!.kind);
    const base = `pnpm film:brief --project ${project.id} --step ${target.id}`;
    const dispatches = lanes.map((lane) => ({
      agent: target.owner,
      lane: lane.lane,
      briefCommand: `${base} --${target.fanOut!.flag} ${lane.lane}`,
    }));
    return {
      ...shared,
      ...(why ? { why } : {}),
      step: target.id,
      title: target.title,
      action: "dispatch",
      agent: target.owner,
      definition: definitionOf(project, target.owner),
      briefCommand: dispatches[0]?.briefCommand ?? base,
      dispatches,
      orchestratorChecks: target.orchestratorChecks,
      forbidden: [...forbiddenShared, ...target.forbidden],
    };
  };

  const repeats = current.status === "stale" ? repeatedAspects(project.projectDir, step.id) : [];
  if (repeats.length) {
    const said = repeats.map(
      (repeat) =>
        `${repeat.aspect}: before ${repeat.earlier.map((item) => `"${item.quote}" (${item.feedbackId})`).join(", ")}; now ${repeat.now.map((quote) => `"${quote}"`).join(", ")}`,
    );
    return {
      ...shared,
      captureMoment: "rejection",
      action: "ask",
      why: `The user sent the same objection to ${step.id} twice; the last answer did not hold. ${said.join(" ")}`,
      question: `This is the second time you raise this for ${step.title.toLowerCase()}. Say exactly what you want there: the line, the track, the shot.`,
      show: [`${path.relative(project.rootDir, project.projectDir)}/pipeline/feedback/open/${step.id}.json`],
      thenRun: [`pnpm feedback --project ${project.id} --step ${step.id} --clarify "<the user's words>"`],
    };
  }
  if (current.status === "blocked") return { ...shared, action: "stop", why: `Cannot continue: ${why}` };
  if (current.status === "unsealed")
    return { ...shared, action: "run", commands: [renderCommand(doneCommand(step.id), tokens)] };

  if (current.status === "awaiting-gate") {
    if (current.firstAsk && step.firstAsk) {
      const preAnswered = policyMusic();
      if (preAnswered) return preAnswered;
      return {
        ...shared,
        captureMoment: "choice",
        action: "ask",
        ...(step.id === "music"
          ? {
              benchmarkProxy: `pnpm music --action record --project ${project.id} --route <route> --candidate <candidate-id> --answer "${PROXY_ANSWER_PREFIX}<why>" --reason "benchmark proxy"`,
            }
          : {}),
        question: step.firstAsk.text,
        show: shownFiles(project, step.firstAsk.show, tokens),
        thenRun: [renderCommand(step.firstAsk.thenRun, tokens), renderCommand(doneCommand(step.id), tokens)],
      };
    }
    if (current.critic) {
      if (current.critic.action === "review") return dispatch(step.critic!.agent ?? CRITIC_AGENT, "critic");
      if (current.critic.action === "fix") {
        if (step.critic!.fixBy) return fanOut(stepById(step.critic!.fixBy)!, why);
        return step.fixerInputs ? dispatch(FIXER_AGENT, "fixer") : dispatch(step.owner);
      }
      return {
        ...shared,
        captureMoment: "choice",
        action: "ask",
        question: `${current.critic.why} How do you want to proceed?`,
        show: shownFiles(
          project,
          [step.critic!.target, ...(current.critic.latestPath ? [current.critic.latestPath] : [])],
          tokens,
        ),
        thenRun: [approve],
        ...proxy,
      };
    }
    const answer = step.question?.answerFrom ? answerIn(project, step, tokens) : undefined;
    if (answer?.startsWith(PROXY_ANSWER_PREFIX))
      return {
        ...shared,
        action: "run",
        why: `${why} The choice was recorded by a benchmark proxy, not the user.`,
        commands: [
          `pnpm film:approve ${flags} --proxy benchmark --reason ${JSON.stringify(answer.slice(PROXY_ANSWER_PREFIX.length) || "benchmark")}`,
        ],
      };
    // A policy's recorded answer is never the user's words: it passes only under the policy, else the user is asked.
    if (answer && !answer.startsWith(POLICY_ANSWER_PREFIX))
      return {
        ...shared,
        action: "run",
        why: `${why} The user already answered, in ${step.question!.answerFrom!.path}.`,
        commands: [`pnpm film:approve ${flags} --answer ${JSON.stringify(answer)}`],
      };
    const passed = underPolicy();
    if (passed) return passed;
    const decisions = step.id === "human" ? ledgerLines(project.projectDir) : [];
    const rescored =
      step.id === "concept"
        ? rescoreLines(project.projectDir, "ideas")
        : step.id === "script"
          ? rescoreLines(project.projectDir, "scripts")
          : [];
    return {
      ...shared,
      captureMoment: CHOICE_STEPS.has(step.id) ? "choice" : "verdict",
      ...(policyWarning ? { advisories: [...advisories, policyWarning] } : {}),
      action: "ask",
      question: [
        step.question!.text,
        ...rescored.map((line) => `Tell the user: ${line}`),
        ...(step.id === "human" && studyOnly
          ? [`Tell the user: ${studyOnly} Accepting it closes the chain; it does not make the film production-ready.`]
          : []),
        ...(decisions.length
          ? [
              `Tell the user what was decided under their policy, by step (any can be revoked: pnpm film:revert --project ${project.id} --decision <id> --answer "<the user's words>"):`,
              ...decisions,
            ]
          : []),
      ].join("\n"),
      show: shownFiles(project, step.question!.show, tokens),
      thenRun: [approve],
      ...proxy,
    };
  }

  if (
    step.critic?.review &&
    current.status === "invalid" &&
    current.reasons.some((reason) => reason.includes("creative-review/"))
  ) {
    return {
      ...shared,
      action: "run",
      why: `${why} If creative:rank refuses, the review is incomplete: the director who wrote it fixes what the refusal names; if it has ended, delete the review file and dispatch a new director for the round.`,
      commands: [`pnpm creative:rank --project ${project.id} --kind ${step.critic.review}`],
    };
  }

  if ((step.id === "measure" || step.id === "replica-compare") && current.status === "failing") {
    const render = fill(RENDER, tokens);
    const renderHash = render ? hashOf(project, render) : undefined;
    const report = step.id === "measure" ? MEASURE : REPLICA_COMPARE;
    const measure =
      step.id === "measure" ? parsed(project, tokens, MEASURE, ARTEFACT_SCHEMAS["film-measure"]) : undefined;
    const compare =
      step.id === "replica-compare"
        ? (raw({ project, tokens, silence: false }, REPLICA_COMPARE) as
            { ok?: boolean; metadata?: { renderSha256?: string } } | undefined)
        : undefined;
    const onRender =
      renderHash !== undefined &&
      (measure
        ? measure.verdict === "fail" && measure.renderSha256 === renderHash
        : compare?.ok === true && compare.metadata?.renderSha256 === renderHash);
    if (onRender) {
      if (latestFixerRounds(project, step.id).length >= step.stop.maxRounds)
        return {
          ...shared,
          captureMoment: "choice",
          action: "ask",
          question: `${step.stop.noProgress} How do you want to proceed?`,
          show: shownFiles(project, [report], tokens),
        };
      return dispatch(FIXER_AGENT, "fixer");
    }
  }

  const owner = stepOwnerKind(step);
  if (owner === "script")
    return { ...shared, action: "run", commands: commandsFor(step).map((command) => renderCommand(command, tokens)) };
  if (owner === "user")
    return {
      ...shared,
      captureMoment: "verdict",
      action: "ask",
      question: step.question!.text,
      show: shownFiles(project, step.question!.show, tokens),
      thenRun: step.commands.length ? commandsFor(step).map((command) => renderCommand(command, tokens)) : [approve],
    };
  if (step.fanOut && current.status === "stale" && !current.openUpstream.length) {
    const plan = planReopen(project.projectDir, step.fanOut.kind, current.reasons);
    if ("refused" in plan)
      return {
        ...shared,
        captureMoment: "rejection",
        action: "ask",
        why: plan.refused,
        question: `This is another round of ${step.title.toLowerCase()} from your feedback. Say exactly what you want there: the idea, the line, the picture.`,
        show: [`${path.relative(project.rootDir, project.projectDir)}/pipeline/feedback/open/${step.id}.json`],
        thenRun: [`pnpm feedback --project ${project.id} --step ${step.id} --clarify "<the user's words>"`],
      };
    const { round, cause } = plan.reopen;
    return fanOut(
      step,
      `${why} The pool reopens for round ${round} (${cause === "feedback" ? "the user's feedback" : "an upstream change"}): every ${step.fanOut.flag} writes it again.`,
      true,
    );
  }
  if (step.fanOut) return fanOut(step);
  if (current.status === "ready") {
    const preAnswered = policyMusic();
    if (preAnswered) return preAnswered;
  }
  return dispatch(step.owner);
}

/** The user's recorded answer, unless an earlier approval already used those words: a changed choice is asked again. */
function answerIn(project: FilmProject, step: ChainStep, tokens: Tokens): string | undefined {
  const answer = parsed(project, tokens, step.question!.answerFrom!.path, MusicDecisionSchema)?.askedUser.answer.trim();
  return answer && !approvalEvents(project, step.id).some((event) => event.answer === answer) ? answer : undefined;
}

function shownFiles(project: FilmProject, templates: string[], tokens: Tokens): string[] {
  const files = templates.flatMap((template) => fill(template, tokens) ?? []);
  const present = files.filter((file) => isFile(abs(project, file)));
  return present.length ? present : files;
}

// --- Writes ---

export class ChainRefusal extends Error {}

/** A step's state, refused when the film's type does not run it. */
export function stepState(project: FilmProject, stepId: string, chain: ChainState = deriveChain(project)): StepState {
  const state = chain.steps.find((item) => item.id === stepId);
  if (!state) throw new ChainRefusal(`Step ${stepId} is not in the ${chain.filmType} route.`);
  return state;
}

/** Records a finished step: outputs valid, done rule met, inputs and outputs hashed. */
export function sealStep(
  project: FilmProject,
  stepId: string,
  options: { unchangedBecause?: string; at?: string } = {},
): Receipt {
  const step = stepById(stepId);
  if (!step) throw new ChainRefusal(`Unknown step "${stepId}".`);
  if (step.selfSealing) throw new ChainRefusal(`Step ${stepId} is bound by its own record and takes no film:done.`);
  const state = stepState(project, stepId);
  if (state.status === "blocked") throw new ChainRefusal(`Step ${stepId} is blocked: ${state.reasons.join(" ")}`);
  if (state.status === "stale" && state.openUpstream.length)
    throw new ChainRefusal(`Step ${stepId} cannot finish: ${state.reasons.join(" ")}`);
  if (["ready", "invalid", "failing"].includes(state.status) || state.firstAsk)
    throw new ChainRefusal(`Step ${stepId} is not done: ${state.reasons.join(" ")}`);
  if (state.status === "stale") {
    if (!options.unchangedBecause?.trim())
      throw new ChainRefusal(
        `Step ${stepId} is stale and its outputs did not change: ${state.reasons.join(" ")} Re-run the owner. If the result is rightly identical, say why with --unchanged-because.`,
      );
    appendUserWords(
      project.projectDir,
      stepId,
      `Result unchanged after an input changed: ${options.unchangedBecause.trim()}`,
      options.at,
    );
  }
  // The user's open feedback is answered by this seal: addressed, or declined with the reason; the receipt does not keep it.
  const inputs = { ...state.inputs };
  const feedback = Object.keys(inputs).find((file) => file.endsWith(`pipeline/feedback/open/${stepId}.json`));
  if (feedback) {
    settleOpenFeedback(
      project.projectDir,
      stepId,
      state.status === "stale" ? { declinedBecause: options.unchangedBecause!.trim() } : {},
    );
    delete inputs[feedback];
  }
  const receipt: Receipt = {
    schemaVersion: 1,
    step: stepId,
    inputs,
    outputs: state.outputs,
    at: options.at ?? new Date().toISOString(),
  };
  writeJsonAtomic(receiptFile(project, stepId), receipt);
  return receipt;
}

/** Skips a skippable step with its reason, recorded in pipeline/skips/<step>.json and the spine. */
export function skipStep(
  project: FilmProject,
  stepId: string,
  reason: string,
  at: string = new Date().toISOString(),
): { reason: string; at: string } {
  const step = stepById(stepId);
  if (!step) throw new ChainRefusal(`Unknown step "${stepId}".`);
  if (!step.skippable) throw new ChainRefusal(`Step ${stepId} cannot be skipped.`);
  if (!reason.trim()) throw new ChainRefusal("A skip needs its reason.");
  const record = { reason: reason.trim(), at };
  writeJsonAtomic(skipFile(project, stepId), record);
  appendUserWords(project.projectDir, stepId, `Skipped: ${record.reason}`, at);
  return record;
}

/** Records the user's approval against the artefact's hash. Passes only a user gate that is actually open. */
/** What film:next shows at a step's gate: an answer that repeats it back is not the user's. */
export const approvalHints = (step: ChainStep): string[] =>
  [step.question?.text, step.firstAsk?.text].filter((text): text is string => Boolean(text));

export function approveStep(
  project: FilmProject,
  stepId: string,
  answer: string,
  at: string = new Date().toISOString(),
  proxy?: { kind: ProxyKind; reason: string; expect?: string },
  expectedOutputs?: Record<string, string>,
  decisionId?: string,
) {
  const step = stepById(stepId);
  if (!step) throw new ChainRefusal(`Unknown step "${stepId}".`);
  if (proxy) {
    if ((PROXY_REFUSED as readonly string[]).includes(stepId))
      throw new ChainRefusal(
        `A proxy cannot pass step ${stepId}: ${stepId === "rights" ? "the rights answer" : "the verdict on the film"} is the user's alone.`,
      );
    if (!proxy.reason.trim()) throw new ChainRefusal("A proxy decision needs its reason.");
    if (proxy.kind === "policy") {
      if (!decisionId)
        throw new ChainRefusal("A policy approval needs its ledger decision: run film:approve --policy.");
      // The basis is found again here, whoever calls: allowlist, judge or pre-answer, and the judged hash unchanged.
      const chain = deriveChain(project);
      const { basis, refused } = policyBasis(
        { projectDir: project.projectDir, rootDir: project.rootDir, tokens: chain.tokens, steps: chain.steps },
        stepId,
      );
      if (!basis) throw new ChainRefusal(refused!);
      if (proxy.expect !== undefined && proxy.expect !== basis.expect)
        throw new ChainRefusal(
          `The judged artefact changed since film:next (${proxy.expect.slice(0, 12)} named, ${basis.expect.slice(0, 12)} now): run film:next again.`,
        );
    }
  }
  if (step.gate !== "user" && step.gate !== "critic")
    throw new ChainRefusal(`Step ${stepId} has a ${step.gate} gate: the user does not approve it.`);
  if (!answer.trim()) throw new ChainRefusal("An approval needs the user's words.");
  const notWords = proxy ? undefined : userWordsProblem(answer, { hints: approvalHints(step) });
  if (notWords) throw new ChainRefusal(`An approval needs the user's own words, verbatim: ${notWords}.`);
  const state = stepState(project, stepId);
  if (
    expectedOutputs &&
    JSON.stringify(Object.entries(expectedOutputs).sort()) !== JSON.stringify(Object.entries(state.outputs).sort())
  )
    throw new ChainRefusal("Campaign approval artefacts changed; review a new package.");
  if (decisionId) {
    const existing = approvalEvents(project, stepId).find((event) => event.decisionId === decisionId);
    if (existing) {
      if (
        existing.answer !== answer.trim() ||
        existing.at !== at ||
        !sameHashes(existing.artefacts, state.outputs) ||
        existing.proxy
      )
        throw new ChainRefusal("Decision ID is bound to another approval.");
      return existing;
    }
  }
  if (step.gate === "critic" && state.status === "awaiting-gate" && state.critic?.action !== "ask")
    throw new ChainRefusal(`Step ${stepId} is with its critic, not the user: ${state.reasons.join(" ")}`);
  if (state.status !== "awaiting-gate" && state.status !== "done")
    throw new ChainRefusal(
      `Step ${stepId} is ${state.status}, so there is nothing to approve: ${state.reasons.join(" ")}`,
    );
  if (state.firstAsk)
    throw new ChainRefusal(`Step ${stepId} has no decision to approve yet: ${state.reasons.join(" ")}`);
  if (proxy?.kind === "policy" && (state.status !== "awaiting-gate" || step.gate !== "user"))
    throw new ChainRefusal(`Step ${stepId} has no open user gate for the policy to pass.`);
  const event = {
    answer: answer.trim(),
    at,
    artefacts: state.outputs,
    ...(proxy ? { proxy: PROXY_KINDS[proxy.kind], reason: proxy.reason.trim() } : {}),
    ...(decisionId ? { decisionId } : {}),
    ...(proxy ? {} : wordsChannel()),
  };
  writeJsonAtomic(approvalFile(project, stepId), {
    schemaVersion: 1,
    step: stepId,
    events: [...approvalEvents(project, stepId), event],
  });
  return event;
}

// --- pipeline-check ---

export const FILM_FINDING_CODES = [
  "FILM_OUTPUT_INVALID",
  "FILM_DONE_RULE_FAILED",
  "FILM_STEP_STALE",
  "FILM_STEP_UNRECORDED",
  "FILM_GATE_OPEN",
] as const;
export type FilmFindingCode = (typeof FILM_FINDING_CODES)[number];
export type FilmFinding = {
  severity: "error" | "warning" | "info";
  code: FilmFindingCode;
  stage?: string;
  message: string;
  ref?: { file: string; jsonPath?: string };
};

/**
 * Chain findings in the shape of `Finding` in scripts/pipeline-check.ts.
 * Returns nothing unless the project's own brief chose bespoke rendering, so template projects stay quiet.
 */
export function filmFindings(projectDir: string, options: FilmProjectOptions = {}): FilmFinding[] {
  if (!isBespokeProject(path.resolve(options.rootDir ?? process.cwd(), projectDir))) return [];
  const project = openFilmProject(projectDir, options);
  const findings: FilmFinding[] = [];
  const pick: Partial<Record<StepStatus, { severity: FilmFinding["severity"]; code: FilmFindingCode; fix: string }>> = {
    invalid: { severity: "error", code: "FILM_OUTPUT_INVALID", fix: "re-run the step's owner" },
    failing: { severity: "error", code: "FILM_DONE_RULE_FAILED", fix: "run film:next for the owner and its brief" },
    stale: { severity: "error", code: "FILM_STEP_STALE", fix: "run film:next; the step's owner runs again" },
    unsealed: { severity: "warning", code: "FILM_STEP_UNRECORDED", fix: "run film:done for this step" },
    "awaiting-gate": { severity: "info", code: "FILM_GATE_OPEN", fix: "run film:next for who passes this gate" },
  };
  for (const state of deriveChain(project).steps) {
    const rule = pick[state.status];
    if (rule)
      findings.push({
        severity: rule.severity,
        code: rule.code,
        stage: state.id,
        message: `Step ${state.id}: ${state.reasons.join(" ")} Fix: ${rule.fix}.`,
      });
  }
  return findings;
}
