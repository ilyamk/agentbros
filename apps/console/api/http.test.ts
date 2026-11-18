import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_TOKEN_HEADER, type ConsoleStreamMessage } from "@contract";
import { fixtureProjects, fixtureViews } from "@/lib/fixtures";
import { HttpApiClient } from "./http";
import { ApiFailure } from "./errors";
import { readStoredToken, takeFragmentToken, TOKEN_STORAGE_KEY } from "./session";
import { SseParser } from "./stream";

const TOKEN = "a".repeat(64);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; init: RequestInit };
function fakeFetch(...replies: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift();
    if (!reply) throw new Error("no reply queued");
    return reply;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}
const header = (call: Call | undefined, name: string) => (call?.init.headers as Record<string, string>)[name];

describe("HttpApiClient", () => {
  const noWait = { sleep: async () => {} };
  afterEach(() => window.sessionStorage.clear());

  it("posts the fragment token to /api/session, then sends it on every read and write", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { ok: true }),
      json(200, fixtureProjects),
      json(200, {
        ok: true,
        decision: {
          ...fixtureViews.filmBuild.waiting[0],
          status: "applied",
          decidedAt: "2026-11-17T09:20:00Z",
          answer: "Yes.",
        },
      }),
    );
    const client = new HttpApiClient({ fetch, fragment: { token: TOKEN }, ...noWait });
    await client.start();
    expect(calls[0]?.url).toBe("/api/session");
    expect(calls[0]?.init.method).toBe("POST");
    expect(header(calls[0], CONSOLE_TOKEN_HEADER)).toBe(TOKEN);
    expect(header(calls[0], "content-type")).toBe("application/json");
    await client.projects();
    expect(header(calls[1], CONSOLE_TOKEN_HEADER)).toBe(TOKEN);
    expect(calls[1]?.init.credentials).toBe("same-origin");
    const reply = await client.decide("promo-acme", {
      decisionId: "dec-narration-quote",
      choice: "approve",
      answer: "Yes.",
    });
    expect(reply.ok).toBe(true);
    expect(calls[2]?.url).toBe("/api/projects/promo-acme/decisions");
    expect(header(calls[2], CONSOLE_TOKEN_HEADER)).toBe(TOKEN);
    expect(header(calls[2], "content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      decisionId: "dec-narration-quote",
      choice: "approve",
      answer: "Yes.",
    });
  });

  it("uses the credentials capability only for key routes and clears it when pairing", async () => {
    const capability = "9".repeat(64);
    const list = { ok: true, editable: true, revision: null, keys: [] };
    window.history.replaceState(null, "", `/#token=${TOKEN}&credentials=${capability}`);
    const fragment = takeFragmentToken();
    expect(window.location.hash).toBe("");
    expect(fragment.credentials).toBe(capability);
    const { fetch, calls } = fakeFetch(
      json(200, { ok: true }),
      json(200, list),
      json(200, { ok: true, value: "example-key" }),
      json(200, list),
      json(200, { ok: true, token: TOKEN }),
      json(200, { ...list, editable: false }),
    );
    const owner = new HttpApiClient({ fetch, fragment, ...noWait });
    await owner.start();
    await owner.credentials();
    await owner.revealCredential("FAL_KEY", null);
    await owner.saveCredentials({ revision: null, changes: { FAL_KEY: null } });
    const paired = new HttpApiClient({ fetch, fragment: { pair: "1".repeat(32) }, ...noWait });
    await paired.start();
    expect((await paired.credentials()).editable).toBe(false);
    expect(calls.map((call) => header(call, "x-console-credentials"))).toEqual([
      undefined,
      capability,
      capability,
      capability,
      undefined,
      undefined,
    ]);
    expect(calls.slice(1, 4).every((call) => call.init.cache === "no-store")).toBe(true);
  });

  it("keeps the token in this tab's sessionStorage and reposts it after a reload (no GET of the token)", async () => {
    const first = fakeFetch(json(200, { ok: true }));
    await new HttpApiClient({ fetch: first.fetch, fragment: { token: TOKEN }, ...noWait }).start();
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    const { fetch, calls } = fakeFetch(
      json(200, { ok: true }),
      json(200, {
        ok: true,
        control: { v: 1, state: "paused", by: "user", channel: "console", at: "2026-11-17T09:20:00Z", history: [] },
      }),
    );
    const client = new HttpApiClient({ fetch, fragment: {}, ...noWait });
    await client.start();
    expect(calls[0]?.url).toBe("/api/session");
    expect(calls[0]?.init.method).toBe("POST");
    expect(header(calls[0], CONSOLE_TOKEN_HEADER)).toBe(TOKEN);
    await client.control("promo-acme", { state: "paused", answer: "Pause." });
    expect(header(calls[1], CONSOLE_TOKEN_HEADER)).toBe(TOKEN);
  });

  it("exchanges a #pair= code once for the token (stored for reloads), then sends the token", async () => {
    const code = "c".repeat(32);
    const { fetch, calls } = fakeFetch(json(200, { ok: true, token: TOKEN }), json(200, fixtureProjects));
    const client = new HttpApiClient({ fetch, fragment: { pair: code }, ...noWait });
    await client.start();
    expect(calls[0]?.url).toBe("/api/session/pair");
    expect(calls[0]?.init.method).toBe("POST");
    expect(header(calls[0], CONSOLE_TOKEN_HEADER)).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code });
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    await client.projects();
    expect(header(calls[1], CONSOLE_TOKEN_HEADER)).toBe(TOKEN);
  });

  it("a used pairing code falls back to the token this tab stored", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const { fetch, calls } = fakeFetch(
      json(403, { ok: false, error: "FORBIDDEN", message: "used" }),
      json(200, { ok: true }),
    );
    await new HttpApiClient({ fetch, fragment: { pair: "d".repeat(32) }, ...noWait }).start();
    expect(calls.map((call) => call.url)).toEqual(["/api/session/pair", "/api/session"]);
    expect(header(calls[1], CONSOLE_TOKEN_HEADER)).toBe(TOKEN);
  });

  it("a used pairing code without a stored token is UNAUTHORIZED", async () => {
    const { fetch } = fakeFetch(json(403, { ok: false, error: "FORBIDDEN", message: "used" }));
    await expect(
      new HttpApiClient({ fetch, fragment: { pair: "d".repeat(32) }, ...noWait }).start(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("without a fragment or a stored token, fails at once without asking the server", async () => {
    const { fetch, calls } = fakeFetch();
    const client = new HttpApiClient({ fetch, fragment: {}, ...noWait });
    await expect(client.start()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(calls).toHaveLength(0);
  });

  it("forgets a stored token the server refuses", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const { fetch } = fakeFetch(json(403, { ok: false, error: "FORBIDDEN", message: "Session token required" }));
    await expect(new HttpApiClient({ fetch, fragment: {}, ...noWait }).start()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(readStoredToken()).toBeUndefined();
  });

  it("refuses a session reply of another shape", async () => {
    const { fetch } = fakeFetch(json(200, { ok: true, token: TOKEN }));
    const client = new HttpApiClient({ fetch, fragment: { token: TOKEN }, ...noWait });
    await expect(client.start()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("fails start without a session, at once (no retry on 401/403)", async () => {
    const { fetch, calls } = fakeFetch(json(403, { ok: false, error: "FORBIDDEN", message: "Session token required" }));
    const client = new HttpApiClient({ fetch, fragment: { token: TOKEN }, ...noWait });
    await expect(client.start()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Session token required",
      status: 403,
    });
    expect(calls).toHaveLength(1);
  });

  it("retries the session with backoff, keeping the token in memory, then gives up; a later start tries again", async () => {
    let up = false;
    const calls: string[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>)[CONSOLE_TOKEN_HEADER] ?? "");
      if (!up) throw new TypeError("Failed to fetch");
      return json(200, { ok: true });
    }) as unknown as typeof globalThis.fetch;
    const delays: number[] = [];
    const attempts: number[] = [];
    const client = new HttpApiClient({
      fetch,
      fragment: { token: TOKEN },
      retryDelays: [10, 20],
      sleep: async (ms) => void delays.push(ms),
    });
    await expect(client.start({ onAttempt: (n) => attempts.push(n) })).rejects.toMatchObject({ code: "NETWORK" });
    expect(attempts).toEqual([1, 2, 3]);
    expect(delays).toEqual([10, 20]);
    expect(calls).toEqual([TOKEN, TOKEN, TOKEN]);
    up = true;
    await client.start();
    expect(calls.at(-1)).toBe(TOKEN);
    expect(client.authenticated).toBe(true);
  });

  it("keeps trying the stored session after a longer restart with capped backoff", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const delays: number[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)[CONSOLE_TOKEN_HEADER]).toBe(TOKEN);
      if (delays.length < 7) throw new TypeError("Server is restarting");
      return json(200, { ok: true });
    });
    const client = new HttpApiClient({ fetch, fragment: {}, sleep: async (ms) => void delays.push(ms) });

    await client.start();

    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    expect(client.authenticated).toBe(true);
  });

  it("parses replies through the contract and reports a bad one", async () => {
    const { fetch } = fakeFetch(json(200, fixtureProjects), json(200, { ...fixtureViews.filmBuild, v: 2 }));
    const client = new HttpApiClient({ fetch, fragment: {} });
    expect((await client.projects()).projects.length).toBe(fixtureProjects.projects.length);
    await expect(client.view("promo-acme")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("keeps the server's error message verbatim (501 until control lands)", async () => {
    const { fetch } = fakeFetch(
      json(501, { ok: false, error: "INTERNAL", message: "console:control is not implemented yet" }),
    );
    const client = new HttpApiClient({ fetch, fragment: {} });
    const error = await client
      .control("promo-acme", { state: "paused", answer: "Pause." })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({ code: "INTERNAL", message: "console:control is not implemented yet", status: 501 });
  });

  it("returns a refused decision as an answer, not a transport error", async () => {
    const refused = {
      ok: false,
      decision: {
        ...fixtureViews.filmBuild.waiting[0],
        status: "refused",
        decidedAt: "2026-11-17T09:20:00Z",
        answer: "Yes.",
        result: { ok: false, error: "VALIDATION", message: "stale --expect" },
      },
    };
    const { fetch } = fakeFetch(json(409, refused));
    const client = new HttpApiClient({ fetch, fragment: {} });
    const reply = await client.decide("promo-acme", { decisionId: "dec-narration-quote", answer: "Yes." });
    expect(reply.ok).toBe(false);
    expect(reply.decision.result?.message).toBe("stale --expect");
  });

  it("validates requests before sending (the user's words are required)", async () => {
    const { fetch, calls } = fakeFetch();
    const client = new HttpApiClient({ fetch, fragment: {} });
    await expect(client.decide("promo-acme", { decisionId: "x", answer: "  " })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("network errors become NETWORK failures", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    const client = new HttpApiClient({ fetch, fragment: {} });
    await expect(client.projects()).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("pages the journal with since and limit", async () => {
    const { fetch, calls } = fakeFetch(json(200, { v: 1, events: [], next: null }));
    const client = new HttpApiClient({ fetch, fragment: {} });
    await client.events("promo-acme", { since: "01KA7Z00000000000000000002", limit: 50 });
    expect(calls[0]?.url).toBe("/api/projects/promo-acme/events?since=01KA7Z00000000000000000002&limit=50");
  });

  it("reads the stream with fetch and the token header, parsing view.changed and event messages", async () => {
    const encoder = new TextEncoder();
    let push: (text: string) => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(encoder.encode(text));
      },
    });
    const { fetch, calls } = fakeFetch(
      json(200, { ok: true }),
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const client = new HttpApiClient({ fetch, fragment: { token: TOKEN }, ...noWait });
    await client.start();
    const messages: ConsoleStreamMessage[] = [];
    const open = vi.fn();
    const stop = client.subscribe("promo-acme", { message: (message) => messages.push(message), open });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(calls[1]?.url).toBe("/api/stream?project=promo-acme");
    expect(header(calls[1], CONSOLE_TOKEN_HEADER)).toBe(TOKEN);
    push("retry: 2000\n\n: heartbeat\n\n");
    push('event: view.changed\nid: 43\ndata: {"type":"view.changed","project":"promo-acme",');
    push('"revision":43}\n\nevent: event\ndata: not json\n\nevent: event\ndata: {"type":"event","event":{"v":1}}\n\n');
    await vi.waitFor(() => expect(messages).toEqual([{ type: "view.changed", project: "promo-acme", revision: 43 }]));
    stop();
    expect((calls[1]?.init.signal as AbortSignal).aborted).toBe(true);
  });

  it("does not open the stream before a session, and stops for good on 403", async () => {
    const idle = new HttpApiClient({ fetch: vi.fn() as never, fragment: {} });
    expect(typeof idle.subscribe(undefined, { message: () => {} })).toBe("function");
    const { fetch, calls } = fakeFetch(json(200, { ok: true }), json(403, { ok: false, error: "FORBIDDEN" }));
    const client = new HttpApiClient({ fetch, fragment: { token: TOKEN }, ...noWait });
    await client.start();
    const error = vi.fn();
    client.subscribe(undefined, { message: () => {}, error });
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHORIZED", status: 403 }));
    expect(client.authenticated).toBe(false);
    expect(readStoredToken()).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("reconnects the open stream with the same session after a restart", async () => {
    const retry = new Response("retry: 1\n\n");
    let resumedStream!: ReadableStreamDefaultController<Uint8Array>;
    const resumed = new Response(
      new ReadableStream<Uint8Array>({ start: (controller) => (resumedStream = controller) }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const { fetch, calls } = fakeFetch(json(200, { ok: true }), retry, json(503, {}), resumed);
    const client = new HttpApiClient({ fetch, fragment: { token: TOKEN }, ...noWait });
    await client.start();
    const open = vi.fn();
    const error = vi.fn();
    const stop = client.subscribe(undefined, { message: () => {}, open, error });
    try {
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
      expect(error.mock.calls).toEqual([[], []]);
      expect(calls.map(({ url }) => url)).toEqual(["/api/session", "/api/stream", "/api/stream", "/api/stream"]);
      expect(calls.every((call) => header(call, CONSOLE_TOKEN_HEADER) === TOKEN)).toBe(true);
    } finally {
      stop();
      resumedStream.close();
    }
  });
});

describe("SseParser", () => {
  it("joins data lines, names events, skips comments, reads retry and handles split CRLF", () => {
    const frames: [string, string][] = [];
    const retries: number[] = [];
    const parser = new SseParser(
      (event, data) => frames.push([event, data]),
      (ms) => retries.push(ms),
    );
    parser.push("retry: 1500\r");
    parser.push("\n: comment\r\ndata: a\r\ndata: b\r\n\r\nevent: x\ndata:c\n\nevent: empty\n\n");
    expect(frames).toEqual([
      ["message", "a\nb"],
      ["x", "c"],
    ]);
    expect(retries).toEqual([1500]);
  });
});

describe("takeFragmentToken", () => {
  it("reads #token= and strips it from the address bar, opening &project= when given", () => {
    window.history.replaceState(null, "", `/?x=1#token=${TOKEN}&project=promo-acme`);
    const taken = takeFragmentToken();
    expect(taken).toEqual({ token: TOKEN, route: "/projects/promo-acme" });
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.hash).toBe("#/projects/promo-acme");
    expect(window.location.search).toBe("?x=1");
  });

  it("reads #pair= with &project= and &view=, stripping it from the address bar", () => {
    const code = "e".repeat(32);
    window.history.replaceState(null, "", `/#pair=${code}&project=promo-acme&view=timeline`);
    expect(takeFragmentToken()).toEqual({ pair: code, route: "/projects/promo-acme/timeline" });
    expect(window.location.href).not.toContain(code);
    window.history.replaceState(null, "", `/#pair=short`);
    expect(takeFragmentToken()).toEqual({ route: undefined });
  });

  it("leaves route hashes alone and refuses foreign routes", () => {
    window.history.replaceState(null, "", "/#/settings");
    expect(takeFragmentToken()).toEqual({});
    expect(window.location.hash).toBe("#/settings");
    window.history.replaceState(null, "", `/#token=${TOKEN}&project=../evil`);
    expect(takeFragmentToken()).toEqual({ token: TOKEN, route: undefined });
    expect(window.location.hash).toBe("");
  });

  it("opens &view=timeline or history on the project; any other view opens the canvas (WP13e)", () => {
    window.history.replaceState(null, "", `/#token=${TOKEN}&project=spring-batch&view=timeline`);
    expect(takeFragmentToken()).toEqual({ token: TOKEN, route: "/projects/spring-batch/timeline" });
    expect(window.location.hash).toBe("#/projects/spring-batch/timeline");
    window.history.replaceState(null, "", `/#token=${TOKEN}&project=promo-acme&view=history`);
    expect(takeFragmentToken().route).toBe("/projects/promo-acme/history");
    window.history.replaceState(null, "", `/#token=${TOKEN}&project=promo-acme&view=../../settings`);
    expect(takeFragmentToken().route).toBe("/projects/promo-acme");
  });
});
