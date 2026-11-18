/**
 * The timeline's offline realtime editor (RU-R, RU-RC, RU-RS; the review:ui parity checklist). Replaces the
 * vm-evaluated review:ui tests for these rows (realtime-still-bootstrap.test.ts, realtime-still-client.test.ts and
 * the client half of review-realtime-browser / realtime-derive-browser / review-realtime-channel-browser): an in-memory
 * review server behind the real `ReviewApi`, a fake WebSocket behind `channelTransport`, and the React section.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { FixtureApiClient } from "@/api/fixture";
import type { TextTransport } from "@/api/types";
import { chooseOption, fixtureStore, FIXTURE_NOW, renderWith, selectOptions } from "@/test/utils";
import { ReviewApi } from "../api";
import { TimelineView } from "../index";
import { RealtimeEditorController } from "./realtime-controller";
import {
  checkStillListing,
  DERIVE_QUOTE_SOURCE,
  derivePatch,
  derivePrefill,
  disabledMatrix,
  editorSummary,
  stillIdentity,
  stillPayload,
  STILL_DEFAULTS,
  type RealtimeEditorView,
  type RealtimeRevision,
} from "./realtime-model";
import { realtimeEn, realtimeRu } from "./realtime.strings";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const H = (c: string) => c.repeat(64);
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------------------------------------------------
// In-memory review server: the realtime routes of /api/review/<project>/ with the service's CAS (409) semantics.

interface Editor {
  editorId: string;
  sequence: number;
  ceilingUsd: number;
  committedUsd: number;
  queued?: string;
  inFlight?: string;
  selected?: string;
  revisions: RealtimeRevision[];
}

const revision = (revisionId: string, status: string): RealtimeRevision => ({
  revisionId,
  sessionId: "s-" + revisionId,
  status,
  highUsd: 0.5,
  inputHash: H("1"),
  request: { sha256: H("2") },
});

class FakeServer {
  editors = new Map<string, Editor>();
  unresolved = 0;
  calls: { method: string; route: string; body?: any }[] = [];
  fail?: (route: string, method: string) => { status: number; body: unknown } | undefined;
  hold?: { route: string; release?: () => void; promise?: Promise<void> };
  stills: unknown = {
    metadataOnly: true,
    registrySha256: H("e"),
    sources: [
      { assetId: "sha256:" + H("f"), assetSha256: H("f"), mime: "image/png", width: 32, height: 24, bytes: 99 },
    ],
  };

  view(editorId: string): RealtimeEditorView {
    const editor = this.editors.get(editorId);
    if (!editor) throw new Error("Unknown editor");
    return { ...structuredClone(editor), frames: [], offline: true, selectionIsApproval: false };
  }

  readonly transport: TextTransport = async (method, url, body) => {
    const parsed = new URL(url, "http://127.0.0.1");
    const route = parsed.pathname.replace("/api/review/demo/", "");
    this.calls.push({ method, route: route + parsed.search, body });
    if (this.hold && this.hold.route === route + parsed.search) {
      const hold = this.hold;
      this.hold = undefined;
      await hold.promise;
    }
    const failed = this.fail?.(route + parsed.search, method);
    if (failed) return { status: failed.status, text: JSON.stringify(failed.body) };
    const ok = (value: unknown) => ({ status: 200, text: JSON.stringify(value) });
    const editor = parsed.searchParams.get("editor") ?? "";
    if (method === "GET" && route === "realtime")
      return ok(
        editor
          ? this.view(editor)
          : {
              editors: [...this.editors.values()].map(({ editorId, sequence }) => ({ editorId, sequence })),
              errors: [],
            },
      );
    if (method === "GET" && route === "realtime/channel-state") {
      const e = this.editors.get(editor)!;
      return ok({ sequence: e.sequence, stateSha256: H(String(e.sequence % 10)), unresolvedCount: this.unresolved });
    }
    if (method === "GET" && route === "realtime/request") return ok({ pinned: parsed.searchParams.get("revision") });
    if (method === "GET" && route === "realtime/derive-source")
      return ok({
        sourceRevision: parsed.searchParams.get("revision"),
        input: { prompt: "a fox", seed: 7, schedule_mu: 1.1 },
      });
    if (method === "GET" && route === "realtime/still-sources") return ok(this.stills);
    if (method === "POST" && route === "realtime/channel-ticket")
      return ok({
        version: 1,
        ...(body as object),
        ticket: H("a"),
        expiresAt: Date.now() + 4000,
        path: "/api/realtime/channel",
        protocol: "avc-local-editor-v1",
        sequence: this.editors.get((body as { editorId: string }).editorId)!.sequence,
        stateSha256: H("b"),
        unresolvedCount: this.unresolved,
        providerAck: false,
        providerPersistent: false,
        liveVerified: false,
      });
    if (method === "POST" && route === "realtime") return this.mutate(body as Record<string, any>);
    return { status: 404, text: JSON.stringify({ ok: false, error: "NOT_FOUND", message: "Unknown review route" }) };
  };

  private mutate(body: Record<string, any>) {
    const conflict = (message: string) => ({
      status: 409,
      text: JSON.stringify({ ok: false, error: "CONFLICT", message }),
    });
    if (body.action === "create") {
      if (this.editors.has(body.editorId)) return conflict("Realtime editor already exists");
      this.editors.set(body.editorId, {
        editorId: body.editorId,
        sequence: 0,
        ceilingUsd: body.ceilingUsd,
        committedUsd: 0,
        revisions: [],
      });
    } else {
      const e = this.editors.get(body.editorId)!;
      if (body.expected !== e.sequence)
        return conflict(`Realtime editor conflict: expected ${body.expected}, found ${e.sequence}`);
      if (body.action === "add") e.revisions.push(revision(body.request.revisionId, "draft"));
      else if (body.action === "add-asset") e.revisions.push(revision(body.draft.revisionId, "draft"));
      else if (body.action === "derive") e.revisions.push(revision(body.patch.revisionId, "draft"));
      else if (body.action === "queue") {
        e.revisions.find((r) => r.revisionId === body.revisionId)!.status = "queued";
        e.queued = body.revisionId;
      } else if (body.action === "handoff") {
        e.revisions.find((r) => r.revisionId === e.queued)!.status = "in-flight";
        e.inFlight = e.queued;
        e.queued = undefined;
      }
      e.sequence++;
    }
    const view = this.view(body.editorId);
    return {
      status: 200,
      text: JSON.stringify(
        body.action === "add-asset" ? { ...view, sourceInput: { physicalDecodeVerified: false } } : view,
      ),
    };
  }

  posts(action?: string) {
    return this.calls.filter(
      (c) => c.method === "POST" && c.route === "realtime" && (!action || c.body?.action === action),
    );
  }
}

// A WebSocket stand-in: records the URL and subprotocols; the test answers what the client sent.
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  sent: string[] = [];
  closed = 0;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send(raw: string) {
    this.sent.push(raw);
  }
  close() {
    this.closed++;
    this.onclose?.();
  }
  /** Answers the last message as `LocalEditorChannel` would. */
  reply(server: FakeServer, changes: Record<string, unknown> = {}) {
    const raw = this.sent.at(-1)!;
    const message = JSON.parse(raw);
    const e = server.editors.get(message.editorId)!;
    this.onmessage?.({
      data: JSON.stringify({
        version: 1,
        editorId: message.editorId,
        localSessionId: message.localSessionId,
        messageId: message.messageId,
        messageSha256: sha(raw),
        action: message.action,
        expectedSequence: message.expectedSequence,
        outcome: "ok",
        historical: false,
        current: {
          sequence: e.sequence,
          stateSha256: H(String(e.sequence % 10)),
          committedPlanningUsd: 0,
          ceilingUsd: 1,
        },
        unresolved: [],
        providerAck: false,
        providerPersistent: false,
        liveVerified: false,
        ...changes,
      }),
    });
  }
}

