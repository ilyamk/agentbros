/**
 * Issuing step leases from the next-step answers: film (`next`, `film:next`, `film:brief`) and footage
 * (`next`, `footage:next`). The answers themselves stay reads-only; the scripts call these after them.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { COMMAND_REGISTRY } from "../cli/commands";
import { FILM_CHAIN, MATERIAL, NARRATION_DIRECTION } from "../film/chain";
import { resolveRoute, toolsFor } from "../film/routes";
import {
  baseTokens,
  commandsFor,
  fill,
  filmTypes,
  openFilmProject,
  spendApprovalEvents,
  type FilmProject,
  type NextAction,
} from "../film/state";
import type { FilmType } from "../../types/pipeline";
import type { StepLease } from "../../types/step-lease";
import type { FootageNext } from "../footage/next";
import {
  aliasesIn,
  chainHash,
  clearLease,
  CONTROL_ALIASES,
  LEASE_TTL_MS,
  leaseFile,
  projectDirOf,
  readLease,
  writeLease,
} from "./lease";

const REGISTERED = new Map(COMMAND_REGISTRY.filter((entry) => entry.alias).map((entry) => [entry.alias!, entry]));

const unique = (items: readonly string[]) => [...new Set(items)];

/** Registered aliases only, the control set first. */
const allowList = (aliases: readonly string[]) =>
  unique([...CONTROL_ALIASES, ...aliases]).filter((alias) => REGISTERED.has(alias));

/**
 * Aliases a prompt or task names in prose, without the user's own records: approvals (registry excluded as
 * "approval is the user's"), feedback and budget raises are never leased from prose, so a brief that mentions
 * them as forbidden moves cannot authorise them.
 */
export const proseAliases = (text: string): string[] =>
  aliasesIn(text).filter((alias) => {
    const entry = REGISTERED.get(alias);
    if (!entry || ["feedback", "budget"].includes(alias)) return false;
    return !(typeof entry.mcp === "object" && entry.mcp.excluded.startsWith("approval is the user's"));
  });

const spendingOf = (allow: readonly string[]) => allow.filter((alias) => REGISTERED.get(alias)?.paid !== "none");

/**
 * A film step's allow list: the control set, the step's own commands (film:done appended), the route's command
 * tools for the type, and any alias the next-step answer names (approvals, creative:rank, music, feedback).
 */
export function leaseAllow(
  stepId: string,
  type: FilmType,
  secondary?: FilmType,
  extra: readonly string[] = [],
): string[] {
  const step = FILM_CHAIN.find((item) => item.id === stepId);
  const own = step ? commandsFor(step).map((command) => command.alias) : [];
  const ask = step?.firstAsk ? [step.firstAsk.thenRun.alias] : [];
  const tools = toolsFor(stepId, type, secondary)
    .filter((tool) => tool.kind === "command")
    .map((tool) => tool.id);
  return allowList([...own, ...ask, ...tools, ...extra]);
}

/** Material spend is authorised only by the user's own yes, or a standing policy spend decision, on the current material.json (as material-sourced reads it). */
export function materialApproved(project: FilmProject): boolean {
  return userApproved(project, "material", MATERIAL);
}

/** Narration spend: the user's own yes, or a standing policy spend decision, on the current narrator-direction.json, which carries the takes' maxCostUsd (narration-ready). */
export function narrationApproved(project: FilmProject): boolean {
  return userApproved(project, "narration", NARRATION_DIRECTION);
}

/** The spend steps: material and narration, each on the user's yes (or a standing policy spend decision) to its current plan; never a proxy. */
export const spendApproved = (project: FilmProject, stepId: string): boolean =>
  (stepId === "material" && materialApproved(project)) || (stepId === "narration" && narrationApproved(project));

/**
 * Steps whose spend opens once the project has a budget ceiling raised with the user's words (`budget --answer`),
 * as footage leases do: music, where generated takes are quoted, the user says yes to the amount, and the ceiling
 * set from that answer is the authority. The guard still checks the ceiling at run time.
 */
const CEILING_SPEND_STEPS: readonly string[] = ["music"];

