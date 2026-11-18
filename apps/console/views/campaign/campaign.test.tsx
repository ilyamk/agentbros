import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FixtureApiClient } from "@/api/fixture";
import type { TextTransport } from "@/api/types";
import { chooseOption, fixtureStore, FIXTURE_NOW, renderWith, selectValue } from "@/test/utils";
import { defaultChoice, memberMatches, type CampaignState } from "./api";
import { CampaignView } from "./index";
import { ProjectPage } from "@/shell/project";

const PLAN = "b".repeat(64);
const OUTPUT = { path: "out/batch/hook-a.mp4", sha256: "c".repeat(64) };

function campaign(revision = 0, choices: CampaignState["selection"]["choices"] = []): CampaignState {
  return {
    campaignId: "spring-batch",
    planHash: PLAN,
    selection: { revision, planHash: PLAN, choices },
    members: [
      {
        id: "hook-a",
        heldForPilot: false,
        excluded: false,
        productId: "sneaker",
        language: "en",
        factors: { hook: "question" },
        tasks: [{ id: "render-hook-a", state: "complete" }],
        outputs: [OUTPUT],
      },
      {
        id: "hook-b",
        heldForPilot: true,
        excluded: true,
        productId: "boot",
        language: "de",
        factors: { hook: "demo" },
        tasks: [{ id: "render-hook-b", state: "waiting" }],
        outputs: [],
      },
    ],
  };
}

function storeWith(transport: TextTransport) {
  const client = new FixtureApiClient({ fixture: "cards", now: () => FIXTURE_NOW });
  Object.assign(client, { text: transport });
  return fixtureStore(client);
}

const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });

describe("campaign review helpers", () => {
  it("defaults to the last saved choice for this plan, else reject when excluded, else keep (RU-CP05)", () => {
    const state = campaign(2, [
      { memberId: "hook-a", planHash: "f".repeat(64), choice: "reject" },
      { memberId: "hook-a", planHash: PLAN, choice: "fix" },
    ]);
    expect(defaultChoice(state, state.members[0]!)).toBe("fix");
    expect(defaultChoice(state, state.members[1]!)).toBe("reject");
    const fresh = campaign();
    expect(defaultChoice(fresh, fresh.members[0]!)).toBe("keep");
  });

  it("filters by a case-insensitive substring of the member JSON (RU-CP03)", () => {
    const [a, b] = campaign().members;
    expect(memberMatches(a!, "QUESTION")).toBe(true);
    expect(memberMatches(b!, "question")).toBe(false);
    expect(memberMatches(b!, "  ")).toBe(true);
  });
});

