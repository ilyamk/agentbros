import { describe, expect, it, vi } from "vitest";
import { ApiFailure } from "@/api/errors";
import type { TextTransport } from "@/api/types";
import {
  applyProposal,
  createReviewChannelClient,
  planApply,
  pointerProposal,
  proposalSummary,
  ProposalGuard,
  ProposalStaleError,
  ReviewApi,
  ReviewRequestError,
  runReviewTask,
  type ReviewStatus,
  validateCommand,
} from "./api";

type Call = { method: string; path: string; body?: unknown };

function fake(
  replies: Record<string, { status: number; body: unknown } | ((call: Call) => { status: number; body: unknown })>,
) {
  const calls: Call[] = [];
  const transport: TextTransport = async (method, path, body) => {
    const call = { method, path, body };
    calls.push(call);
    const key = `${method} ${path}`;
    const reply = replies[key];
    if (!reply) return { status: 404, text: JSON.stringify({ ok: false, error: "NOT_FOUND", message: key }) };
    const value = typeof reply === "function" ? reply(call) : reply;
    return { status: value.status, text: typeof value.body === "string" ? value.body : JSON.stringify(value.body) };
  };
  return { calls, transport };
}

const state = (revision: number | null) => ({
  projectId: "demo-film",
  revision,
  timelineHash: revision === null ? null : "a".repeat(64),
  durationInFrames: 90,
  tracks: [],
  journal: [],
  redoCount: 0,
  assets: [],
  entities: [],
  budget: { status: "uninitialized", jobs: [] },
  snapshots: [],
  selected: null,
  reports: [],
  outputs: [],
});
const dry = { revision: 3, timelineHash: "b".repeat(64), snapshot: { durationInFrames: 120 } };
const B = "/api/review/demo-film";

describe("ReviewApi", () => {
  it("calls the console review routes and parses replies", async () => {
    const { calls, transport } = fake({
      [`GET ${B}/state`]: { status: 200, body: state(3) },
      [`POST ${B}/dry-run`]: { status: 200, body: dry },
      [`GET ${B}/compare?left=current&right=a%2Fb`]: { status: 200, body: { equal: true } },
      [`POST ${B}/visual-split-proposal`]: { status: 200, body: { ...dry, command: { type: "split" } } },
      [`GET ${B}/realtime?editor=e%201`]: { status: 200, body: { sequence: 1 } },
      [`POST ${B}/realtime/channel-ticket`]: { status: 200, body: { ticket: "t" } },
    });
    const api = new ReviewApi("demo-film", transport);
    expect((await api.state()).revision).toBe(3);
    expect((await api.dryRun(3, { type: "move" })).timelineHash).toBe("b".repeat(64));
    expect(calls[1]!.body).toEqual({ expectedRevision: 3, command: { type: "move" } });
    expect((await api.compare("current", "a/b")).equal).toBe(true);
    expect((await api.propose("visual-split-proposal", { x: 1 })).command).toEqual({ type: "split" });
    expect(await api.realtime.view("e 1")).toEqual({ sequence: 1 });
    await api.realtime.channelTicket({ editorId: "e", localSessionId: "s" });
    expect(api.fileUrl("@out/landscape.mp4")).toBe(`${B}/file?path=%40out%2Flandscape.mp4`);
    expect(api.originalPath({ original: "projects/demo-film/media/a.png" })).toBe("media/a.png");
    expect(api.channelSocketUrl("http://127.0.0.1:4317")).toBe(`ws://127.0.0.1:4317${B}/realtime/channel`);
  });

  it("maps failures: 409 is a conflict, others keep the server message, network errors become NETWORK", async () => {
    const { transport } = fake({
      [`POST ${B}/mutate`]: { status: 409, body: { ok: false, error: "CONFLICT", message: "Expected revision 1" } },
      [`POST ${B}/dry-run`]: { status: 400, body: { ok: false, error: "VALIDATION", message: "bad" } },
      [`GET ${B}/state`]: { status: 200, body: "<html>" },
    });
    const api = new ReviewApi("demo-film", transport);
    const conflict = await api.mutate({ action: "undo", expectedRevision: 1 }).catch((e) => e);
    expect(conflict).toBeInstanceOf(ReviewRequestError);
    expect(conflict.conflict).toBe(true);
    expect(conflict.message).toBe("Expected revision 1");
    const bad = await api.dryRun(1, {}).catch((e) => e);
    expect([bad.conflict, bad.status, bad.code, bad.message]).toEqual([false, 400, "VALIDATION", "bad"]);
    expect((await api.state().catch((e) => e)).code).toBe("INVALID_RESPONSE");
    const offline = new ReviewApi("demo-film", async () => {
      throw new ApiFailure("NETWORK", "offline");
    });
    expect((await offline.state().catch((e) => e)).code).toBe("NETWORK");
  });

  it("reads reports as text and refuses with 'Cannot open report'", async () => {
    const { transport } = fake({
      [`GET ${B}/file?path=pipeline%2Fqa.md`]: { status: 200, body: "<script>x</script>" },
      [`GET ${B}/file?path=nope`]: { status: 400, body: { message: "File is not a declared review artifact" } },
    });
    const api = new ReviewApi("demo-film", transport);
    expect(await api.reportText("pipeline/qa.md")).toBe("<script>x</script>");
    await expect(api.reportText("nope")).rejects.toThrow("Cannot open report");
  });
});

