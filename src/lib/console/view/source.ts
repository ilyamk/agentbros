/**
 * The projector as the console server's data source (RFC 0004 WP3, D6, FR1, §4.4). Revisions are monotonic in-memory
 * counters per project (and one for the home page): a watched project bumps on every debounced file change under
 * `public/projects/<id>/`, `out/<id>/` or `src/projects/<id>/` (render staleness depends on the film's code) and on new
 * journal lines; `out/<id>/` and `src/projects/<id>/` are picked up when they first appear. Every read also compares a
 * cheap stat fingerprint, so a change a watcher missed still bumps (and, while watched, is pushed). The first
 * fingerprint is a baseline, so a fresh server reports revision 0.
 * Views are cached by revision (and rebuilt at most every {@link VIEW_MAX_AGE_MS} for clock-bound fields).
 */
import { readdirSync, watch as fsWatch, type Dirent } from "node:fs";
import path from "node:path";
import {
  PROJECTS_DIR,
  ProjectIdSchema,
  type Decision,
  type EventsPage,
  type EventsQuery,
  type ProjectSummary,
  type ProjectsResponse,
  type ProjectView,
} from "../../../types/console";
import { PROJECT_DISPLAY_FILE } from "../../project-display";
import type { ConsoleChange, ConsoleDataSource } from "../data";
import { eventsFileSize, readEvents, readEventsAfter, type EventsCursor } from "../events-reader";
import { ignoredChange, watchTree, type TreeWatchOptions } from "../watch";
import { MetricsCache, type ConsoleMetrics } from "../metrics";
import { JournalCache } from "./activity";
import { buildProjectView, isProject } from "./build";
import { sha256, statOf, projectPaths, type ProjectPaths } from "./files";
import { readMoney } from "./money";
import { projectSummary } from "./summary";

/** Clock-bound fields (durations, today's runs, card expiry) are refreshed at least this often. */
export const VIEW_MAX_AGE_MS = 30_000;
const FINGERPRINT_MAX_ENTRIES = 8000;

type ProjectState = {
  paths: ProjectPaths;
  revision: number;
  fingerprint?: string;
  cached?: { revision: number; builtAt: number; view: ProjectView };
  journal: JournalCache;
  watchers: number;
  /** Set while watched: pushes `view.changed` for a change found by the fingerprint rather than a watcher. */
  notify?: () => void;
};

/** The film's code directory, whose changes make a render stale. */
export const codeDir = (paths: ProjectPaths): string => path.join(paths.rootDir, "src", "projects", paths.id);

type Hub = { listeners: Set<(change: ConsoleChange) => void>; stop: () => void };

/** A stat fingerprint of the project's files and its renders (downloads and caches ignored). */
export function fingerprint(paths: ProjectPaths): string {
  const title = statOf(path.join(paths.projectDir, PROJECT_DISPLAY_FILE));
  const parts = title ? [`title:${title.ino}:${title.mtimeMs}:${title.size}`] : [];
  let budget = FINGERPRINT_MAX_ENTRIES;
  // Each folder has its own budget: a large project folder never hides the renders or the film's code.
  const walk = (directory: string, prefix: string, depth: number, top = true) => {
    if (top) budget = FINGERPRINT_MAX_ENTRIES;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignoredChange(relative)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(full, relative, depth - 1, false);
      } else if (entry.isFile()) {
        const info = statOf(full);
        if (info) parts.push(`${relative}:${info.size}:${info.mtimeMs}`);
      }
    }
  };
  walk(paths.projectDir, "p", 12);
  walk(paths.outDir, "o", 2);
  walk(codeDir(paths), "s", 8);
  return sha256(parts.sort().join("\n"));
}

export class ProjectorDataSource implements ConsoleDataSource {
  readonly projectsDir: string;
  private readonly projects = new Map<string, ProjectState>();
  private readonly hubs = new Map<string, Hub>();
  private homeRevision = 0;
  private homeFingerprint?: string;
  /** Items this month with an unknown price, from the last `listProjects()` (the contract has no field for it yet). */
  monthUnknownPriced = 0;
  private metricsCache?: MetricsCache;

  constructor(
    readonly rootDir: string,
    private readonly options: TreeWatchOptions & { now?: () => number } = {},
  ) {
    this.rootDir = path.resolve(rootDir);
    this.projectsDir = path.join(this.rootDir, PROJECTS_DIR);
  }

