/** Every name a playbook points to resolves in the repository. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BenchSuiteSchema } from "../../types/bench";
import { CaptionProfileIdSchema } from "../../types/caption-style";
import { PlaybookSchema, type Playbook, type PlaybookRoute } from "../../types/playbook";
import { FILM_CHAIN } from "../film/chain";
import { FILM_TYPES } from "../film/routes";
import { FOOTAGE_STEP_READ, TIMELINE_STEP_READ } from "../pipeline/route";
import { RECIPES } from "../templates/recipes";
import { TEMPLATE_REGISTRY } from "../templates/registry";
import { STYLE_PROFILES } from "../templates/styles";
import { WORKFLOWS } from "../workflows/dispatch";
import { listPlaybookIds, PLAYBOOKS_DIR, playbooksRoot } from "./project";

/** `pnpm X` words in a command line. */
export const pnpmAliases = (line: string): string[] =>
  [...line.matchAll(/(?<![\w./-])pnpm\s+(?:--\s+)?([a-z][a-z0-9:_-]*)/g)].map((match) => match[1]!);

/**
 * A `ready` or `proven` playbook has `reviewedAt`, at least 3 intake questions and at least 1 platform profile; `--check`
 * refuses one that lacks them (`readinessProblems` holds the rule).
 */
export const ENFORCE_READY_FIELDS = true;

/** A review older than this is a warning, never an error: platform rules and trends move in months. */
export const REVIEW_MAX_AGE_DAYS = 180;

/** Caption profile ids a platform profile may name: every timeline caption profile (presets, template profiles, legacy aliases), or none. */
export const CAPTION_PROFILE_IDS: readonly string[] = [...CaptionProfileIdSchema.options, "none"];

/** Step ids a playbook's `stepRead` may name: every route's next-step keys. */
const ROUTE_STEP_IDS = new Set([
  ...FILM_CHAIN.map((step) => step.id),
  ...Object.keys(FOOTAGE_STEP_READ),
  ...Object.keys(TIMELINE_STEP_READ),
]);

export type KnownNames = {
  ids: string[];
  scripts: Record<string, string>;
  blocks: Set<string>;
  categories: Set<string>;
  benchmarks: Set<string>;
  styles?: Set<string>;
  templates?: Set<string>;
};

/** What a playbook's names resolve against, read from `root`. */
export function knownNames(root = playbooksRoot()): Required<KnownNames> {
  const scripts = (
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }
  ).scripts;
  const catalogue = JSON.parse(readFileSync(path.join(root, "docs/library/catalogue.json"), "utf8")) as {
    items: { id: string; category: string }[];
    styles?: { id: string }[];
  };
  const suite = BenchSuiteSchema.parse(JSON.parse(readFileSync(path.join(root, "bench/suite.json"), "utf8")));
  return {
    ids: listPlaybookIds(root),
    scripts,
    blocks: new Set(catalogue.items.map((item) => item.id)),
    categories: new Set(catalogue.items.map((item) => item.category)),
    benchmarks: new Set(suite.tasks.map((task) => task.id)),
    styles: new Set([...(catalogue.styles ?? []).map((style) => style.id), ...Object.keys(STYLE_PROFILES)]),
    templates: new Set(TEMPLATE_REGISTRY.map((template) => template.id)),
  };
}

function routeProblems(route: PlaybookRoute, where: string, scripts: Record<string, string>): string[] {
  const problems: string[] = [];
  if (route.kind === "film") {
    for (const type of [route.filmType, route.secondaryFilmType])
      if (type && !FILM_TYPES.includes(type)) problems.push(`${where}: unknown film type ${type}`);
  }
  if (route.kind === "workflow" && !WORKFLOWS.some((workflow) => workflow.id === route.workflow))
    problems.push(`${where}: unknown workflow ${route.workflow}`);
  if (route.kind === "template" && !RECIPES.some((recipe) => recipe.id === route.recipe))
    problems.push(`${where}: unknown recipe ${route.recipe}`);
  const aliases = pnpmAliases(route.start);
  if (!aliases.length) problems.push(`${where}: start names no pnpm command`);
  for (const alias of aliases)
    if (!(alias in scripts)) problems.push(`${where}: start names pnpm ${alias}, not a package.json alias`);
  return problems;
}

/** An optional third-party skill: whether this copy has it, and how to install it from upstream when it does not. */
export type OptionalSkill = { id: string; installed: boolean; source: string | null; install: string | null };

