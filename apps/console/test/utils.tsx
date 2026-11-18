/** Test helpers: render with the console's providers over a fixture or fake client. */
import type { ReactNode } from "react";
import { fireEvent, render } from "@testing-library/react";
import { I18nProvider, type Language } from "@/i18n";
import { StoreProvider } from "@/store/context";
import { createConsoleStore, type ConsoleStore } from "@/store/store";
import { FixtureApiClient } from "@/api/fixture";
import type { ApiClient } from "@/api/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setFixedNow } from "@/lib/clock";
import { setDisplayTimeZone } from "@/lib/format";

export const FIXTURE_NOW = Date.parse("2026-11-17T09:18:00Z");

export function fixtureStore(
  client: ApiClient = new FixtureApiClient({ fixture: "cards", now: () => FIXTURE_NOW }),
): ConsoleStore {
  setFixedNow(FIXTURE_NOW);
  setDisplayTimeZone("UTC");
  return createConsoleStore(client);
}

export function renderWith(ui: ReactNode, { store = fixtureStore(), language = "en" as Language } = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider language={language}>
      <StoreProvider store={store}>
        <TooltipProvider>{children}</TooltipProvider>
      </StoreProvider>
    </I18nProvider>
  );
  const result = render(ui, { wrapper });
  return { ...result, store };
}

/** The value a `SelectField` (Radix) shows, mirrored on its trigger as `data-value`. */
export const selectValue = (trigger: Element) => trigger.getAttribute("data-value");

const openSelect = (trigger: Element) => {
  if ((trigger as HTMLButtonElement).disabled) throw new Error(`select ${trigger.id || ""} is disabled`);
  fireEvent.keyDown(trigger, { key: "Enter" });
};

/** Opens a `SelectField` from its trigger and picks the option whose value is `value` (synchronous, keyboard path). */
export function chooseOption(trigger: Element, value: string): void {
  openSelect(trigger);
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (element) => element.getAttribute("data-value") === value,
  );
  if (!option)
    throw new Error(
      `select ${trigger.id || ""} has no option ${JSON.stringify(value)}; open: ${trigger.getAttribute("aria-expanded")}; ${document.querySelectorAll("[role=option]").length} options`,
    );
  fireEvent.click(option);
}

/** The options of a `SelectField` as `{ value, label }`, read by opening it and closing it again. */
export function selectOptions(trigger: Element): { value: string; label: string }[] {
  openSelect(trigger);
  const options = [...document.querySelectorAll('[role="option"]')].map((element) => ({
    value: element.getAttribute("data-value") ?? "",
    label: element.textContent ?? "",
  }));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  return options;
}

/** Moves a `Slider` thumb (Radix, `role="slider"`) to `value` with the keyboard: Home, then one step right at a time. */
export function setSlider(thumb: Element, value: number): void {
  fireEvent.keyDown(thumb, { key: "Home" });
  const min = Number(thumb.getAttribute("aria-valuemin") ?? 0);
  for (let at = min; at < value; at++) fireEvent.keyDown(thumb, { key: "ArrowRight" });
}