/** `paidWhen` for a film lease: only where the step spends at all and is a ceiling-spend step. */
const ceilingSpend = (stepId: string, spending: readonly string[]) =>
  CEILING_SPEND_STEPS.includes(stepId) && spending.length ? { paidWhen: "budget-ceiling" as const } : {};

function userApproved(project: FilmProject, stepId: string, template: string): boolean {
  const relative = fill(template, baseTokens(project));
  if (!relative) return false;
  const file = path.resolve(project.rootDir, relative);
  if (!existsSync(file)) return false;
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  return spendApprovalEvents(project, stepId).some((event) => event.artefacts[relative] === hash);
}

const routeTypes = (project: FilmProject) => {
  const { type, secondary } = filmTypes(project, baseTokens(project));
  const route = resolveRoute(type, secondary);
  return { type: route.type, ...(route.secondary ? { secondary: route.secondary } : {}) };
};

const stamp = (now: Date) => ({
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + LEASE_TTL_MS).toISOString(),
});

/** Aliases a film next-step answer names in its commands, questions' follow-ups, briefs and checks. */
const namedIn = (next: NextAction): string[] =>
  [
    ...(next.commands ?? []),
    ...(next.thenRun ?? []),
    ...(next.briefCommand ? [next.briefCommand] : []),
    ...(next.dispatches ?? []).map((item) => item.briefCommand),
    ...(next.benchmarkProxy ? [next.benchmarkProxy] : []),
    ...(next.orchestratorChecks ? [...next.orchestratorChecks.before, ...next.orchestratorChecks.after] : []),
  ].flatMap(aliasesIn);

/** The lease for a film project's next action; a closed chain (no step) clears it. */
export function filmLeaseFor(project: FilmProject, next: NextAction, issuedBy: string, now = new Date()) {
  if (!next.step) return undefined;
  const { type, secondary } = routeTypes(project);
  const role: StepLease["role"] =
    next.action !== "dispatch"
      ? "orchestrator"
      : /--role critic\b/.test(next.briefCommand ?? "")
        ? "critic"
        : /--role fixer\b/.test(next.briefCommand ?? "")
          ? "fixer"
          : "owner";
  const step = FILM_CHAIN.find((item) => item.id === next.step);
  const allow = leaseAllow(next.step, type, secondary, namedIn(next));
  return {
    schemaVersion: 1 as const,
    project: project.id,
    route: "film" as const,
    step: next.step,
    owner: next.agent ?? step?.owner ?? "orchestrator",
    role,
    lanes: unique((next.dispatches ?? []).map((item) => item.lane)),
    allow,
    spending: spendingOf(allow),
    paidAllowed: role !== "critic" && spendApproved(project, next.step),
    ...(role !== "critic" ? ceilingSpend(next.step, spendingOf(allow)) : {}),
    chainHash: chainHash(project.projectDir, "film"),
    ...stamp(now),
    issuedBy,
  } satisfies StepLease;
}

/** A compact view of a written lease for the command's metadata. */
export const leaseSummary = (rootDir: string, lease: StepLease) => ({
  file: path.relative(rootDir, leaseFile(projectDirOf(rootDir, lease.project))),
  step: lease.step,
  role: lease.role,
  owner: lease.owner,
  tools: lease.allow.filter((alias) => !(CONTROL_ALIASES as readonly string[]).includes(alias)),
  paidAllowed: lease.paidAllowed,
  ...(lease.paidWhen ? { paidWhen: lease.paidWhen } : {}),
  expiresAt: lease.expiresAt,
});

/** Writes (or, with no step, clears) a film project's lease; a failure clears it, so the guard never reads an old one. */
export function issueFilmLease(project: FilmProject, next: NextAction, issuedBy: string) {
  return issuing(project.rootDir, project.projectDir, () => filmLeaseFor(project, next, issuedBy));
}