  private now = () => this.options.now?.() ?? Date.now();

  private state(project: string): ProjectState | undefined {
    if (!ProjectIdSchema.safeParse(project).success) return undefined;
    const paths = projectPaths(this.rootDir, project);
    const info = statOf(paths.projectDir);
    if (!info?.isDirectory() || !isProject(paths)) return undefined;
    let state = this.projects.get(project);
    if (!state) {
      state = { paths, revision: 0, journal: new JournalCache(paths.projectDir), watchers: 0 };
      this.projects.set(project, state);
    }
    return state;
  }

  /** Bumps the revision when the files changed since the last look (unwatched projects); returns the revision. */
  private refresh(state: ProjectState): number {
    const next = fingerprint(state.paths);
    const changed = state.fingerprint !== undefined && next !== state.fingerprint;
    state.fingerprint = next;
    if (changed) {
      state.revision += 1;
      if (state.watchers > 0) state.notify?.();
    }
    return state.revision;
  }

  async view(project: string): Promise<ProjectView | undefined> {
    const state = this.state(project);
    if (!state) return undefined;
    const revision = this.refresh(state);
    const now = this.now();
    const cached = state.cached;
    if (cached && cached.revision === revision && now - cached.builtAt < VIEW_MAX_AGE_MS) return cached.view;
    const view = buildProjectView(this.rootDir, project, { revision, now, journal: state.journal });
    if (!view) return undefined;
    state.cached = { revision, builtAt: now, view };
    return view;
  }

  forgetProject(project: string): void {
    const state = this.projects.get(project);
    this.projects.delete(project);
    if (!state) return;
    state.revision += 1;
    state.notify?.();
  }

  private projectIds(): string[] {
    try {
      return readdirSync(this.projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ProjectIdSchema.safeParse(entry.name).success)
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  async listProjects(): Promise<ProjectsResponse> {
    const projects: ProjectSummary[] = [];
    const waiting: Decision[] = [];
    const deliveries: NonNullable<ProjectsResponse["recentDeliveries"]> = [];
    const month = new Date(this.now());
    month.setDate(1);
    month.setHours(0, 0, 0, 0);
    let monthSpentUsd = 0;
    let monthUnknownPriced = 0;
    for (const id of this.projectIds()) {
      const view = await this.view(id).catch(() => undefined);
      if (!view) continue;
      const state = this.projects.get(id);
      if (!state) continue;
      projects.push(projectSummary(view, state.paths));
      waiting.push(...view.waiting);
      try {
        const { money } = readMoney(state.paths, { since: month.getTime() });
        monthSpentUsd += money.spentUsd;
        monthUnknownPriced += money.unknownPriced;
      } catch {
        // a corrupt store is already an advisory in its view
      }
      if (view.qa.delivery?.ok && view.media.latestRender)
        deliveries.push({ project: id, media: view.media.latestRender, checkedAt: view.qa.delivery.checkedAt });
    }
    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    this.monthUnknownPriced = monthUnknownPriced;
    return {
      v: 1,
      projects,
      waiting: waiting.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 200),
      // A total missing unknown-priced items would read as complete: it is left out until the contract can carry the
      // count beside it (see `monthUnknownPriced`); each project's view still shows its own count.
      ...(monthUnknownPriced === 0 ? { monthSpentUsd: Math.round(monthSpentUsd * 1e6) / 1e6 } : {}),
      recentDeliveries: deliveries.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).slice(0, 50),
    };
  }

  /** Interaction metrics over every project's view (§12): recomputed only when a revision changed. */
  async metrics(): Promise<ConsoleMetrics> {
    const views: ProjectView[] = [];
    for (const id of this.projectIds()) {
      const view = await this.view(id).catch(() => undefined);
      if (view) views.push(view);
    }
    this.metricsCache ??= new MetricsCache(this.rootDir);
    return this.metricsCache.get(views, this.now());
  }

  async events(project: string, query: EventsQuery): Promise<EventsPage> {
    if (!this.state(project)) return { v: 1, events: [], next: null };
    return readEvents(this.rootDir, project, query);
  }

