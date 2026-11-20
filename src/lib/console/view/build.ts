/**
 * The project view builder (RFC 0004 §6.2, WP3): a pure function of the project's files plus its journal. It reuses
 * the chain (`deriveChain`, `nextAction`), footage:next, timeline next, the job store, the asset registry, the step
 * lease and the policy, and adds only durations and agent runs from the journal. Every section degrades on its own:
 * a missing or corrupt file gives the section's empty value and an advisory, never an exception.
 */
import path from "node:path";
import { readProjectTitle } from "../../project-display";
import {
  ProjectIdSchema,
  ProjectViewSchema,
  type Decision,
  type FormatSchema,
  type ProjectView,
  type StepRow,
} from "../../../types/console";
import { readProjectPlaybook } from "../../playbooks/project";
import { TIMELINE_STEPS, timelineNext } from "../../pipeline/timeline-next";
import { activeRun, agentRuns, JournalCache, runsToday, stepStarts } from "./activity";
import { readJsonObject, statOf, text, toIso, projectPaths, type ProjectPaths } from "./files";
import { filmCurrent, filmSteps, filmWaiting, readFilm, type FilmRead, type QuoteContext } from "./film";
import { readFilmMaterial } from "./film-material";
import { footageCurrent, footageSteps, footageWaiting, readFootageWithState } from "./footage";
import { readFootageMaterial } from "./footage-material";
import { readGenerations, timelineWithoutMaterial } from "./generations";
import { readMedia } from "./media";
import { emptyMoney } from "./money";
import { readMoneyContext } from "./money-context";
import { projectRoute } from "./route";
import { readCampaignMaterial, readRecipeMaterial, readReplicaMaterial } from "./route-material";
import { readAssets, readAutonomy, readCards, readControl, readQa, readStepGuard } from "./sections";
import { cardDecisions, sortWaiting } from "./waiting";
import type { z } from "zod";

export type BuildOptions = {
  /** The view's revision (the data source's counter); 0 by default. */
  revision?: number;
  /** Clock for durations, card expiry and "today" (tests pin it). */
  now?: number;
  /** A journal reader kept across builds (incremental); a fresh one reads the whole file. */
  journal?: JournalCache;
};

type Format = z.infer<typeof FormatSchema>;
const FORMAT_NAMES = new Set<string>(["vertical", "square", "landscape"]);

/** Whether a project directory exists under `public/projects/` and looks like a project. */
export function isProject(paths: ProjectPaths): boolean {
  if (!statOf(paths.projectDir)?.isDirectory()) return false;
  return (
    statOf(path.join(paths.projectDir, "project.json"))?.isFile() === true ||
    statOf(path.join(paths.projectDir, "pipeline"))?.isDirectory() === true
  );
}

function projectMeta(paths: ProjectPaths, advisories: string[]) {
  const config = readJsonObject(path.join(paths.projectDir, "project.json"));
  const brief = readJsonObject(path.join(paths.projectDir, "pipeline", "brief.json"));
  if (config === "corrupt") advisories.push("project: project.json is not valid JSON.");
  if (brief === "corrupt") advisories.push("project: pipeline/brief.json is not valid JSON.");
  const configObject = config && config !== "corrupt" ? config : {};
  const briefObject = brief && brief !== "corrupt" ? brief : {};
  let playbook: string | undefined;
  try {
    playbook = text(readProjectPlaybook(paths.projectDir)?.id, 64);
  } catch {
    playbook = undefined;
  }
  const declared = [configObject.formats, briefObject.formats, briefObject.format, briefObject.aspect].flatMap(
    (value) => (Array.isArray(value) ? value : [value]),
  );
  const formats = [...new Set(declared.filter((value): value is Format => FORMAT_NAMES.has(String(value))))];
  const info = statOf(paths.projectDir);
  return {
    title:
      readProjectTitle(paths.projectDir) ??
      text(configObject.title, 200) ??
      text(configObject.name, 200) ??
      text(briefObject.title, 200),
    filmType: text(briefObject.filmType, 64),
    playbook,
    formats,
    createdAt: toIso(info ? info.birthtimeMs || info.mtimeMs : 0),
  };
}

function guard<T>(name: string, advisories: string[], work: () => T, fallback: T): T {
  try {
    return work();
  } catch (error) {
    advisories.push(`${name}: ${(error as Error)?.message ?? String(error)}`.slice(0, 2000));
    return fallback;
  }
}

