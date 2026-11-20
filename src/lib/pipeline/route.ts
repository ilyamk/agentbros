/** Which next-step command a project follows, and what an agent reads at each step of it. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { experimentInstructions } from "../experiments/project";
import { STEP_RULES } from "../film/chain";
import { isConsolePipelineEntry } from "./paths";
import { filmTypeDoc } from "../film/routes";
import type { FilmType } from "../../types/pipeline";
import {
  FILM_TYPE_COVERAGE,
  FOOTAGE_GOAL_COVERAGE,
  ownerPlaybooks,
  RECIPE_COVERAGE,
  type CoverageOwner,
} from "../playbooks/coverage";
import { listPlaybookIds, loadPlaybook, playbookRead, playbooksRoot, readProjectPlaybook } from "../playbooks/project";
import { captureFor, loadMemoryFast, scopedMemory, type Capture, type CaptureMoment } from "./memory";
import { QUERY_LIMIT, QUERY_MAX_CHARS } from "../memory";
import type { MemoryRef } from "../../types/memory";
import { PlaybookPlatformSchema, type Playbook, type PlaybookRoute } from "../../types/playbook";

type PlaybookPlatform = (typeof PlaybookPlatformSchema.options)[number];

/** `timeline`: a project.json rendered as it stands (recipe drafts, campaign children, project:new, and old template-mode projects, whose pipeline-state.json is ignored). */
export type ProjectRoute = "film" | "footage" | "timeline" | "campaign";

export const ROUTE_COMMANDS: Record<ProjectRoute, { alias: string; script: string; guide: string }> = {
  campaign: { alias: "campaign:next", script: "scripts/campaign-next.ts", guide: "docs/campaign-production.md" },
  film: { alias: "film:next", script: "scripts/film-next.ts", guide: "docs/production-chain.md" },
  footage: { alias: "footage:next", script: "scripts/footage-next.ts", guide: "docs/footage-editing.md" },
  timeline: { alias: "next", script: "scripts/next.ts", guide: "docs/delivery.md" },
};

export const ROUTE_OPTIONS = [
  "bespoke film: pnpm film:route --type <type>, then pnpm film:init --project <id> --type <type>",
  "the user's own recording: pnpm footage:next --project <id> --goal <goals> --source <file>",
  "a project.json to render as it stands: pnpm project:new --project <id> (or pnpm video:recipe --action materialize --input <file>), then pnpm next --project <id> for render, QA and delivery",
];

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** A recut request under pipeline/ (footage:next writes it next to the transcript), at most three levels down. */
function findRecordingRequest(dir: string, depth = 0, root = dir): string | undefined {
  if (depth > 3 || !existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (isConsolePipelineEntry(path.relative(root, file))) continue; // console inbox, cards, session, ratings
    if (entry.isDirectory()) {
      const found = findRecordingRequest(file, depth + 1, root);
      if (found) return found;
    } else if (/request.*\.json$/.test(entry.name) && statSync(file).size < 4 * 1024 * 1024) {
      const value = readJson(file) as { workflow?: unknown } | undefined;
      if (value?.workflow === "recording-edit") return file;
    }
  }
  return undefined;
}

/** Where a project's playbooks are read from: always the checkout that holds the code (`playbooksRoot`), whatever the workspace. */
export const rootOfProject = (_projectDir?: string): string => playbooksRoot();

/** The playbook's route of a kind: its main route when it has that kind, else its first alternative of that kind. */
export function playbookRouteOf<K extends PlaybookRoute["kind"]>(
  playbook: Playbook,
  kind: K,
): Extract<PlaybookRoute, { kind: K }> | undefined {
  const routes = [playbook.route, ...playbook.alternatives.map((alternative) => alternative.route)];
  return routes.find((route): route is Extract<PlaybookRoute, { kind: K }> => route.kind === kind);
}

export type BoundPlaybook = { id: string; title: string; kind: PlaybookRoute["kind"]; start: string };