describe("G1/G2 runReviewTask", () => {
  it("shows working then ready, or the message", async () => {
    const seen: ReviewStatus[] = [];
    const hooks = { setStatus: (s: ReviewStatus) => seen.push(s), onConflict: vi.fn(async () => {}) };
    expect(await runReviewTask(async () => {}, hooks)).toBe(true);
    expect(await runReviewTask(async () => Promise.reject(new Error("nope")), hooks)).toBe(false);
    expect(seen).toEqual([
      { kind: "working" },
      { kind: "ready" },
      { kind: "working" },
      { kind: "error", message: "nope" },
    ]);
    expect(hooks.onConflict).not.toHaveBeenCalled();
  });

  it("a 409 refreshes once and never re-sends the request", async () => {
    const task = vi.fn(async () => Promise.reject(new ReviewRequestError("Revision changed", "CONFLICT", 409)));
    const seen: ReviewStatus[] = [];
    const onConflict = vi.fn(async () => {});
    await runReviewTask(task, { setStatus: (s) => seen.push(s), onConflict });
    expect(task).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual({ kind: "conflict", message: "Revision changed" });
  });
});

describe("G3 ProposalGuard", () => {
  it("discards a late reply after a cancel or any binding change", () => {
    const guard = new ProposalGuard();
    const binding = { revision: 2, trackId: "visual", clipId: "a", operation: "move" };
    const ticket = guard.begin(binding);
    expect(guard.isCurrent(ticket, binding)).toBe(true);
    for (const change of [
      { revision: 3 },
      { trackId: "v2" },
      { clipId: "b" },
      { operation: "trim" },
      { signature: "x" },
    ])
      expect(guard.isCurrent(ticket, { ...binding, ...change })).toBe(false);
    const listener = vi.fn();
    guard.onCancel(listener);
    guard.cancel({ clearCommand: false });
    expect(listener).toHaveBeenCalledWith({ clearCommand: false });
    expect(() => guard.assertCurrent(ticket, binding)).toThrow(ProposalStaleError);
  });

  it("a generic validate restarts the epoch: a specialized prepare in flight goes stale, the command text stays", async () => {
    const guard = new ProposalGuard();
    const prepare = guard.begin({ revision: 3, trackId: "visual", clipId: "a", operation: "visual-split" });
    const events: unknown[] = [];
    guard.onCancel((event) => events.push(event));
    const { transport } = fake({ [`POST ${B}/dry-run`]: { status: 200, body: dry } });
    const result = await validateCommand(new ReviewApi("demo-film", transport), guard, 3, { type: "move" });
    expect(result.draft).toEqual({ command: { type: "move" }, revision: 3 });
    expect(guard.isCurrent(prepare, prepare.binding)).toBe(false);
    expect(events).toEqual([{ clearCommand: false }]);
    await expect(validateCommand(new ReviewApi("demo-film", transport), guard, null, {})).rejects.toThrow(/Initialize/);
  });
});