function setup(seed?: (server: FakeServer) => void) {
  const server = new FakeServer();
  seed?.(server);
  let hidden = false;
  const api = new ReviewApi("demo", server.transport);
  let n = 0;
  const controller = new RealtimeEditorController({
    api,
    messages: realtimeEn.msg,
    hidden: () => hidden,
    hash: async (raw) => sha(raw),
    id: () => `message-${++n}`,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    now: () => new Date("2026-11-17T00:00:00.000Z"),
  });
  return {
    server,
    controller,
    snap: () => controller.getSnapshot(),
    setHidden: (value: boolean) => (hidden = value),
  };
}

const seeded = (server: FakeServer) => {
  server.editors.set("A", { editorId: "A", sequence: 0, ceilingUsd: 1, committedUsd: 0, revisions: [] });
  server.editors.set("B", {
    editorId: "B",
    sequence: 4,
    ceilingUsd: 2,
    committedUsd: 0,
    revisions: [revision("r1", "draft")],
  });
};

async function opened(seed: (server: FakeServer) => void = seeded) {
  const s = setup(seed);
  s.controller.setPanelOpen(true);
  await vi.waitFor(() => expect(s.snap().current).toBeTruthy());
  return s;
}

async function openChannel(s: ReturnType<typeof setup>, session = "local") {
  const before = FakeSocket.all.length;
  const opening = s.controller.openChannel(session);
  await vi.waitFor(() => expect(FakeSocket.all.length).toBe(before + 1));
  const socket = FakeSocket.all.at(-1)!;
  socket.onopen?.();
  await vi.waitFor(() => expect(socket.sent.length).toBe(1));
  socket.reply(s.server);
  await opening;
  await vi.waitFor(() => expect(s.snap().channel.busy).toBe(false));
  return socket;
}

