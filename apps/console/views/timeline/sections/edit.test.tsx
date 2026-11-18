/**
 * The edit section against a fake review transport (RU-T, RU-P, RU-K; G1–G6). These replace the review:ui tests that
 * evaluated client.ts in a fake DOM or drove it in a browser (Appendix A): same ids, same behaviour.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { FixtureApiClient } from "@/api/fixture";
import type { TextTransport } from "@/api/types";
import { chooseOption, fixtureStore, FIXTURE_NOW, renderWith, selectOptions } from "@/test/utils";
import type { ReviewState } from "../api";
import { TimelineView } from "../index";
import { editState } from "./edit-fixture";

type Call = { method: string; route: string; body?: any };
type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

const B = "/api/review/demo-film/";
const dry = (revision = 3, frames = 120) => ({
  revision,
  timelineHash: "b".repeat(64),
  snapshot: { durationInFrames: frames },
});

function server(initial: ReviewState = editState()) {
  let state = initial;
  const calls: Call[] = [];
  const handlers: Record<string, (call: Call) => Reply> = {
    "GET state": () => ({ status: 200, body: state }),
    "POST dry-run": () => ({ status: 200, body: dry(state.revision ?? 0) }),
    "POST mutate": (call) => {
      if (call.body.expectedRevision !== state.revision)
        return { status: 409, body: { ok: false, error: "CONFLICT", message: "Expected revision changed" } };
      state = {
        ...state,
        revision: (state.revision ?? 0) + (call.body.action === "edit" || call.body.action === "redo" ? 1 : -1),
        journal: call.body.action === "edit" ? [...state.journal, call.body.command] : state.journal.slice(0, -1),
        redoCount: call.body.action === "undo" ? state.redoCount + 1 : 0,
      };
      return { status: 200, body: state };
    },
  };
  const transport = vi.fn<TextTransport>(async (method, path, body) => {
    const route = path.slice(B.length);
    const call = { method, route, body };
    calls.push(call);
    const handler = handlers[`${method} ${route}`];
    const reply = handler ? await handler(call) : { status: 404, body: { message: `no ${route}` } };
    return { status: reply.status, text: JSON.stringify(reply.body) };
  });
  return {
    transport,
    calls,
    handlers,
    set: (next: ReviewState) => (state = next),
    get state() {
      return state;
    },
  };
}

function storeWith(transport: TextTransport) {
  const client = new FixtureApiClient({ fixture: "cards", now: () => FIXTURE_NOW });
  Object.assign(client, { text: transport });
  return fixtureStore(client);
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
const status = () => $("status").textContent;
const shown = () => $("dry-run").textContent ?? "";
const click = (id: string) => act(() => fireEvent.click($(id)));
const type = (id: string, text: string) => act(() => fireEvent.change($(id), { target: { value: text } }));

async function open(api = server(), language: "en" | "ru" | "zh-Hans" = "en") {
  const view = renderWith(<TimelineView project="demo-film" />, { store: storeWith(api.transport), language });
  await waitFor(() => expect($("identity")?.textContent).toContain("demo-film ·"));
  return { api, ...view };
}

const clipButton = (id: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".clip")].find((b) => b.title.startsWith(`${id} ·`))!;

async function selectOperation(operation: string) {
  chooseOption($("operation"), operation);
  await act(async () => {});
}

describe("storyboard, lanes and selection (RU-T01–T03, T15)", () => {
  it("shows cards for visual and presenter clips, proportional lanes, and selects from either", async () => {
    const { api } = await open();
    const cards = [...document.querySelectorAll("#board .card")];
    expect(cards.map((card) => card.querySelector("button")!.textContent)).toEqual(["hook", "proof", "cut", "talk"]);
    expect(cards[0]!.textContent).toContain("asset-hook · 0–30 frames");
    expect(cards[0]!.querySelector("img")!.getAttribute("src")).toBe(`${B}file?path=media%2Fhook.png`);
    expect(cards[1]!.querySelector("img")).toBeNull();
    const lanes = [...document.querySelectorAll<HTMLElement>(".lane")];
    expect(lanes.map((lane) => `${lane.dataset.kind}/${lane.dataset.trackId}`)).toEqual([
      "visual/visual",
      "visual/broll",
      "presenter/host",
      "voiceover/voice",
      "music/music",
    ]);
    const proof = clipButton("proof");
    expect(proof.title).toBe("proof · asset-proof · 60 → 90");
    expect([proof.style.left, proof.style.width]).toEqual(["50%", "25%"]);
    expect(proof.querySelectorAll(".trim-handle")).toHaveLength(2);
    expect(clipButton("speech").querySelectorAll(".trim-handle")).toHaveLength(0);
    expect($("selection").textContent).toBe("Select a clip");
    act(() => fireEvent.click(cards[1]!.querySelector("button")!));
    expect($("selection").textContent).toBe("visual / proof · asset-proof");
    expect(value("edit-start")).toBe("60");
    act(() => fireEvent.click(clipButton("speech")));
    expect($("selection").textContent).toBe("voiceover / speech · asset-speech");
    expect($("journal").textContent).toBe("No edits yet.");
    // A refresh keeps the selection while the clip exists, then resets it.
    api.set(editState(3, { tracks: editState().tracks.filter((track) => track.id !== "voice") }));
    await act(async () => fireEvent.click($("refresh")));
    await waitFor(() => expect($("selection").textContent).toBe("Select a clip"));
  });

  it("clip text is rendered as text, never markup", async () => {
    const state = editState();
    state.tracks[0]!.clips[0]!.id = "<img src=x onerror=alert(1)>";
    await open(server(state));
    expect(document.querySelector("img[src=x]")).toBeNull();
    expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("generic edits (RU-T04–T14, G5, G6)", () => {
  it("prepares a move through the generic dry-run, pins it and applies with the draft's revision", async () => {
    const { api } = await open();
    act(() => fireEvent.click(clipButton("proof")));
    type("edit-start", "45");
    await act(async () => fireEvent.click($("prepare")));
    expect(JSON.parse(value("command"))).toEqual({
      type: "move",
      trackId: "visual",
      clipId: "proof",
      start: { num: 45, den: 1 },
    });
    expect(JSON.parse(shown())).toEqual({ revision: 3, proposedHash: "b".repeat(64), durationInFrames: 120 });
    expect(api.calls.at(-1)).toMatchObject({ route: "dry-run", body: { expectedRevision: 3 } });
    await act(async () => fireEvent.click($("apply")));
    expect(api.calls.at(-1)).toMatchObject({
      route: "mutate",
      body: { action: "edit", expectedRevision: 3, command: { type: "move", start: { num: 45, den: 1 } } },
    });
    expect(api.calls.filter((c) => c.route === "dry-run")).toHaveLength(1);
    await waitFor(() => expect($("identity").textContent).toContain("revision 4"));
    expect(shown()).toBe("Applied with revision readback.");
    expect(value("command")).toBe("");
    expect($("journal").textContent).toContain('"type": "move"');
    expect($<HTMLButtonElement>("undo").disabled).toBe(false);
    expect($<HTMLButtonElement>("redo").disabled).toBe(true);
    await act(async () => fireEvent.click($("undo")));
    await waitFor(() => expect($("identity").textContent).toContain("revision 3"));
    expect(api.calls.at(-1)).toMatchObject({ route: "mutate", body: { action: "undo", expectedRevision: 4 } });
    expect($<HTMLButtonElement>("redo").disabled).toBe(false);
    await act(async () => fireEvent.click($("redo")));
    expect(api.calls.at(-1)).toMatchObject({ route: "mutate", body: { action: "redo", expectedRevision: 3 } });
  });

  it("integers only; refusals show in the status; no selection says so (RU-T05, G1)", async () => {
    const { api } = await open();
    await act(async () => fireEvent.click($("prepare")));
    expect(status()).toBe("Select a clip first");
    act(() => fireEvent.click(clipButton("proof")));
    type("edit-start", "4.5");
    await act(async () => fireEvent.click($("prepare")));
    expect(status()).toBe("Frame/rate values must be integers. Use advanced rational commands for fractions.");
    expect(api.calls.some((c) => c.route === "dry-run")).toBe(false);
  });

  it("builds trim, rate, transition, captions and transfer commands from their forms (RU-T06–T10)", async () => {
    const { api } = await open();
    act(() => fireEvent.click(clipButton("proof")));
    const prepared = async () => {
      await act(async () => fireEvent.click($("prepare")));
      return JSON.parse(value("command"));
    };
    await selectOperation("trim");
    type("edit-start", "2");
    expect(await prepared()).toMatchObject({ type: "trim", start: { num: 2, den: 1 }, end: { num: 30, den: 1 } });
    await selectOperation("rate");
    type("rate-den", "2");
    expect(await prepared()).toMatchObject({ type: "rate", rate: { num: 1, den: 2 } });
    await selectOperation("transition");
    type("fade-frames", "6");
    expect(await prepared()).toMatchObject({ transition: { kind: "fade", duration: { num: 6, den: 1 } } });
    await selectOperation("captions");
    expect(screen.getByLabelText("Caption 1 (60–75)")).toBeTruthy();
    type("caption-0", "Second");
    expect(await prepared()).toMatchObject({ captions: [{ start: { num: 60, den: 1 }, text: "Second" }] });
    await selectOperation("transfer");
    expect(selectOptions($("target-track")).map((o) => o.value)).toEqual(["broll"]);
    expect([value("transfer-num"), value("transfer-den")]).toEqual(["60", "1"]);
    expect(await prepared()).toMatchObject({ type: "transfer", targetTrackId: "broll", start: { num: 60, den: 1 } });
    act(() => fireEvent.click(clipButton("hook")));
    await selectOperation("captions");
    expect($("fields").textContent).toContain("No timed captions on this clip.");
    act(() => fireEvent.click(clipButton("talk")));
    await selectOperation("transfer");
    expect($("fields").textContent).toBe("Transfer supports visual tracks only.");
    expect(api.calls.filter((c) => c.route === "dry-run")).toHaveLength(5);
  });

  it("the advanced command validates raw JSON; an edited command is re-validated before Apply (RU-T11, G5)", async () => {
    const { api } = await open();
    const split = { type: "split", trackId: "visual", clipId: "proof", at: { num: 75, den: 1 }, newClipId: "r" };
    type("command", JSON.stringify(split));
    await act(async () => fireEvent.click($("validate")));
    expect(api.calls.at(-1)).toMatchObject({ route: "dry-run", body: { expectedRevision: 3, command: split } });
    type("command", JSON.stringify({ ...split, newClipId: "r2" }));
    await act(async () => fireEvent.click($("apply")));
    const tail = api.calls.slice(-2);
    expect(tail.map((c) => c.route)).toEqual(["dry-run", "mutate"]);
    expect(tail[1]!.body.command.newClipId).toBe("r2");
  });

  it("Apply refuses an empty command; a 409 refreshes, shows the notice and never re-sends (G2, G5)", async () => {
    const { api } = await open();
    await act(async () => fireEvent.click($("apply")));
    expect(status()).toBe("Prepare a new proposal first");
    act(() => fireEvent.click(clipButton("proof")));
    await act(async () => fireEvent.click($("prepare")));
    api.set({ ...api.state, revision: 5 });
    await act(async () => fireEvent.click($("apply")));
    await waitFor(() => expect($("status").dataset.kind).toBe("conflict"));
    expect($("conflict-notice").textContent).toContain("no automatic replay");
    expect(api.calls.filter((c) => c.route === "mutate")).toHaveLength(1);
    expect(value("command")).toBe("");
    expect($("identity").textContent).toContain("revision 5");
  });
});

describe("cancel and invalidation (RU-T19, RU-K01, K02, K07, K08)", () => {
  it("Escape, resize, Cancel, field input and a new selection clear the command and the draft", async () => {
    await open();
    const prepare = async () => {
      act(() => fireEvent.click(clipButton("proof")));
      await act(async () => fireEvent.click($("prepare")));
      expect(value("command")).not.toBe("");
    };
    const cancelled = () => {
      expect(value("command")).toBe("");
      expect(shown()).toBe("Proposal cancelled; prepare a new edit.");
    };
    await prepare();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    cancelled();
    await prepare();
    act(() => window.dispatchEvent(new Event("resize")));
    cancelled();
    await prepare();
    click("cancel-edit");
    cancelled();
    await prepare();
    type("edit-start", "61");
    cancelled();
    await prepare();
    act(() => fireEvent.click(clipButton("hook")));
    cancelled();
  });

  it("typing in the command drops the draft but keeps the text; Apply then re-validates (RU-K07)", async () => {
    const { api } = await open();
    act(() => fireEvent.click(clipButton("proof")));
    await act(async () => fireEvent.click($("prepare")));
    const text = value("command").replace("60", "61");
    type("command", text);
    expect(value("command")).toBe(text);
    await act(async () => fireEvent.click($("apply")));
    expect(api.calls.slice(-2).map((c) => c.route)).toEqual(["dry-run", "mutate"]);
  });
});

describe("prepared proposals (RU-P01–P06, G3, G6)", () => {
  it("prepares a reframe, shows its facts, and applies the prepared command without a generic dry-run", async () => {
    const { api } = await open();
    const command = { type: "replace", trackId: "visual", clipId: "hook", payload: { reframe: {} } };
    api.handlers["POST visual-reframe-proposal"] = () => ({
      status: 200,
      body: { ...dry(), command, originalSha256: "c".repeat(64), format: "vertical" },
    });
    act(() => fireEvent.click(clipButton("hook")));
    await selectOperation("visual-reframe");
    type("reframe-x", "0.25");
    await act(async () => fireEvent.click($("prepare")));
    expect(api.calls.at(-1)).toMatchObject({
      route: "visual-reframe-proposal",
      body: {
        expectedRevision: 3,
        trackId: "visual",
        clipId: "hook",
        format: "vertical",
        position: { x: 0.25, y: 0.5 },
      },
    });
    expect(JSON.parse(shown())).toEqual({
      revision: 3,
      proposedHash: "b".repeat(64),
      format: "vertical",
      position: { x: 0.25, y: 0.5 },
      originalSha256: "c".repeat(64),
    });
    expect(JSON.parse(value("command"))).toEqual(command);
    await act(async () => fireEvent.click($("apply")));
    expect(api.calls.slice(-1)[0]).toMatchObject({
      route: "mutate",
      body: { action: "edit", expectedRevision: 3, command },
    });
    expect(api.calls.filter((c) => c.route === "dry-run")).toHaveLength(0);
  });

  // The frame disables Refresh while a request is out, so "refresh" from review:ui's matrix becomes "select".
  it.each(["coordinates", "format", "reset", "select", "operation", "escape"])(
    "discards a late reframe reply after %s, with no draft and no write (G3, RU-P02)",
    async (mutation) => {
      const { api } = await open();
      let release!: () => void;
      api.handlers["POST visual-reframe-proposal"] = () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ status: 200, body: { ...dry(), command: { type: "replace" }, originalSha256: "c" } });
        });
      act(() => fireEvent.click(clipButton("hook")));
      await selectOperation("visual-reframe");
      act(() => {
        fireEvent.click($("prepare"));
      });
      await waitFor(() => expect(api.calls.at(-1)?.route).toBe("visual-reframe-proposal"));
      if (mutation === "coordinates") type("reframe-x", "1");
      else if (mutation === "format") chooseOption($("reframe-format"), "landscape");
      else if (mutation === "reset") act(() => fireEvent.click($("reframe-reset")));
      else if (mutation === "select") act(() => fireEvent.click(clipButton("proof")));
      else if (mutation === "operation") await selectOperation("visual-remove");
      else act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      await act(async () => release());
      await waitFor(() => expect(status()).toMatch(/cancelled or revision changed/));
      expect(value("command")).toBe("");
      await act(async () => fireEvent.click($("apply")));
      expect(api.calls.some((c) => c.route === "mutate")).toBe(false);
    },
  );

  it("blocks invalid reframe coordinates before any request (RU-P02)", async () => {
    const { api } = await open();
    act(() => fireEvent.click(clipButton("hook")));
    await selectOperation("visual-reframe");
    for (const input of ["", "-0.1", "1.1", "NaN", "Infinity"]) {
      type("reframe-x", input);
      await act(async () => fireEvent.click($("prepare")));
      expect(status()).toMatch(/coordinates/);
    }
    expect(api.calls.some((c) => c.route === "visual-reframe-proposal")).toBe(false);
  });

  it("refuses to apply a hand-edited specialized proposal (parity plan defect 3); Dry run makes it generic", async () => {
    const { api } = await open();
    const command = {
      type: "split",
      trackId: "visual",
      clipId: "proof",
      at: { num: 75, den: 1 },
      newClipId: "proof-right",
    };
    api.handlers["POST visual-split-proposal"] = () => ({ status: 200, body: { ...dry(), command } });
    act(() => fireEvent.click(clipButton("proof")));
    await selectOperation("visual-split");
    expect([value("split-at-num"), value("split-at-den"), value("split-right-id")]).toEqual(["75", "1", "proof-right"]);
    await act(async () => fireEvent.click($("prepare")));
    expect(JSON.parse(shown())).toMatchObject({ visualSplit: true });
    type("command", JSON.stringify({ ...command, at: { num: 80, den: 1 } }));
    await act(async () => fireEvent.click($("apply")));
    expect(status()).toContain("Split plain visual clip");
    expect(status()).toContain("Prepare it again, or press Dry run");
    expect(api.calls.some((c) => c.route === "mutate")).toBe(false);
    await act(async () => fireEvent.click($("validate")));
    await act(async () => fireEvent.click($("apply")));
    expect(api.calls.at(-1)).toMatchObject({ route: "mutate", body: { command: { at: { num: 80, den: 1 } } } });
  });

  it("authored copy, remove, slip and audio position post their strict bodies and flags", async () => {
    const { api } = await open();
    for (const route of ["authored-copy", "visual-remove", "visual-slip", "audio-position"])
      api.handlers[`POST ${route}-proposal`] = () => ({
        status: 200,
        body: { ...dry(), command: { type: "batch", commands: [] }, physical: { decodedFrames: 30 } },
      });
    act(() => fireEvent.click(clipButton("hook")));
    await selectOperation("authored-copy");
    expect([value("copy-headline"), value("copy-subtext")]).toEqual(["Ship faster", "Today"]);
    expect($<HTMLTextAreaElement>("copy-headline").maxLength).toBe(80);
    expect($<HTMLTextAreaElement>("copy-subtext").maxLength).toBe(160);
    chooseOption($("copy-headline-mode"), "set");
    await act(async () => {});
    type("copy-headline", "Ship today");
    chooseOption($("copy-subtext-mode"), "remove");
    await act(async () => {});
    await act(async () => fireEvent.click($("prepare")));
    expect(api.calls.at(-1)!.body).toEqual({
      expectedRevision: 3,
      trackId: "visual",
      clipId: "hook",
      target: "scene.hook",
      headline: "Ship today",
      subtext: null,
    });
    expect(JSON.parse(shown())).toMatchObject({ authoredCopy: true, freshRenderRequired: true });
    await selectOperation("visual-remove");
    await act(async () => fireEvent.click($("prepare")));
    expect(JSON.parse(shown())).toMatchObject({ visualRemove: true, gapRetained: true });
    await selectOperation("visual-slip");
    type("slip-num", "-3");
    await act(async () => fireEvent.click($("prepare")));
    expect(api.calls.at(-1)).toMatchObject({ route: "visual-slip-proposal", body: { delta: { num: -3, den: 1 } } });
    expect(JSON.parse(shown())).toMatchObject({ sourceSlip: true, physical: { decodedFrames: 30 } });
    act(() => fireEvent.click(clipButton("bed")));
    await selectOperation("audio-position");
    expect($("audio-position-notice")).toBeTruthy();
    expect($("fields").textContent).toContain("Output clock: 30/1 frames/sec. Source clock: 48000/1 frames/sec.");
    type("audio-position-num", "15");
    await act(async () => fireEvent.click($("prepare")));
    expect(api.calls.at(-1)).toMatchObject({
      route: "audio-position-proposal",
      body: { mode: "move", start: { num: 15, den: 1 } },
    });
    expect(JSON.parse(shown())).toMatchObject({ audioPosition: true });
  });

  it("gain shortcuts validate at once; the server's refusal is shown verbatim (RU-AU03)", async () => {
    const { api } = await open();
    act(() => fireEvent.click(clipButton("bed")));
    await selectOperation("audio-gain");
    expect($("fields").textContent).toContain("Current gain: 0 · muted.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Prepare gain reset" })));
    expect(api.calls.at(-1)).toMatchObject({
      route: "dry-run",
      body: { command: { type: "audio-gain", trackId: "music", clipId: "bed", gain: null } },
    });
    api.handlers["POST dry-run"] = () => ({
      status: 400,
      body: { ok: false, message: "Audio gain is already default" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Prepare mute" })));
    expect(status()).toBe("Audio gain is already default");
  });

  it("group move: 2–24 visual clips, 25th refused, cleared on every display (RU-P06)", async () => {
    const tracks = editState().tracks;
    tracks[0]!.clips = Array.from({ length: 25 }, (_, i) => ({ ...tracks[0]!.clips[0]!, id: `c${i}` }));
    const { api } = await open(server(editState(3, { tracks })));
    api.handlers["POST group-move-proposal"] = () => ({
      status: 200,
      body: { ...dry(), command: { type: "batch", commands: [] } },
    });
    const box = (clip: string) => screen.getByLabelText(`Group visual / ${clip}`);
    expect($<HTMLButtonElement>("group-prepare").disabled).toBe(true);
    act(() => fireEvent.click(box("c0")));
    expect($<HTMLButtonElement>("group-prepare").disabled).toBe(true);
    act(() => fireEvent.click(box("c1")));
    expect($("group-selection").textContent).toBe("2 / 24 selected · visual / c0, visual / c1");
    await act(async () => fireEvent.click($("group-prepare")));
    expect(api.calls.at(-1)).toMatchObject({
      route: "group-move-proposal",
      body: { expectedRevision: 3, members: [{ clipId: "c0" }, { clipId: "c1" }], delta: { num: 30, den: 1 } },
    });
    expect(JSON.parse(shown())).toMatchObject({ groupMembers: 2 });
    type("group-num", "-15");
    expect(value("command")).toBe("");
    for (let i = 2; i < 24; i++) act(() => fireEvent.click(box(`c${i}`)));
    act(() => fireEvent.click(box("c24")));
    expect(box("c24").getAttribute("aria-checked")).toBe("false");
    expect(status()).toBe("Visual groups support at most 24 clips");
    expect($("group-selection").textContent).toMatch(/^24 \/ 24 selected/);
    click("group-clear");
    expect($("group-selection").textContent).toBe("0 / 24 selected · ");
    act(() => fireEvent.click(box("c3")));
    await act(async () => fireEvent.click($("refresh")));
    await waitFor(() => expect($("group-selection").textContent).toBe("0 / 24 selected · "));
  });
});

describe("pointer (RU-T16–T18, RU-K03–K06)", () => {
  function layout() {
    const lanes = [...document.querySelectorAll<HTMLElement>(".lane")];
    lanes.forEach((lane, i) => {
      const top = i * 100;
      lane.getBoundingClientRect = () =>
        ({ left: 0, top, width: 1200, height: 52, right: 1200, bottom: top + 52, x: 0, y: top }) as DOMRect;
    });
    const proof = clipButton("proof");
    proof.getBoundingClientRect = () =>
      ({ left: 600, top: 0, width: 300, height: 44, right: 900, bottom: 44, x: 600, y: 0 }) as DOMRect;
    return proof;
  }
  const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp", target: Element, x: number, y = 20) =>
    act(() => fireEvent[type](target, { button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: y }));

  it("a drag previews, then release runs a dry-run only; the click after it is suppressed", async () => {
    const { api } = await open();
    const proof = layout();
    pointer("pointerDown", proof, 650);
    expect($("selection").textContent).toBe("visual / proof · asset-proof");
    pointer("pointerMove", proof, 652);
    expect(proof.classList.contains("dragging")).toBe(false);
    pointer("pointerMove", proof, 750);
    expect(clipButton("proof").classList.contains("dragging")).toBe(true);
    expect(parseFloat(clipButton("proof").style.left)).toBeCloseTo((100 * 70) / 120, 3);
    expect(shown()).toBe("Pointer preview only. Release to validate, then apply explicitly.");
    await act(async () => fireEvent.click($("apply")));
    expect(status()).toBe("Finish or cancel pointer interaction before applying");
    pointer("pointerUp", clipButton("proof"), 750);
    await waitFor(() => expect(api.calls.at(-1)?.route).toBe("dry-run"));
    expect(api.calls.at(-1)!.body).toEqual({
      expectedRevision: 3,
      command: { type: "move", trackId: "visual", clipId: "proof", start: { num: 70, den: 1 } },
    });
    expect(api.calls.some((c) => c.route === "mutate")).toBe(false);
    expect(clipButton("proof").style.left).toBe("50%");
    act(() => fireEvent.click(clipButton("proof")));
    expect(value("command")).not.toBe("");
  });

  it("drops onto another visual lane as a transfer; outside a visual lane it is refused; Escape restores", async () => {
    const { api } = await open();
    const proof = layout();
    pointer("pointerDown", proof, 650);
    pointer("pointerMove", proof, 650, 220);
    expect(shown()).toBe("Drop inside a visual track lane");
    pointer("pointerMove", proof, 450, 120);
    expect(clipButton("proof").style.transform).toMatch(/^translate\(0px, ?100px\)$/);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(clipButton("proof").classList.contains("dragging")).toBe(false);
    expect(clipButton("proof").style.transform).toBe("");
    pointer("pointerDown", clipButton("proof"), 650);
    pointer("pointerMove", clipButton("proof"), 450, 120);
    pointer("pointerUp", clipButton("proof"), 450, 120);
    await waitFor(() => expect(api.calls.at(-1)?.route).toBe("dry-run"));
    expect(api.calls.at(-1)!.body.command).toEqual({
      type: "transfer",
      trackId: "visual",
      clipId: "proof",
      targetTrackId: "broll",
      start: { num: 40, den: 1 },
    });
  });

  it("an end handle trims inward; a no-op release shows the pointer message", async () => {
    const { api } = await open();
    const proof = layout();
    const end = proof.querySelector<HTMLElement>(".trim-end")!;
    expect(end.title).toBe("Trim end inward; keyboard: use Trim source form");
    pointer("pointerDown", end, 895);
    pointer("pointerMove", end, 795);
    pointer("pointerUp", end, 795);
    await waitFor(() => expect(api.calls.at(-1)?.route).toBe("dry-run"));
    expect(api.calls.at(-1)!.body.command).toMatchObject({ type: "trim", end: { num: 20, den: 1 } });
    pointer("pointerDown", clipButton("proof").querySelector(".trim-end")!, 895);
    pointer("pointerMove", clipButton("proof"), 1000);
    expect(shown()).toBe("Pointer proposal makes no change");
    act(() => fireEvent.pointerCancel(clipButton("proof"), { pointerId: 1 }));
    expect(clipButton("proof").classList.contains("dragging")).toBe(false);
  });

  it("a no-op release reports the pointer message in the user's language (zh-Hans)", async () => {
    const { api } = await open(server(), "zh-Hans");
    const end = layout().querySelector<HTMLElement>(".trim-end")!;
    pointer("pointerDown", end, 895);
    pointer("pointerMove", end, 1000);
    pointer("pointerUp", end, 1000);
    await waitFor(() => expect(status()).toBe("指针提案没有任何更改"));
    expect(api.calls.some((c) => c.route === "dry-run")).toBe(false);
  });

  it("non-visual lanes take no pointer drags", async () => {
    const { api } = await open();
    layout();
    const bed = clipButton("bed");
    pointer("pointerDown", bed, 10);
    pointer("pointerMove", bed, 200);
    pointer("pointerUp", bed, 200);
    expect(api.calls.some((c) => c.route === "dry-run")).toBe(false);
  });
});

describe("i18n", () => {
  it("renders the section in Russian and Chinese", async () => {
    await open(server(), "ru");
    expect(screen.getByRole("button", { name: "Подготовить проверенную правку" })).toBeTruthy();
    expect($("selection").textContent).toBe("Выберите клип");
  });
  it("an uninitialized journal refuses a dry run in the user's language (ru)", async () => {
    await open(server(editState(null)), "ru");
    type("command", "{}");
    await act(async () => fireEvent.click($("validate")));
    expect(status()).toBe("Перед правкой инициализируйте таймлайн");
  });
  it("translates browser refusals (zh-Hans)", async () => {
    await open(server(), "zh-Hans");
    await act(async () => fireEvent.click($("prepare")));
    expect(status()).toBe("请先选择片段");
  });
});
