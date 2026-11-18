/**
 * RFC 0004 gaps in the console UI: the autonomy and budget form (A10, US14, D13), Stop's per-job cancel list (A9),
 * the hooks status and install (H3) and the history's version compare (US17), against the fixture client.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectView } from "@contract";
import { FixtureApiClient } from "@/api/fixture";
import { dictionaries, format } from "@/i18n";
import { FIXTURES, fixtureViews } from "@/lib/fixtures";
import { collapse, diffLines, normaliseText } from "@/lib/line-diff";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import { CompareVersions, collectVersions, comparable } from "@/panels/generic/compare-versions";
import { AutonomyDialog, modeSettable, policyChangeOf, policyPhrase, widens } from "./autonomy";
import { HooksSettings } from "./hooks";
import { PaidJobs, listedJobs } from "./paid-jobs";

const build = fixtureViews.filmBuild;
const i18n = (language: "en" | "ru" | "zh-Hans" = "en") => ({
  d: dictionaries[language],
  f: format,
  locale: language === "en" ? "en-US" : language === "ru" ? "ru-RU" : "zh-Hans-CN",
});

function setup(fixture: "view-film-build" | "view-film-human" = "view-film-build") {
  const client = new FixtureApiClient({ fixture, now: () => FIXTURE_NOW });
  const store = fixtureStore(client);
  return { client, store, decide: vi.spyOn(store, "decide") };
}

describe("autonomy and budget form (A10)", () => {
  it("asks only for what changed and calls a first or higher ceiling and autonomous mode wider", () => {
    expect(policyChangeOf(build, "interactive", "10")).toEqual({ error: "nothing" });
    expect(policyChangeOf(build, "interactive", "-1")).toEqual({ error: "invalidAmount" });
    expect(policyChangeOf(build, "autonomous", "10").change).toEqual({ autonomy: "autonomous" });
    expect(policyChangeOf(build, "interactive", "12.5").change).toEqual({ ceilingUsd: 12.5 });
    expect(widens(build, { ceilingUsd: 12 })).toBe(true);
    expect(widens(build, { ceilingUsd: 4 })).toBe(false);
    expect(widens(build, { autonomy: "autonomous" })).toBe(true);
    expect(widens(build, { autonomy: "interactive" })).toBe(false);
    const recipe: ProjectView = { ...build, project: { ...build.project, route: "recipe" } };
    expect(policyChangeOf(recipe, "autonomous", "10")).toEqual({ error: "nothing" });
    // A replica is a bespoke film: film:policy sets its mode (the server's detectRoute calls it `film`).
    expect(modeSettable({ project: { ...build.project, route: "replica" } })).toBe(true);
    expect(modeSettable({ project: { ...build.project, route: "timeline" } })).toBe(false);
  });

  it("prefills words that say what they grant, in the UI language", () => {
    expect(policyPhrase(i18n(), { autonomy: "autonomous", ceilingUsd: 20 })).toBe(
      "Set autonomy to autonomous and the budget ceiling to $20.00.",
    );
    expect(policyPhrase(i18n("ru"), { ceilingUsd: 5 })).toMatch(/^Установить потолок бюджета 5,00/);
    expect(policyPhrase(i18n("zh-Hans"), { autonomy: "interactive" })).toBe("将自主程度设为交互。");
  });

  it("a raise shows the exact command and the amounts before and after, then applies on confirm", async () => {
    const { store, decide } = setup();
    const onClose = vi.fn();
    renderWith(<AutonomyDialog view={build} onClose={onClose} />, { store });
    const user = userEvent.setup();
    const amount = screen.getByLabelText("Budget ceiling (USD)");
    await user.clear(amount);
    await user.type(amount, "20");
    const words = screen.getByLabelText("Your words") as HTMLTextAreaElement;
    expect(words.value).toBe("Set the budget ceiling to $20.00.");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Confirm a wider grant");
    const table = screen.getByRole("table");
    expect(within(table).getByRole("row", { name: /Budget ceiling/ }).textContent).toContain("$10.00");
    expect(within(table).getByRole("row", { name: /Budget ceiling/ }).textContent).toContain("$20.00");
    expect(document.querySelector("[data-policy-command]")?.textContent).toBe(
      'pnpm film:policy --project promo-acme "--answer=Set the budget ceiling to \\$20.00." --ceiling-usd 20',
    );
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![2]).toEqual({ dryRun: true });
    await user.click(screen.getByRole("button", { name: "Confirm and apply" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [project, request] = decide.mock.calls[1]!;
    expect(project).toBe("promo-acme");
    expect(request).toMatchObject({
      kind: "policy",
      policy: { ceilingUsd: 20 },
      answer: "Set the budget ceiling to $20.00.",
    });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a lower ceiling applies at once with the user's own words", async () => {
    const { store, decide } = setup();
    renderWith(<AutonomyDialog view={build} onClose={() => {}} />, { store });
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Budget ceiling (USD)"));
    await user.type(screen.getByLabelText("Budget ceiling (USD)"), "4");
    const words = screen.getByLabelText("Your words");
    await user.clear(words);
    await user.type(words, "Keep it small.");
    await user.clear(screen.getByLabelText("Budget ceiling (USD)"));
    await user.type(screen.getByLabelText("Budget ceiling (USD)"), "5");
    expect((words as HTMLTextAreaElement).value, "edited words are never overwritten").toBe("Keep it small.");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide.mock.calls[0]![1]).toMatchObject({ policy: { ceilingUsd: 5 }, answer: "Keep it small." });
    expect(decide.mock.calls[0]![2]).toBeUndefined();
  });

  it("nothing changed is said, not sent", async () => {
    const { store, decide } = setup();
    renderWith(<AutonomyDialog view={build} onClose={() => {}} />, { store });
    await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("status").textContent).toBe(dictionaries.en.autonomy.nothing);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("Stop's paid jobs (A9)", () => {
  it("lists in-flight jobs with reservations; cancels one only after its own confirmation", async () => {
    const { store } = setup();
    const cancel = vi.spyOn(store, "cancelJob");
    renderWith(<PaidJobs view={build} />, { store });
    const user = userEvent.setup();
    const narration = document.querySelector('[data-job="job-narration-02"]') as HTMLElement;
    expect(narration.textContent).toContain("$1.40 reserved");
    const sfx = document.querySelector('[data-job="job-sfx-03"]') as HTMLElement;
    expect(sfx.textContent).toContain("unknown price reserved");
    expect(within(sfx).queryByRole("button")).toBeNull();
    expect(sfx.textContent).toContain("Cannot be cancelled: provider elevenlabs offers no cancellation for this job");
    expect(document.querySelector('[data-job="job-hero-01"]')).toBeNull();

    await user.click(within(narration).getByRole("button", { name: "Cancel job job-narration-02" }));
    expect(cancel).not.toHaveBeenCalled();
    const confirm = within(narration).getByRole("group", { name: "Cancel job-narration-02?" });
    expect((within(confirm).getByLabelText("Your words") as HTMLTextAreaElement).value).toBe(
      "Cancel job job-narration-02.",
    );
    await user.click(within(confirm).getByRole("button", { name: "Cancel this job" }));
    await within(narration).findByText("Cancelled.");
    expect(cancel).toHaveBeenCalledWith("promo-acme", "job-narration-02", { answer: "Cancel job job-narration-02." });
  });

  it("keeps a job the stop listed even when the view no longer has it in flight", () => {
    const view = { ...build, money: { ...build.money, jobs: [] } };
    const listed = listedJobs(view, [build.money.jobs[1]!]);
    expect(listed.map((job) => job.id)).toEqual(["job-narration-02"]);
    expect(listedJobs(build).map((job) => job.id)).toEqual(["job-narration-02", "job-sfx-03"]);
  });

  it("says when the list could not be read and how many ids were too long", () => {
    renderWith(<PaidJobs view={build} listing={{ jobs: [], error: "store locked", omitted: 2 }} />, {
      store: setup().store,
    });
    expect(screen.getByRole("alert").textContent).toBe("The paid jobs could not be listed: store locked");
    expect(screen.getByText("2 more jobs have ids too long to list here.")).toBeTruthy();
  });
});

describe("hooks in Settings (H3)", () => {
  it("shows the real status, the command to copy, and installs only after the confirm", async () => {
    const { store, client } = setup();
    const install = vi.spyOn(client, "installHooks");
    renderWith(<HooksSettings />, { store });
    const user = userEvent.setup();
    await waitFor(() =>
      expect(document.querySelector('[data-hook-state="installed"]')?.textContent).toContain("Installed"),
    );
    expect(document.querySelector('[data-hook-state="missing"]')?.textContent).toContain("Not installed");
    expect(document.querySelector("[data-hooks-command]")?.textContent).toBe("pnpm harness:setup --hooks --apply");
    await user.click(screen.getByRole("button", { name: "Install hooks…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install the harness hooks" });
    expect(dialog.textContent).toContain(".codex/hooks.json");
    expect(install).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await screen.findByText("Hooks installed. One trust step per harness:");
    expect(install).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelectorAll('[data-hook-state="installed"]').length).toBe(2));
    expect(screen.queryByRole("button", { name: "Install hooks…" })).toBeNull();
  });
});

describe("history version compare (US17)", () => {
  it("line diff: Myers edit script, collapsed context, JSON with sorted keys", () => {
    expect(diffLines("a\nb\nc\n", "a\nx\nc\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
    ]);
    expect(diffLines("", "")).toEqual([]);
    expect(diffLines("", "a\n")).toEqual([{ kind: "added", text: "a" }]);
    const long = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const rows = collapse(diffLines(long, long.replace("l10", "L10")));
    expect(rows.filter((row) => row.kind === "skip").map((row) => ("count" in row ? row.count : 0))).toEqual([7, 6]);
    expect(normaliseText("a.json", '{"b":1,"a":{"d":2,"c":3}}')).toEqual({
      text: '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n',
      json: true,
    });
    expect(normaliseText("a.md", '{"b":1}').json).toBe(false);
  });

  it("collects renders, served text documents and step outputs the view carries", () => {
    const keys = collectVersions(FIXTURES["view-film-human"]).map((version) => version.key);
    expect(keys.slice(0, 2)).toEqual(["out:film.mp4", "out:animatic/animatic-v3.mp4"]);
    expect(keys).toContain("project:pipeline/strategy.md");
    expect(keys).not.toContain("project:pipeline/design.json");
    expect(keys.filter((key) => key.startsWith("critic:")).length).toBeGreaterThanOrEqual(2);
    const versions = collectVersions(fixtureViews.filmScriptGate);
    const scripts = versions.filter((version) => version.key.startsWith("scripts:"));
    expect(scripts.map((version) => version.key)).toEqual(["scripts:1:S1", "scripts:1:S2", "scripts:1:S3"]);
    const doc = versions.find((version) => version.key === "project:pipeline/brief.md")!;
    expect(comparable(scripts[0]!, doc)).toBe(true);
  });

  it("compares two script candidates as a line diff, marked in text, not colour alone", async () => {
    const { store } = setup();
    renderWith(<CompareVersions view={fixtureViews.filmScriptGate} />, { store });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Version A" }));
    await user.click(await screen.findByRole("option", { name: /Script S1/ }));
    await user.click(screen.getByRole("combobox", { name: "Version B" }));
    await user.click(await screen.findByRole("option", { name: /Script S2/ }));
    const diff = await screen.findByLabelText(/^Differences between Script S1/);
    expect(diff.querySelectorAll('[data-diff="removed"]').length).toBe(3);
    expect(diff.querySelectorAll('[data-diff="added"]').length).toBe(2);
    expect(diff.textContent).toContain("removed: Your inbox, empty by nine.");
    expect(screen.getByText(/2 lines added, 3 removed/)).toBeTruthy();
  });

  it("fetches two text documents from /media and diffs them line by line", async () => {
    const texts: Record<string, string> = {
      "/media/teaser-nova/pipeline/brief.md": "# Brief\nNova teaser\n15 seconds\n",
      "/media/teaser-nova/pipeline/script-b.md": "# Brief\nNova teaser\n20 seconds\nvertical\n",
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const body = texts[String(input)];
      return new Response(body ?? "", { status: body === undefined ? 404 : 200 });
    });
    try {
      renderWith(<CompareVersions view={fixtureViews.filmScriptGate} />, { store: setup().store });
      const user = userEvent.setup();
      await user.click(screen.getByRole("combobox", { name: "Version A" }));
      await user.click(await screen.findByRole("option", { name: "Documents · pipeline/brief.md" }));
      await user.click(screen.getByRole("combobox", { name: "Version B" }));
      await user.click(await screen.findByRole("option", { name: "Documents · pipeline/script-b.md" }));
      const diff = await screen.findByLabelText("Differences between pipeline/brief.md and pipeline/script-b.md");
      expect([...diff.querySelectorAll("[data-diff]")].map((row) => row.textContent)).toEqual([
        "  # Brief",
        "  Nova teaser",
        "- removed: 15 seconds",
        "+ added: 20 seconds",
        "+ added: vertical",
      ]);
      expect(fetch.mock.calls.map((call) => String(call[0])).sort()).toEqual(Object.keys(texts).sort());
    } finally {
      fetch.mockRestore();
    }
  });
});
