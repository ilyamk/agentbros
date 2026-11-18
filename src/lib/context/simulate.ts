import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBrief, type BriefRole } from "../film/brief";
import { briefFileName, briefMetadata, dispatchLine } from "../film/brief-handoff";
import {
  CRITIC_AGENT,
  FIXER_AGENT,
  FORBIDDEN_FOR_ALL,
  LIBRARY_CATALOGUE,
  stepById,
  stepOwnerKind,
  type ChainStep,
} from "../film/chain";
import { scaffoldFilmProject } from "../film/project";
import { resolveRoute, toolLines, toolsFor, type RouteTool } from "../film/routes";
import {
  baseTokens,
  commandsFor,
  fill,
  nextAction,
  openFilmProject,
  renderCommand,
  type FilmProject,
} from "../film/state";
import { lanesFor } from "../film/studio";
import { decideNext, footageCaptureMoment, type FootageNext, type FootageState } from "../footage/next";
import {
  captureFields,
  detectRoute,
  filmRead,
  footageRead,
  memoryFields,
  ROUTE_COMMANDS,
  withPlaybook,
} from "../pipeline/route";
import { CliErrorObject } from "../cli";
import { resolvePlaybook } from "../playbooks/resolve";
import { listPlaybookIds, writeProjectPlaybook } from "../playbooks/project";
import { descriptionOf, isAgent, isSkill, repositoryText, type RepositoryText } from "./repository";
import type { FootageGoals } from "../../types/footage-goals";
import type { FilmType } from "../../types/pipeline";

/**
 * A whole-run estimate for one playbook: the orchestrator's single conversation, step by step in chain order, and the
 * fresh context of every subagent it dispatches. Next-step answers and briefs are rendered by the real code on a
 * scratch project in the system temporary directory; what a project would hold later (reports, artefacts, the user's
 * words) is estimated with the documented sizes below. Nothing is written in the repository and no provider is called.
 */

export type Rounds = "expected" | "worst";
export type SimulationOptions = {
  rounds: Rounds;
  /** A subagent's returned report. */
  reportBytes: number;
  /** One exchange at a user gate: the orchestrator's message and the user's reply. */
  userTurnBytes: number;
  /** The one-line JSON result of a command the orchestrator runs (other than next and film:brief, which are rendered). */
  commandBytes: number;
  /** A project artefact (JSON or Markdown) of a kind the table below does not name. */
  artefactBytes: number;
  /** Length of the user's recording on a footage route: the transcript chunks the shorts task reads scale with it. */
  sourceMinutes: number;
};

export const DEFAULT_SIMULATION: SimulationOptions = {
  rounds: "expected",
  reportBytes: 2048,
  userTurnBytes: 1024,
  commandBytes: 1024,
  artefactBytes: 4096,
  sourceMinutes: 20,
};

/** Text bytes of a project artefact by file name: estimates, larger than the minimal fixtures in tests/fixtures/film-chain. Media are 0 (images and audio are not text). */
export const ARTEFACT_BYTES: [RegExp, number][] = [
  [/\.(mp4|mov|wav|mp3|m4a|png|jpe?g|webp)$/i, 0],
  [/(^|\/)(audio-map|pools\/ideas|pools\/scripts|motion-plan)\.json$/, 16384],
  [/(^|\/)(creative-review\/[^/]+|critic-pack\/[^/]+\/pack)\.json$/, 16384],
  [/(^|\/)(cue-sheet|material|category-scan|motion-check)\.json$/, 8192],
  [/(^|\/)(brief|music-decision|ideas-key|scripts-key|plan-check|build|mix-report|film-measure)\.json$/, 2048],
  [/(^|\/)brief\.md$/, 2048],
];
/** A directory input (a reference's layers) or an unresolved token such as {previousCritique}. */
const DIRECTORY_BYTES = 32768;
/** footage: transcript text per recorded minute (about 150 words with ids and times) and a shorts brief.md. */
const TRANSCRIPT_BYTES_PER_MINUTE = 1536;
const SHORTS_BRIEF_BYTES = 4096;

export type EventKind =
  "boot" | "skill" | "answer" | "brief" | "report" | "read" | "shown" | "user" | "command" | "written";
export type SimEvent = { step: string; kind: EventKind; label: string; bytes: number; quarters: number };
export type DispatchPart = { label: string; bytes: number; estimatedTokens: number };
export type DispatchRow = {
  step: string;
  round: number;
  role: BriefRole;
  agent: string;
  lane?: string;
  bytes: number;
  estimatedTokens: number;
  parts: { boot: number; definition: number; brief: number; reads: number; inputs: number };
  files: string[];
};
export type StepRow = {
  step: string;
  addedBytes: number;
  addedTokens: number;
  cumulativeTokens: number;
  dispatches: number;
};
export type Contributor = { kind: EventKind; bytes: number; estimatedTokens: number };
export type TopItem = { step: string; kind: EventKind; label: string; bytes: number; estimatedTokens: number };
export type PlaybookSimulation = {
  id: string;
  route: "film" | "footage";
  rounds: Rounds;
  totalBytes: number;
  totalTokens: number;
  /** The first step at whose end the orchestrator's cumulative estimate reaches the threshold, or null. */
  crossings: { "100k": string | null; "200k": string | null };
  steps: StepRow[];
  contributors: Contributor[];
  topItems: TopItem[];
  dispatchCount: number;
  largestDispatches: DispatchRow[];
  missing: string[];
};
export type Simulation = {
  version: 1;
  estimate: string;
  options: SimulationOptions;
  playbooks: PlaybookSimulation[];
  skipped: { id: string; reason: string }[];
  assumptions: string[];
  limitations: string[];
};

export const THRESHOLDS = { "100k": 100_000, "200k": 200_000 } as const;