/** film:brief: the brief's own step and role; parallel lanes of one step and chain merge into one lease. */
export function issueBriefLease(
  project: FilmProject,
  brief: { step: string; role: "owner" | "critic" | "fixer"; agent: string; lane?: string; prompt?: string },
  now = new Date(),
) {
  return issuing(project.rootDir, project.projectDir, () => {
    const { type, secondary } = routeTypes(project);
    // The brief's own commands too (a critic's critic:pack, a fixer's render and sensors), never the user's records.
    const allow = leaseAllow(brief.step, type, secondary, proseAliases(brief.prompt ?? ""));
    const hash = chainHash(project.projectDir, "film");
    const previous = readLease(project.projectDir);
    const earlier =
      previous && "lease" in previous && previous.lease.step === brief.step && previous.lease.role === brief.role
        ? previous.lease
        : undefined;
    const lanes =
      earlier && earlier.chainHash === hash ? unique([...earlier.lanes, ...(brief.lane ? [brief.lane] : [])]) : [];
    return {
      schemaVersion: 1 as const,
      project: project.id,
      route: "film" as const,
      step: brief.step,
      owner: brief.agent,
      role: brief.role,
      lanes: lanes.length ? lanes : brief.lane ? [brief.lane] : [],
      allow,
      spending: spendingOf(allow),
      paidAllowed: brief.role !== "critic" && spendApproved(project, brief.step),
      ...(brief.role !== "critic" ? ceilingSpend(brief.step, spendingOf(allow)) : {}),
      chainHash: hash,
      ...stamp(now),
      issuedBy: "film:brief",
    } satisfies StepLease;
  });
}

/** The footage lease: aliases from the answer's argv, commands and follow-ups; spend once a budget ceiling exists. */
export function footageLeaseFor(rootDir: string, next: FootageNext, issuedBy: string, now = new Date()) {
  const projectId = (next.state as { project?: unknown }).project;
  if (typeof projectId !== "string" || next.action === "stop") return undefined;
  const named = [
    ...(next.argv ?? []).flatMap((argv) => (argv[0] === "pnpm" && argv[1] ? [argv[1]] : [])),
    ...[...(next.commands ?? []), ...(next.thenRun ?? [])].flatMap(aliasesIn),
    ...proseAliases(next.task ?? ""),
  ];
  const allow = allowList(named);
  const spending = spendingOf(allow);
  return {
    schemaVersion: 1 as const,
    project: projectId,
    route: "footage" as const,
    step: next.step,
    owner: "footage-editor",
    role: "owner" as const,
    lanes: [],
    allow,
    spending,
    paidAllowed: false,
    ...(spending.length ? { paidWhen: "budget-ceiling" as const } : {}),
    chainHash: chainHash(projectDirOf(rootDir, projectId), "footage"),
    ...stamp(now),
    issuedBy,
  } satisfies StepLease;
}

export function issueFootageLease(rootDir: string, next: FootageNext, issuedBy: string) {
  const projectId = (next.state as { project?: unknown }).project;
  if (typeof projectId !== "string") return {};
  const projectDir = projectDirOf(rootDir, projectId);
  if (!existsSync(projectDir)) return {};
  return issuing(rootDir, projectDir, () => footageLeaseFor(rootDir, next, issuedBy));
}

/** `pnpm next`: the film and footage routes' answers issue a lease; other routes have none. */
export function issueRouteLease(rootDir: string, route: string, projectId: string, next: unknown) {
  if (route === "film")
    return issueFilmLease(openFilmProject(projectDirOf(rootDir, projectId), { rootDir }), next as NextAction, "next");
  if (route === "footage") return issueFootageLease(rootDir, next as FootageNext, "next");
  return {};
}

function issuing(
  rootDir: string,
  projectDir: string,
  make: () => StepLease | undefined,
): { stepLease?: ReturnType<typeof leaseSummary>; stepLeaseError?: string } {
  try {
    const lease = make();
    if (!lease) {
      clearLease(projectDir);
      return {};
    }
    writeLease(projectDir, lease);
    return { stepLease: leaseSummary(rootDir, lease) };
  } catch (error) {
    clearLease(projectDir);
    return { stepLeaseError: error instanceof Error ? error.message : String(error) };
  }
}