beforeEach(() => {
  FakeSocket.all = [];
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------------

describe("realtime model", () => {
  const view = (patch: Partial<RealtimeEditorView> = {}) =>
    ({
      editorId: "A",
      sequence: 1,
      ceilingUsd: 1,
      committedUsd: 0,
      revisions: [],
      frames: [],
      ...patch,
    }) as RealtimeEditorView;
  const idle = { active: false, busy: false, blocked: false };

  it("RU-R17: busy or a busy channel disables everything; an active channel disables create/add/add-file", () => {
    for (const input of [
      { busy: true, channel: idle },
      { busy: false, channel: { ...idle, busy: true } },
    ]) {
      const m = disabledMatrix({
        ...input,
        current: view({ queued: "q" }),
        historyBlocked: false,
        composer: { editorId: "A" },
      });
      for (const key of [
        "editor",
        "refresh",
        "create",
        "add",
        "addFile",
        "complete",
        "handoff",
        "cancel",
        "recover",
        "derive",
        "channelOpen",
        "channelStatus",
        "reconcile",
      ] as const)
        expect(m[key], key).toBe(true);
      for (const action of ["queue", "inspect", "derive", "select"] as const)
        expect(m.revision({ status: action === "select" ? "complete" : "draft" }, action)).toBe(true);
    }
    const active = disabledMatrix({
      busy: false,
      current: view(),
      historyBlocked: false,
      channel: { ...idle, active: true },
    });
    expect([active.create, active.add, active.addFile, active.channelOpen]).toEqual([true, true, true, true]);
    expect([active.complete, active.channelClose, active.channelStatus, active.reconcile, active.editor]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("RU-R17: blocked (history or channel unknowns) disables every mutation but create, inspect and derive-open", () => {
    for (const [historyBlocked, blocked] of [
      [true, false],
      [false, true],
    ] as const) {
      const m = disabledMatrix({
        busy: false,
        current: view({ queued: "q", inFlight: "f" }),
        historyBlocked,
        channel: { ...idle, blocked },
        composer: { editorId: "A" },
      });
      for (const key of ["add", "addFile", "complete", "handoff", "cancel", "recover", "derive"] as const)
        expect(m[key], key).toBe(true);
      expect(m.create).toBe(false);
      expect(m.revision({ status: "draft" }, "queue")).toBe(true);
      expect(m.revision({ status: "complete" }, "select")).toBe(true);
      expect(m.revision({ status: "draft" }, "inspect")).toBe(false);
      expect(m.revision({ status: "draft" }, "derive")).toBe(false);
    }
  });

  it("RU-R08/R11/R12/R13/R15: queue/select by status; handoff/cancel/recover by queue state", () => {
    const m = (patch: Partial<RealtimeEditorView>) =>
      disabledMatrix({ busy: false, current: view(patch), historyBlocked: false, channel: idle });
    expect(m({}).revision({ status: "draft" }, "queue")).toBe(false);
    expect(m({}).revision({ status: "queued" }, "queue")).toBe(true);
    expect(m({}).revision({ status: "complete" }, "select")).toBe(false);
    expect(m({}).revision({ status: "draft" }, "select")).toBe(true);
    expect([m({}).handoff, m({}).cancel, m({}).recover]).toEqual([true, true, true]);
    expect([m({ queued: "q" }).handoff, m({ queued: "q" }).cancel, m({ queued: "q" }).recover]).toEqual([
      false,
      false,
      true,
    ]);
    expect([
      m({ queued: "q", inFlight: "f" }).handoff,
      m({ inFlight: "f" }).cancel,
      m({ inFlight: "f" }).recover,
    ]).toEqual([true, false, false]);
    expect(m({ queued: "q", revisions: [revision("u", "uncertain")] }).handoff).toBe(true);
    const none = disabledMatrix({ busy: false, historyBlocked: false, channel: idle });
    expect([none.channelOpen, none.cancel, none.channelClose, none.channelStatus]).toEqual([true, true, true, true]);
  });

  it("RU-R10: derive fieldset only for the same editor; prefill and the exact user-bound quote", () => {
    const m = (editorId?: string) =>
      disabledMatrix({
        busy: false,
        current: view(),
        historyBlocked: false,
        channel: idle,
        composer: editorId ? { editorId } : undefined,
      });
    expect([m("A").derive, m("B").derive, m().derive]).toEqual([false, true, true]);
    const prefill = derivePrefill({ prompt: "p", seed: 3 });
    expect(prefill).toEqual({
      revisionId: "",
      sessionId: "",
      bound: "",
      prompt: "p",
      seed: "3",
      steps: "3",
      scheduleMu: "2.3",
      feedback: "1",
      imageSize: "square",
      interpolation: false,
    });
    const patch = derivePatch(
      "r1",
      { ...prefill, revisionId: "r2", sessionId: "s2", bound: "0.25" },
      "2026-11-17T00:00:00.000Z",
    );
    expect(patch).toEqual({
      sourceRevision: "r1",
      revisionId: "r2",
      sessionId: "s2",
      input: {
        prompt: "p",
        seed: 3,
        num_inference_steps: 3,
        schedule_mu: 2.3,
        output_feedback_strength: 1,
        image_size: "square",
        enable_interpolation: false,
      },
      quote: {
        currency: "USD",
        lowUsd: 0,
        expectedUsd: 0.25,
        highUsd: 0.25,
        bounded: true,
        confidence: "user-bound",
        providerEnforced: false,
        source: DERIVE_QUOTE_SOURCE,
        asOf: "2026-11-17T00:00:00.000Z",
      },
    });
    expect(editorSummary(view({ queued: "q" }))).toEqual({
      editor: "A",
      sequence: 1,
      ceilingUsd: 1,
      committedPlanningUsd: 0,
      queued: "q",
      inFlight: null,
      selected: null,
      providerAck: false,
      liveVerified: false,
    });
  });

  it("RU-RS01/RS02/RS03: metadata check, payload and identity", () => {
    expect(() => checkStillListing({ metadataOnly: false, sources: [], registrySha256: H("a") })).toThrow(
      "Invalid still source metadata",
    );
    expect(() =>
      checkStillListing({ metadataOnly: true, sources: Array(129).fill({}), registrySha256: H("a") }),
    ).toThrow();
    expect(() => checkStillListing({ metadataOnly: true, sources: [], registrySha256: "x" })).toThrow();
    const source = { assetId: "sha256:" + H("f"), assetSha256: H("f"), mime: "image/png", width: 1, height: 1 };
    expect(
      stillPayload({ editorId: "A", sequence: 2, registrySha256: H("e") }, source, {
        ...STILL_DEFAULTS,
        revisionId: "r",
        sessionId: "s",
        prompt: "p",
        seed: "1",
        bound: "0.1",
      }),
    ).toEqual({
      action: "add-asset",
      editorId: "A",
      expected: 2,
      draft: {
        assetId: source.assetId,
        assetSha256: H("f"),
        registrySha256: H("e"),
        revisionId: "r",
        sessionId: "s",
        input: { prompt: "p", seed: 1 },
        highUsd: 0.1,
        limits: { maxFrames: 1, maxInputBytes: 4194304, maxResponseBytes: 16777216, maxControls: 4, timeoutMs: 2000 },
      },
    });
    const base = { editorId: "A", sequence: 1, active: true, blocked: false, channelActive: false, channelBusy: false };
    for (const change of [
      { editorId: "B" },
      { sequence: 2 },
      { active: false },
      { blocked: true },
      { channelActive: true },
      { channelBusy: true },
    ])
      expect(stillIdentity({ ...base, ...change })).not.toBe(stillIdentity(base));
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("realtime controller (RU-R)", () => {
  it("RU-R01/R02: lists editors, keeps the choice, verifies view against channel-state; no editors message", async () => {
    const empty = setup();
    empty.controller.setPanelOpen(true);
    await vi.waitFor(() => expect(empty.snap().summary).toBe("No local editors. Create an editor to begin."));
    const s = await opened();
    expect(s.snap().selectedEditor).toBe("A");
    s.controller.selectEditor("B");
    await vi.waitFor(() => expect(s.snap().current?.editorId).toBe("B"));
    expect(s.snap().summary).toMatchObject({ editor: "B", sequence: 4, providerAck: false, liveVerified: false });
    s.controller.refreshClicked();
    await vi.waitFor(() => expect(s.server.calls.filter((c) => c.route === "realtime").length).toBe(3));
    expect(s.snap().selectedEditor).toBe("B");
    s.controller.dispose();
  });

  it("RU-R02: a channel-state sequence that differs from the view discards the render; a failed read is not verified", async () => {
    const s = setup(seeded);
    s.server.fail = (route) =>
      route.startsWith("realtime/channel-state")
        ? { status: 200, body: { sequence: 99, stateSha256: H("0"), unresolvedCount: 0 } }
        : undefined;
    s.controller.setPanelOpen(true);
    await vi.waitFor(() => expect(s.server.calls.some((c) => c.route.startsWith("realtime/channel-state"))).toBe(true));
    await flush();
    expect(s.snap().current).toBeUndefined();
    s.server.fail = (route) =>
      route.startsWith("realtime?editor")
        ? { status: 400, body: { ok: false, error: "INVALID_INPUT", message: "Broken editor" } }
        : undefined;
    s.controller.refreshClicked();
    await vi.waitFor(() => expect(s.snap().summary).toBe("State is not verified. Refresh before another action."));
    expect(s.snap().status).toEqual({ value: "Broken editor", tone: "error" });
    s.controller.dispose();
  });

  it("RU-R03/R18: polls every 2.5 s only while open and visible; toggle, visibility, pagehide and unmount stop it", async () => {
    vi.useFakeTimers();
    const s = setup(seeded);
    const lists = () => s.server.calls.filter((c) => c.route === "realtime").length;
    s.controller.setPanelOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toBe(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(lists()).toBe(2);
    s.setHidden(true);
    s.controller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists()).toBe(2);
    s.setHidden(false);
    s.controller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toBe(3);
    s.controller.pageHidden();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists()).toBe(3);
    s.controller.setPanelOpen(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists()).toBe(3);
    s.controller.setPanelOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    s.controller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists()).toBe(4);
  });

  it("RU-R03: a late read after a stop is discarded (epoch)", async () => {
    const s = setup(seeded);
    let release!: () => void;
    s.server.hold = { route: "realtime?editor=A", promise: new Promise<void>((r) => (release = r)) };
    s.controller.setPanelOpen(true);
    await vi.waitFor(() => expect(s.server.calls.some((c) => c.route === "realtime?editor=A")).toBe(true));
    s.controller.setPanelOpen(false);
    release();
    await flush();
    expect(s.snap().current).toBeUndefined();
    s.controller.dispose();
  });

  it("RU-R04/R05/R08/R11: each action is sent once with the CAS, then one read-only refresh", async () => {
    const s = setup();
    s.controller.setPanelOpen(true);
    await vi.waitFor(() => expect(s.snap().summary).toContain("No local editors"));
    await s.controller.create("draft", 1);
    expect(s.server.posts("create")).toHaveLength(1);
    expect(s.server.posts("create")[0]!.body).toEqual({ action: "create", editorId: "draft", ceilingUsd: 1 });
    expect(s.snap().status.value).toBe("Recorded once. No provider execution.");
    expect(s.snap().editors.map((e) => e.editorId)).toEqual(["draft"]);
    await s.controller.addInline("{not json");
    expect(s.snap().status.tone).toBe("error");
    expect(s.server.posts("add")).toHaveLength(0);
    await s.controller.addInline(JSON.stringify({ revisionId: "first" }));
    expect(s.server.posts("add")[0]!.body).toMatchObject({ action: "add", editorId: "draft", expected: 0 });
    await s.controller.mutate("queue", { revisionId: "first" });
    await s.controller.mutate("handoff");
    expect(s.server.posts().map((c) => [c.body.action, c.body.expected])).toEqual([
      ["create", undefined],
      ["add", 0],
      ["queue", 1],
      ["handoff", 2],
    ]);
    expect(s.snap().current?.inFlight).toBe("first");
    expect(s.snap().disabled.recover).toBe(false);
    s.controller.dispose();
  });

  it("RU-R05: an inline request over 64 KiB is refused before sending", async () => {
    const s = await opened();
    await s.controller.addInline(JSON.stringify({ blob: "x".repeat(70_000) }));
    expect(s.snap().status.value).toBe(
      "Inline request exceeds 64 KiB; use a project request file. · Read state before another explicit action; no automatic replay.",
    );
    expect(s.server.posts()).toHaveLength(0);
    s.controller.dispose();
  });

  it("G2 for realtime: a 409 shows the server message with no replay and only re-reads", async () => {
    const s = await opened();
    s.server.editors.get("A")!.sequence = 9; // another local caller committed
    const before = s.server.calls.length;
    await s.controller.mutate("handoff");
    expect(s.server.posts()).toHaveLength(1);
    expect(s.snap().status.value).toBe(
      "Realtime editor conflict: expected 0, found 9 · Read state before another explicit action; no automatic replay.",
    );
    expect(s.server.calls.slice(before).filter((c) => c.method === "GET").length).toBeGreaterThan(0);
    expect(s.snap().current?.sequence).toBe(9);
    s.controller.dispose();
  });

  it("RU-R06/R09/R14: add-file, inspect pinned request and complete send exactly the review:ui bodies", async () => {
    const s = await opened();
    await s.controller.addFile("pipeline/realtime/input.json");
    expect(s.server.posts("add-file")[0]!.body).toEqual({
      action: "add-file",
      editorId: "A",
      requestFile: "pipeline/realtime/input.json",
      expected: 0,
    });
    await s.controller.inspectRequest("r9");
    expect(s.snap().requestDetail).toEqual({ pinned: "r9" });
    s.server.fail = (route, method) =>
      method === "POST"
        ? { status: 400, body: { ok: false, error: "VALIDATION", message: "Manifest outside pipeline/realtime" } }
        : undefined;
    await s.controller.mutate("complete", { revisionId: "r1", manifest: "x.json" });
    expect(s.server.posts("complete")[0]!.body).toEqual({
      action: "complete",
      editorId: "A",
      revisionId: "r1",
      manifest: "x.json",
      expected: 1,
    });
    expect(s.snap().status.value).toContain("Manifest outside pipeline/realtime · Read state");
    s.controller.dispose();
  });

  it("RU-R10: edit as new local draft prefills, refuses an invalid form, saves the exact patch once", async () => {
    const s = await opened();
    s.controller.selectEditor("B");
    await vi.waitFor(() => expect(s.snap().current?.editorId).toBe("B"));
    expect(s.snap().disabled.derive).toBe(true);
    await s.controller.editRequest("r1");
    expect(s.snap().composer).toMatchObject({
      editorId: "B",
      sourceRevision: "r1",
      prefill: { prompt: "a fox", seed: "7", scheduleMu: "1.1", steps: "3" },
    });
    expect(s.snap().disabled.derive).toBe(false);
    expect(s.snap().status.value).toContain("Editing r1.");
    const form = { ...s.snap().composer!.prefill, revisionId: "r2", sessionId: "s2", bound: "0" };
    await s.controller.saveDerive(form, true);
    expect(s.snap().status.value).toBe("Enter valid controls and a positive new planning bound");
    await s.controller.saveDerive({ ...form, bound: "0.4" }, false);
    expect(s.server.posts("derive")).toHaveLength(0);
    await s.controller.saveDerive({ ...form, bound: "0.4" }, true);
    expect(s.server.posts("derive")).toHaveLength(1);
    expect(s.server.posts("derive")[0]!.body.patch).toEqual(
      derivePatch("r1", { ...form, bound: "0.4" }, "2026-11-17T00:00:00.000Z"),
    );
    s.controller.selectEditor("A");
    expect(s.snap().composer).toBeUndefined();
    s.controller.dispose();
  });

  it("RU-RC06 (dead item 6 fixed): reconcile never goes over HTTP; unresolved history blocks HTTP mutations", async () => {
    const s = await opened((server) => {
      seeded(server);
      server.unresolved = 2;
    });
    expect(s.snap().historyBlocked).toBe(true);
    await s.controller.mutate("handoff");
    expect(s.snap().status.value).toBe("Unresolved local intent requires explicit channel reconciliation");
    await s.controller.reconcile({ localSessionId: "old", messageId: "m1", intentSha256: H("c") });
    expect(s.snap().status.value).toBe("Reconcile needs the open local channel; nothing was sent.");
    expect(s.server.posts()).toHaveLength(0);
    s.controller.dispose();
  });
});

describe("realtime controller (RU-RC local channel)", () => {
  it("RU-RC01/RC02/RC05: one ticket, the token only in the subprotocol, one status; historical vs current shown", async () => {
    const s = await opened();
    const socket = await openChannel(s, "local-1");
    expect(s.server.calls.filter((c) => c.route === "realtime/channel-ticket")).toHaveLength(1);
    expect(s.server.calls.find((c) => c.route === "realtime/channel-ticket")!.body).toEqual({
      editorId: "A",
      localSessionId: "local-1",
    });
    expect(socket.url).toBe(
      "ws://localhost:3000/api/review/demo/realtime/channel".replace("localhost:3000", location.host),
    );
    expect(socket.url).not.toContain(H("a"));
    expect(socket.protocols).toEqual(["avc-local-editor-v1", "t." + H("a")]);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      action: "status",
      editorId: "A",
      localSessionId: "local-1",
      expectedSequence: 0,
      version: 1,
    });
    expect(s.snap().channel).toMatchObject({ active: true, busy: false });
    expect(s.snap().channel.summary).toEqual({
      outcome: "ok",
      historical: false,
      currentSequence: 0,
      unresolved: [],
      providerAck: false,
      providerPersistent: false,
      liveVerified: false,
    });
    // An active channel disables the HTTP-only actions and stops the background poll.
    expect([s.snap().disabled.create, s.snap().disabled.add, s.snap().disabled.addFile]).toEqual([true, true, true]);
    await s.controller.addFile("x.json");
    expect(s.snap().status.value).toContain("HTTP-only");
    expect(s.server.posts()).toHaveLength(0);
    s.controller.dispose();
    expect(socket.closed).toBe(1);
  });

  it("RU-RC03/RC04: channel actions go over the socket with one pending slot; a mismatched reply closes without replay", async () => {
    const s = await opened();
    const socket = await openChannel(s);
    const queued = s.controller.mutate("handoff");
    await vi.waitFor(() => expect(socket.sent.length).toBe(2));
    expect(s.snap().channel.busy).toBe(true);
    expect(s.snap().disabled.channelStatus).toBe(true);
    s.controller.inspectChannel(); // second send while pending: refused
    await flush();
    expect(socket.sent.length).toBe(2);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ action: "handoff", expectedSequence: 0 });
    socket.reply(s.server, { messageSha256: H("9") });
    await queued;
    expect(s.snap().status.value).toContain("Local reply identity/correlation/protocol mismatch");
    expect(s.snap().status.value).toContain("no automatic replay");
    expect(s.snap().channel.active).toBe(false);
    expect(socket.sent.length).toBe(2);
    expect(s.server.posts()).toHaveLength(0);
    s.controller.dispose();
  });

  it("RU-RC04: a reply whose current state disagrees with the HTTP readback is refused", async () => {
    const s = await opened();
    const socket = await openChannel(s);
    const pending = s.controller.mutate("cancel");
    await vi.waitFor(() => expect(socket.sent.length).toBe(2));
    socket.reply(s.server, { current: { sequence: 5, stateSha256: H("5"), committedPlanningUsd: 0, ceilingUsd: 1 } });
    await pending;
    expect(s.snap().channel.summary).toBe("Current editor readback changed; inspect without replay");
    expect(s.snap().channel.active).toBe(false);
    s.controller.dispose();
  });

  it("RU-RC06: unresolved items render acknowledge buttons; reconcile goes over the channel with the exact body", async () => {
    const s = await opened();
    const socket = await openChannel(s);
    s.controller.inspectChannel();
    await vi.waitFor(() => expect(socket.sent.length).toBe(2));
    s.server.unresolved = 1;
    const item = { localSessionId: "old", messageId: "m1", intentSha256: H("c") };
    socket.reply(s.server, { unresolved: [item], unresolvedCount: 1 });
    await vi.waitFor(() => expect(s.snap().channel.unresolved).toEqual([item]));
    expect(s.snap().channel.blocked).toBe(true);
    expect(s.snap().disabled.reconcile).toBe(false);
    await s.controller.mutate("handoff");
    expect(s.snap().status.value).toBe("Unresolved local intent requires explicit channel reconciliation");
    const reconciling = s.controller.reconcile(item);
    await vi.waitFor(() => expect(socket.sent.length).toBe(3));
    expect(JSON.parse(socket.sent[2]!)).toMatchObject({
      action: "reconcile",
      targetLocalSessionId: "old",
      pendingMessageId: "m1",
      intentSha256: H("c"),
      currentStateSha256: H("0"),
      acknowledge: "unknown-local-outcome-no-replay",
    });
    s.server.unresolved = 0;
    socket.reply(s.server);
    await reconciling;
    expect(s.snap().channel.blocked).toBe(false);
    expect(s.server.posts()).toHaveLength(0);
    s.controller.dispose();
  });

  it("RU-RC07: close is explicit, never replays, re-reads; a disconnect asks for inspection", async () => {
    const s = await opened();
    let socket = await openChannel(s);
    const reads = s.server.calls.length;
    s.controller.closeChannel();
    expect(s.snap().channel.active).toBe(false);
    expect(s.snap().channel.summary).toBe("Local channel closed; inspect before another explicit action");
    await vi.waitFor(() => expect(s.server.calls.length).toBeGreaterThan(reads));
    expect(socket.sent.length).toBe(1);
    socket = await openChannel(s);
    socket.onclose?.();
    expect(s.snap().channel.summary).toBe("Local channel disconnected; unknown outcomes require inspection, no replay");
    expect(FakeSocket.all.length).toBe(2); // no auto-reconnect
    s.controller.dispose();
  });

  it("RU-R18: toggle and editor change close the channel", async () => {
    const s = await opened();
    const first = await openChannel(s);
    s.controller.selectEditor("B");
    expect(first.closed).toBe(1);
    await vi.waitFor(() => expect(s.snap().current?.editorId).toBe("B"));
    const second = await openChannel(s);
    s.controller.setPanelOpen(false);
    expect(second.closed).toBe(1);
    s.controller.dispose();
  });
});

describe("realtime controller (RU-RS still drafts)", () => {
  it("RU-RS01: refused while the channel is open; loads metadata only and pins the context", async () => {
    const s = await opened();
    const socket = await openChannel(s);
    expect(s.snap().still.ready).toBe(false);
    await s.controller.loadStills();
    expect(s.snap().status.value).toBe(
      "Close the local channel explicitly and resolve unknown intents before adding a still.",
    );
    expect(s.server.calls.some((c) => c.route === "realtime/still-sources")).toBe(false);
    expect(socket.closed).toBe(0); // never closed implicitly
    s.controller.closeChannel();
    await vi.waitFor(() => expect(s.snap().still.ready).toBe(true));
    await s.controller.loadStills();
    expect(s.snap().still.context).toEqual({ editorId: "A", sequence: 0, registrySha256: H("e") });
    expect(s.snap().still.summary).toEqual({ registrySha256: H("e"), metadataOnly: true, sources: 1 });
    s.server.stills = { metadataOnly: false, sources: [], registrySha256: H("e") };
    await s.controller.loadStills();
    expect(s.snap().status.value).toBe("Invalid still source metadata");
    expect(s.snap().still.context).toBeUndefined();
    s.controller.dispose();
  });

  it("RU-RS02: saves once with the pinned context, shows sourceInput, never retries; invalid forms send nothing", async () => {
    const s = await opened();
    await s.controller.loadStills();
    const source = s.snap().still.sources[0]!;
    const form = {
      ...STILL_DEFAULTS,
      revisionId: "still-1",
      sessionId: "still-s",
      prompt: "p",
      seed: "3",
      bound: "0.2",
    };
    await s.controller.saveStill(form, true); // no source chosen yet
    expect(s.server.posts("add-asset")).toHaveLength(0);
    s.controller.chooseStill(source.assetId);
    await s.controller.saveStill({ ...form, bound: "0" }, true);
    expect(s.snap().status.value).toBe("Enter fresh IDs, a concrete seed, prompt, positive bound and finite limits.");
    await s.controller.saveStill({ ...form, prompt: "x".repeat(17_000) }, true);
    expect(s.snap().status.value).toBe("Still selector/control payload exceeds 16 KiB");
    expect(s.server.posts("add-asset")).toHaveLength(0);
    await s.controller.saveStill(form, true);
    expect(s.server.posts("add-asset")).toHaveLength(1);
    expect(s.server.posts("add-asset")[0]!.body).toEqual(
      stillPayload({ editorId: "A", sequence: 0, registrySha256: H("e") }, source, form),
    );
    expect(s.snap().still.summary).toEqual({ physicalDecodeVerified: false });
    expect(s.snap().status.value).toBe("Saved one new offline still draft. No queue, handoff or provider execution.");
    // the sequence moved: the context is gone, so a second click sends nothing
    await vi.waitFor(() => expect(s.snap().current?.sequence).toBe(1));
    await s.controller.saveStill(form, true);
    expect(s.server.posts("add-asset")).toHaveLength(1);
    s.controller.dispose();
  });

  it("RU-RS03: a late listing after an editor change, and a late save after a source change, are discarded", async () => {
    const s = await opened();
    let release!: () => void;
    s.server.hold = { route: "realtime/still-sources", promise: new Promise<void>((r) => (release = r)) };
    const loading = s.controller.loadStills();
    await vi.waitFor(() => expect(s.snap().still.pending).toBe(true));
    s.controller.selectEditor("B");
    release();
    await loading;
    expect(s.snap().still.context).toBeUndefined();
    await vi.waitFor(() => expect(s.snap().current?.editorId).toBe("B"));
    await s.controller.loadStills();
    const source = s.snap().still.sources[0]!;
    s.controller.chooseStill(source.assetId);
    let releaseSave!: () => void;
    s.server.hold = { route: "realtime", promise: new Promise<void>((r) => (releaseSave = r)) };
    const form = { ...STILL_DEFAULTS, revisionId: "still-2", sessionId: "s", prompt: "p", seed: "1", bound: "0.1" };
    const saving = s.controller.saveStill(form, true);
    await vi.waitFor(() => expect(s.server.posts("add-asset")).toHaveLength(1));
    s.controller.chooseStill("");
    releaseSave();
    await saving;
    expect(s.snap().still.summary).not.toEqual({ physicalDecodeVerified: false });
    expect(s.server.posts("add-asset")).toHaveLength(1);
    s.controller.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("RealtimeSection (React)", () => {
  const reviewState = {
    projectId: "demo",
    revision: 1,
    timelineHash: H("a"),
    durationInFrames: 30,
    tracks: [],
    journal: [],
    redoCount: 0,
    assets: [],
    entities: [],
    budget: { jobs: [] },
    snapshots: [],
    selected: null,
    reports: [],
    outputs: [],
  };
  function mount(language: "en" | "ru" = "en") {
    const server = new FakeServer();
    seeded(server);
    const transport: TextTransport = async (method, url, body) =>
      url.endsWith("/state") ? { status: 200, text: JSON.stringify(reviewState) } : server.transport(method, url, body);
    const client = new FixtureApiClient({ fixture: "cards", now: () => FIXTURE_NOW });
    Object.assign(client, { text: transport });
    const view = renderWith(<TimelineView project="demo" />, { store: fixtureStore(client), language });
    return { server, ...view };
  }
  const panel = () => document.getElementById("realtime-panel") as HTMLDetailsElement;
  const toggle = (open: boolean) =>
    act(() => {
      panel().open = open;
      panel().dispatchEvent(new Event("toggle"));
    });

  it("the panel is closed by default and reads nothing until opened; opening lists, renders cards and the matrix", async () => {
    const { server } = mount();
    await screen.findByText("demo · revision 1 · 30 frames");
    expect(panel().open).toBe(false);
    expect(server.calls.some((c) => c.route.startsWith("realtime"))).toBe(false);
    toggle(true);
    await waitFor(() => expect(document.getElementById("rt-summary")!.textContent).toContain('"editor": "A"'));
    const select = document.getElementById("rt-editor")!;
    expect(selectOptions(select).map((o) => o.label)).toEqual(["A · sequence 0", "B · sequence 4"]);
    chooseOption(select, "B");
    await waitFor(() => expect(document.querySelector('[data-revision="r1"]')).toBeTruthy());
    const card = document.querySelector('[data-revision="r1"]')!;
    expect(card.textContent).toContain("r1 · draft");
    expect(card.textContent).toContain("Session s-r1 · quote upper bound USD 0.5");
    expect(card.textContent).toContain("Request SHA256 " + H("2"));
    expect((card.querySelector('[data-action="queue"]') as HTMLButtonElement).disabled).toBe(false);
    expect((card.querySelector('[data-action="select"]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("rt-handoff") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("rt-derive-fields") as HTMLFieldSetElement).disabled).toBe(true);
    expect((document.getElementById("rt-still-fields") as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.click(card.querySelector('[data-action="queue"]')!);
    await waitFor(() =>
      expect(document.getElementById("rt-status")!.textContent).toBe("Recorded once. No provider execution."),
    );
    expect(server.posts("queue")[0]!.body).toEqual({ action: "queue", editorId: "B", revisionId: "r1", expected: 4 });
    await waitFor(() => expect((document.getElementById("rt-handoff") as HTMLButtonElement).disabled).toBe(false));
  });

  it("derive form: Edit prefills the fieldset, HTML constraints gate Save, and the patch is sent once", async () => {
    const { server } = mount();
    await screen.findByText("demo · revision 1 · 30 frames");
    toggle(true);
    await waitFor(() => expect(document.getElementById("rt-editor")).toBeTruthy());
    chooseOption(document.getElementById("rt-editor")!, "B");
    await waitFor(() => expect(document.querySelector('[data-revision="r1"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-revision="r1"] [data-action="derive"]')!);
    await waitFor(() =>
      expect((document.getElementById("rt-derive-prompt") as HTMLTextAreaElement).value).toBe("a fox"),
    );
    expect((document.getElementById("rt-derive-source") as HTMLInputElement).value).toBe("r1");
    expect((document.getElementById("rt-derive-fields") as HTMLFieldSetElement).disabled).toBe(false);
    fireEvent.change(document.getElementById("rt-derive-revision")!, { target: { value: "r2" } });
    fireEvent.change(document.getElementById("rt-derive-session")!, { target: { value: "s2" } });
    fireEvent.change(document.getElementById("rt-derive-steps")!, { target: { value: "9" } });
    fireEvent.change(document.getElementById("rt-derive-bound")!, { target: { value: "0.3" } });
    fireEvent.click(document.getElementById("rt-derive-save")!);
    expect(document.getElementById("rt-status")!.textContent).toBe(
      "Enter valid controls and a positive new planning bound",
    );
    expect(server.posts("derive")).toHaveLength(0);
    fireEvent.change(document.getElementById("rt-derive-steps")!, { target: { value: "4" } });
    fireEvent.click(document.getElementById("rt-derive-save")!);
    await waitFor(() => expect(server.posts("derive")).toHaveLength(1));
    expect(server.posts("derive")[0]!.body.patch.input).toMatchObject({
      prompt: "a fox",
      seed: 7,
      num_inference_steps: 4,
      schedule_mu: 1.1,
    });
  });

  it("RU-R16: the selected preview's frames load from the review file route with their original SHA-256", async () => {
    const { server } = mount();
    const frames = [{ file: `@realtime/${H("d")}/${H("e")}/0`, sha256: H("7") }];
    const view = server.view.bind(server);
    server.view = (editorId) => ({ ...view(editorId), selected: "r1", frames });
    await screen.findByText("demo · revision 1 · 30 frames");
    toggle(true);
    const img = (await screen.findByAltText("Selected realtime preview frame 1")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`/api/review/demo/file?path=${encodeURIComponent(frames[0]!.file)}`);
    expect(screen.getByText(`Original SHA256 ${H("7")}`)).toBeTruthy();
    expect(document.getElementById("rt-summary")!.textContent).toContain('"selected": "r1"');
  });

  it("is translated (ru) and keeps server text as written", async () => {
    mount("ru");
    await screen.findByText("demo · ревизия 1 · кадров: 30");
    expect(screen.getByText(realtimeRu.panel)).toBeTruthy();
    toggle(true);
    await waitFor(() => expect(screen.getByText(realtimeRu.channel.open)).toBeTruthy());
    expect(screen.getByRole("heading", { level: 4, name: realtimeRu.still.heading })).toBeTruthy();
  });
});
