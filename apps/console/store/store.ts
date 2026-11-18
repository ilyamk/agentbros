/**
 * The console's client state (RFC 0004 D3, D6): a small external store read with `useSyncExternalStore`. It holds what
 * the server projected (home, views, journal pages), the stream status and the in-page notices; it never holds truth
 * of its own. A `view.changed` message with a newer revision refetches the view; a reconnect refetches what is shown.
 */
import type {
  CardAnswerRequest,
  ConsoleEvent,
  ConsoleStreamMessage,
  ControlRequest,
  DecisionRequest,
  JobCancelRequest,
  ProjectView,
  ProjectsResponse,
} from "@contract";
import { ApiFailure, asFailure } from "@/api/errors";
import type { ApiClient } from "@/api/types";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface Resource<T> {
  status: LoadStatus;
  data?: T;
  error?: ApiFailure;
}

export interface EventsState {
  status: LoadStatus;
  /** The journal read so far, unique by id and oldest first (ids are ULIDs, so id order is time order). */
  items: ConsoleEvent[];
  /** How many of the newest items the History shows; "Load older" raises it. */
  shown: number;
  /** True when the journal held more than {@link MAX_EVENTS_HELD}: the oldest were dropped, the newest kept. */
  partial: boolean;
  error?: ApiFailure;
}

export type NoticeTone = "info" | "success" | "warning" | "error";

/** An in-page notification (the notification stack). Text is already in the UI language or verbatim from the server. */
export interface Notice {
  id: string;
  tone: NoticeTone;
  title: string;
  text?: string;
  /** Hash route to open, e.g. `/projects/promo-acme`. */
  route?: string;
}

export interface ConsoleState {
  mode: ApiClient["mode"];
  /** `attempt` counts session requests (more than 1 means the server was not reachable at first). */
  session: { status: "pending" | "ready" | "failed"; attempt?: number; error?: ApiFailure };
  stream: "idle" | "connecting" | "live" | "offline" | "closed";
  home: Resource<ProjectsResponse>;
  views: Record<string, Resource<ProjectView>>;
  events: Record<string, EventsState>;
  notices: Notice[];
}

export interface ConsoleStore {
  getState(): ConsoleState;
  subscribe(listener: () => void): () => void;
  readonly client: ApiClient;
  /** Opens the session; call again after a failure (the client keeps the fragment token in memory). */
  start(): Promise<void>;
  loadHome(): Promise<void>;
  loadView(project: string): Promise<void>;
  forgetProject(project: string): void;
  /** Shows a project (or the home page when undefined): loads it and keeps one stream open for it. */
  watch(project: string | undefined): void;
  /**
   * Reads the project's journal: the first call pages through to the newest event, later calls fetch only what came
   * after the last one held (also after a stream reconnect). Results merge by id with live events, never replace them.
   * `older` shows {@link EVENTS_SHOWN} more of what is held.
   */
  loadEvents(project: string, options?: { older?: boolean }): Promise<void>;
  decide: ApiClient["decide"];
  control: ApiClient["control"];
  /** Cancels one paid job (D12); throws NOT_IMPLEMENTED where the client has no cancel (snapshot mode). */
  cancelJob: NonNullable<ApiClient["cancelJob"]>;
  answerCard: ApiClient["answerCard"];
  notify(notice: Omit<Notice, "id"> & { id?: string }): string;
  dismiss(id: string): void;
  dispose(): void;
}

/** Page size for `/events` (the contract's maximum). */
export const EVENTS_PAGE = 1000;
/** Events the History shows at first and per "Load older". */
export const EVENTS_SHOWN = 200;
/**
 * The journal API pages oldest first (`since`), so reaching the newest event means reading forward to the end. The
 * client keeps at most this many (the newest) and marks the history partial; a `before` cursor in the contract would
 * let it read only the newest page (proposed contract change).
 */
export const MAX_EVENTS_HELD = 50_000;