describe("G5 apply", () => {
  it("plans: refuses during a drag, on an empty or invalid command; re-validates an edited command", () => {
    const draft = { command: { type: "move", start: { num: 1, den: 1 } }, revision: 4 };
    expect(planApply({ draft, commandText: "{}", pointerActive: true })).toMatchObject({
      kind: "refuse",
      reason: "pointer-active",
    });
    expect(planApply({ commandText: "  ", pointerActive: false })).toMatchObject({
      kind: "refuse",
      reason: "empty-command",
    });
    expect(planApply({ commandText: "{", pointerActive: false })).toMatchObject({
      kind: "refuse",
      reason: "invalid-json",
    });
    expect(planApply({ draft, commandText: JSON.stringify(draft.command, null, 2), pointerActive: false })).toEqual({
      kind: "apply",
      draft,
    });
    expect(planApply({ draft, commandText: '{"type":"trim"}', pointerActive: false })).toEqual({
      kind: "validate-then-apply",
      command: { type: "trim" },
    });
    expect(planApply({ commandText: '{"type":"trim"}', pointerActive: false }).kind).toBe("validate-then-apply");
  });

  it("applies a pinned draft with its revision as CAS, without a dry-run", async () => {
    const { calls, transport } = fake({ [`POST ${B}/mutate`]: { status: 200, body: state(5) } });
    const api = new ReviewApi("demo-film", transport);
    const draft = { command: { type: "move" }, revision: 4 };
    const result = await applyProposal(api, new ProposalGuard(), {
      draft,
      commandText: JSON.stringify(draft.command),
      pointerActive: false,
      revision: 4,
    });
    expect(result.state.revision).toBe(5);
    expect(calls.map((c) => c.path)).toEqual([`${B}/mutate`]);
    expect(calls[0]!.body).toEqual({ action: "edit", expectedRevision: 4, command: { type: "move" } });
  });

  it("an edited command runs the generic dry-run first; a cancel meanwhile stops before mutate", async () => {
    const guard = new ProposalGuard();
    const { calls, transport } = fake({
      [`POST ${B}/dry-run`]: () => {
        guard.cancel();
        return { status: 200, body: dry };
      },
      [`POST ${B}/mutate`]: { status: 200, body: state(4) },
    });
    const api = new ReviewApi("demo-film", transport);
    const input = { commandText: '{"type":"trim"}', pointerActive: false, revision: 3 };
    await expect(applyProposal(api, guard, input)).rejects.toBeInstanceOf(ProposalStaleError);
    expect(calls.map((c) => c.path)).toEqual([`${B}/dry-run`]);
    const ok = await applyProposal(api, new ProposalGuard(), input);
    expect(ok.applied).toEqual({ command: { type: "trim" }, revision: 3 });
    expect(calls.at(-1)!.body).toEqual({ action: "edit", expectedRevision: 3, command: { type: "trim" } });
  });

  it("G6 summary", () => {
    expect(proposalSummary(dry, { visualSplit: true })).toEqual({
      revision: 3,
      proposedHash: "b".repeat(64),
      durationInFrames: 120,
      visualSplit: true,
    });
  });
});

describe("review:ui browser modules are imported as modules", () => {
  it("pointerProposal is the real function", () => {
    expect(typeof pointerProposal).toBe("function");
  });

  it("the channel client takes its ticket from the console route and opens the console socket URL", async () => {
    const ticket = {
      version: 1,
      ticket: "a".repeat(64),
      expiresAt: Date.now() + 4000,
      path: "/api/realtime/channel",
      protocol: "avc-local-editor-v1",
      editorId: "edit",
      localSessionId: "local",
      sequence: 1,
      stateSha256: "b".repeat(64),
      unresolvedCount: 0,
      providerAck: false,
      providerPersistent: false,
      liveVerified: false,
    };
    const { calls, transport } = fake({ [`POST ${B}/realtime/channel-ticket`]: { status: 200, body: ticket } });
    const api = new ReviewApi("demo-film", transport);
    const opened: { url: string; protocols: string[] }[] = [];
    class FakeSocket {
      onopen?: () => void;
      constructor(url: string, protocols: string[]) {
        opened.push({ url, protocols });
        queueMicrotask(() => this.onopen?.());
      }
      close() {}
    }
    vi.stubGlobal("location", { origin: "http://127.0.0.1:4317" });
    const client = createReviewChannelClient({
      ...api.channelTransport(FakeSocket as unknown as typeof WebSocket),
      hash: async () => "c".repeat(64),
      id: () => "id",
      current: async () => {},
      changed: () => {},
      status: () => {},
    });
    await client.open("edit", "local");
    expect(calls[0]!.body).toEqual({ editorId: "edit", localSessionId: "local" });
    expect(opened).toEqual([
      { url: `ws://127.0.0.1:4317${B}/realtime/channel`, protocols: ["avc-local-editor-v1", `t.${"a".repeat(64)}`] },
    ]);
    expect(opened[0]!.url).not.toContain("a".repeat(64));
    client.close();
    vi.unstubAllGlobals();
  });
});