/** The v1 rule of measureText, kept in quarter tokens so a whole conversation rounds up once. */
export function quartersOf(text: string): number {
  let quarters = 0;
  for (const char of text) quarters += char.codePointAt(0)! <= 127 ? 1 : 4;
  return quarters;
}
const textEvent = (step: string, kind: EventKind, label: string, text: string): SimEvent => ({
  step,
  kind,
  label,
  bytes: Buffer.byteLength(text),
  quarters: quartersOf(text),
});
/** An estimated size, assumed ASCII: four bytes a token. */
const sizeEvent = (step: string, kind: EventKind, label: string, bytes: number): SimEvent => ({
  step,
  kind,
  label,
  bytes,
  quarters: bytes,
});
const ceilTokens = (quarters: number) => Math.ceil(quarters / 4);

export function artefactBytes(file: string, fallback: number): number {
  if (file.includes("{") || file.endsWith("/")) return DIRECTORY_BYTES;
  return ARTEFACT_BYTES.find(([pattern]) => pattern.test(file))?.[1] ?? fallback;
}

/** Rows, crossings and contributors from an ordered event list: pure, so rounds and crossings are testable on synthetic events. */
export function accumulate(
  id: string,
  route: "film" | "footage",
  rounds: Rounds,
  events: SimEvent[],
  dispatches: DispatchRow[],
  missing: string[] = [],
): PlaybookSimulation {
  const steps: StepRow[] = [];
  const crossings: PlaybookSimulation["crossings"] = { "100k": null, "200k": null };
  let quarters = 0;
  let bytes = 0;
  for (const event of events) {
    let row = steps.at(-1);
    if (!row || row.step !== event.step)
      steps.push((row = { step: event.step, addedBytes: 0, addedTokens: 0, cumulativeTokens: 0, dispatches: 0 }));
    row.addedBytes += event.bytes;
    row.addedTokens += event.quarters;
    quarters += event.quarters;
    bytes += event.bytes;
    row.cumulativeTokens = ceilTokens(quarters);
  }
  for (const row of steps) {
    row.addedTokens = ceilTokens(row.addedTokens);
    row.dispatches = dispatches.filter((dispatch) => dispatch.step === row.step).length;
    for (const [name, limit] of Object.entries(THRESHOLDS) as [keyof typeof THRESHOLDS, number][])
      if (crossings[name] === null && row.cumulativeTokens >= limit) crossings[name] = row.step;
  }
  const byKind = new Map<EventKind, { bytes: number; quarters: number }>();
  for (const event of events) {
    const entry = byKind.get(event.kind) ?? { bytes: 0, quarters: 0 };
    entry.bytes += event.bytes;
    entry.quarters += event.quarters;
    byKind.set(event.kind, entry);
  }
  const contributors = [...byKind]
    .map(([kind, entry]) => ({ kind, bytes: entry.bytes, estimatedTokens: ceilTokens(entry.quarters) }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.kind.localeCompare(b.kind));
  const topItems = events
    .map((event) => ({
      step: event.step,
      kind: event.kind,
      label: event.label,
      bytes: event.bytes,
      estimatedTokens: ceilTokens(event.quarters),
    }))
    .sort(
      (a, b) => b.estimatedTokens - a.estimatedTokens || a.step.localeCompare(b.step) || a.label.localeCompare(b.label),
    )
    .slice(0, 10);
  const largestDispatches = [...dispatches]
    .sort(
      (a, b) =>
        b.estimatedTokens - a.estimatedTokens ||
        a.step.localeCompare(b.step) ||
        (a.lane ?? "").localeCompare(b.lane ?? ""),
    )
    .slice(0, 5);
  return {
    id,
    route,
    rounds,
    totalBytes: bytes,
    totalTokens: ceilTokens(quarters),
    crossings,
    steps,
    contributors,
    topItems,
    dispatchCount: dispatches.length,
    largestDispatches,
    missing: [...new Set(missing)].sort(),
  };
}

// --- Shared context ---

type Context = {
  root: string;
  repo: RepositoryText;
  options: SimulationOptions;
  /** Root AGENTS.md, skill and agent descriptions and literal MCP instructions: the claude-code boot row. */
  boot: string;
  events: SimEvent[];
  dispatches: DispatchRow[];
  /** Files the orchestrator has read in this conversation: each counted once. */
  seen: Set<string>;
  missing: string[];
  /** The scratch root: no measured text may name it, or sizes would differ between machines. */
  scratch: string;
};

/** Refuses text that names the scratch directory (also through /private on macOS). */
function clean(context: Context, text: string): string {
  const real = existsSync(context.scratch) ? realpathSync(context.scratch) : context.scratch;
  if (context.scratch && (text.includes(context.scratch) || text.includes(real)))
    throw new Error(`The simulation measured a scratch path in: ${text.slice(0, 200)}`);
  return text;
}

const PROJECT = "simulated";

/** Tracked files under a path (a directory expands to its files, as budget rows do). */
function repoFiles(repo: RepositoryText, file: string): string[] {
  const clean = file.replace(/\/$/, "");
  const children = repo.files.filter((name) => name.startsWith(`${clean}/`));
  return children.length ? children : repo.files.includes(clean) ? [clean] : [];
}

function readOnce(context: Context, step: string, file: string, kind: EventKind = "read"): void {
  const files = repoFiles(context.repo, file);
  if (!files.length) context.missing.push(file);
  for (const name of files) {
    if (context.seen.has(name)) continue;
    context.seen.add(name);
    context.events.push(textEvent(step, kind, name, context.repo.read(name) ?? ""));
  }
}

/** What `pnpm next` prints for this answer: runScript's one-line envelope around next.ts's metadata. elapsedMs is fixed at 0. */
function nextEnvelope(projectDir: string, route: "film" | "footage", answer: object): string {
  const { detectedBy } = detectRoute(projectDir);
  const bound = withPlaybook(projectDir);
  const command = ROUTE_COMMANDS[route];
  const metadata = {
    projectId: PROJECT,
    route,
    detectedBy,
    playbook: bound.playbook,
    command: `pnpm ${command.alias} --project ${PROJECT}`,
    guide: command.guide,
    next: answer,
  };
  return JSON.stringify({ ok: true, outputs: [], metadata, elapsedMs: 0 });
}

/** Inputs a brief tells its agent to search with a command rather than read: counted as one command result. */
export const SEARCHED = new Map([[LIBRARY_CATALOGUE, "pnpm library:list --query"]]);

const BRIEF_SECTIONS_READ = new Set(["Inputs", "Inputs, and nothing else", "Rules, read before you start", "Goal"]);

/**
 * Paths a brief tells its agent to read: everything before the first section, and the goal, inputs, rules and lane
 * sections; a lane's "Write round N to <file>" line names its output, not a read.
 */
export function briefReads(prompt: string): string[] {
  const found: string[] = [];
  let section: string | undefined;
  for (const line of prompt.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (section !== undefined && !BRIEF_SECTIONS_READ.has(section) && !section.startsWith("Your ")) continue;
    if (/^Write /.test(line)) continue;
    for (const match of line.matchAll(/(?:^|[\s`(])((?:\{[a-zA-Z]+\}|[\w.-]+\/)[\w./{}-]*)/g)) {
      const file = match[1]!.replace(/[.,;:]+$/, "");
      if ((file.includes("/") || /^\{[a-zA-Z]+\}$/.test(file)) && !file.startsWith("http")) found.push(file);
    }
  }
  return [...new Set(found)];
}

function dispatch(
  context: Context,
  step: string,
  round: number,
  role: BriefRole,
  agent: string,
  rendered: { step: string; prompt: string },
  tools: RouteTool[],
  lane?: string,
): void {
  const { repo, options } = context;
  const prompt = clean(context, rendered.prompt);
  const file = `public/projects/${PROJECT}/pipeline/briefs/${briefFileName(rendered.step, lane, role)}`;
  // By reference: the orchestrator holds film:brief's envelope and passes one line; the subagent reads the brief file.
  const envelope = JSON.stringify({
    ok: true,
    outputs: [file],
    metadata: briefMetadata({
      projectId: PROJECT,
      step: rendered.step,
      role,
      agent,
      ...(lane ? { lane } : {}),
      file,
      prompt,
    }),
    elapsedMs: 0,
  });
  const handoff = dispatchLine(agent, file);
  const definitionFile = `.agents/agents/${agent}.md`;
  const definition = repo.read(definitionFile) ?? "";
  if (!repo.read(definitionFile)) context.missing.push(definitionFile);
  const toolFiles = tools.flatMap((tool) =>
    tool.kind === "skill" ? [`.agents/skills/${tool.id}/SKILL.md`] : tool.kind === "path" ? [tool.id] : [],
  );
  const reads = new Set<string>();
  let inputBytes = 0;
  const files: string[] = [];
  for (const file of [...briefReads(prompt), ...toolFiles]) {
    if (file === definitionFile) continue;
    if (SEARCHED.has(file)) {
      // Searched with its command, not read whole: one command result.
      inputBytes += options.commandBytes;
      files.push(`${file} (${SEARCHED.get(file)})`);
      continue;
    }
    const tracked = repoFiles(repo, file);
    if (tracked.length) {
      for (const name of tracked) reads.add(name);
      continue;
    }
    if (file.startsWith(`public/projects/${PROJECT}/`) || file.startsWith(`out/${PROJECT}/`) || file.startsWith("{")) {
      const local = file.startsWith("public/") ? path.join(context.scratch, file) : undefined;
      const bytes =
        local && /spine\.md$/.test(file) && existsSync(local)
          ? Buffer.byteLength(readFileSync(local, "utf8"))
          : artefactBytes(file, options.artefactBytes);
      inputBytes += bytes;
      files.push(file);
    }
  }
  const readText = [...reads]
    .sort()
    .map((name) => repo.read(name) ?? "")
    .join("");
  const quarters =
    quartersOf(context.boot) +
    quartersOf(definition) +
    quartersOf(handoff) +
    quartersOf(prompt) +
    quartersOf(readText) +
    inputBytes;
  context.dispatches.push({
    step,
    round,
    role,
    agent,
    ...(lane ? { lane } : {}),
    bytes:
      Buffer.byteLength(context.boot) +
      Buffer.byteLength(definition) +
      Buffer.byteLength(handoff) +
      Buffer.byteLength(prompt) +
      Buffer.byteLength(readText) +
      inputBytes,
    estimatedTokens: ceilTokens(quarters),
    parts: {
      boot: ceilTokens(quartersOf(context.boot)),
      definition: ceilTokens(quartersOf(definition)),
      brief: ceilTokens(quartersOf(handoff) + quartersOf(prompt)),
      reads: ceilTokens(quartersOf(readText)),
      inputs: ceilTokens(inputBytes),
    },
    files: [definitionFile, file, ...[...reads].sort(), ...files],
  });
  const who = `${agent}${lane ? ` ${lane}` : ""}${role === "owner" ? "" : ` (${role} round ${round})`}`;
  context.events.push(textEvent(step, "brief", `${who} film:brief result`, clean(context, envelope)));
  context.events.push(textEvent(step, "brief", `${who} Agent prompt`, handoff));
  context.events.push(sizeEvent(step, "report", `${who} report`, options.reportBytes));
}

// --- Film route ---

type FilmScratch = { project: FilmProject; types: FilmType[] };

function filmAnswer(
  scratch: FilmScratch,
  step: ChainStep,
  kind: "dispatch" | "critic" | "fixer" | "fanOut" | "run" | "ask",
  why: string,
): object {
  const { project, types } = scratch;
  const tokens = baseTokens(project);
  const target = kind === "fanOut" && step.critic?.fixBy ? stepById(step.critic.fixBy)! : step;
  const flags = `--project ${project.id} --step ${target.id}`;
  const tools = toolLines(toolsFor(target.id, types[0]!, types[1]));
  const shared = {
    filmType: types.join("+"),
    step: target.id,
    title: target.title,
    why,
    ...(tools.length ? { tools } : {}),
    orchestratorChecks: target.orchestratorChecks,
    forbidden: [...FORBIDDEN_FOR_ALL, ...target.forbidden],
  };
  const definition = (agent: string) => ({ path: `.agents/agents/${agent}.md`, exists: true });
  const approve = `pnpm film:approve ${flags} --answer "<the user's words>"`;
  let action: object;
  if (kind === "fanOut") {
    const base = `pnpm film:brief --project ${project.id} --step ${target.id}`;
    const dispatches = lanesFor(project.projectDir, target.fanOut!.kind).map((lane) => ({
      agent: target.owner,
      lane,
      briefCommand: `${base} --${target.fanOut!.flag} ${lane}`,
    }));
    action = {
      ...shared,
      action: "dispatch",
      agent: target.owner,
      definition: definition(target.owner),
      briefCommand: dispatches[0]?.briefCommand ?? base,
      dispatches,
    };
  } else if (kind === "run")
    action = { ...shared, action: "run", commands: commandsFor(step).map((command) => renderCommand(command, tokens)) };
  else if (kind === "ask") {
    const question = step.question!;
    const thenRun =
      step.owner === "user" && step.commands.length
        ? commandsFor(step).map((command) => renderCommand(command, tokens))
        : [approve];
    action = {
      ...shared,
      action: "ask",
      question: question.text,
      show: question.show.map((file) => fill(file, tokens) ?? file),
      thenRun,
      benchmarkProxy: `pnpm film:approve ${flags} --proxy benchmark --reason "<why the benchmark goes on>"`,
    };
  } else {
    const agent =
      kind === "critic" ? (step.critic!.agent ?? CRITIC_AGENT) : kind === "fixer" ? FIXER_AGENT : step.owner;
    action = {
      ...shared,
      action: "dispatch",
      agent,
      definition: definition(agent),
      briefCommand: `pnpm film:brief ${flags}${kind === "dispatch" ? "" : ` --role ${kind}`}`,
      ...(kind === "critic" ? { fresh: true } : {}),
    };
  }
  const moment = kind === "ask" ? "verdict" : undefined;
  return {
    ...action,
    ...withPlaybook(project.projectDir, filmRead(target.id, types), target.id),
    ...memoryFields(project.projectDir, target.id),
    ...captureFields(project.projectDir, moment, target.id),
  };
}

function answerEvent(
  context: Context,
  projectDir: string,
  route: "film" | "footage",
  stepId: string,
  label: string,
  answer: object,
): void {
  context.events.push(textEvent(stepId, "answer", label, clean(context, nextEnvelope(projectDir, route, answer))));
  for (const file of (answer as { read?: string[] }).read ?? []) readOnce(context, stepId, file);
}

/** The fixture artefacts a film has by its middle steps, so later briefs resolve their tokens (audio map, music, critique paths) as a real project's do. */
const FILM_FIXTURES = [
  "brief.json",
  "product-truth.json",
  "film-targets.json",
  "music-shortlist.json",
  "music-decision.json",
  "audio-map.json",
  "script.json",
  "script-music-map.json",
  "concept.json",
  "design.json",
  "motion-plan.json",
  "cue-sheet.json",
  "plan-check.json",
  "build.json",
  "motion-check.json",
  "mix-plan.json",
  "mix-report.json",
];

function placeFixtures(root: string, scratch: FilmScratch, profile: string, types: FilmType[]): void {
  const fixtures = path.join(root, "tests/fixtures/film-chain");
  const pipeline = path.join(scratch.project.projectDir, "pipeline");
  for (const file of FILM_FIXTURES) {
    const source = path.join(fixtures, file);
    if (!existsSync(source)) continue;
    if (file === "brief.json") {
      const brief = {
        ...(JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>),
        profile,
        filmType: types[0],
        ...(types[1] ? { secondaryFilmType: types[1] } : {}),
      };
      writeFileSync(path.join(pipeline, file), JSON.stringify(brief));
    } else copyFileSync(source, path.join(pipeline, file));
  }
  const track = path.join(fixtures, "track.wav");
  if (existsSync(track)) {
    mkdirSync(path.join(scratch.project.projectDir, "music"), { recursive: true });
    copyFileSync(track, path.join(scratch.project.projectDir, "music/track.wav"));
  }
}

type FilmRoute = { filmType: FilmType; secondaryFilmType?: FilmType; start: string };

/** A new film project bound to the playbook, as film:init leaves it, under the scratch root. */
function filmScratch(
  root: string,
  playbookId: string,
  route: FilmRoute,
  scratchRoot: string,
): FilmScratch & { profile: string; steps: string[] } {
  const profile = /--profile promo\b/.test(route.start) ? "promo" : "full";
  const projectDir = path.join(scratchRoot, "public/projects", PROJECT);
  scaffoldFilmProject(projectDir, PROJECT, [], {
    repoRoot: root,
    profile,
    filmType: route.filmType,
    ...(route.secondaryFilmType ? { secondaryFilmType: route.secondaryFilmType } : {}),
  });
  writeProjectPlaybook(projectDir, playbookId, "agent");
  const project = openFilmProject(projectDir, { rootDir: scratchRoot, repoRoot: root });
  const resolved = resolveRoute(route.filmType, route.secondaryFilmType);
  return {
    project,
    types: [resolved.type, ...(resolved.secondary ? [resolved.secondary] : [])],
    profile,
    steps: resolved.steps.map((step) => step.id),
  };
}

/**
 * The real first answer of a new film (nextAction) and the one the simulation assembles for the same step, both as
 * the pnpm next envelope: a test holds them close, so the assembled answers of later steps cannot drift unnoticed.
 */
export function firstFilmAnswers(root: string, playbookId: string): { step: string; real: string; assembled: string } {
  const route = resolvePlaybook(playbookId, root).playbook.route;
  if (route.kind !== "film") throw new Error(`Playbook ${playbookId} is not a film route.`);
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "context-simulate-"));
  try {
    const scratch = filmScratch(root, playbookId, route, scratchRoot);
    const step = stepById(scratch.steps[0]!)!;
    const real = nextAction(scratch.project);
    const assembled = filmAnswer(scratch, step, "dispatch", real.why ?? "");
    const envelope = (answer: object) =>
      nextEnvelope(scratch.project.projectDir, "film", answer).replaceAll(scratchRoot, "<scratch>");
    return { step: step.id, real: envelope(real), assembled: envelope(assembled) };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function simulateFilm(context: Context, playbookId: string, route: FilmRoute, scratchRoot: string): void {
  const { options } = context;
  const scratch = filmScratch(context.root, playbookId, route, scratchRoot);
  const { project, types, profile } = scratch;
  const projectDir = project.projectDir;
  const resolved = resolveRoute(route.filmType, route.secondaryFilmType);
  const worst = options.rounds === "worst";
  const brief = (stepId: string, role: BriefRole, round: number, lane?: string) => ({
    step: stepId,
    ...renderBrief(project, stepId, {
      role,
      round,
      ...(lane ? { lane } : {}),
      ...(round > 1
        ? { previousCritique: `public/projects/${PROJECT}/pipeline/critique/round-${round - 1}.json` }
        : {}),
    }),
  });
  const owner = (step: ChainStep, round: number, lanes?: ChainStep) => {
    const target = lanes ?? step;
    if (target.fanOut)
      for (const lane of lanesFor(projectDir, target.fanOut.kind))
        dispatch(
          context,
          step.id,
          round,
          "owner",
          target.owner,
          brief(target.id, "owner", round, lane),
          toolsFor(target.id, types[0]!, types[1]),
          lane,
        );
    else
      dispatch(
        context,
        step.id,
        round,
        "owner",
        target.owner,
        brief(target.id, "owner", round),
        toolsFor(target.id, types[0]!, types[1]),
      );
  };
  const commands = (step: ChainStep, label: string) => {
    for (const command of commandsFor(step))
      context.events.push(sizeEvent(step.id, "command", `${label}: ${command.alias}`, options.commandBytes));
  };
  const answer = (step: ChainStep, kind: Parameters<typeof filmAnswer>[2], label: string, why: string) =>
    answerEvent(context, projectDir, "film", step.id, label, filmAnswer(scratch, step, kind, why));
  const userGate = (step: ChainStep) => {
    for (const file of step.question?.show ?? []) {
      const shown = fill(file, baseTokens(project)) ?? file;
      if (repoFiles(context.repo, shown).length) readOnce(context, step.id, shown, "shown");
      else context.events.push(sizeEvent(step.id, "shown", shown, artefactBytes(shown, options.artefactBytes)));
    }
    context.events.push(sizeEvent(step.id, "user", `${step.id} question and answer`, options.userTurnBytes));
  };

  let first = true;
  for (const resolvedStep of resolved.steps) {
    const step = stepById(resolvedStep.id)!;
    const kind = stepOwnerKind(step);
    const rounds = worst ? step.stop.maxRounds : 1;
    const ready = `${step.title}: its inputs are ready.`;
    if (first) {
      // The real answer: a new project's first step needs no earlier state.
      answerEvent(context, projectDir, "film", step.id, "next (dispatch)", nextAction(project));
      owner(step, 1);
      placeFixtures(context.root, scratch, profile, types);
      first = false;
    } else if (step.owner === CRITIC_AGENT) {
      // Judged by the critic loop below.
    } else if (kind === "agent") {
      answer(step, step.fanOut ? "fanOut" : "dispatch", "next (dispatch)", ready);
      owner(step, 1);
    } else if (kind === "script") {
      answer(step, "run", "next (run)", ready);
      commands(step, "run");
    } else {
      answer(step, "ask", "next (ask)", ready);
      userGate(step);
      commands(step, "user");
    }
    if (step.gate === "user" && kind !== "user") {
      answer(step, "ask", "next (ask)", `${step.title} is done and waits for the user.`);
      userGate(step);
      context.events.push(sizeEvent(step.id, "command", "film:approve", options.commandBytes));
    }
    if (step.gate === "critic") {
      for (let round = 1; round <= rounds; round++) {
        if (round > 1) {
          const fixBy = step.critic!.fixBy ? stepById(step.critic!.fixBy) : undefined;
          if (fixBy) {
            answer(step, "fanOut", `next (fix round ${round})`, `Round ${round - 1} fell below the threshold.`);
            owner(step, round, fixBy);
          } else if (step.fixerInputs) {
            answer(step, "fixer", `next (fixer round ${round})`, `The critic asked for changes in round ${round - 1}.`);
            dispatch(
              context,
              step.id,
              round,
              "fixer",
              FIXER_AGENT,
              brief(step.id, "fixer", round),
              toolsFor("build", types[0]!, types[1]),
            );
          } else {
            answer(
              step,
              "dispatch",
              `next (owner round ${round})`,
              `The critic asked for changes in round ${round - 1}.`,
            );
            owner(step, round);
          }
          if (kind === "script") {
            answer(step, "run", `next (run round ${round})`, ready);
            commands(step, `run round ${round}`);
          }
        }
        answer(step, "critic", `next (critic round ${round})`, `${step.title}: waiting for critic round ${round}.`);
        dispatch(
          context,
          step.id,
          round,
          "critic",
          step.critic!.agent ?? CRITIC_AGENT,
          brief(step.id, "critic", round),
          [],
        );
      }
    }
    if (step.gate === "measure") {
      for (let round = 2; round <= rounds; round++) {
        if (step.fixerInputs) {
          answer(step, "fixer", `next (fixer round ${round})`, `The measure failed in round ${round - 1}.`);
          dispatch(
            context,
            step.id,
            round,
            "fixer",
            FIXER_AGENT,
            brief(step.id, "fixer", round),
            toolsFor("build", types[0]!, types[1]),
          );
          answer(step, "run", `next (run round ${round})`, ready);
          commands(step, `run round ${round}`);
        } else {
          answer(step, "dispatch", `next (owner round ${round})`, `The step's sensors failed in round ${round - 1}.`);
          owner(step, round);
        }
      }
    }
  }
}

// --- Footage route ---

const FOOTAGE_SOURCE = `public/projects/${PROJECT}/assets/footage/recording.mp4`;

function footageState(
  scratchRoot: string,
  playbook: string,
  goals: FootageGoals["goals"],
  minutes: number,
): FootageState {
  return {
    rootDir: scratchRoot,
    projectId: PROJECT,
    projectExists: false,
    redirectedFrom: null,
    goalsFile: `public/projects/${PROJECT}/pipeline/footage-goals.json`,
    playbook,
    goals: null,
    goalsSaved: false,
    candidates: [],
    source: null,
    sha256: null,
    cameras: [],
    workDir: `public/projects/${PROJECT}/pipeline/footage/recording`,
    transcripts: [],
    raws: [],
    speechMasks: [],
    shots: null,
    speakerMap: null,
    multicam: { sync: null, angles: null },
    request: null,
    recut: null,
    otherRecuts: [],
    takenProjectIds: [PROJECT],
    budget: false,
    openScribe: [],
    shorts: null,
    series: null,
    ...({ wanted: goals, minutes } as object),
  } as FootageState;
}

/** Moves a footage state one step on, as the step's commands or the user's answer would. */
function advanceFootage(
  state: FootageState & { wanted?: FootageGoals["goals"]; minutes?: number },
  next: FootageNext,
): void {
  const work = state.workDir;
  const recutId = `${PROJECT}-recut`;
  switch (next.step) {
    case "setup":
      if (!state.projectExists) state.projectExists = true;
      else
        state.goals = {
          version: 1,
          goals: state.wanted!,
          captionStyle: "outline-pop",
          language: "en",
          transcriber: "scribe",
          source: FOOTAGE_SOURCE,
        };
      return;
    case "0-source":
      state.source = {
        file: FOOTAGE_SOURCE,
        exists: true,
        width: 1920,
        height: 1080,
        fps: "30/1",
        durationSec: (state.minutes ?? 20) * 60,
        problems: [],
      };
      state.sha256 = "0".repeat(64);
      return;
    case "1-transcript":
      state.transcripts = [
        {
          file: `${work}/transcript.json`,
          provider: "elevenlabs",
          model: "scribe_v1",
          verbatim: true,
          diarized: true,
          speakers: ["speaker_0"],
          language: "en",
          valid: true,
          mtimeMs: 1,
          firstWords: [{ speaker: "speaker_0", startSec: 1, endSec: 4 }],
          gluedWords: [],
        },
      ];
      return;
    case "1-speech-mask":
      state.speechMasks = [`${work}/speech-mask.json`];
      return;
    case "2-shots":
      state.shots = `${work}/shots/shots.json`;
      return;
    case "3-recut-plan":
      state.request = {
        file: `${work}/recut-request.json`,
        projectId: recutId,
        formats: next.commands
          ?.join(" ")
          .match(/--formats (\S+)/)?.[1]
          ?.split(",") ?? ["landscape"],
        mtimeMs: 1,
        planFile: `${work}/recut-plan.md`,
        planHash: "1".repeat(64),
        approvedEditHash: null,
        cuts: Array.from({ length: 24 }, (_, index) => ({ id: `c${index + 1}`, kind: "pause" })),
      };
      return;
    case "4-approve":
      state.request!.approvedEditHash = state.request!.planHash;
      return;
    case "4-create":
      state.recut = {
        projectId: recutId,
        editHash: "1".repeat(64),
        mtimeMs: 2,
        revision: 1,
        captionStyle: null,
        captionsPlaced: false,
        pictureTrackId: "picture",
        reframed: [],
        renders: {},
        chapters: false,
      };
      return;
    case "5-captions":
      if (state.recut!.captionStyle !== state.goals!.captionStyle)
        state.recut!.captionStyle = state.goals!.captionStyle ?? null;
      else state.recut!.captionsPlaced = true;
      return;
    case "8-reframe":
      state.recut!.reframed.push(
        ...(["vertical", "square", "landscape"] as const).filter((format) => !state.recut!.reframed.includes(format)),
      );
      return;
    case "6-shorts": {
      const recut = state.recut!;
      const dir = `${work}/shorts`;
      if (!recut.chapters) recut.chapters = true;
      else if (!state.shorts) state.shorts = { dir, prepared: true, candidates: null, proposals: null };
      else if (!state.shorts.candidates) state.shorts.candidates = `${dir}/candidates.json`;
      else if (!state.shorts.proposals)
        state.shorts.proposals = {
          file: `${dir}/proposals.json`,
          projectId: recutId,
          fresh: true,
          proposed: ["s1", "s2", "s3", "s4", "s5"],
          others: ["s6", "s7"],
        };
      else if (!state.series)
        state.series = { file: `${dir}/series.json`, seriesId: "series", episodes: 5, created: [] };
      else if (state.series.created.length < state.series.episodes)
        state.series.created = Array.from({ length: state.series.episodes }, (_, index) => ({
          projectId: `${recutId}-short-${index + 1}`,
          rendered: false,
        }));
      else state.series.created = state.series.created.map((episode) => ({ ...episode, rendered: true }));
      return;
    }
    case "9-render": {
      const format = next.commands?.join(" ").match(/--format (\S+)/)?.[1] ?? "landscape";
      const name = next.commands?.join(" ").includes("--captions off") ? `${format}-clean` : format;
      state.recut!.renders[name] = { state: "fresh", file: `out/${recutId}/${name}.mp4` };
      return;
    }
    default:
      throw new Error(`The footage simulation cannot advance step ${next.step}.`);
  }
}

function simulateFootage(
  context: Context,
  playbookId: string,
  goals: FootageGoals["goals"],
  scratchRoot: string,
): void {
  const { options } = context;
  const projectDir = path.join(scratchRoot, "public/projects", PROJECT);
  mkdirSync(path.join(projectDir, "pipeline"), { recursive: true });
  writeProjectPlaybook(projectDir, playbookId, "agent");
  writeFileSync(
    path.join(projectDir, "pipeline/footage-goals.json"),
    `${JSON.stringify({ version: 1, goals }, null, 2)}\n`,
  );
  const state = footageState(scratchRoot, playbookId, goals, options.sourceMinutes);
  const counts = new Map<string, number>();
  for (let guard = 0; guard < 60; guard++) {
    const decided = decideNext(state, playbookId);
    const moment = footageCaptureMoment(decided, state);
    const answer = {
      ...decided,
      ...withPlaybook(projectDir, footageRead(decided.step), decided.step),
      ...memoryFields(projectDir, decided.step, playbookId),
      ...captureFields(projectDir, moment, decided.step, { playbook: playbookId }),
    };
    const seen = (counts.get(decided.step) ?? 0) + 1;
    counts.set(decided.step, seen);
    const step = seen > 1 ? `${decided.step} (${seen})` : decided.step;
    answerEvent(context, projectDir, "footage", step, `next (${decided.action})`, answer);
    if (decided.action === "stop") return;
    if (decided.action === "run")
      for (const command of decided.commands ?? [])
        context.events.push(sizeEvent(step, "command", command.split(" ").slice(0, 2).join(" "), options.commandBytes));
    if (decided.action === "ask") {
      for (const file of decided.show ?? []) {
        if (repoFiles(context.repo, file).length) readOnce(context, step, file, "shown");
        else
          context.events.push(
            sizeEvent(
              step,
              "shown",
              file,
              file.endsWith("recut-plan.md")
                ? Math.round(options.sourceMinutes * TRANSCRIPT_BYTES_PER_MINUTE * 0.5)
                : artefactBytes(file, options.artefactBytes),
            ),
          );
      }
      context.events.push(sizeEvent(step, "user", `${decided.step} question and answer`, options.userTurnBytes));
      for (const _ of decided.thenRun ?? [])
        context.events.push(sizeEvent(step, "command", "then run", options.commandBytes));
    }
    if (decided.action === "agent-task") {
      // The shorts task: read brief.md and every transcript chunk, then write candidates.json.
      context.events.push(sizeEvent(step, "read", "shorts brief.md", SHORTS_BRIEF_BYTES));
      context.events.push(
        sizeEvent(
          step,
          "read",
          `transcript chunks (${options.sourceMinutes} min)`,
          options.sourceMinutes * TRANSCRIPT_BYTES_PER_MINUTE,
        ),
      );
      context.events.push(sizeEvent(step, "written", "candidates.json", options.artefactBytes * 2));
    }
    advanceFootage(state, decided);
  }
  throw new Error("The footage simulation did not reach done in 60 answers.");
}

// --- Entry ---

export const SIMULATION_ASSUMPTIONS = (options: SimulationOptions): string[] => [
  "One orchestrator conversation from the playbook's start to its last step, with no compaction; every file it reads stays in context and is counted once.",
  "The orchestrator starts from the claude-code boot row and loads the route's skill (creative-studio for films, recording-recut for footage) and the playbook's start command result.",
  `Each next answer is the pnpm next envelope: the real first film answer (nextAction on a fresh scratch project), later film answers assembled from the same functions nextAction uses, and footage answers from decideNext on a simulated state.`,
  `Each film dispatch is by reference: the film:brief result (the brief's path, summary and dispatch line, not its text) and the Agent call carrying metadata.dispatch, then a ${options.reportBytes}-byte report. The subagent reads the brief file once.`,
  `A user gate adds the shown files and a ${options.userTurnBytes}-byte exchange; every other command result is ${options.commandBytes} bytes.`,
  `Rounds ${options.rounds}: ${options.rounds === "expected" ? "every critic, fixer and measure loop passes in one round" : "every critic, fixer and measure loop runs stop.maxRounds rounds; a fixBy round dispatches every fan-out lane again"}. User gates are answered once in both.`,
  "A subagent's fresh context: the same boot row as the orchestrator (root AGENTS.md through CLAUDE.md, skill and agent descriptions), its definition, its brief, the tracked files the brief names in its inputs and rules plus its route tool skills, and estimated project artefacts.",
  `Project artefacts are estimated by name (ARTEFACT_BYTES in src/lib/context/simulate.ts, else ${options.artefactBytes} bytes); media count as 0 text bytes. A footage source is ${options.sourceMinutes} minutes.`,
  "A footage route's footage:next loop runs in the orchestrator itself, so it has no dispatches; when it is delegated to the footage-editor agent, the same loop content moves into that one subagent's context.",
  "The user's memory is pinned to an empty scratch folder and playbooks to the measured root, so results do not depend on the machine.",
];

export const SIMULATION_LIMITATIONS = [
  "Briefs after intake render on a scratch project with the minimal fixtures in tests/fixtures/film-chain: no approvals so far, user words, memory, category clichés, product-only proofs or earlier review notes, so later briefs are a floor.",
  "Agents' own work is not modelled: library:list and other tool output, source code they open, images and frames they look at, and files they write.",
  "localSuggestions (local tools) depends on the machine and is left out of answers and briefs.",
  "Compaction, prompt caching and the harness's own wrappers are not modelled; 100k and 200k are where Claude Code's compaction becomes likely, not observed behaviour.",
  "--base is not supported with --simulate: answers and briefs come from the current code, so a historical comparison would mix two trees.",
];

export type PlaybookChoice = { id: string; route: { kind: string } & Record<string, unknown> };

export function simulatePlaybook(
  root: string,
  id: string,
  partial: Partial<SimulationOptions> = {},
  shared?: { repo: RepositoryText; boot: string },
): PlaybookSimulation {
  const options = { ...DEFAULT_SIMULATION, ...partial };
  const repo = shared?.repo ?? repositoryText(root);
  const boot = shared?.boot ?? bootText(repo);
  const resolved = resolvePlaybook(id, root);
  const route = resolved.playbook.route;
  if (route.kind !== "film" && route.kind !== "footage")
    throw new Error(`Playbook ${id} is a ${route.kind} route: only film and footage routes are simulated.`);
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "context-simulate-"));
  // The user's memory and a fixture playbook root would make the measurement depend on the machine: pin both.
  const pinned = { AGENTBROS_MEMORY_ROOT: path.join(scratchRoot, "memory"), AGENTBROS_PLAYBOOKS_ROOT: root };
  const saved = Object.fromEntries(Object.keys(pinned).map((key) => [key, process.env[key]]));
  Object.assign(process.env, pinned);
  const context: Context = {
    root,
    repo,
    options,
    boot,
    events: [],
    dispatches: [],
    seen: new Set(),
    missing: [],
    scratch: scratchRoot,
  };
  try {
    context.events.push(textEvent("start", "boot", "boot (claude-code)", boot));
    readOnce(
      context,
      "start",
      `.agents/skills/${route.kind === "film" ? "creative-studio" : "recording-recut"}/SKILL.md`,
      "skill",
    );
    context.events.push(sizeEvent("start", "command", "playbook --match", options.commandBytes));
    readOnce(context, "start", resolved.read[0]!);
    context.events.push(
      sizeEvent("start", "command", route.start.split(" ").slice(0, 2).join(" "), options.commandBytes),
    );
    if (route.kind === "film") simulateFilm(context, id, route, scratchRoot);
    else simulateFootage(context, id, route.footageGoals, scratchRoot);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratchRoot, { recursive: true, force: true });
  }
  return accumulate(id, route.kind, options.rounds, context.events, context.dispatches, context.missing);
}

