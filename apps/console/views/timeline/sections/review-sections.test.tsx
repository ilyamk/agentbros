/**
 * WP13c review sections against a fake review transport: snapshots and takes (RU-N), assets and entities (RU-AS),
 * budget (RU-B), visualisations (RU-V), QA evidence (RU-Q), chapters (RU-C, the port of the vm-evaluated
 * review-chapters-client.test.ts cases). Music/SFX (RU-AU) is WP13b's edit section.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FixtureApiClient } from "@/api/fixture";
import type { TextTransport } from "@/api/types";
import { chooseOption, fixtureStore, FIXTURE_NOW, renderWith, selectOptions, selectValue } from "@/test/utils";
import { TimelineView } from "../index";
import { billingStatus, filterAssets } from "./assets";
import { keptTake } from "./snapshots";
import { reviewFileKind } from "./review-kit";

const H = (c: string) => c.repeat(64);
const r = (num: number, den = 1) => ({ num, den });

function baseState(patch: Record<string, unknown> = {}) {
  return {
    projectId: "demo-film",
    revision: 3,
    timelineHash: H("a"),
    durationInFrames: 90,
    timebase: r(30),
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          {
            id: "hook",
            assetId: "scene:hook",
            start: r(0),
            end: r(90),
            source: { start: r(0), end: r(90), timebase: r(30) },
            rate: r(1),
          },
        ],
      },
      {
        id: "music",
        kind: "music",
        clips: [
          {
            id: "bed",
            assetId: "music:bed",
            start: r(0),
            end: r(60),
            source: { start: r(0), end: r(60), timebase: r(30) },
            rate: r(1),
            payload: { audioGain: 0.5 },
          },
        ],
      },
    ],
    journal: [],
    redoCount: 0,
    assets: [],
    entities: [],
    budget: { status: "uninitialized", jobs: [] },
    snapshots: [],
    selected: null,
    reports: [],
    outputs: [],
    ...patch,
  };
}

type Handler = (method: string, route: string, body: any) => unknown;
interface Call {
  method: string;
  route: string;
  body: any;
}

/** A fake review transport: `handler` answers a route (a value, a promise, or `{status, body}` for errors). */
function harness(handler: Handler) {
  const calls: Call[] = [];
  const transport: TextTransport = async (method, path, body) => {
    const route = path.replace("/api/review/demo-film/", "");
    calls.push({ method, route, body });
    const reply = await handler(method, route, body);
    if (reply && typeof reply === "object" && "status" in reply && "body" in reply) {
      const { status, body: replyBody } = reply as { status: number; body: unknown };
      return { status, text: typeof replyBody === "string" ? replyBody : JSON.stringify(replyBody) };
    }
    return { status: 200, text: typeof reply === "string" ? reply : JSON.stringify(reply) };
  };
  const client = new FixtureApiClient({ fixture: "cards", now: () => FIXTURE_NOW });
  Object.assign(client, { text: transport });
  renderWith(<TimelineView project="demo-film" />, { store: fixtureStore(client) });
  return { calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const status = () => document.getElementById("status")!;
const $ = (id: string) => document.getElementById(id)!;
const ready = () => screen.findByText(/demo-film · revision \d+ · 90 frames/);
const select = (id: string, value: string) => chooseOption($(id), value);

describe("snapshots and takes (RU-N)", () => {
  it("saves a snapshot with the shown revision, lists it with createdAt and duration, keeps a take across refresh", async () => {
    let state = baseState();
    const snapshot = {
      hash: H("b"),
      label: "First cut",
      revision: 3,
      createdAt: "2026-11-17T09:00:00Z",
      durationInFrames: 90,
    };
    const { calls } = harness((method, route, body) => {
      if (route === "mutate") {
        state = baseState({ snapshots: [snapshot] });
        expect(body).toEqual({ action: "snapshot", label: "First cut", expectedRevision: 3 });
        return state;
      }
      return state;
    });
    await ready();
    expect($("snapshots").textContent).toContain("No snapshots saved yet.");
    fireEvent.change($("label"), { target: { value: "First cut" } });
    fireEvent.click($("snapshot"));
    await screen.findByText(`First cut · revision 3 · ${H("b")}`);
    expect($("snapshots").textContent).toContain("Saved Nov 17");
    expect($("snapshots").textContent).toContain("90 frames");
    expect(calls.filter((c) => c.route === "mutate")).toHaveLength(1);
    select("right", H("b"));
    expect(selectValue($("right"))).toBe(H("b"));
    expect(within($("right")).getByText(`First cut · ${H("b").slice(0, 12)}`)).toBeTruthy();
    expect(within($("left")).getByText("Current working revision 3")).toBeTruthy();
    fireEvent.click($("refresh"));
    await waitFor(() => expect(status().textContent).toBe("Ready"));
    expect(selectValue($("right"))).toBe(H("b"));
    expect(keptTake(H("c"), { snapshots: [snapshot] })).toBe("current");
  });

  it("compares two takes side by side", async () => {
    const side = (hash: string, revision: number, start: number) => ({
      hash,
      revision,
      timeline: {
        durationInFrames: 90,
        tracks: [
          { id: "visual", kind: "visual", clips: [{ id: "hook", assetId: "scene:hook", start: r(start), end: r(90) }] },
        ],
      },
    });
    const { calls } = harness((_m, route) =>
      route.startsWith("compare") ? { left: side(H("a"), 3, 0), right: side(H("a"), 3, 0), equal: true } : baseState(),
    );
    await ready();
    fireEvent.click($("compare"));
    await waitFor(() => expect($("comparison").textContent).toContain('"equal": true'));
    expect(calls.some((c) => c.route === "compare?left=current&right=current")).toBe(true);
    const sides = $("take-comparison").querySelectorAll("article");
    expect(sides).toHaveLength(2);
    expect(sides[0]!.textContent).toContain("left · revision 3");
    expect(sides[1]!.textContent).toContain("visual / hook · 0–90 · scene:hook");
  });

  it("choosing refuses the current revision, then records the right snapshot; the choice shows matchesCurrent", async () => {
    const snapshot = {
      hash: H("a"),
      label: "Take A",
      revision: 3,
      createdAt: "2026-11-17T09:00:00Z",
      durationInFrames: 90,
    };
    let state = baseState({ snapshots: [snapshot] });
    const { calls } = harness((_m, route, body) => {
      if (route === "mutate") {
        expect(body).toEqual({ action: "choose", snapshotHash: H("a"), actor: "Ilya", expectedRevision: 3 });
        state = baseState({
          snapshots: [snapshot],
          selected: {
            version: 1,
            snapshotHash: H("a"),
            snapshotRevision: 3,
            currentRevision: 3,
            currentHash: H("a"),
            actor: "Ilya",
            declaredAt: "2026-11-17T09:01:00Z",
          },
        });
      }
      return state;
    });
    await ready();
    expect($("choice").textContent).toBe("No chosen take");
    fireEvent.click($("choose"));
    await waitFor(() => expect(status().textContent).toBe("Save a snapshot before choosing a take"));
    expect(calls.some((c) => c.route === "mutate")).toBe(false);
    select("right", H("a"));
    fireEvent.change($("actor"), { target: { value: "Ilya" } });
    fireEvent.click($("choose"));
    await waitFor(() => expect($("choice").textContent).toContain('"matchesCurrent": true'));
    expect($("choice").textContent).toContain("Selection is a review choice, not release approval");
  });
});

describe("assets and entities (RU-AS)", () => {
  const assets = [
    {
      id: "hero",
      kind: "image",
      origin: "manual",
      rights: { licence: "fixture" },
      billing: { status: "not-billed" },
      original: "projects/demo-film/assets/hero.png",
      hash: H("d"),
    },
    {
      id: "bed",
      kind: "audio",
      origin: "stock",
      rights: { licence: "CC-BY" },
      billing: { status: "unknown" },
      original: "projects/demo-film/assets/bed.mp3",
    },
  ];

  it("lists, searches and filters assets with the count and previews an original through the review file route", async () => {
    harness(() =>
      baseState({
        assets,
        entities: [{ id: "mira", kind: "character", latestRevision: 2, canonicalRevision: 1, name: "Mira" }],
      }),
    );
    await ready();
    expect($("asset-count").textContent).toBe("2 / 2 assets");
    expect($("assets").textContent).toContain("hero · image · manual · licence fixture · billing not-billed");
    fireEvent.change($("asset-search"), { target: { value: "CC-by" } });
    expect($("asset-count").textContent).toBe("1 / 2 assets");
    fireEvent.change($("asset-search"), { target: { value: "" } });
    select("asset-kind", "image");
    expect($("asset-count").textContent).toBe("1 / 2 assets");
    fireEvent.click(screen.getByRole("button", { name: "Preview original" }));
    const img = $("assets").querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/review/demo-film/file?path=assets%2Fhero.png");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect($("entities").textContent).toContain("character / mira · Mira · latest revision 2 · canonical 1");
    expect($("assets").textContent).toContain(H("d"));
  });

  it("billing reads the provenance object; search covers id, origin and licence", () => {
    expect(billingStatus({ billing: { status: "estimated" } as never })).toBe("estimated");
    expect(filterAssets(assets as never, "STOCK", "").map((a) => a.id)).toEqual(["bed"]);
    expect(filterAssets(assets as never, "", "video")).toEqual([]);
  });
});

describe("budget and liability (RU-B)", () => {
  it("shows job lines with unknown actuals and the liability copy, read-only", async () => {
    harness(() =>
      baseState({
        budget: {
          status: "ok",
          jobs: [
            { id: "op-1", state: "succeeded", reservedUsd: 0.125, actualUsd: null },
            { id: "op-2", state: "succeeded", reservedUsd: 1, actualUsd: 0.98 },
          ],
        },
      }),
    );
    await ready();
    expect($("costs").textContent).toContain("op-1 · succeeded · reserved $0.125 · actual unknown (no receipt)");
    expect($("costs").textContent).toContain("op-2 · succeeded · reserved $1 · actual $0.98");
    expect($("liability").textContent).toBe(
      "Unknown billing remains unknown. Reservations are planning bounds; actual amounts require receipts.",
    );
    expect($("budget").textContent).toContain('"status": "ok"');
    const section = screen.getByTestId("timeline-section-budget");
    expect(within(section).queryAllByRole("button")).toHaveLength(0);
  });

  it("an empty ledger never implies free billing", async () => {
    harness(() => baseState());
    await ready();
    expect($("costs").textContent).toBe("No durable operations recorded. This does not imply asset billing is free.");
    expect($("budget").textContent).toContain("uninitialized");
  });
});

describe("visualisations (RU-V)", () => {
  it("keeps factualTruth visible, or says none are mounted", async () => {
    harness(() =>
      baseState({
        visualisations: {
          scenes: [{ sceneId: "chart", revision: H("e"), recipe: "bar", formats: ["vertical"] }],
          commands: ["pnpm viz:check --project demo-film --scene chart --revision " + H("e")],
          read: ["docs/visualisations.md"],
          factualTruth: "unverified",
        },
      }),
    );
    await ready();
    expect($("viz-factual-truth").textContent).toBe("Factual truth: unverified");
    expect(screen.getByTestId("timeline-section-visualisations").textContent).toContain("pnpm viz:check");
  });

  it("none mounted", async () => {
    harness(() => baseState());
    await ready();
    expect($("visualisations").textContent).toBe("No prepared visualisations mounted.");
  });
});

describe("QA evidence and outputs (RU-Q)", () => {
  const pack =
    "pipeline/qa-evidence/landscape-11111111-1111-1111-1111-111111111111/review-22222222-2222-2222-2222-222222222222/manifest.json";

  it("pins the hash, shows text reports as text, previews outputs and opens review packs", async () => {
    const { calls } = harness((_m, route) => {
      if (route === "file?path=pipeline%2Fqa.md") return "<script>window.hacked=true</script>";
      if (route.startsWith("review-pack"))
        return {
          source: { kind: "video", sha256: H("f") },
          status: "ok",
          warnings: ["Source freshness is unverified in the selected-project UI"],
          pages: [{ kind: "contact", path: "page-001.png", frameIds: ["f1", "f2"] }],
          frames: [
            {
              id: "f1",
              timeSec: 1.5,
              reasons: ["scene cut"],
              path: "frames/f1.png",
              crops: [{ path: "frames/f1-c1.png" }],
            },
          ],
          truncated: true,
          sourceFreshness: "unverified",
        };
      if (route === "file?path=pipeline%2Feditorial-qa.md") return { status: 400, body: "nope" };
      return baseState({
        reports: ["pipeline/qa.md", "pipeline/editorial-qa.md", pack],
        outputs: ["@out/landscape.mp4"],
      });
    });
    await ready();
    expect($("qa-pin").textContent).toBe(
      `Current timeline hash: ${H("a")} · QA reports retain their own captured revision; edits may make them stale.`,
    );
    fireEvent.click(screen.getByRole("button", { name: "pipeline/qa.md" }));
    await waitFor(() => expect($("report").textContent).toContain("<script>window.hacked=true</script>"));
    expect($("report").querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "pipeline/editorial-qa.md" }));
    await waitFor(() => expect(status().textContent).toBe("Cannot open report"));
    fireEvent.click(screen.getByRole("button", { name: "@out/landscape.mp4" }));
    const video = await waitFor(() => $("report").querySelector("video")!);
    expect(video.getAttribute("src")).toBe("/api/review/demo-film/file?path=%40out%2Flandscape.mp4");
    expect(video.getAttribute("preload")).toBe("metadata");
    fireEvent.click(screen.getByRole("button", { name: pack }));
    await screen.findByText(`video · ${H("f")} · ok`);
    expect(calls.some((c) => c.route === `review-pack?path=${encodeURIComponent(pack)}`)).toBe(true);
    expect(screen.getByText("Source freshness: unverified")).toBeTruthy();
    expect(screen.getByText("f1 · 1.500s · scene cut")).toBeTruthy();
    expect(screen.getByText("Frame metadata truncated; inspect the manifest with vision:inspect.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Crop f1/1" }));
    const parent = pack.slice(0, pack.lastIndexOf("/") + 1);
    expect(screen.getByTestId("review-pack").querySelector("img")!.getAttribute("src")).toBe(
      `/api/review/demo-film/file?path=${encodeURIComponent(parent + "frames/f1-c1.png")}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open contact page: f1, f2" }));
    expect(screen.getByTestId("review-pack").querySelector("img")!.getAttribute("src")).toContain("page-001.png");
  });

  it("classifies files as review:ui did", () => {
    expect(reviewFileKind(pack)).toBe("pack");
    expect(reviewFileKind("@out/qa-screenshots/a.JPG")).toBe("image");
    expect(reviewFileKind("music.flac")).toBe("audio");
    expect(reviewFileKind("entities/asset-board.html")).toBe("text");
    expect(reviewFileKind("pipeline/qa-evidence/x/evidence.json")).toBe("text");
  });
});

describe("chapters (RU-C, ported from review-chapters-client.test.ts)", () => {
  const result = {
    status: "ready",
    revision: 3,
    timelineHash: H("a"),
    journalSha256: H("9"),
    manifestSha256: H("b"),
    manifestRevision: 1,
    format: "landscape",
    chapters: [
      { id: "one", title: "One <script>x</script>", start: r(0), end: r(30) },
      { id: "two", title: "Two", start: r(30), end: r(90) },
    ],
    selected: { id: "one", reuse: { action: "render-required" } },
  };

  function chapterHarness() {
    const pending: { body: any; resolve: (value: unknown) => void }[] = [];
    let state = baseState();
    const view = harness((_m, route, body) => {
      if (route === "chapter-inspection") {
        const d = deferred<unknown>();
        pending.push({ body, resolve: d.resolve });
        return d.promise;
      }
      return state;
    });
    return { ...view, pending, setState: (next: ReturnType<typeof baseState>) => (state = next) };
  }

  it("a late inspection is discarded after a revision refresh", async () => {
    const f = chapterHarness();
    await ready();
    fireEvent.click($("chapter-refresh"));
    await waitFor(() => expect(f.pending).toHaveLength(1));
    expect(f.pending[0]!.body).toEqual({
      expectedRevision: 3,
      timelineHash: H("a"),
      manifestSha256: null,
      format: "landscape",
    });
    f.setState(baseState({ revision: 4, timelineHash: H("c") }));
    fireEvent.click($("refresh"));
    await screen.findByText("demo-film · revision 4 · 90 frames");
    await act(async () => f.pending[0]!.resolve(result));
    expect($("chapter-status").textContent).toBe("Not inspected for this revision");
    expect(($("chapter-selection") as HTMLButtonElement).disabled).toBe(true);
    expect(selectValue($("chapter-selection"))).toBe("");
    expect($("chapter-inspection").textContent).toBe("");
  });

  it("a format change invalidates a late reply and needs a new inspection", async () => {
    const f = chapterHarness();
    await ready();
    fireEvent.click($("chapter-refresh"));
    await waitFor(() => expect(f.pending).toHaveLength(1));
    select("chapter-format", "vertical");
    await act(async () => f.pending[0]!.resolve(result));
    expect($("chapter-inspection").textContent).toBe("");
    expect($("chapter-status").textContent).toBe("Not inspected for this revision");
    expect(f.pending).toHaveLength(1);
  });

  it("selecting a chapter binds the returned manifest SHA; titles are text", async () => {
    const f = chapterHarness();
    await ready();
    fireEvent.click($("chapter-refresh"));
    await waitFor(() => expect(f.pending).toHaveLength(1));
    await act(async () => f.pending[0]!.resolve(result));
    expect($("chapter-status").textContent).toBe(`Revision 3 · manifest SHA ${H("b")} · landscape · read-only`);
    const options = selectOptions($("chapter-selection"));
    expect(options[0]!.label).toBe("One <script>x</script> · 0/1–30/1");
    expect(document.querySelector("#chapter-selection script, [role='option'] script")).toBeNull();
    expect(($("chapter-selection") as HTMLButtonElement).disabled).toBe(false);
    expect($("chapter-inspection").textContent).toContain('"render-required"');
    select("chapter-selection", "two");
    await waitFor(() => expect(f.pending).toHaveLength(2));
    expect(f.pending[1]!.body.manifestSha256).toBe(H("b"));
    expect(f.pending[1]!.body.chapterId).toBe("two");
    await act(async () => f.pending[1]!.resolve({ ...result, selected: { id: "two" } }));
    expect(selectValue($("chapter-selection"))).toBe("two");
  });

  it("an absent manifest disables the select; an error stays in the chapter status", async () => {
    const f = chapterHarness();
    await ready();
    fireEvent.click($("chapter-refresh"));
    await waitFor(() => expect(f.pending).toHaveLength(1));
    await act(async () =>
      f.pending[0]!.resolve({ ...result, status: "absent", manifestSha256: null, chapters: [], selected: undefined }),
    );
    expect($("chapter-status").textContent).toBe("No chapter manifest; existing project remains compatible.");
    expect(($("chapter-selection") as HTMLButtonElement).disabled).toBe(true);
    expect($("chapter-inspection").textContent).toBe("No chapters");
  });

  it("an uninitialized timeline refuses inspection", async () => {
    harness(() => baseState({ revision: null, timelineHash: null, durationInFrames: 0 }));
    await screen.findByText("demo-film · no timeline journal");
    fireEvent.click($("chapter-refresh"));
    expect($("chapter-status").textContent).toBe("Initialize timeline before chapter inspection");
  });
});