/** Unique by id, oldest first. */
export function mergeEvents(current: readonly ConsoleEvent[], incoming: readonly ConsoleEvent[]): ConsoleEvent[] {
  if (!incoming.length) return current as ConsoleEvent[];
  const byId = new Map<string, ConsoleEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function createConsoleStore(client: ApiClient): ConsoleStore {
  let state: ConsoleState = {
    mode: client.mode,
    session: { status: "pending" },
    stream: "idle",
    home: { status: "idle" },
    views: {},
    events: {},
    notices: [],
  };
  const listeners = new Set<() => void>();
  const inflight = new Map<string, Promise<void>>();
  const again = new Set<string>();
  let watched: { project: string | undefined; close: () => void } | undefined;
  let noticeSeq = 0;
  let homeVersion = 0;
  let reconnecting = false;
  // The server's project revisions start over when its projector restarts.
  let currentViews = new WeakSet<ProjectView>();

  const set = (patch: (current: ConsoleState) => ConsoleState) => {
    state = patch(state);
    for (const listener of listeners) listener();
  };

  /** Runs one load per key at a time; a request during a load runs once more afterwards (coalesced refetch). */
  const once = (key: string, load: () => Promise<void>): Promise<void> => {
    const running = inflight.get(key);
    if (running) {
      again.add(key);
      return running;
    }
    const run = (async () => {
      try {
        await load();
      } finally {
        inflight.delete(key);
        if (again.delete(key)) void once(key, load);
      }
    })();
    inflight.set(key, run);
    return run;
  };

  const loadHome = () =>
    once("home", async () => {
      const version = homeVersion;
      set((s) => ({ ...s, home: { ...s.home, status: s.home.data ? "ready" : "loading" } }));
      try {
        const data = await client.projects();
        if (version !== homeVersion) return;
        set((s) => ({ ...s, home: { status: "ready", data } }));
      } catch (error) {
        if (version !== homeVersion) return;
        set((s) => ({ ...s, home: { ...s.home, status: "error", error: asFailure(error) } }));
      }
    });

  const loadView = (project: string) =>
    once(`view:${project}`, async () => {
      const connectionViews = currentViews;
      set((s) => {
        const current = s.views[project];
        return { ...s, views: { ...s.views, [project]: { ...current, status: current?.data ? "ready" : "loading" } } };
      });
      try {
        const data = await client.view(project);
        if (connectionViews !== currentViews) return;
        set((s) => {
          const resource = s.views[project];
          if (!resource) return s;
          const current = resource.data;
          // Never go back to an older revision when replies cross.
          if (current && currentViews.has(current) && current.revision > data.revision) return s;
          currentViews.add(data);
          return { ...s, views: { ...s.views, [project]: { status: "ready", data } } };
        });
      } catch (error) {
        if (connectionViews !== currentViews) return;
        const failure = asFailure(error);
        set((s) => {
          const resource = s.views[project];
          if (!resource) return s;
          const data = failure.status === 404 || failure.code === "PROJECT_NOT_FOUND" ? undefined : resource.data;
          return { ...s, views: { ...s.views, [project]: { data, status: "error", error: failure } } };
        });
      }
    });

  const appendEvent = (event: ConsoleEvent) => {
    const project = event.project;
    if (!project) return;
    set((s) => {
      const current = s.events[project];
      if (!current || current.items.some((item) => item.id === event.id)) return s;
      const items = mergeEvents(current.items, [event]);
      return {
        ...s,
        events: {
          ...s.events,
          [project]: {
            ...current,
            items: items.slice(-MAX_EVENTS_HELD),
            partial: current.partial || items.length > MAX_EVENTS_HELD,
          },
        },
      };
    });
  };

  const onMessage = (message: ConsoleStreamMessage) => {
    if (message.type === "event") {
      appendEvent(message.event);
      return;
    }
    const project = message.project;
    if (project) {
      const current = state.views[project]?.data;
      const known = current && currentViews.has(current) ? current.revision : -1;
      if (message.revision > known && state.views[project]) void loadView(project);
    }
    if (watched && watched.project === undefined) void loadHome();
  };

  const refresh = (project: string | undefined) => {
    void loadHome();
    if (project) void loadView(project);
  };

  /** After a reconnect: the view and home, and the journal of every project whose History was opened. */
  const refreshAll = (project: string | undefined) => {
    refresh(project);
    for (const id of Object.keys(state.events)) void loadEventsTail(id);
  };

  const loadEventsTail = (project: string) =>
    once(`events:${project}`, async () => {
      set((s) => ({
        ...s,
        events: {
          ...s.events,
          [project]: { items: [], shown: EVENTS_SHOWN, partial: false, ...s.events[project], status: "loading" },
        },
      }));
      try {
        let since = state.events[project]?.items.at(-1)?.id;
        for (;;) {
          const page = await client.events(project, { ...(since ? { since } : {}), limit: EVENTS_PAGE });
          if (!state.events[project]) return;
          set((s) => {
            const current = s.events[project]!;
            let items = mergeEvents(current.items, page.events);
            const partial = current.partial || items.length > MAX_EVENTS_HELD;
            if (items.length > MAX_EVENTS_HELD) items = items.slice(items.length - MAX_EVENTS_HELD);
            return { ...s, events: { ...s.events, [project]: { ...current, items, partial } } };
          });
          // Stop at the end, or if the cursor does not advance (never loop on a misbehaving server).
          if (!page.next || !page.events.length || page.next === since) break;
          since = page.next;
        }
        set((s) => ({
          ...s,
          events: { ...s.events, [project]: { ...s.events[project]!, status: "ready", error: undefined } },
        }));
      } catch (error) {
        if (!state.events[project]) return;
        set((s) => ({
          ...s,
          events: {
            ...s.events,
            [project]: { ...s.events[project]!, status: "error", error: asFailure(error) },
          },
        }));
      }
    });

  const store: ConsoleStore = {
    client,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      set((s) => ({ ...s, session: { status: "pending" } }));
      try {
        await client.start({
          onAttempt: (attempt) => set((s) => ({ ...s, session: { status: "pending", attempt } })),
        });
        set((s) => ({ ...s, session: { status: "ready" } }));
      } catch (error) {
        set((s) => ({ ...s, session: { status: "failed", error: asFailure(error) } }));
      }
    },
    loadHome,
    loadView,
    forgetProject(project) {
      homeVersion++;
      again.delete(`view:${project}`);
      again.delete(`events:${project}`);
      set((s) => {
        const views = { ...s.views };
        const events = { ...s.events };
        delete views[project];
        delete events[project];
        const route = `/projects/${project}`;
        const data = s.home.data;
        const home = data
          ? {
              ...s.home,
              data: {
                ...data,
                projects: data.projects.filter(({ id }) => id !== project),
                waiting: data.waiting.filter((decision) => decision.project !== project),
                recentDeliveries: data.recentDeliveries?.filter((delivery) => delivery.project !== project),
              },
            }
          : s.home;
        return {
          ...s,
          views,
          events,
          home,
          notices: s.notices.filter((notice) => notice.route !== route && !notice.route?.startsWith(`${route}/`)),
        };
      });
      void loadHome();
    },
    watch(project) {
      if (watched && watched.project === project) return;
      watched?.close();
      set((s) => ({ ...s, stream: "connecting" }));
      const close = client.subscribe(project, {
        message: onMessage,
        open: () => {
          const reconnected = reconnecting;
          reconnecting = false;
          if (reconnected) currentViews = new WeakSet<ProjectView>();
          set((s) => ({ ...s, stream: "live" }));
          if (reconnected) refreshAll(project);
        },
        error: (error) => {
          reconnecting = true;
          if (!error) {
            set((s) => ({ ...s, stream: "offline" }));
            return;
          }
          watched?.close();
          watched = undefined;
          if (error.code === "UNAUTHORIZED") {
            set((s) => ({ ...s, stream: "idle", session: { status: "failed", error } }));
          } else if (error.status === 404 && project) {
            currentViews = new WeakSet<ProjectView>();
            set((s) => ({ ...s, views: { ...s.views, [project]: { status: "error", error } } }));
            store.watch(undefined);
          } else {
            set((s) => ({ ...s, stream: "closed" }));
          }
        },
      });
      watched = { project, close };
      refresh(project);
    },
    async loadEvents(project, options = {}) {
      if (options.older) {
        set((s) => {
          const current = s.events[project];
          if (!current) return s;
          return { ...s, events: { ...s.events, [project]: { ...current, shown: current.shown + EVENTS_SHOWN } } };
        });
        return;
      }
      await loadEventsTail(project);
    },
    async decide(project: string, request: DecisionRequest, options?: { dryRun?: boolean }) {
      const reply = await client.decide(project, request, options);
      if (!options?.dryRun) refresh(project);
      return reply;
    },
    async cancelJob(project: string, jobId: string, request: JobCancelRequest) {
      if (!client.cancelJob) throw new ApiFailure("NOT_IMPLEMENTED", "Cancelling a job needs the console server.", 501);
      const reply = await client.cancelJob(project, jobId, request);
      refresh(project);
      return reply;
    },
    async control(project: string, request: ControlRequest) {
      const reply = await client.control(project, request);
      refresh(project);
      return reply;
    },
    async answerCard(project: string, cardId: string, request: CardAnswerRequest) {
      const reply = await client.answerCard(project, cardId, request);
      refresh(project);
      return reply;
    },
    notify(notice) {
      const id = notice.id ?? `notice-${++noticeSeq}`;
      set((s) => ({ ...s, notices: [{ ...notice, id }, ...s.notices.filter((item) => item.id !== id)].slice(0, 20) }));
      return id;
    },
    dismiss(id) {
      set((s) => ({ ...s, notices: s.notices.filter((item) => item.id !== id) }));
    },
    dispose() {
      watched?.close();
      watched = undefined;
      listeners.clear();
    },
  };
  return store;
}
