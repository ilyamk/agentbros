import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CredentialList } from "../../../src/types/console-credentials";
import { ApiFailure } from "@/api/errors";
import { FixtureApiClient } from "@/api/fixture";
import { fixtureStore, renderWith } from "@/test/utils";
import { CredentialSettings } from "./credentials";

const SAVED = "example-existing-key";
const DRAFT = "example-replacement-key";
const REVISION = "a1b2c3d4-abcd-4321-aabc-000000000000";
const result: CredentialList = {
  ok: true,
  editable: true,
  revision: REVISION,
  keys: [{ name: "FAL_KEY", service: "fal.ai", signup: "https://fal.ai/dashboard/keys", state: "set" }],
};

async function setup(editable = true, keys = result.keys) {
  const api = Object.assign(new FixtureApiClient({ fixture: "cards" }), {
    credentials: vi.fn(async () => ({ ...result, editable, keys })),
    openCredentialEditor: vi.fn(async (): Promise<void> => {}),
    revealCredential: vi.fn(async () => SAVED),
    saveCredentials: vi.fn(async () => result),
  });
  const store = fixtureStore(api);
  await store.start();
  const user = userEvent.setup();
  renderWith(<CredentialSettings />, { store });
  await screen.findByRole("link", { name: "fal.ai" });
  return { user, api };
}

describe("API key settings", () => {
  it("describes integrations and pairs each saved key state with a coloured icon", async () => {
    await setup(false, [
      ...result.keys,
      { name: "PEXELS_API_KEY", service: "Pexels", signup: "https://www.pexels.com/api/new/", state: "unset" },
      {
        name: "HIGGSFIELD_API_KEY",
        service: "Higgsfield",
        signup: "https://open.higgsfield.ai/api-keys",
        state: "malformed",
      },
      {
        name: "OPENVERSE_CLIENT_ID",
        service: "Openverse",
        signup: "https://docs.openverse.org/api/",
        state: "incomplete",
      },
    ]);
    const [fal, pexels] = screen.getAllByRole("listitem");
    expect(within(fal!).getByText(/hosts AI media models/)).toBeTruthy();
    expect(within(pexels!).getByText(/stock library for photos and video clips/)).toBeTruthy();
    for (const [label, icon, colour] of [
      ["Key set", "circle-check", "text-status-done"],
      ["No key", "circle-alert", "text-status-paused"],
      ["Invalid format", "circle-x", "text-status-blocked"],
      ["Missing companion credential", "circle-alert", "text-status-paused"],
    ] as const) {
      const status = screen.getByText(label);
      expect(status.querySelector(`svg.lucide-${icon}.${colour}[aria-hidden="true"]`)).toBeTruthy();
    }
  });

  it("reveals on demand, drops revealed values when hidden, and copies without displaying", async () => {
    const { user, api } = await setup();
    const link = screen.getByRole("link", { name: "fal.ai" });
    expect(link.getAttribute("href")).toBe("https://fal.ai/dashboard/keys");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const field = screen.getByLabelText("FAL_KEY", { selector: "input" });
    expect(field.getAttribute("type")).toBe("password");
    expect((field as HTMLInputElement).value).toBe("");
    expect(api.revealCredential).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Show FAL_KEY" }));
    await waitFor(() => expect(field.getAttribute("type")).toBe("text"));
    expect((field as HTMLInputElement).value).toBe(SAVED);
    await user.click(screen.getByRole("button", { name: "Hide FAL_KEY" }));
    expect(field.getAttribute("type")).toBe("password");
    expect((field as HTMLInputElement).value).toBe("");

    await user.click(screen.getByRole("button", { name: "Copy FAL_KEY" }));
    expect(await screen.findByText("Key copied.")).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe(SAVED);
    expect((field as HTMLInputElement).value).toBe("");
    expect(api.revealCredential).toHaveBeenCalledTimes(2);
    expect(api.saveCredentials).not.toHaveBeenCalled();
  });

  it("cancels drafts, validates invalid input, and saves replacement and removal explicitly", async () => {
    const { user, api } = await setup();
    const field = () => screen.getByLabelText("FAL_KEY", { selector: "input" });
    const button = (name: string) => screen.getByRole("button", { name });
    await user.type(field(), "two words");
    await user.click(button("Save"));
    expect(await screen.findByText(/with no spaces/)).toBeTruthy();
    expect(api.saveCredentials).not.toHaveBeenCalled();
    await user.click(button("Cancel"));
    expect((field() as HTMLInputElement).value).toBe("");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);

    await user.type(field(), DRAFT);
    await user.click(button("Save"));
    await screen.findByText("API keys saved.");
    expect(api.saveCredentials).toHaveBeenLastCalledWith(
      { revision: REVISION, changes: { FAL_KEY: DRAFT } },
      expect.any(AbortSignal),
    );
    expect((field() as HTMLInputElement).value).toBe("");
    await user.click(button("Remove FAL_KEY"));
    expect(within(screen.getByRole("list")).getByText("Will be removed on save")).toBeTruthy();
    await user.click(button("Save"));
    expect(api.saveCredentials).toHaveBeenLastCalledWith(
      { revision: REVISION, changes: { FAL_KEY: null } },
      expect.any(AbortSignal),
    );
  });

  it("leaves a stale draft in place until the user cancels, and keeps ordinary sessions read-only", async () => {
    const { user, api } = await setup();
    api.saveCredentials.mockRejectedValueOnce(new ApiFailure("CONFLICT", "changed", 409));
    await user.type(screen.getByLabelText("FAL_KEY", { selector: "input" }), DRAFT);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Keys changed in another tab/)).toBeTruthy();
    expect((screen.getByLabelText("FAL_KEY", { selector: "input" }) as HTMLInputElement).value).toBe(DRAFT);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.credentials).toHaveBeenCalledTimes(2);
  });

  it("shows masked fields immediately and opens the editor from a paired session", async () => {
    const { user, api } = await setup(false);
    const open = screen.getByRole("button", { name: "Edit API keys" });
    expect(screen.queryByText("pnpm console --open")).toBeNull();
    const field = screen.getByLabelText("FAL_KEY", { selector: "input" }) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.disabled).toBe(true);
    expect(field.placeholder).toBe("••••••••••••");
    await user.type(field, "fixture-unsaved-key");
    for (const label of ["Show FAL_KEY", "Copy FAL_KEY", "Remove FAL_KEY", "Cancel", "Save"]) {
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(field.value).toBe("");
    expect(api.revealCredential).not.toHaveBeenCalled();
    expect(api.saveCredentials).not.toHaveBeenCalled();
    await user.click(open);
    expect(await screen.findByText("Opening the key editor in your browser.")).toBeTruthy();
    expect(api.openCredentialEditor).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(screen.getByText("Key set")).toBeTruthy();
    expect(field.value).toBe("");
    expect(field.disabled).toBe(true);
  });

  it("shows the terminal fallback when opening the browser fails", async () => {
    const { user, api } = await setup(false);
    api.openCredentialEditor.mockRejectedValueOnce(new ApiFailure("BROWSER_UNAVAILABLE", "Could not open", 503));
    await user.click(screen.getByRole("button", { name: "Edit API keys" }));
    expect(await screen.findByText("pnpm console --open")).toBeTruthy();
  });
});
