/**
 * The console's default data source until the projector (RFC 0004 WP3) replaces it: projects are the folders of
 * `public/projects/` with a `project.json` or a `pipeline/brief.json`, summarised from a few marker files; a view is
 * the minimal valid `ProjectView`; the journal page reads `pipeline/events.jsonl`; changes come from `watch.ts`.
 * Revisions are in-memory counters per project (and one for the home page), so they restart with the server; the
 * stream's first message carries the current one and a client refetches whenever the number is not the next one.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  CONTROL_FILE,
  ConsoleEventSchema,
  ControlFileSchema,
  EVENTS_FILE,
  PROJECTS_DIR,
  ProjectIdSchema,
  ProjectSummarySchema,
  ProjectViewSchema,
  type ConsoleEvent,
  type ControlState,
  type EventsPage,
  type EventsQuery,
  type ProjectSummary,
  type ProjectsResponse,
  type ProjectView,
  type Route,
} from "../../types/console";
import { listCards } from "./cards";
import { readProjectTitle } from "../project-display";
import type { ConsoleChange, ConsoleDataSource } from "./data";
import { JournalTail, watchTree, type TreeWatchOptions } from "./watch";

const DEFAULT_EVENTS_LIMIT = 200;

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** The route from marker files only (no film-chain import): bespoke brief, footage files, campaign owner, else timeline. */
export function markerRoute(projectDir: string): Route {
  const pipeline = path.join(projectDir, "pipeline");
  if (readJson(path.join(pipeline, "brief.json"))?.renderMode === "bespoke") return "film";
  if (existsSync(path.join(pipeline, "campaign-production/owner.json"))) return "campaign";
  for (const file of ["footage-goals.json", "recording-edit.json", "shorts-series-binding.json"])
    if (existsSync(path.join(pipeline, file))) return "footage";
  return "timeline";
}

function controlState(projectDir: string): { state: ControlState; at?: string; reason?: string } {
  const parsed = ControlFileSchema.safeParse(readJson(path.join(projectDir, CONTROL_FILE)));
  return parsed.success
    ? { state: parsed.data.state, at: parsed.data.at, reason: parsed.data.reason }
    : { state: "running" };
}

function latestMtime(files: string[]): number {
  let latest = 0;
  for (const file of files) {
    try {
      latest = Math.max(latest, statSync(file).mtimeMs);
    } catch {
      // absent
    }
  }
  return latest;
}

export class FileDataSource implements ConsoleDataSource {
  readonly projectsDir: string;
  private readonly revisions = new Map<string, number>();
  private readonly hubs = new Map<
    string,
    { listeners: Set<(change: ConsoleChange) => void>; stop: () => void; tail?: JournalTail }
  >();

  constructor(
    readonly rootDir: string,
    private readonly watchOptions: TreeWatchOptions = {},
  ) {
    this.projectsDir = path.join(rootDir, PROJECTS_DIR);
  }

  /** Absolute directory of a valid, existing, non-symlinked project, or undefined. */
  projectDir(project: string): string | undefined {
    if (!ProjectIdSchema.safeParse(project).success) return undefined;
    const directory = path.join(this.projectsDir, project);
    try {
      const info = lstatSync(directory);
      return info.isDirectory() && !info.isSymbolicLink() ? directory : undefined;
    } catch {
      return undefined;
    }
  }

  private isProject(directory: string) {
    return existsSync(path.join(directory, "project.json")) || existsSync(path.join(directory, "pipeline/brief.json"));
  }

  summary(project: string): ProjectSummary | undefined {
    const directory = this.projectDir(project);
    if (!directory || !this.isProject(directory)) return undefined;
    const config = readJson(path.join(directory, "project.json")) ?? {};
    const brief = readJson(path.join(directory, "pipeline/brief.json")) ?? {};
    const binding = readJson(path.join(directory, "pipeline/playbook.json")) ?? {};
    const updated = latestMtime([
      directory,
      path.join(directory, "project.json"),
      path.join(directory, "pipeline"),
      path.join(directory, EVENTS_FILE),
    ]);
    const base = {
      id: project,
      route: markerRoute(directory),
      waiting: 0,
      control: controlState(directory).state,
      spentUsd: 0,
      updatedAt: new Date(updated || 0).toISOString(),
    };
    const full = {
      ...base,
      title: readProjectTitle(directory) ?? text(config.title, 200) ?? text(config.name, 200) ?? text(brief.title, 200),
      filmType: text(brief.filmType, 64),
      playbook: text(binding.id, 64) ?? text(binding.playbook, 64),
    };
    const parsed = ProjectSummarySchema.safeParse(
      Object.fromEntries(Object.entries(full).filter(([, value]) => value !== undefined)),
    );
    return parsed.success ? parsed.data : ProjectSummarySchema.parse(base);
  }