  revision(project?: string): number {
    if (project === undefined) {
      if (!this.hubs.has("")) {
        const next = sha256(
          this.projectIds()
            .map((id) => `${id}:${statOf(path.join(this.projectsDir, id))?.mtimeMs}`)
            .join("|"),
        );
        if (this.homeFingerprint !== undefined && next !== this.homeFingerprint) this.homeRevision += 1;
        this.homeFingerprint = next;
      }
      return this.homeRevision;
    }
    const state = this.state(project);
    return state ? this.refresh(state) : 0;
  }

  watch(project: string | undefined, onChange: (change: ConsoleChange) => void): () => void {
    const key = project ?? "";
    let hub = this.hubs.get(key);
    if (!hub) {
      const listeners = new Set<(change: ConsoleChange) => void>();
      const emit = (change: ConsoleChange) => {
        for (const listener of [...listeners]) listener(change);
      };
      hub = { listeners, stop: project ? this.watchProject(project, emit) : this.watchHome(emit) };
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

  private watchProject(project: string, emit: (change: ConsoleChange) => void): () => void {
    const state = this.state(project);
    if (!state) return () => undefined;
    this.refresh(state);
    state.watchers += 1;
    const journalFile = state.journal.file;
    let cursor: EventsCursor = { offset: eventsFileSize(journalFile) };
    const onFlush = () => {
      let events: ReturnType<typeof readEventsAfter>["events"] = [];
      try {
        const read = readEventsAfter(journalFile, cursor);
        cursor = read.cursor;
        events = read.events;
      } catch {
        events = [];
      }
      state.revision += 1;
      state.fingerprint = fingerprint(state.paths);
      const revision = state.revision;
      for (const event of events) emit({ type: "event", project, event, revision });
      emit({ type: "view.changed", project, revision });
    };
    state.notify = () => emit({ type: "view.changed", project, revision: state.revision });
    const pollFiles = [state.paths.projectDir, path.join(state.paths.projectDir, "pipeline"), journalFile];
    const stops = [
      watchTree(state.paths.projectDir, onFlush, { ...this.options, pollFiles }),
      this.watchWhenPresent(state.paths.outDir, onFlush),
      this.watchWhenPresent(codeDir(state.paths), onFlush),
    ];
    return () => {
      state.watchers = Math.max(0, state.watchers - 1);
      if (state.watchers === 0) state.notify = undefined;
      for (const stop of stops) stop();
    };
  }

  /**
   * Watches `directory` recursively once it exists: when it is missing, a non-recursive watch on its parent (or, when
   * the parent is missing too, a slow poll) starts the tree watch the moment it appears and flushes once.
   */
  private watchWhenPresent(directory: string, onFlush: () => void): () => void {
    let stopTree: (() => void) | undefined;
    let stopWait: (() => void) | undefined;
    let stopped = false;
    const start = () => {
      if (stopped || stopTree || !statOf(directory)?.isDirectory()) return false;
      stopWait?.();
      stopWait = undefined;
      stopTree = watchTree(directory, onFlush, { ...this.options, pollFiles: [directory] });
      return true;
    };
    if (!start()) {
      const name = path.basename(directory);
      const check = () => {
        if (start()) onFlush();
      };
      const poll = setInterval(check, Math.max(250, this.options.pollMs ?? 1000));
      poll.unref();
      let parentWatcher: ReturnType<typeof fsWatch> | undefined;
      try {
        parentWatcher = fsWatch(path.dirname(directory), (_type, file) => {
          if (file === null || String(file) === name) check();
        });
        parentWatcher.on("error", () => undefined);
        parentWatcher.unref();
      } catch {
        parentWatcher = undefined; // the parent is missing: the poll covers it
      }
      stopWait = () => {
        clearInterval(poll);
        parentWatcher?.close();
      };
    }
    return () => {
      stopped = true;
      stopWait?.();
      stopTree?.();
    };
  }

  private watchHome(emit: (change: ConsoleChange) => void): () => void {
    if (!statOf(this.projectsDir)?.isDirectory()) return () => undefined;
    return watchTree(
      this.projectsDir,
      () => {
        this.homeRevision += 1;
        emit({ type: "view.changed", revision: this.homeRevision });
      },
      { ...this.options, pollFiles: [this.projectsDir] },
    );
  }

  /** Stops every watcher (server shutdown). */
  close(): void {
    for (const hub of this.hubs.values()) hub.stop();
    this.hubs.clear();
  }
}

export const createProjectorDataSource = (rootDir: string, options: TreeWatchOptions & { now?: () => number } = {}) =>
  new ProjectorDataSource(rootDir, options);