export type DetectedRoute = {
  route: ProjectRoute | null;
  detectedBy: string;
  /** The project's playbook binding, when it has one. */
  playbook?: BoundPlaybook;
  /** Set when the route is null but the binding names how to start: the playbook's `route.start`, `<id>` filled in. */
  start?: string;
};

function boundPlaybook(projectDir: string): BoundPlaybook | undefined {
  const binding = readProjectPlaybook(projectDir);
  if (!binding) return undefined;
  try {
    const playbook = loadPlaybook(binding.id, rootOfProject(projectDir));
    return {
      id: playbook.id,
      title: playbook.title,
      kind: playbook.route.kind,
      start: playbook.route.start.replaceAll("<id>", path.basename(projectDir)),
    };
  } catch {
    return undefined;
  }
}

/**
 * Bespoke first (brief.renderMode), then footage markers, then project.json: the timeline route (render, QA, delivery),
 * whether or not a legacy pipeline-state.json is left over; null when none applies.
 * The playbook binding (pipeline/playbook.json) decides only what the markers leave open: a footage binding outranks a
 * bare project.json (footage:next's own setup creates the project with project:new), and a bound project whose route
 * cannot open yet (a film with no bespoke brief, a template with no project.json, a workflow) gets the playbook's start
 * command.
 */
export function detectRoute(projectDir: string): DetectedRoute {
  const detected = detectMarkers(projectDir);
  const playbook = boundPlaybook(projectDir);
  if (!playbook) return detected;
  const by = `pipeline/playbook.json binds the ${playbook.kind} playbook ${playbook.id}`;
  if (detected.route === "film" || detected.route === "footage" || detected.route === "campaign")
    return { ...detected, playbook };
  if (playbook.kind === "footage") return { route: "footage", detectedBy: by, playbook };
  if (detected.route === "timeline") return { ...detected, playbook };
  const why =
    playbook.kind === "film"
      ? "the project has no bespoke brief yet"
      : playbook.kind === "template"
        ? "the project has no project.json yet"
        : "a workflow starts from its own command";
  return { route: null, detectedBy: `${by}, and ${why}`, playbook, start: playbook.start };
}

function detectMarkers(projectDir: string): DetectedRoute {
  const pipeline = path.join(projectDir, "pipeline");
  const owner = readJson(path.join(pipeline, "campaign-production/owner.json")) as
    { version?: unknown; campaignId?: unknown } | undefined;
  if (owner?.version === 1 && owner.campaignId === path.basename(projectDir)) {
    if (existsSync(path.join(projectDir, "project.json")) || existsSync(path.join(pipeline, "brief.json")))
      throw new Error("Campaign container conflicts with a video project marker");
    return { route: "campaign", detectedBy: "pipeline/campaign-production/owner.json identifies a campaign" };
  }
  const brief = readJson(path.join(pipeline, "brief.json")) as { renderMode?: unknown } | undefined;
  if (brief?.renderMode === "bespoke")
    return { route: "film", detectedBy: 'pipeline/brief.json has renderMode "bespoke"' };
  for (const [file, why] of [
    ["footage-goals.json", "the recording's goals"],
    ["recording-edit.json", "a recut of a recording; footage:next resolves it to the source project"],
    ["shorts-series-binding.json", "a shorts episode; footage:next resolves it to the source project"],
  ] as const) {
    if (existsSync(path.join(pipeline, file)))
      return { route: "footage", detectedBy: `pipeline/${file} exists: ${why}` };
  }
  const request = findRecordingRequest(pipeline);
  if (request)
    return { route: "footage", detectedBy: `${path.relative(projectDir, request)} is a recording-edit request` };
  if (existsSync(path.join(projectDir, "project.json")))
    return {
      route: "timeline",
      detectedBy: `no bespoke brief and no footage files, and project.json exists: render, QA and delivery of the project as it stands${
        existsSync(path.join(pipeline, "pipeline-state.json"))
          ? " (legacy template-mode pipeline/pipeline-state.json ignored: the 16-stage pipeline was removed)"
          : ""
      }`,
    };
  return { route: null, detectedBy: "no bespoke brief, no footage files and no project.json" };
}