function timelineSteps(paths: ProjectPaths, starts: Map<string, string>) {
  const next = timelineNext(paths.id, paths.rootDir);
  const order = Object.keys(TIMELINE_STEPS) as (keyof typeof TIMELINE_STEPS)[];
  const index = order.indexOf(next.step);
  const steps: StepRow[] = order.map((id, position) => ({
    id,
    title: TIMELINE_STEPS[id],
    status:
      next.step === "done" || position < index
        ? "done"
        : position === index
          ? next.action === "ask"
            ? "awaiting-gate"
            : "running"
          : "pending",
    reasons: position === index ? [next.why.slice(0, 2000)] : [],
    ...(starts.get(id) ? { startedAt: new Date(starts.get(id)!).toISOString() } : {}),
  }));
  const argv = next.commands.map((command) => command.split(/\s+/)).find((parts) => parts[0] === "pnpm") ?? [];
  return {
    steps,
    current:
      next.step === "done"
        ? undefined
        : { step: next.step, next: { argv: argv.slice(0, 64), why: next.why.slice(0, 2000) } },
  };
}

/** Builds the view of project `projectId` under `rootDir`, or undefined when there is no such project. */
export function buildProjectView(
  rootDir: string,
  projectId: string,
  options: BuildOptions = {},
): ProjectView | undefined {
  if (!ProjectIdSchema.safeParse(projectId).success) return undefined;
  const paths = projectPaths(path.resolve(rootDir), projectId);
  if (!isProject(paths)) return undefined;
  const now = options.now ?? Date.now();
  const advisories: string[] = [];
  const meta = projectMeta(paths, advisories);
  const route = projectRoute(paths.projectDir);
  const journal = options.journal ?? new JournalCache(paths.projectDir);
  const events = guard("journal", advisories, () => journal.read(), []);
  const starts = stepStarts(events);

  const context = readMoneyContext(paths);
  advisories.push(...context.advisories, ...context.autonomy.advisories);
  const autonomy = context.autonomy;
  const money = context.money;
  const quoteContext: QuoteContext = context.quote;

  let steps: StepRow[] = [];
  let current: ProjectView["current"];
  const waiting: Decision[] = [];
  let filmType = meta.filmType;
  let openSteps: Set<string> | undefined;
  let film: ProjectView["film"];
  let replica: ProjectView["replica"];
  let recipe: ProjectView["recipe"];
  let campaign: ProjectView["campaign"];
  let footage: ProjectView["footage"];
  if (route.chain === "film") {
    const chain = guard<FilmRead | undefined>("chain", advisories, () => readFilm(paths), undefined);
    if (chain) {
      filmType = chain.chain.filmType;
      steps = filmSteps(chain, starts, now);
      current = filmCurrent(chain);
      openSteps = new Set(
        chain.chain.steps.filter((s) => s.status !== "done" && s.status !== "skipped").map((s) => s.id),
      );
      advisories.push(...(chain.next.advisories ?? []).map((line) => line.slice(0, 2000)));
      film = guard(
        "film material",
        advisories,
        () => readFilmMaterial(paths, new Map(chain.chain.steps.map((s) => [s.id, s.status])), advisories),
        undefined,
      );
      if (route.route === "replica")
        replica = guard("replica material", advisories, () => readReplicaMaterial(paths, advisories), undefined);
      const found = guard("waiting", advisories, () => filmWaiting(chain, paths, quoteContext), {
        decisions: [],
        advisories: [],
      });
      waiting.push(...found.decisions);
      advisories.push(...found.advisories);
    }
  } else if (route.chain === "footage") {
    const read = guard("footage", advisories, () => readFootageWithState(paths), undefined);
    if (read) {
      const { next, state } = read;
      footage = guard("footage material", advisories, () => readFootageMaterial(paths, state, advisories), undefined);
      steps = footageSteps(next, starts, now);
      current = footageCurrent(next);
      advisories.push(...(next.advisories ?? []).map((line) => line.slice(0, 2000)));
      const found = guard("waiting", advisories, () => footageWaiting(next, paths, quoteContext), {
        decisions: [],
        advisories: [],
      });
      waiting.push(...found.decisions);
      advisories.push(...found.advisories);
    }
  } else if (route.chain === "timeline") {
    const timeline = guard("timeline", advisories, () => timelineSteps(paths, starts), undefined);
    if (timeline) {
      steps = timeline.steps;
      current = timeline.current;
    }
    if (route.route === "recipe")
      recipe = guard("recipe material", advisories, () => readRecipeMaterial(paths, advisories), undefined);
  } else if (route.route === "campaign") {
    campaign = guard("campaign material", advisories, () => readCampaignMaterial(paths, advisories), undefined);
    if (!campaign) advisories.push(`Minimal view for the campaign route: ${route.detectedBy}`.slice(0, 2000));
  } else {
    advisories.push(`Minimal view for the ${route.route} route: ${route.detectedBy}`.slice(0, 2000));
  }

  const cards = readCards(paths, projectId, now);
  advisories.push(...cards.advisories);
  waiting.push(...cardDecisions(paths, cards.value.cards, cards.value.files));

  const control = readControl(paths);
  advisories.push(...control.advisories);
  const assets = guard("assets", advisories, () => readAssets(paths), { value: [], advisories: [] });
  advisories.push(...assets.advisories);
  const qa = guard("qa", advisories, () => readQa(paths), { value: { findings: [] }, advisories: [] });
  const media = guard("media", advisories, () => readMedia(paths), {});
  let generations = guard("generations", advisories, () => readGenerations(paths, assets.value, advisories), undefined);
  // A `project:new` template used only for generations: its render is not the current step (2026-11-20).
  if (
    generations &&
    route.route === "timeline" &&
    route.chain === "timeline" &&
    guard("generations", advisories, () => timelineWithoutMaterial(paths, Object.keys(media).length > 0), false)
  ) {
    generations = { ...generations, templateOnly: true };
    current = undefined;
    steps = steps.map((row, index): StepRow => ({
      ...row,
      status: "pending",
      reasons: index
        ? []
        : [
            "project.json is still the project:new template (no film code, render, music or voiceover); the generations below are this project's material.",
          ],
    }));
  }
  const runs = agentRuns(events, { now, ...(openSteps ? { openSteps } : {}) });
  const active = activeRun(runs);
  const stepGuard = readStepGuard(paths);

  const view = {
    v: 1 as const,
    revision: options.revision ?? 0,
    generatedAt: new Date(now).toISOString(),
    project: {
      id: projectId,
      route: route.route,
      ...(meta.title ? { title: meta.title } : {}),
      ...(filmType ? { filmType: filmType.slice(0, 64) } : {}),
      ...(meta.playbook ? { playbook: meta.playbook } : {}),
      ...(meta.formats.length ? { formats: meta.formats.slice(0, 3) } : {}),
      createdAt: meta.createdAt,
    },
    control: control.value,
    autonomy: autonomy.value,
    steps,
    ...(current ? { current } : {}),
    waiting: sortWaiting(waiting),
    agents: { ...(active ? { active } : {}), today: runsToday(runs, now) },
    money,
    media,
    assets: assets.value,
    qa: qa.value,
    cards: cards.value.cards,
    advisories: [...new Set(advisories.map((line) => line.slice(0, 2000)))].slice(0, 64),
    ...(film ? { film } : {}),
    ...(replica ? { replica } : {}),
    ...(recipe ? { recipe } : {}),
    ...(campaign ? { campaign } : {}),
    ...(footage ? { footage } : {}),
    ...(generations ? { generations } : {}),
    ...(stepGuard ? { stepGuard } : {}),
  };
  return validated(view);
}