  async listProjects(): Promise<ProjectsResponse> {
    let names: string[] = [];
    try {
      names = readdirSync(this.projectsDir);
    } catch {
      names = [];
    }
    const projects = names
      .map((name) => this.summary(name))
      .filter((summary): summary is ProjectSummary => !!summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { v: 1, projects, waiting: [] };
  }

  async view(project: string): Promise<ProjectView | undefined> {
    const summary = this.summary(project);
    const directory = this.projectDir(project);
    if (!summary || !directory) return undefined;
    const control = controlState(directory);
    let createdAt = summary.updatedAt;
    try {
      const info = statSync(directory);
      createdAt = new Date(info.birthtimeMs || info.mtimeMs).toISOString();
    } catch {
      // keep updatedAt
    }
    return ProjectViewSchema.parse({
      v: 1,
      revision: this.revision(project),
      generatedAt: new Date().toISOString(),
      project: {
        id: project,
        route: summary.route,
        ...(summary.title ? { title: summary.title } : {}),
        ...(summary.filmType ? { filmType: summary.filmType } : {}),
        ...(summary.playbook ? { playbook: summary.playbook } : {}),
        createdAt,
      },
      control: {
        state: control.state,
        ...(control.state !== "running" || control.at ? { by: "user" } : {}),
        ...(control.at ? { at: control.at } : {}),
        ...(control.reason ? { reason: control.reason } : {}),
      },
      autonomy: { mode: "interactive", source: "none" },
      steps: [],
      waiting: [],
      agents: { today: [] },
      money: { reservedUsd: 0, spentUsd: 0, unknownPriced: 0, byProvider: [], jobs: [] },
      media: {},
      assets: [],
      qa: { findings: [] },
      cards: listCards(directory, project),
      advisories: ["Minimal view: the projector (RFC 0004 WP3) fills steps, decisions, money and media."],
    });
  }

  async events(project: string, query: EventsQuery): Promise<EventsPage> {
    const directory = this.projectDir(project);
    const limit = query.limit ?? DEFAULT_EVENTS_LIMIT;
    if (!directory) return { v: 1, events: [], next: null };
    let lines: string[] = [];
    try {
      lines = readFileSync(path.join(directory, EVENTS_FILE), "utf8").split("\n");
    } catch {
      lines = [];
    }
    const all: ConsoleEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = ConsoleEventSchema.safeParse(JSON.parse(line));
        if (parsed.success && (!query.since || parsed.data.id > query.since)) all.push(parsed.data);
      } catch {
        // skip a malformed line
      }
    }
    all.sort((a, b) => a.id.localeCompare(b.id));
    const events = all.slice(0, limit);
    return { v: 1, events, next: all.length > limit ? events.at(-1)!.id : null };
  }

  revision(project?: string): number {
    return this.revisions.get(project ?? "") ?? 0;
  }

  private bump(key: string) {
    const next = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, next);
    return next;
  }

  watch(project: string | undefined, onChange: (change: ConsoleChange) => void): () => void {
    const key = project ?? "";
    let hub = this.hubs.get(key);
    if (!hub) {
      const listeners = new Set<(change: ConsoleChange) => void>();
      const directory = project ? this.projectDir(project) : this.projectsDir;
      const journal = project && directory ? path.join(directory, EVENTS_FILE) : undefined;
      const tail = journal ? new JournalTail(journal) : undefined;
      const emit = (change: ConsoleChange) => {
        for (const listener of [...listeners]) listener(change);
      };
      const stop =
        directory && existsSync(directory)
          ? watchTree(
              directory,
              () => {
                const events = tail?.read() ?? [];
                const revision = this.bump(key);
                for (const event of events) emit({ type: "event", project, event, revision });
                emit({ type: "view.changed", project, revision });
              },
              {
                ...this.watchOptions,
                pollFiles: directory
                  ? [directory, path.join(directory, "pipeline"), ...(journal ? [journal] : [])]
                  : [],
              },
            )
          : () => undefined;
      hub = { listeners, stop, tail };
      this.hubs.set(key, hub);
    }
    hub.listeners.add(onChange);
    return () => {
      const current = this.hubs.get(key);
      if (!current) return;
      current.listeners.delete(onChange);
      if (current.listeners.size === 0) {
        current.stop();
        this.hubs.delete(key);
      }
    };
  }

  /** Stops every watcher (server shutdown). */
  close(): void {
    for (const hub of this.hubs.values()) hub.stop();
    this.hubs.clear();
  }
}

export const createFileDataSource = (rootDir: string, options: TreeWatchOptions = {}) =>
  new FileDataSource(rootDir, options);