// --- What to read ---

export const playbookHint = (projectId: string) =>
  `bind one: pnpm playbook --match "<request>" then pnpm playbook --use <id> --project ${projectId}`;

/** The owning playbooks of an unbound project's film type, footage goals or template recipe (src/lib/playbooks/coverage.ts). */
export type PlaybookSuggest = { by: string; playbooks: { id: string; title: string; when?: string }[]; use: string };

/** `playbookWarning`: pipeline/playbook.json exists but cannot be used (invalid, or names an unknown playbook); no bind hint then. */
export type PlaybookAnswer = {
  playbook: { id: string; title: string } | null;
  playbookHint?: string;
  playbookSuggest?: PlaybookSuggest;
  playbookWarning?: string;
  experiments?: ReturnType<typeof experimentInstructions>;
  activeExperiments?: { id: string; status: string }[];
  read: string[];
};

/** The owners and the route kind the project's own files imply: a brief means film, goals footage, a recipe template. */
function suggestFrom(
  projectDir: string,
): { by: string; kind: PlaybookRoute["kind"]; owners: CoverageOwner[] } | undefined {
  const pipeline = path.join(projectDir, "pipeline");
  const brief = readJson(path.join(pipeline, "brief.json")) as
    { filmType?: unknown; secondaryFilmType?: unknown } | undefined;
  const types = [brief?.filmType, brief?.secondaryFilmType].filter(
    (type): type is keyof typeof FILM_TYPE_COVERAGE => typeof type === "string" && type in FILM_TYPE_COVERAGE,
  );
  if (types.length)
    return {
      by: `film type ${types.join(" + ")} (pipeline/brief.json)`,
      kind: "film",
      owners: types.flatMap((type) => FILM_TYPE_COVERAGE[type]),
    };
  const goals = readJson(path.join(pipeline, "footage-goals.json")) as { goals?: unknown } | undefined;
  if (Array.isArray(goals?.goals)) {
    const rule = FOOTAGE_GOAL_COVERAGE.find(
      (entry) => entry.goal === "*" || (goals.goals as unknown[]).includes(entry.goal),
    )!;
    return {
      by: `footage goals ${goals.goals.join(", ")} (pipeline/footage-goals.json)`,
      kind: "footage",
      owners: [rule.owner],
    };
  }
  const recipe = (readJson(path.join(pipeline, "recipe.json")) as { request?: { recipeId?: unknown } } | undefined)
    ?.request?.recipeId;
  if (typeof recipe === "string" && recipe in RECIPE_COVERAGE)
    return {
      by: `template recipe ${recipe} (pipeline/recipe.json)`,
      kind: "template",
      owners: RECIPE_COVERAGE[recipe as keyof typeof RECIPE_COVERAGE],
    };
  return undefined;
}

/**
 * Existing, non-pending owners of an unbound project that have a route of the project's kind (so `--use` accepts them),
 * with the bind command; undefined when nothing on disk names its kind or no owner fits.
 */
export function playbookSuggest(projectDir: string, root = rootOfProject(projectDir)): PlaybookSuggest | undefined {
  const found = suggestFrom(projectDir);
  if (!found) return undefined;
  const existing = listPlaybookIds(root);
  const playbooks = [...new Set(ownerPlaybooks(found.owners))]
    .filter((id) => existing.includes(id))
    .flatMap((id) => {
      const owner = found.owners.find((entry) => "playbook" in entry && entry.playbook === id);
      try {
        const playbook = loadPlaybook(id, root);
        // A recipe project is on the timeline route, which any playbook can bind; the other kinds need a route of that kind.
        if (found.kind !== "template" && !playbookRouteOf(playbook, found.kind)) return [];
        return [{ id, title: playbook.title, ...(owner?.when ? { when: owner.when } : {}) }];
      } catch {
        return [];
      }
    });
  if (!playbooks.length) return undefined;
  const id = playbooks.length === 1 ? playbooks[0]!.id : "<id>";
  return { by: found.by, playbooks, use: `pnpm playbook --use ${id} --project ${path.basename(projectDir)}` };
}