/** The claude-code boot row's text, in budget.ts's order: root AGENTS.md, skill and agent descriptions, literal MCP instructions. A test holds its size to measureBudget's boot row. */
export function bootText(repo: RepositoryText): string {
  const descriptions = repo.files
    .filter((file) => isSkill(file) || isAgent(file))
    .sort((a, b) => Number(isAgent(a)) - Number(isAgent(b)))
    .map((file) => descriptionOf(repo.read(file) ?? ""));
  const instructions: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "instructions" && typeof item === "string") instructions.push(item);
      else visit(item);
    }
  };
  const config = repo.read(".mcp.json");
  if (config) visit(JSON.parse(config));
  return (repo.read("AGENTS.md") ?? "") + descriptions.join("") + instructions.join("");
}

export function simulateRun(
  root: string,
  ids: string[] | undefined,
  partial: Partial<SimulationOptions> = {},
): Simulation {
  const options = { ...DEFAULT_SIMULATION, ...partial };
  const repo = repositoryText(root);
  const boot = bootText(repo);
  const playbooks: PlaybookSimulation[] = [];
  const skipped: Simulation["skipped"] = [];
  for (const id of ids ?? listPlaybookIds(root)) {
    let kind: string;
    try {
      kind = resolvePlaybook(id, root).playbook.route.kind;
    } catch (error) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (kind !== "film" && kind !== "footage") {
      if (ids)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `Playbook ${id} is a ${kind} route; --simulate covers film and footage routes.`,
        });
      skipped.push({ id, reason: `${kind} route: not simulated` });
      continue;
    }
    playbooks.push(simulatePlaybook(root, id, options, { repo, boot }));
  }
  return {
    version: 1,
    estimate:
      "v1: ASCII code points / 4 + non-ASCII code points, rounded up once per conversation; estimated sizes count four bytes a token",
    options,
    playbooks,
    skipped,
    assumptions: SIMULATION_ASSUMPTIONS(options),
    limitations: SIMULATION_LIMITATIONS,
  };
}

