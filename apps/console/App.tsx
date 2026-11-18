/**
 * The studio console (RFC 0004): providers around the shell. `main.tsx` boots it (CSP nonce, session token, fixture
 * mode); tests render `<App store={…} />` with a fixture client.
 */
import { useEffect, useSyncExternalStore } from "react";
import { I18nProvider } from "@/i18n";
import { StoreProvider } from "@/store/context";
import type { ConsoleStore } from "@/store/store";
import { applyDocument, resolveLanguage, resolveTheme, usePreferences } from "@/lib/preferences";
import { AppShell } from "@/shell/app-shell";
import { registerAllPanels } from "@/panels";

registerAllPanels();

function subscribeColorScheme(listener: () => void) {
  const query = globalThis.matchMedia?.("(prefers-color-scheme: light)");
  query?.addEventListener?.("change", listener);
  return () => query?.removeEventListener?.("change", listener);
}

export function App({ store }: { store: ConsoleStore }) {
  const preferences = usePreferences();
  // Re-resolve "follow the system" when the system scheme changes.
  useSyncExternalStore(
    subscribeColorScheme,
    () => globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ?? false,
  );
  const language = resolveLanguage(preferences.language);
  const theme = resolveTheme(preferences.theme);

  useEffect(() => {
    applyDocument(theme, language);
  }, [theme, language]);

  return (
    <I18nProvider language={language}>
      <StoreProvider store={store}>
        <AppShell />
      </StoreProvider>
    </I18nProvider>
  );
}