/** A next-step answer's playbook fields: the bound playbook's files for `step` first in `read`, a warning for an unusable binding, or a hint to bind one with the owners of the project's kind. */
export function withPlaybook(projectDir: string, read: string[] = [], step?: string | null): PlaybookAnswer {
  const active = experimentInstructions(projectDir, step);
  const experiments = !active.length
    ? {}
    : step
      ? { experiments: active }
      : { activeExperiments: active.map(({ id, status }) => ({ id, status })) };
  const bound = playbookRead(projectDir, rootOfProject(projectDir), step);
  if (bound.warning) return { playbook: null, playbookWarning: bound.warning, ...experiments, read };
  if (!bound.playbook) {
    const suggest = playbookSuggest(projectDir);
    return {
      playbook: null,
      ...experiments,
      playbookHint: playbookHint(path.basename(projectDir)),
      ...(suggest ? { playbookSuggest: suggest } : {}),
      read,
    };
  }
  return { playbook: bound.playbook, ...experiments, read: [...new Set([...bound.read, ...read])] };
}

// --- The user's memory ---

/** Said once per answer, beside `memory`. */
export const MEMORY_HINT =
  "memory: entries for this playbook and step; decisions and preferences hold unless the user says otherwise now; observations are agents' unconfirmed views. Open one with pnpm memory --id <id> only when its summary bears on the step.";

/** `memoryWarning`: memory files that are invalid and were skipped; `pnpm memory --list` says why. */
export type MemoryFields = { memory?: MemoryRef[]; memoryHint?: string; memoryWarning?: string };

/** The workspace that holds `public/projects/<id>`: its `memory/` belongs to this user (AGENTBROS_MEMORY_ROOT overrides it). */
export const workspaceOf = (projectDir: string): string => path.resolve(projectDir, "..", "..", "..");

const PLATFORM_ALIASES: Record<string, PlaybookPlatform> = { reels: "instagram-reels", shorts: "youtube-shorts" };

