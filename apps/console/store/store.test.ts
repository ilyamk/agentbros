import { describe, expect, it, vi } from "vitest";
import type { ConsoleStreamMessage, ProjectView } from "@contract";
import { FixtureApiClient } from "@/api/fixture";
import { ApiFailure } from "@/api/errors";
import type { ApiClient, StreamHandlers } from "@/api/types";
import { fixtureEvents, fixtureProjects, fixtureViews } from "@/lib/fixtures";
import { createConsoleStore, EVENTS_PAGE, EVENTS_SHOWN, MAX_EVENTS_HELD, mergeEvents } from "./store";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeClient(views: ProjectView[]) {
  let handlers: StreamHandlers | undefined;
  const queue = [...views];
  const client: ApiClient = {
    mode: "http",
    start: vi.fn(async () => {}),
    projects: vi.fn(async () => fixtureProjects),
    view: vi.fn(async () => queue.shift() ?? views.at(-1)!),
    events: vi.fn(async () => ({ v: 1 as const, events: fixtureEvents.slice(0, 2), next: fixtureEvents[1]!.id })),
    decide: vi.fn(),
    control: vi.fn(),
    answerCard: vi.fn(),
    subscribe: vi.fn((_project: string | undefined, next: StreamHandlers) => {
      handlers = next;
      return () => (handlers = undefined);
    }),
  };
  return { client, emit: (message: ConsoleStreamMessage) => handlers?.message(message), handlers: () => handlers };
}