/** `skills-lock.json` sources of the vendored third-party skills (an optional skill must be one of them). */
export function lockedSkillSources(root = playbooksRoot()): Map<string, string> {
  const file = path.join(root, "skills-lock.json");
  if (!existsSync(file)) return new Map();
  const lock = JSON.parse(readFileSync(file, "utf8")) as { skills?: Record<string, { source?: string }> };
  return new Map(
    Object.entries(lock.skills ?? {}).flatMap(([id, entry]) =>
      typeof entry.source === "string" ? [[id, entry.source] as const] : [],
    ),
  );
}

export function optionalSkills(playbook: Pick<Playbook, "optionalSkills">, root = playbooksRoot()): OptionalSkill[] {
  const sources = lockedSkillSources(root);
  return (playbook.optionalSkills ?? []).map((id) => {
    const source = sources.get(id) ?? null;
    return {
      id,
      installed: existsSync(path.join(root, ".agents/skills", id, "SKILL.md")),
      source,
      install: source ? `npx skills add ${source}` : null,
    };
  });
}

/** The readiness rule (applied by validatePlaybookRefs only while ENFORCE_READY_FIELDS is on). */
export function readinessProblems(playbook: Playbook): string[] {
  if (playbook.status === "draft") return [];
  const problems: string[] = [];
  if (!playbook.reviewedAt) problems.push(`a ${playbook.status} playbook needs reviewedAt`);
  if ((playbook.intake?.length ?? 0) < 3)
    problems.push(
      `a ${playbook.status} playbook needs at least 3 intake questions (has ${playbook.intake?.length ?? 0})`,
    );
  if (!playbook.profiles?.length) problems.push(`a ${playbook.status} playbook needs at least 1 platform profile`);
  return problems;
}

/** A warning when `reviewedAt` is older than REVIEW_MAX_AGE_DAYS; undefined when recent or absent. */
export function reviewAgeWarning(playbook: Playbook, now = new Date()): string | undefined {
  if (!playbook.reviewedAt) return undefined;
  const days = Math.floor((now.getTime() - Date.parse(`${playbook.reviewedAt}T00:00:00Z`)) / 86_400_000);
  return days > REVIEW_MAX_AGE_DAYS
    ? `reviewed ${days} days ago (${playbook.reviewedAt}); recheck its platform rules and References (limit ${REVIEW_MAX_AGE_DAYS} days)`
    : undefined;
}

/** Ready playbooks without benchmark coverage remain usable until strict checking is enabled. */
export function benchmarkWarning(playbook: Pick<Playbook, "status" | "benchmarks">): string | undefined {
  return playbook.status === "ready" && !playbook.benchmarks.length
    ? "a ready playbook needs at least 1 benchmark task from bench/suite.json"
    : undefined;
}

function newFieldProblems(playbook: Playbook, known: KnownNames): string[] {
  const problems: string[] = [];
  playbook.profiles?.forEach((profile, index) => {
    if (profile.captions && !CAPTION_PROFILE_IDS.includes(profile.captions))
      problems.push(
        `profiles[${index}].captions: unknown caption profile ${profile.captions} (known: ${CAPTION_PROFILE_IDS.join(", ")})`,
      );
  });
  if (playbook.starter) {
    for (const block of playbook.starter.blocks)
      if (!known.blocks.has(block)) problems.push(`starter: unknown library block ${block}`);
    if (playbook.starter.style && known.styles && !known.styles.has(playbook.starter.style))
      problems.push(`starter: unknown style ${playbook.starter.style}`);
    if (playbook.starter.template && known.templates && !known.templates.has(playbook.starter.template))
      problems.push(`starter: unknown template ${playbook.starter.template}`);
  }
  const seen = new Set<string>();
  for (const variant of playbook.variants ?? []) {
    if (seen.has(variant.id)) problems.push(`variant id ${variant.id} is repeated`);
    seen.add(variant.id);
    if (known.ids.includes(variant.id)) problems.push(`variant id ${variant.id} is a playbook id`);
    for (const trigger of [...variant.triggers.en, ...variant.triggers.ru, ...(variant.triggers.zh ?? [])])
      if (trigger !== trigger.toLowerCase())
        problems.push(`variant ${variant.id}: trigger "${trigger}" is not lower case`);
  }
  return problems;
}

