/**
 * The hooks banner and its dialog (H3): shown while a harness's hooks are missing, Check again asks the server again,
 * Install runs only on the dialog's click and hides the banner, and "hide for good" survives a remount.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FixtureApiClient } from "@/api/fixture";
import { en } from "@/i18n/en";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import { HooksBanner } from "./hooks-banner";
import { HooksSettings } from "./hooks";

const t = en.hooksBanner;

function setup() {
  const client = new FixtureApiClient({ fixture: "cards", now: () => FIXTURE_NOW });
  return { client, store: fixtureStore(client) };
}

describe("hooks banner (H3)", () => {
  it("asks to connect the hooks while Codex's are missing, explains why, checks again and installs on the click", async () => {
    const { client, store } = setup();
    const hooks = vi.spyOn(client, "hooks");
    const install = vi.spyOn(client, "installHooks");
    renderWith(<HooksBanner />, { store });
    const user = userEvent.setup();

    const banner = await screen.findByRole("region", { name: t.title });
    expect(banner.textContent).toContain(t.body);
    await user.click(within(banner).getByRole("button", { name: t.open }));
    const dialog = await screen.findByRole("dialog", { name: t.dialogTitle });
    expect(dialog.textContent).toContain(t.reasonDecisions);
    expect(dialog.textContent).toContain(".codex/hooks.json");
    expect(dialog.querySelector('[data-hook-state="missing"]')).toBeTruthy();
    expect(install).not.toHaveBeenCalled();

    const calls = hooks.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: t.check }));
    await within(dialog).findByText(t.checkedIncomplete);
    expect(hooks.mock.calls.length).toBe(calls + 1);

    await user.click(within(dialog).getByRole("button", { name: t.install }));
    await within(dialog).findByText(en.settings.installed);
    expect(install).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(dialog.querySelectorAll('[data-hook-state="installed"]').length).toBe(2));
    expect(screen.queryByRole("region", { name: t.title })).toBeNull();
    const close = within(dialog)
      .getAllByRole("button", { name: en.app.close })
      .find((button) => button.textContent === en.app.close)!;
    await user.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shares the status with Settings: an install there hides the banner", async () => {
    const { store } = setup();
    renderWith(
      <>
        <HooksBanner />
        <HooksSettings />
      </>,
      { store },
    );
    const user = userEvent.setup();
    await screen.findByRole("region", { name: t.title });
    await user.click(screen.getByRole("button", { name: en.settings.install }));
    const dialog = await screen.findByRole("dialog", { name: en.settings.installTitle });
    await user.click(within(dialog).getByRole("button", { name: en.settings.installConfirm }));
    await screen.findByText(en.settings.installed);
    await waitFor(() => expect(screen.queryByRole("region", { name: t.title })).toBeNull());
  });

  it("hides for good once dismissed, also after a remount", async () => {
    const first = setup();
    const view = renderWith(<HooksBanner />, { store: first.store });
    const user = userEvent.setup();
    const banner = await screen.findByRole("region", { name: t.title });
    await user.click(within(banner).getByRole("button", { name: t.dismiss }));
    expect(screen.queryByRole("region", { name: t.title })).toBeNull();
    view.unmount();

    const second = setup();
    const hooks = vi.spyOn(second.client, "hooks");
    renderWith(<HooksBanner />, { store: second.store });
    await waitFor(() => expect(hooks).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("region", { name: t.title })).toBeNull();
  });

  it("shows nothing when both harnesses are connected", async () => {
    const { client, store } = setup();
    await client.installHooks();
    const hooks = vi.spyOn(client, "hooks");
    renderWith(<HooksBanner />, { store });
    await waitFor(() => expect(hooks).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("region", { name: t.title })).toBeNull();
  });
});