describe("console store", () => {
  it("bounds live event retention and marks truncated history as partial", async () => {
    const { client, emit } = fakeClient([fixtureViews.filmBuild]);
    const all = Array.from({ length: MAX_EVENTS_HELD }, (_, n) => ({
      ...fixtureEvents[0]!,
      id: `01KA8000000000000000${String(n).padStart(6, "0")}`,
    }));
    client.events = vi.fn(async () => ({ v: 1 as const, events: all, next: null }));
    const store = createConsoleStore(client);
    store.watch("promo-acme");
    await store.loadEvents("promo-acme");
    expect(store.getState().events["promo-acme"]!.partial).toBe(false);
    const event = { ...fixtureEvents[0]!, id: "01KA9000000000000000000000" };
    emit({ type: "event", event });
    const state = store.getState().events["promo-acme"]!;
    expect(state.items).toHaveLength(MAX_EVENTS_HELD);
    expect(state.items[0]!.id).toBe(all[1]!.id);
    expect(state.items.at(-1)!.id).toBe(event.id);
    expect(state.partial).toBe(true);
    emit({ type: "event", event });
    expect(store.getState().events["promo-acme"]!.items).toHaveLength(MAX_EVENTS_HELD);
    store.dispose();
  });
  it("watches a project: loads the view and home, refetches on a newer revision only", async () => {
    const v42 = fixtureViews.filmBuild;
    const v43 = { ...v42, revision: 43 };
    const { client, emit } = fakeClient([v42, v43]);
    const store = createConsoleStore(client);
    store.watch("promo-acme");
    await flush();
    expect(store.getState().views["promo-acme"]?.data?.revision).toBe(42);
    expect(store.getState().home.status).toBe("ready");
    emit({ type: "view.changed", project: "promo-acme", revision: 42 });
    await flush();
    expect(client.view).toHaveBeenCalledTimes(1);
    emit({ type: "view.changed", project: "promo-acme", revision: 43 });
    await flush();
    expect(client.view).toHaveBeenCalledTimes(2);
    expect(store.getState().views["promo-acme"]?.data?.revision).toBe(43);
  });

  it("never goes back to an older revision when replies cross", async () => {
    const { client } = fakeClient([{ ...fixtureViews.filmBuild, revision: 50 }, fixtureViews.filmBuild]);
    const store = createConsoleStore(client);
    await store.loadView("promo-acme");
    await store.loadView("promo-acme");
    expect(store.getState().views["promo-acme"]?.data?.revision).toBe(50);
  });

  it("coalesces refetches while a load is in flight", async () => {
    const { client } = fakeClient([fixtureViews.filmBuild]);
    const store = createConsoleStore(client);
    await Promise.all([store.loadView("promo-acme"), store.loadView("promo-acme"), store.loadView("promo-acme")]);
    await flush();
    expect(client.view).toHaveBeenCalledTimes(2);
  });

  it("drops a removed project's cached view, events and notices even if older requests finish later", async () => {
    const project = "promo-acme";
    const { client } = fakeClient([fixtureViews.filmBuild]);
    const store = createConsoleStore(client);
    await store.loadHome();
    await store.loadView(project);
    store.notify({ tone: "info", title: "Waiting for approval", route: `/projects/${project}/decision/approval` });
    let finishView!: (view: ProjectView) => void;
    let finishEvents!: (page: Awaited<ReturnType<ApiClient["events"]>>) => void;
    client.view = vi.fn(() => new Promise<ProjectView>((resolve) => (finishView = resolve)));
    client.events = vi.fn(
      () => new Promise<Awaited<ReturnType<ApiClient["events"]>>>((resolve) => (finishEvents = resolve)),
    );
    const loadingView = store.loadView(project);
    const loadingEvents = store.loadEvents(project);
    client.projects = vi.fn(async () => ({
      ...fixtureProjects,
      projects: fixtureProjects.projects.filter(({ id }) => id !== project),
    }));
    store.forgetProject(project);
    finishView(fixtureViews.filmBuild);
    finishEvents({ v: 1, events: fixtureEvents.slice(0, 2), next: null });
    await Promise.all([loadingView, loadingEvents]);

    const state = store.getState();
    expect(state.views[project]).toBeUndefined();
    expect(state.events[project]).toBeUndefined();
    expect(state.home.data?.projects.some(({ id }) => id === project)).toBe(false);
    expect(state.notices).toEqual([]);
    store.dispose();
  });

  it("clears a cached project view when the server says it has gone", async () => {
    const { client } = fakeClient([fixtureViews.filmBuild]);
    const store = createConsoleStore(client);
    await store.loadView("promo-acme");
    client.view = vi.fn().mockRejectedValue(new ApiFailure("PROJECT_NOT_FOUND", "Project not found", 404));
    await store.loadView("promo-acme");
    expect(store.getState().views["promo-acme"]?.data).toBeUndefined();
    expect(store.getState().views["promo-acme"]?.error?.status).toBe(404);
    store.dispose();
  });

  it("refetches what is shown after the stream reconnects", async () => {
    const { client, emit, handlers } = fakeClient([
      fixtureViews.filmBuild,
      { ...fixtureViews.filmBuild, revision: 1 },
      { ...fixtureViews.filmBuild, revision: 2 },
    ]);
    const store = createConsoleStore(client);
    store.watch("promo-acme");
    await flush();
    expect(store.getState().views["promo-acme"]?.data?.revision).toBe(42);
    handlers()?.error?.();
    expect(store.getState().stream).toBe("offline");
    handlers()?.open?.();
    await flush();
    expect(store.getState().stream).toBe("live");
    expect(client.view).toHaveBeenCalledTimes(2);
    expect(store.getState().views["promo-acme"]?.data?.revision).toBe(1);
    emit({ type: "view.changed", project: "promo-acme", revision: 2 });
    await flush();
    expect(store.getState().views["promo-acme"]?.data?.revision).toBe(2);
  });

  it("stops reporting retries when the server refuses the session", async () => {
    const { client, handlers } = fakeClient([fixtureViews.filmBuild]);
    const store = createConsoleStore(client);
    await store.start();
    store.watch(undefined);
    const error = new ApiFailure("UNAUTHORIZED", "Session expired", 403);
    handlers()?.error?.(error);
    expect(store.getState().session).toEqual({ status: "failed", error });
    expect(store.getState().stream).toBe("idle");
    expect(handlers()).toBeUndefined();
    store.dispose();
  });

  it("falls back to the global stream when the open project is removed", async () => {
    const { client, handlers } = fakeClient([fixtureViews.filmBuild]);
    const store = createConsoleStore(client);
    await store.start();
    store.watch("promo-acme");
    handlers()?.error?.(new ApiFailure("NOT_FOUND", "Project removed", 404));
    handlers()?.open?.();
    await flush();
    expect(client.subscribe).toHaveBeenLastCalledWith(undefined, expect.any(Object));
    expect(store.getState().session.status).toBe("ready");
    expect(store.getState().stream).toBe("live");
    expect(store.getState().views["promo-acme"]).toMatchObject({ status: "error", error: { status: 404 } });
    expect(store.getState().views["promo-acme"]?.data).toBeUndefined();
    store.dispose();
  });

  it("reads the journal to the newest event, keeps live events that arrive meanwhile, shows the newest first", async () => {
    const { client, emit } = fakeClient([fixtureViews.filmBuild]);
    const all = Array.from({ length: 2300 }, (_, n) => ({
      ...fixtureEvents[0]!,
      id: `01KA8000000000000000${String(n).padStart(6, "0")}`,
    }));
    const live = { ...fixtureEvents[0]!, id: "01KA9000000000000000000000" };
    client.events = vi.fn(async (_project: string, query: { since?: string; limit?: number } = {}) => {
      const start = query.since ? all.findIndex((event) => event.id === query.since) + 1 : 0;
      const events = all.slice(start, start + (query.limit ?? 200));
      // a live event lands while the first page is in flight
      if (!query.since) emit({ type: "event", event: live });
      const next = start + events.length < all.length ? events.at(-1)!.id : null;
      return { v: 1 as const, events, next };
    });
    const store = createConsoleStore(client);
    store.watch("promo-acme");
    await store.loadEvents("promo-acme");
    const state = store.getState().events["promo-acme"]!;
    expect(client.events).toHaveBeenCalledTimes(3);
    expect(state.items).toHaveLength(2301);
    expect(state.items.at(-1)?.id).toBe(live.id);
    expect(state.items.at(-2)?.id).toBe(all.at(-1)!.id);
    expect(state.shown).toBe(EVENTS_SHOWN);
    await store.loadEvents("promo-acme", { older: true });
    expect(store.getState().events["promo-acme"]!.shown).toBe(EVENTS_SHOWN * 2);
  });

  it("merges by id and refetches the journal tail after the stream reconnects", async () => {
    const { client, handlers } = fakeClient([fixtureViews.filmBuild]);
    const store = createConsoleStore(client);
    store.watch("promo-acme");
    await store.loadEvents("promo-acme");
    expect(store.getState().events["promo-acme"]?.items.map((event) => event.id)).toEqual(
      fixtureEvents.slice(0, 2).map((event) => event.id),
    );
    client.events = vi.fn(async () => ({ v: 1 as const, events: fixtureEvents.slice(1, 4), next: null }));
    handlers()?.error?.();
    handlers()?.open?.();
    await flush();
    await flush();
    expect(client.events).toHaveBeenCalledWith("promo-acme", { since: fixtureEvents[1]!.id, limit: EVENTS_PAGE });
    expect(store.getState().events["promo-acme"]?.items.map((event) => event.id)).toEqual(
      fixtureEvents.slice(0, 4).map((event) => event.id),
    );
  });

  it("merges events by id in id order", () => {
    const many = Array.from({ length: 5 }, (_, n) => ({ ...fixtureEvents[0]!, id: `01KA80000000000000000000${n}0` }));
    expect(mergeEvents(many.slice(2), many.slice(0, 3)).map((event) => event.id)).toEqual(
      many.map((event) => event.id),
    );
  });

  it("records a failed load as an error with the server's failure", async () => {
    const { client } = fakeClient([]);
    client.view = vi.fn(async () => {
      throw Object.assign(new Error("gone"), { code: "PROJECT_NOT_FOUND" });
    });
    const store = createConsoleStore(client);
    await store.loadView("nope");
    expect(store.getState().views.nope?.status).toBe("error");
  });

  it("keeps notices newest first and dismisses them", () => {
    const { client } = fakeClient([]);
    const store = createConsoleStore(client);
    const first = store.notify({ tone: "info", title: "One" });
    store.notify({ tone: "error", title: "Two" });
    expect(store.getState().notices.map((notice) => notice.title)).toEqual(["Two", "One"]);
    store.dismiss(first);
    expect(store.getState().notices.map((notice) => notice.title)).toEqual(["Two"]);
  });

  it("with the fixture client, a decision leaves the waiting list and bumps the revision", async () => {
    const store = createConsoleStore(
      new FixtureApiClient({ fixture: "view-film-build", now: () => Date.parse("2026-11-17T09:20:00Z") }),
    );
    store.watch("promo-acme");
    await flush();
    const reply = await store.decide("promo-acme", {
      decisionId: "dec-narration-quote",
      choice: "approve",
      answer: "Approve: Narration quote.",
    });
    expect(reply.decision.status).toBe("applied");
    expect(reply.decision.argv).toContain("Approve: Narration quote.");
    await flush();
    await flush();
    const view = store.getState().views["promo-acme"]?.data;
    expect(view?.waiting).toHaveLength(0);
    expect(view?.revision).toBe(43);
    expect(view?.steps.find((step) => step.id === "narration")?.status).toBe("done");
  });

  it("with the fixture client, a card answer is stored and pause changes control", async () => {
    const client = new FixtureApiClient({ fixture: "cards" });
    const answered = await client.answerCard("promo-acme", "card-endings", { choice: "b", text: "B lands better." });
    expect(answered.card.answer?.choice).toBe("b");
    await expect(client.answerCard("promo-acme", "card-notes", { text: "x" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const stopped = await client.control("promo-acme", { state: "stopped", answer: "Stop." });
    expect(stopped.control.state).toBe("stopped");
    expect(stopped.runningJobs?.map((job) => job.id)).toEqual(["job-narration-02", "job-sfx-03"]);
    expect((await client.view("promo-acme")).control.state).toBe("stopped");
  });
});