/** Parses the view; a failing section is replaced by its empty value with an advisory, so the view always parses. */
function validated(view: ProjectView): ProjectView {
  const first = ProjectViewSchema.safeParse(view);
  if (first.success) return first.data;
  const broken = new Set(first.error.issues.map((issue) => String(issue.path[0])));
  const empty: Partial<Record<keyof ProjectView, unknown>> = {
    steps: [],
    current: undefined,
    waiting: [],
    agents: { today: [] },
    money: emptyMoney(),
    media: {},
    assets: [],
    qa: { findings: [] },
    cards: [],
    stepGuard: undefined,
    film: undefined,
    replica: undefined,
    recipe: undefined,
    campaign: undefined,
    footage: undefined,
    generations: undefined,
    autonomy: { mode: "interactive", source: "none" },
    control: { state: "running" },
  };
  const repaired: Record<string, unknown> = { ...view };
  for (const key of broken) if (key in empty) repaired[key] = empty[key as keyof ProjectView];
  for (const key of Object.keys(repaired)) if (repaired[key] === undefined) delete repaired[key];
  repaired.advisories = [
    ...view.advisories,
    ...[...broken].map((key) => `view: the ${key} section did not validate and is not shown.`),
  ].slice(0, 64);
  const second = ProjectViewSchema.safeParse(repaired);
  if (second.success) return second.data;
  // The project block itself is wrong (an id or a date): the smallest valid view.
  return ProjectViewSchema.parse({
    v: 1,
    revision: view.revision,
    generatedAt: view.generatedAt,
    project: { id: view.project.id, route: view.project.route, createdAt: new Date(0).toISOString() },
    control: { state: "running" },
    autonomy: { mode: "interactive", source: "none" },
    steps: [],
    waiting: [],
    agents: { today: [] },
    money: emptyMoney(),
    media: {},
    assets: [],
    qa: { findings: [] },
    cards: [],
    advisories: ["view: the project could not be read; this is a minimal view."],
  });
}
