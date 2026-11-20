/**
 * Generations panel (2026-11-20): one card per paid model job, newest first, with state, the provider's error, money
 * (reserved never shown as free) and the published result in the player; the latest preparation; the panel leads the
 * canvas of a template project holding only generations; the top bar shows reserved beside spent; History folds
 * repeated resume runs into one row.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import type { ConsoleEvent, ProjectView } from "@contract";
import { dictionaries, LANGUAGES } from "@/i18n";
import { FIXTURES } from "@/lib/fixtures";
import { mediaHref } from "@/media";
import { Canvas } from "@/shell/project";
import { TopBar } from "@/shell/top-bar";
import { renderWith } from "@/test/utils";
import { panelsFor } from "../registry";
import { registerGenericPanels } from "./index";
import { GenerationsPanel } from "./generations";
import { collapseRepeatedRuns, toTimelineEvent } from "./history";

beforeAll(() => registerGenericPanels());

const view = FIXTURES["view-generations"];
const card = (id: string) => document.querySelector<HTMLElement>(`[data-generation="${id}"]`)!;

describe("generations panel", () => {
  it("shows one card per job, newest first, and plays only the published result", () => {
    const { container } = renderWith(<GenerationsPanel view={view} />);
    const cards = [...container.querySelectorAll<HTMLElement>("[data-generation]")];
    expect(cards.map((element) => element.dataset.state)).toEqual(["running", "published", "failed"]);

    const published = card("higgsfield:published");
    const video = published.querySelector("video");
    expect(video).toBeTruthy();
    expect(video!.getAttribute("src")).toBe(
      mediaHref(view.project.id, { path: "assets/face-720p.mp4", kind: "video" }),
    );
    expect(within(published).getByText(/\$2\.21 reserved, not settled/)).toBeTruthy();

    // A failed or running job never gets a player for its planned file.
    expect(card("higgsfield:failed").querySelector("video")).toBeNull();
    expect(card("higgsfield:running").querySelector("video")).toBeNull();
  });

  it("shows the provider's error as written, the no-charge note and the running elapsed time", () => {
    renderWith(<GenerationsPanel view={view} />);
    const failed = card("higgsfield:failed");
    expect(within(failed).getByRole("note").textContent).toContain("rejected by content moderation (nsfw)");
    expect(within(failed).getByText(/no charge/)).toBeTruthy();
    expect(within(failed).queryByText(/quote/)).toBeNull();
    expect(within(failed).getByText(/from preparation face-v2/)).toBeTruthy();
    const running = card("higgsfield:running");
    expect(within(running).getByText(/running for/)).toBeTruthy();
    expect(within(running).getByText(/\$1\.47 reserved/)).toBeTruthy();
    expect(within(running).getByText(/appears here once the job is published/)).toBeTruthy();
  });

  it("shows the latest preparation: prompt, approval in the user's words, rights and references", () => {
    renderWith(<GenerationsPanel view={view} />);
    const preparation = document.querySelector<HTMLElement>('[data-preparation="face-v2"]')!;
    expect(within(preparation).getByText("Approved")).toBeTruthy();
    expect(within(preparation).getByText(/Yes, approved; for me only/)).toBeTruthy();
    expect(within(preparation).getByText(/study-only/)).toBeTruthy();
    // The prompt is a compact block; its text is only in the dialog.
    expect(within(preparation).queryByText(/Reference bindings: @Image1/)).toBeNull();
    expect(within(preparation).getByText("Generation prompt")).toBeTruthy();
    expect(within(preparation).getByText("2 preparations")).toBeTruthy();
  });

  it("is the current panel of a template project and the step rail has no current step", () => {
    const placed = panelsFor(view);
    expect(placed[0]!.def.id).toBe("generic.generations");
    expect(placed[0]!.collapsed).toBe(false);
    renderWith(<Canvas view={view} />);
    expect(screen.getByText(/project.json is the project:new template/)).toBeTruthy();
    expect(document.querySelector('[data-generation="higgsfield:published"] video')).toBeTruthy();
  });

  it("is absent without generations and shows an empty state when the section is empty", () => {
    expect(panelsFor(FIXTURES["view-empty"]).some((panel) => panel.def.id === "generic.generations")).toBe(false);
    const empty: ProjectView = { ...view, generations: { jobs: [] } };
    renderWith(<GenerationsPanel view={empty} />);
    expect(screen.getByText("No paid generations yet")).toBeTruthy();
  });

  it("renders in every language", () => {
    for (const language of LANGUAGES) {
      const { unmount } = renderWith(<GenerationsPanel view={view} />, { language });
      expect(screen.getAllByText(dictionaries[language].generations.state.failed).length).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe("prompt block", () => {
  it("shows the length and opens the full prompt in a dialog with Copy and Close", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWith(<GenerationsPanel view={view} />);
    const prompt = view.generations!.preparation!.prompt!;
    const block = document.querySelector<HTMLElement>('[data-preparation="face-v2"] [data-prompt]')!;
    expect(block.textContent).toContain(`${[...prompt].length} characters`);
    await user.click(within(block).getByRole("button", { name: /Show/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("[data-prompt-text]")!.textContent).toBe(prompt);
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(prompt);
    expect(within(dialog).getByRole("status").textContent).toBe("Copied");
    // The footer's Close (the dialog also has its corner close button).
    const closes = within(dialog).getAllByRole("button", { name: "Close" });
    await user.click(closes.find((button) => button.textContent === "Close")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("speaks Russian", () => {
    renderWith(<GenerationsPanel view={view} />, { language: "ru" });
    expect(screen.getAllByRole("button", { name: /Показать/ }).length).toBe(4);
    expect(screen.getAllByText("Промпт генерации").length).toBe(4);
  });
});

describe("top bar", () => {
  it("shows reserved beside spent, never only $0", () => {
    renderWith(<TopBar view={view} />);
    expect(screen.getByText(/\$0\.00 spent · \$3\.68 reserved of \$9\.00/)).toBeTruthy();
  });

  it("keeps the plain spend line when nothing is reserved", () => {
    const plain: ProjectView = { ...view, money: { ...view.money, reservedUsd: 0 } };
    renderWith(<TopBar view={plain} />);
    expect(screen.getByText("$0.00 of $9.00")).toBeTruthy();
  });
});

describe("history", () => {
  const run = (n: number, ok = true, argv = ["--request", "a.json"]): ConsoleEvent[] => {
    const runId = `01M7WCJRY7B00685DGPZYFST${String(n).padStart(2, "0")}`;
    const base = { v: 1 as const, project: "swap-demo", runId, alias: "generate:model", actor: "agent" as const };
    return [
      { ...base, id: `${runId}A`, at: `2026-11-20T11:${String(n).padStart(2, "0")}:00Z`, kind: "cli.start", argv },
      {
        ...base,
        id: `${runId}B`,
        at: `2026-11-20T11:${String(n).padStart(2, "0")}:02Z`,
        kind: "cli.end",
        ok,
        elapsedMs: 2000,
        ...(ok ? {} : { error: "NETWORK" }),
      },
    ] as ConsoleEvent[];
  };
  const i18n = {
    d: dictionaries.en,
    f: (t: string, v: Record<string, unknown> = {}) => t.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? "")),
    locale: "en",
  };

  it("folds consecutive identical successful runs into one row with a count", () => {
    const rows = collapseRepeatedRuns([...run(1), ...run(2), ...run(3)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repeat).toEqual({ count: 3, firstAt: "2026-11-20T11:01:00Z" });
    const row = toTimelineEvent(rows[0]!.event, i18n, rows[0]!.repeat);
    expect(row.title).toBe("generate:model ran 3 times");
  });

  it("keeps a failed run, a different command and the run in progress as their own rows", () => {
    const rows = collapseRepeatedRuns([
      ...run(1),
      ...run(2),
      ...run(3, false),
      ...run(4),
      ...run(5, true, ["--request", "b.json"]),
      run(6)[0]!,
    ]);
    expect(rows.map((row) => [row.event.kind, row.repeat?.count ?? 1])).toEqual([
      ["cli.end", 2],
      ["cli.start", 1],
      ["cli.end", 1],
      ["cli.start", 1],
      ["cli.end", 1],
      ["cli.start", 1],
      ["cli.end", 1],
      ["cli.start", 1],
    ]);
  });
});
