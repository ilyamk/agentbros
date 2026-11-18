import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ApiFailure } from "@/api/errors";
import { FixtureApiClient } from "@/api/fixture";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import { HomePage } from "./home";

const PROJECT = "promo-acme";
const TITLE = "Acme launch";
const href = `#/projects/${PROJECT}`;

it("renames and removes a Home card only after the user confirms its exact ID", async () => {
  const fixture = new FixtureApiClient({ fixture: "cards", now: () => FIXTURE_NOW });
  let title = TITLE;
  let deleted = false;
  const projects = fixture.projects.bind(fixture);
  vi.spyOn(fixture, "projects").mockImplementation(async () => {
    const response = await projects();
    const summary = response.projects.find(({ id }) => id === PROJECT)!;
    return { ...response, projects: deleted ? [] : [{ ...summary, title }], waiting: [] };
  });
  const renameProject = vi.fn(async (_project: string, name: string) => {
    title = name;
    return { ok: true } as const;
  });
  const removeProject = vi
    .fn<(project: string, confirm: string) => Promise<{ ok: true }>>()
    .mockRejectedValueOnce(new ApiFailure("VALIDATION", "A paid job is still running.", 409))
    .mockImplementation(async () => {
      deleted = true;
      return { ok: true };
    });
  const store = fixtureStore(Object.assign(fixture, { renameProject, removeProject }));
  renderWith(<HomePage />, { store });
  const user = userEvent.setup();
  const gear = await screen.findByRole("button", { name: `Settings for ${TITLE}` });
  const articleLink = screen.getByRole("link", { name: new RegExp(TITLE) });
  expect(articleLink.getAttribute("href")).toBe(href);
  expect(articleLink.contains(gear)).toBe(false);
  await user.click(gear);

  let dialog = within(screen.getByRole("dialog", { name: "Project settings" }));
  const input = dialog.getByRole("textbox", { name: "Project name" });
  expect((input as HTMLInputElement).value).toBe(TITLE);
  await user.clear(input);
  expect((dialog.getByRole("button", { name: "Save name" }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(input, "New launch");
  await user.click(dialog.getByRole("button", { name: "Save name" }));
  expect(renameProject).toHaveBeenCalledWith(PROJECT, "New launch");
  expect((await screen.findByRole("link", { name: /New launch/ })).getAttribute("href")).toBe(href);

  await user.click(screen.getByRole("button", { name: "Settings for New launch" }));
  await user.click(screen.getByRole("button", { name: "Delete project" }));
  dialog = within(screen.getByRole("dialog", { name: "Delete New launch?" }));
  expect(dialog.getByText(/permanently deletes the project and all its local files/)).toBeTruthy();
  const confirm = dialog.getByRole("textbox", { name: `Enter ${PROJECT} to confirm` });
  const deleteButton = dialog.getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement;
  expect(deleteButton.disabled).toBe(true);
  await user.type(confirm, "other-project");
  expect(deleteButton.disabled).toBe(true);
  await user.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(removeProject).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Delete project" }));
  expect(deleteButton.isConnected).toBe(false);
  await user.type(screen.getByRole("textbox", { name: `Enter ${PROJECT} to confirm` }), PROJECT);
  const confirmed = screen.getByRole("button", { name: "Delete permanently" });
  await user.click(confirmed);
  expect((await screen.findByRole("alert")).textContent).toContain("A paid job is still running.");
  expect(removeProject).toHaveBeenLastCalledWith(PROJECT, PROJECT);
  await user.click(confirmed);
  expect(await screen.findByText("No projects yet")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("omits project settings in fixture mode", async () => {
  renderWith(<HomePage />);
  await screen.findByRole("heading", { name: "Projects" });
  expect(screen.getAllByRole("link").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: /^Settings for/ })).toBeNull();
});
