import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { FixtureApiClient } from "@/api/fixture";
import type { TextTransport } from "@/api/types";
import { fixtureStore, FIXTURE_NOW, renderWith } from "@/test/utils";
import { ProposalGuard } from "./api";
import { TimelineView } from "./index";
import { TIMELINE_SECTIONS } from "./sections";

const state = (revision: number | null, frames = 90) => ({
  projectId: "demo-film",
  revision,
  timelineHash: revision === null ? null : "a".repeat(64),
  durationInFrames: revision === null ? 0 : frames,
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

function storeWith(transport: TextTransport) {
  const client = new FixtureApiClient({ fixture: "cards", now: () => FIXTURE_NOW });
  Object.assign(client, { text: transport });
  return fixtureStore(client);
}

const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });

describe("TimelineView", () => {
  it("shows identity, Refresh, the non-approval notice, the status line and every section", async () => {
    let revision = 3;
    const transport = vi.fn<TextTransport>(async () => json(200, state(revision)));
    renderWith(<TimelineView project="demo-film" />, { store: storeWith(transport) });
    expect((await screen.findByText("demo-film · revision 3 · 90 frames")).id).toBe("identity");
    expect(transport).toHaveBeenCalledWith("GET", "/api/review/demo-film/state", undefined, undefined);
    expect(document.getElementById("non-approval")!.textContent).toBe(
      "Local editing. Snapshot choices do not approve production delivery.",
    );
    for (const { id } of TIMELINE_SECTIONS) expect(screen.getByTestId(`timeline-section-${id}`)).toBeTruthy();
    revision = 4;
    fireEvent.click(document.getElementById("refresh")!);
    expect(await screen.findByText("demo-film · revision 4 · 90 frames")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Review status" })!.textContent).toContain("Ready");
  });

  it("renders an uninitialized journal with the init hint (RU-SE07)", async () => {
    renderWith(<TimelineView project="demo-film" />, { store: storeWith(async () => json(200, state(null))) });
    expect(await screen.findByText("demo-film · no timeline journal")).toBeTruthy();
    expect(screen.getByText("No timeline journal yet", { selector: "p" })).toBeTruthy();
    expect(screen.getByText(/pnpm timeline:edit --project demo-film --init/)).toBeTruthy();
    expect(screen.getByTestId("timeline-section-assets")).toBeTruthy();
  });

  it("a server error shows its message; a 409 refreshes and shows the no-replay notice (G1, G2)", async () => {
    const transport = vi.fn<TextTransport>(async () => json(200, state(3)));
    renderWith(<TimelineView project="demo-film" />, { store: storeWith(transport) });
    await screen.findByText("demo-film · revision 3 · 90 frames");
    transport.mockResolvedValueOnce(json(400, { ok: false, error: "INVALID_INPUT", message: "Journal is broken" }));
    fireEvent.click(document.getElementById("refresh")!);
    await waitFor(() => expect(document.getElementById("status")!.textContent).toContain("Journal is broken"));
    expect(document.getElementById("status")!.getAttribute("data-kind")).toBe("error");
    expect(document.getElementById("conflict-notice")).toBeNull();
    transport.mockResolvedValueOnce(
      json(409, { ok: false, error: "CONFLICT", message: "Expected revision 3, found 4" }),
    );
    transport.mockResolvedValueOnce(json(200, state(4)));
    fireEvent.click(document.getElementById("refresh")!);
    await waitFor(() => expect(document.getElementById("status")!.getAttribute("data-kind")).toBe("conflict"));
    expect(document.getElementById("status")!.textContent).toContain("Expected revision 3, found 4");
    expect(document.getElementById("conflict-notice")!.textContent).toContain("no automatic replay");
    expect(screen.getByText("demo-film · revision 4 · 90 frames")).toBeTruthy();
  });

  it("a failed first load shows the server's message and a retry", async () => {
    renderWith(<TimelineView project="demo-film" />, {
      store: storeWith(async () => json(400, { ok: false, error: "VALIDATION", message: "Unreadable journal" })),
    });
    expect(await screen.findByText("The review state could not be read")).toBeTruthy();
    expect(screen.getByText("Unreadable journal")).toBeTruthy();
    expect(document.getElementById("refresh")).toBeTruthy();
  });

  it("fixture mode has no review transport", () => {
    renderWith(<TimelineView project="demo-film" />);
    expect(screen.getByText("Timeline review needs the local console server")).toBeTruthy();
  });

  it("Escape and resize cancel the current proposal (G4)", async () => {
    const { container } = renderWith(<TimelineView project="demo-film" />, {
      store: storeWith(async () => json(200, state(3))),
    });
    await screen.findByText("demo-film · revision 3 · 90 frames");
    expect(container).toBeTruthy();
    const spy = vi.spyOn(ProposalGuard.prototype, "cancel");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      window.dispatchEvent(new Event("resize"));
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