export function playbookProblems(
  playbook: Playbook,
  root: string,
  known: KnownNames,
  options: { strictBenchmarks?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const at = (relative: string) => existsSync(path.join(root, relative));
  // The schema leaves zh optional for fixtures; every real playbook matches Chinese requests too.
  if ((playbook.triggers.zh?.length ?? 0) < 3) problems.push("triggers.zh: at least 3 Chinese triggers");
  const listed = new Set([...playbook.triggers.en, ...playbook.triggers.ru, ...(playbook.triggers.zh ?? [])]);
  for (const trigger of playbook.triggers.generic ?? [])
    if (!listed.has(trigger)) problems.push(`triggers.generic: "${trigger}" is not one of the playbook's triggers`);
  for (const agent of playbook.agents) if (!at(`.agents/agents/${agent}.md`)) problems.push(`unknown agent ${agent}`);
  for (const skill of playbook.skills)
    if (!at(`.agents/skills/${skill}/SKILL.md`)) problems.push(`unknown skill ${skill}`);
  const locked = lockedSkillSources(root);
  for (const skill of playbook.optionalSkills ?? []) {
    if (playbook.skills.includes(skill)) problems.push(`optional skill ${skill} is also in skills`);
    if (!locked.has(skill)) problems.push(`optional skill ${skill} has no upstream source in skills-lock.json`);
  }
  for (const category of playbook.library.categories)
    if (!known.categories.has(category)) problems.push(`unknown library category ${category}`);
  for (const block of playbook.library.blocks)
    if (!known.blocks.has(block)) problems.push(`unknown library block ${block}`);
  for (const command of playbook.commands) if (!(command in known.scripts)) problems.push(`unknown command ${command}`);
  for (const benchmark of playbook.benchmarks)
    if (!known.benchmarks.has(benchmark))
      problems.push(`unknown benchmark task ${benchmark} (not in bench/suite.json)`);
  const warning = benchmarkWarning(playbook);
  if (options.strictBenchmarks && warning) problems.push(warning);
  for (const file of playbook.read) if (!at(file)) problems.push(`read path ${file} does not exist`);
  for (const [step, files] of Object.entries(playbook.stepRead ?? {})) {
    if (!ROUTE_STEP_IDS.has(step))
      problems.push(`stepRead: unknown step ${step} (film chain steps, footage:next steps or template stages)`);
    for (const file of files) {
      if (!at(file)) problems.push(`stepRead.${step} path ${file} does not exist`);
      else if (playbook.read.includes(file)) problems.push(`stepRead.${step}: ${file} is already in read`);
    }
  }
  for (const entry of playbook.notFor) {
    if (entry.use === playbook.id) problems.push(`notFor points to itself`);
    else if (!known.ids.includes(entry.use)) problems.push(`notFor names unknown playbook ${entry.use}`);
  }
  problems.push(...routeProblems(playbook.route, "route", known.scripts));
  playbook.alternatives.forEach((alternative, index) =>
    problems.push(...routeProblems(alternative.route, `alternatives[${index}]`, known.scripts)),
  );
  problems.push(...newFieldProblems(playbook, known));
  if (ENFORCE_READY_FIELDS) problems.push(...readinessProblems(playbook));
  return problems;
}

/** Problems across every playbook folder, each prefixed with its id; empty when sound. */
export function validatePlaybookRefs(root = playbooksRoot(), options: { strictBenchmarks?: boolean } = {}): string[] {
  const known = knownNames(root);
  const problems: string[] = [];
  for (const id of known.ids) {
    const file = path.join(root, PLAYBOOKS_DIR, id, "playbook.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      problems.push(`${id}: playbook.json is not JSON (${(error as Error).message})`);
      continue;
    }
    const parsed = PlaybookSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(
        ...parsed.error.issues.map((issue) => `${id}: ${issue.path.join(".") || "(root)"}: ${issue.message}`),
      );
      continue;
    }
    if (parsed.data.id !== id) problems.push(`${id}: id "${parsed.data.id}" differs from its folder`);
    if (!existsSync(path.join(root, PLAYBOOKS_DIR, id, "AGENTS.md"))) problems.push(`${id}: AGENTS.md is missing`);
    problems.push(...playbookProblems(parsed.data, root, known, options).map((problem) => `${id}: ${problem}`));
  }
  return problems;
}

/** Warnings across every loadable playbook (review age and benchmark coverage), each prefixed with its id. */
export function playbookWarnings(playbooks: Playbook[], now = new Date()): string[] {
  return playbooks.flatMap((playbook) => {
    return [reviewAgeWarning(playbook, now), benchmarkWarning(playbook)].flatMap((warning) =>
      warning ? [`${playbook.id}: ${warning}`] : [],
    );
  });
}