describe("CampaignView", () => {
  it("shows the identity, members with facts and pinned videos, and filters (RU-CP02–04, RU-CP06)", async () => {
    let state = campaign();
    const transport = vi.fn<TextTransport>(async () => json(200, state));
    renderWith(<CampaignView project="spring-batch" />, { store: storeWith(transport) });
    expect((await screen.findByText(`spring-batch · ${"b".repeat(12)} · review draft revision 0`)).id).toBe(
      "campaign-identity",
    );
    expect(transport).toHaveBeenCalledWith("GET", "/api/review/spring-batch/campaign", undefined);
    expect(document.getElementById("status")!.textContent).toBe("Ready");
    expect(screen.getByText(/user approval and strict delivery remain separate/)).toBeTruthy();
    const a = screen.getByTestId("campaign-member-hook-a");
    const video = a.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("/api/review/spring-batch/file?path=out%2Fbatch%2Fhook-a.mp4");
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.hasAttribute("controls")).toBe(true);
    expect(within(a).getByText(`out/batch/hook-a.mp4 · ${"c".repeat(12)}`)).toBeTruthy();
    expect(within(a).getByText("sneaker")).toBeTruthy();
    const b = screen.getByTestId("campaign-member-hook-b");
    expect(within(b).getByText(/stale outputs are hidden/)).toBeTruthy();
    expect(selectValue(within(b).getByTestId("campaign-choice"))).toBe("reject");

    fireEvent.change(screen.getByTestId("campaign-filter"), { target: { value: "BOOT" } });
    expect(screen.queryByTestId("campaign-member-hook-a")).toBeNull();
    expect(screen.getByTestId("campaign-member-hook-b")).toBeTruthy();
    fireEvent.change(screen.getByTestId("campaign-filter"), { target: { value: "nothing-like-this" } });
    expect(screen.getByText("No member matches the filter.")).toBeTruthy();
    fireEvent.change(screen.getByTestId("campaign-filter"), { target: { value: "" } });

    state = campaign(1, [{ memberId: "hook-a", planHash: PLAN, choice: "keep" }]);
    fireEvent.click(document.getElementById("refresh")!);
    expect(await screen.findByText(/review draft revision 1/)).toBeTruthy();
    expect(screen.getByRole("status", { name: "Campaign review status" }).textContent).toContain("Ready");
  });

  it("saves the exact outputs with the shown revision, then refreshes (RU-CP05)", async () => {
    let state = campaign();
    const transport = vi.fn<TextTransport>(async (method, _path, body) => {
      if (method === "POST") {
        state = campaign(1, [{ memberId: "hook-a", planHash: PLAN, ...(body as object) } as never]);
        return json(200, state.selection);
      }
      return json(200, state);
    });
    renderWith(<CampaignView project="spring-batch" />, { store: storeWith(transport) });
    const card = await screen.findByTestId("campaign-member-hook-a");
    chooseOption(within(card).getByTestId("campaign-choice"), "fix");
    fireEvent.change(within(card).getByTestId("campaign-note"), { target: { value: "New opening" } });
    expect((within(card).getByTestId("campaign-note") as HTMLTextAreaElement).maxLength).toBe(2000);
    fireEvent.click(within(card).getByTestId("campaign-save"));
    await screen.findByText(/review draft revision 1/);
    expect(transport).toHaveBeenCalledWith("POST", "/api/review/spring-batch/selection", {
      planHash: PLAN,
      expectedRevision: 0,
      memberId: "hook-a",
      choice: "fix",
      note: "New opening",
      outputs: [OUTPUT],
    });
    await waitFor(() => expect(document.getElementById("status")!.getAttribute("data-kind")).toBe("ready"));
  });

  it("a 409 refreshes, keeps the typed note and never re-sends; a 400 shows the message (G1, G2)", async () => {
    let state = campaign();
    const transport = vi.fn<TextTransport>(async () => json(200, state));
    renderWith(<CampaignView project="spring-batch" />, { store: storeWith(transport) });
    const card = await screen.findByTestId("campaign-member-hook-a");
    fireEvent.change(within(card).getByTestId("campaign-note"), { target: { value: "Keep me" } });
    state = campaign(3);
    transport.mockResolvedValueOnce(
      json(409, { ok: false, error: "CONFLICT", message: "Campaign review changed; refresh" }),
    );
    fireEvent.click(within(card).getByTestId("campaign-save"));
    await waitFor(() => expect(document.getElementById("status")!.getAttribute("data-kind")).toBe("conflict"));
    expect(document.getElementById("status")!.textContent).toBe("Campaign review changed; refresh");
    expect(document.getElementById("status")!.className).toContain("error");
    expect(document.getElementById("conflict-notice")!.textContent).toContain("nothing was re-sent");
    expect(screen.getByText(/review draft revision 3/)).toBeTruthy();
    expect(transport.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(
      (within(screen.getByTestId("campaign-member-hook-a")).getByTestId("campaign-note") as HTMLTextAreaElement).value,
    ).toBe("Keep me");

    transport.mockResolvedValueOnce(
      json(400, { ok: false, error: "INVALID_INPUT", message: "Review member is outside campaign" }),
    );
    fireEvent.click(within(screen.getByTestId("campaign-member-hook-a")).getByTestId("campaign-save"));
    await waitFor(() =>
      expect(document.getElementById("status")!.textContent).toBe("Review member is outside campaign"),
    );
    expect(document.getElementById("status")!.getAttribute("data-kind")).toBe("error");
  });

  it("explains a failed load and fixture mode", async () => {
    renderWith(<CampaignView project="spring-batch" />, {
      store: storeWith(async () =>
        json(400, { ok: false, error: "INVALID_INPUT", message: "Campaign plan is missing" }),
      ),
    });
    expect(await screen.findByText("Campaign plan is missing")).toBeTruthy();
    expect(screen.getByText("The campaign review could not be read")).toBeTruthy();
  });

  it("fixture mode has no review transport", () => {
    renderWith(<CampaignView project="spring-batch" />);
    expect(screen.getByText("Timeline review needs the local console server")).toBeTruthy();
  });

  it("the Timeline page of a campaign container is the campaign view; other projects keep the timeline", async () => {
    const client = new FixtureApiClient({ fixture: "view-empty", now: () => FIXTURE_NOW });
    const project = FixtureApiClient.projectOf("view-empty")!;
    const original = client.view.bind(client);
    let route: "campaign" | "timeline" = "campaign";
    const transport = vi.fn<TextTransport>(async (_method, path) =>
      path.endsWith("/campaign") ? json(200, campaign()) : json(404, { ok: false, error: "NOT_FOUND", message: "x" }),
    );
    Object.assign(client, {
      text: transport,
      view: async (id: string) => {
        const view = await original(id);
        return { ...view, project: { ...view.project, route } };
      },
    });
    const first = renderWith(<ProjectPage project={project} view="timeline" />, { store: fixtureStore(client) });
    expect(await screen.findByTestId("campaign-view")).toBeTruthy();
    expect(transport).toHaveBeenCalledWith("GET", `/api/review/${project}/campaign`, undefined);
    first.unmount();
    route = "timeline";
    renderWith(<ProjectPage project={project} view="timeline" />, { store: fixtureStore(client) });
    await waitFor(() =>
      expect(transport).toHaveBeenCalledWith("GET", `/api/review/${project}/state`, undefined, undefined),
    );
    expect(screen.queryByTestId("campaign-view")).toBeNull();
  });
});