/** The platform the project names, when it is one of the playbook platforms: strategy.json, else the footage goals' ad platform. */
export function projectPlatform(projectDir: string): PlaybookPlatform | undefined {
  const pipeline = path.join(projectDir, "pipeline");
  const strategy = readJson(path.join(pipeline, "strategy.json")) as { platform?: { name?: unknown } } | undefined;
  const goals = readJson(path.join(pipeline, "footage-goals.json")) as { platform?: unknown } | undefined;
  for (const name of [strategy?.platform?.name, goals?.platform]) {
    if (typeof name !== "string") continue;
    const key = name.trim().toLowerCase().replaceAll(" ", "-");
    const parsed = PlaybookPlatformSchema.safeParse(PLATFORM_ALIASES[key] ?? key);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/**
 * The memory fields of a next-step answer: the few active entries for the bound playbook, this step and the project's
 * platform (memoryFor's caps). Nothing for an unbound project (an unscoped query would match every playbook); with no
 * step, only entries scoped to no step. Never throws: a broken store gives no memory, and invalid files a warning.
 */
export function memoryFields(
  projectDir: string,
  step: string | null | undefined,
  playbook = readProjectPlaybook(projectDir)?.id,
  options: { lessons?: number; lessonsOnly?: boolean } = {},
): MemoryFields {
  try {
    if (!playbook) return {};
    const platform = projectPlatform(projectDir);
    const store = loadMemoryFast(workspaceOf(projectDir));
    const root = workspaceOf(projectDir);
    const ctx = {
      playbook,
      step: step ?? undefined,
      project: path.basename(projectDir),
      ...(platform ? { platform } : {}),
    };
    // A step that reads the creative lessons reserves room for the user's own lessons inside the one budget (QUERY_LIMIT, QUERY_MAX_CHARS).
    const lessons =
      options.lessons || options.lessonsOnly
        ? scopedMemory(store, ctx, root, {
            types: ["lesson"],
            limit: Math.min(options.lessons ?? QUERY_LIMIT, QUERY_LIMIT),
          })
        : [];
    const used = lessons.reduce((sum, ref) => sum + ref.summary.length, 0);
    const rest = options.lessonsOnly
      ? []
      : scopedMemory(store, ctx, root, { limit: QUERY_LIMIT - lessons.length, maxChars: QUERY_MAX_CHARS - used });
    const memory = [...rest, ...lessons.filter((lesson) => !rest.some((ref) => ref.id === lesson.id))];
    const warning = store.warnings.length
      ? `${store.warnings.length} memory file(s) are invalid and were skipped; pnpm memory --list says why.`
      : undefined;
    return {
      ...(memory.length ? { memory, memoryHint: MEMORY_HINT } : {}),
      ...(warning ? { memoryWarning: warning } : {}),
    };
  } catch {
    return {};
  }
}

/** `capture`: only where the answer waits on the user (verdict, choice, rejection) or follows a delivery. */
export type CaptureFields = { capture?: Capture };

/**
 * The newest delivery report of a project (pipeline/delivery/reports, written by `delivery --action check`) when its
 * state is production-ready, as a workspace-relative path; undefined otherwise. A study-only replica never gets one.
 */
export function passedDeliveryReport(projectDir: string): string | undefined {
  const dir = path.join(projectDir, "pipeline", "delivery", "reports");
  try {
    const newest = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) return undefined;
    const report = readJson(path.join(dir, newest.name)) as { state?: unknown } | undefined;
    return report?.state === "production-ready"
      ? path.join("public", "projects", path.basename(projectDir), "pipeline", "delivery", "reports", newest.name)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The capture field for a moment, scoped to the bound playbook, the step (none for a delivery), the project's platform
 * and the project (`project` names the delivered one when it differs, e.g. a recut). Empty without a moment, and a
 * delivery is empty until that project's latest delivery check passed.
 */
export function captureFields(
  projectDir: string,
  moment: CaptureMoment | undefined,
  step: string | null | undefined,
  options: { playbook?: string; project?: string } = {},
): CaptureFields {
  if (!moment) return {};
  const project = options.project ?? path.basename(projectDir);
  const measured =
    moment === "delivery" ? passedDeliveryReport(path.join(path.dirname(projectDir), project)) : undefined;
  if (moment === "delivery" && !measured) return {};
  const playbook = options.playbook ?? readProjectPlaybook(projectDir)?.id;
  const platform = projectPlatform(projectDir);
  return {
    capture: captureFor(moment, {
      project,
      ...(measured ? { measured } : {}),
      ...(playbook ? { playbook } : {}),
      ...(step && moment !== "delivery" ? { step } : {}),
      ...(platform ? { platform } : {}),
    }),
  };
}

const LIBRARY = "src/motion/library/AGENTS.md";
const AUDIO = "src/lib/audio/AGENTS.md";
const REAL_UI = "docs/real-ui.md";
const DELIVERY = "docs/delivery.md";
const FOOTAGE = "docs/footage-editing.md";
const AUDIO_INTEGRATIONS = "docs/audio-integrations.md";

/** The production chain's index, read at every film step; its sections are read only at the steps below. */
const CHAIN = "docs/production-chain.md";
const CREATIVE = "docs/production-chain/creative-department.md";
const BUILD_GATES = "docs/production-chain/build-gates.md";
const MEASURE = "docs/production-chain/measure-and-critic.md";
const REPLICA = "docs/production-chain/replica.md";

/** Film steps beyond the chain index and the step's STEP_RULES files; intake also reads the film type's page (filmRead). */
const FILM_STEP_READ: Record<string, string[]> = {
  /** The guard's stop (src/lib/film/guard.ts), not a chain step. */
  "present-best": ["docs/production-chain/autonomy.md"],
  rights: [REPLICA, ".agents/skills/reference-replica/SKILL.md"],
  "replica-reference": [REPLICA, "docs/reference-analysis.md"],
  "replica-spec": [REPLICA],
  "replica-compare": [REPLICA],
  reference: ["docs/reference-analysis.md"],
  strategy: [CREATIVE],
  ideas: [CREATIVE],
  "idea-review": [CREATIVE],
  concept: [CREATIVE],
  music: [AUDIO, AUDIO_INTEGRATIONS, ".agents/skills/sound-design-and-mix/SKILL.md"],
  "audio-map": [AUDIO],
  "script-variants": [CREATIVE],
  "script-review": [CREATIVE],
  script: [CREATIVE],
  narration: ["docs/production-chain/narration.md"],
  material: [
    "docs/production-chain/material.md",
    AUDIO_INTEGRATIONS,
    "docs/icon-resources.md",
    REAL_UI,
    ".agents/skills/engine-selection/SKILL.md",
    ".agents/skills/resource-discovery/SKILL.md",
  ],
  look: [LIBRARY, "design-reference/AGENTS.md"],
  "beat-sheet": [BUILD_GATES, LIBRARY, AUDIO],
  animatic: [BUILD_GATES, LIBRARY],
  build: [BUILD_GATES, "docs/icon-resources.md", LIBRARY, "src/motion/AGENTS.md", REAL_UI],
  sound: [AUDIO, AUDIO_INTEGRATIONS, ".agents/skills/sound-design-and-mix/SKILL.md"],
  measure: [BUILD_GATES, MEASURE, AUDIO],
  critic: [MEASURE, ".agents/skills/qa-and-delivery/SKILL.md"],
  human: [DELIVERY, "docs/production-chain/feedback.md", ".agents/skills/creative-postmortem/SKILL.md"],
};

/** A STEP_RULES token that names a guide rather than a file. */
const RULE_TOKEN: Record<string, string | undefined> = { library: LIBRARY, spine: undefined };

/** What a film step reads: the chain index, the step's sections and guides, its STEP_RULES; at intake the film types' pages (the index without a type). */
export function filmRead(stepId: string | undefined, types: readonly FilmType[] = []): string[] {
  const rules = stepId
    ? (STEP_RULES[stepId] ?? []).flatMap((rule) => (rule in RULE_TOKEN ? (RULE_TOKEN[rule] ?? []) : rule))
    : [];
  const typePages = stepId === "intake" ? (types.length ? types.map(filmTypeDoc) : ["docs/film-types.md"]) : [];
  return [...new Set([CHAIN, ...typePages, ...(stepId ? (FILM_STEP_READ[stepId] ?? []) : []), ...rules])];
}

/** Keyed by footage:next step ids. */
export const FOOTAGE_STEP_READ: Record<string, string[]> = {
  setup: [".agents/skills/recording-recut/SKILL.md"],
  "0-source": [],
  "1-transcript": ["docs/speech.md"],
  "1-speech-mask": ["docs/speech.md"],
  "2-shots": ["docs/footage-shots.md"],
  "3-recut-plan": [".agents/skills/recording-recut/SKILL.md"],
  "4-approve": [],
  "4-create": ["docs/timeline-edit.md"],
  "5-captions": [AUDIO_INTEGRATIONS, "docs/caption-delivery.md", ".agents/skills/captions-and-localization/SKILL.md"],
  "6-shorts": ["docs/workflows.md"],
  "7-cameras": ["docs/multicam-reframe.md"],
  "8-reframe": ["docs/multicam-reframe.md"],
  "9-render": [DELIVERY],
  done: [DELIVERY],
};

export function footageRead(step: string): string[] {
  return [FOOTAGE, ...(FOOTAGE_STEP_READ[step] ?? [])];
}

/** Keyed by timeline-route step (src/lib/pipeline/timeline-next.ts): a project.json rendered, checked and delivered as it stands. */
export const TIMELINE_STEP_READ: Record<string, string[]> = {
  render: ["src/components/AGENTS.md"],
  qa: [".agents/skills/qa-and-delivery/SKILL.md"],
  delivery: [".agents/skills/qa-and-delivery/SKILL.md"],
  done: [".agents/skills/creative-postmortem/SKILL.md"],
};

export function timelineRead(step: string): string[] {
  return [DELIVERY, ...(TIMELINE_STEP_READ[step] ?? [])];
}