const k = (value: number) => `${(value / 1000).toFixed(1)}k`;

export function simulationMarkdown(simulation: Simulation): string {
  const lines = [
    `Rounds: ${simulation.options.rounds}. Estimate ${simulation.estimate}.`,
    "",
    "| Playbook | Route | Orchestrator tokens | Crosses 100k at | Crosses 200k at | Dispatches | Largest dispatch |",
    "|---|---|---:|---|---|---:|---|",
    ...simulation.playbooks.map((item) => {
      const largest = item.largestDispatches[0];
      return `| ${item.id} | ${item.route} | ${item.totalTokens} | ${item.crossings["100k"] ?? "—"} | ${item.crossings["200k"] ?? "—"} | ${item.dispatchCount} | ${largest ? `${largest.step} ${largest.agent}${largest.lane ? ` ${largest.lane}` : ""} (${largest.estimatedTokens})` : "—"} |`;
    }),
    "",
  ];
  for (const item of simulation.playbooks) {
    lines.push(
      `### ${item.id}`,
      "",
      "| Step | Added tokens | Cumulative tokens | Dispatches |",
      "|---|---:|---:|---:|",
      ...item.steps.map((row) => `| ${row.step} | ${row.addedTokens} | ${row.cumulativeTokens} | ${row.dispatches} |`),
      "",
    );
    lines.push(
      `Contributors: ${item.contributors.map((entry) => `${entry.kind} ${k(entry.estimatedTokens)}`).join(", ")}.`,
      "",
    );
  }
  lines.push(
    ...simulation.assumptions.map((line) => `- ${line}`),
    ...simulation.limitations.map((line) => `- ${line}`),
    "",
  );
  return lines.join("\n");
}
