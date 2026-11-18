/** The fixed shell (RFC 0004 §5.1): sidebar (a sheet below 1024 px), routed main, notifications, search, live region. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Menu } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsole, useConsoleStore } from "@/store/context";
import { navigate, useRoute } from "@/lib/router";
import { useHotkeys } from "@/lib/keyboard";
import { NotificationStack } from "@/components/notification-stack";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LibraryPage } from "@/views/library";
import { HomePage } from "./home";
import { NotifyPrompt, NotifyProvider } from "./notify";
import { MetricsPage } from "./metrics";
import { ProjectPage } from "./project";
import { SearchPalette } from "./search";
import { SettingsPage } from "./settings";
import { PairingWatcher } from "./pairings";
import { SidebarNav } from "./sidebar";
import { GithubButton } from "./github-button";
import { HooksBanner } from "./hooks-banner";

export function AppShell() {
  const { d, f, p } = useI18n();
  const store = useConsoleStore();
  const route = useRoute();
  const notices = useConsole((s) => s.notices);
  const session = useConsole((s) => s.session);
  const shellWatches = route.name !== "project" && route.name !== "home" && route.name !== "metrics";
  const waiting = useConsole((s) => s.home.data?.waiting.length ?? 0);
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const openSearch = useCallback(() => setSearch(true), []);
  const hotkeys = useMemo(() => ({ search: openSearch }), [openSearch]);
  useHotkeys(hotkeys);

  useEffect(() => {
    if (session.status === "ready" && shellWatches) store.watch(undefined);
  }, [store, session.status, shellWatches]);

  // Confirmations fade out by themselves; errors and warnings stay until dismissed.
  useEffect(() => {
    const timers = notices
      .filter((notice) => notice.tone === "success" || notice.tone === "info")
      .map((notice) => setTimeout(() => store.dismiss(notice.id), 8000));
    return () => timers.forEach(clearTimeout);
  }, [notices, store]);

  // The tab title carries the waiting count (D23: other platforms get the title count).
  useEffect(() => {
    document.title = waiting ? `(${waiting}) ${d.app.name}` : d.app.name;
  }, [waiting, d]);

  let page;
  if (session.status === "pending")
    page = (
      <main id="main" tabIndex={-1} aria-busy="true" className="p-4 outline-none lg:p-8">
        <p role="status" className="text-sm text-muted-foreground">
          {session.attempt && session.attempt > 1
            ? f(d.errors.sessionRetrying, { attempt: session.attempt })
            : d.app.loading}
        </p>
      </main>
    );
  else if (session.status === "failed")
    page = (
      <main id="main" tabIndex={-1} className="p-4 outline-none lg:p-8">
        <EmptyState
          title={session.error?.code === "UNAUTHORIZED" ? d.errors.sessionRefused : d.errors.sessionUnreachable}
          description={session.error?.message}
          action={
            session.error?.code === "UNAUTHORIZED" ? undefined : (
              <Button variant="outline" onClick={() => void store.start()}>
                {d.app.retry}
              </Button>
            )
          }
        />
      </main>
    );
  else if (route.name === "home") page = <HomePage />;
  else if (route.name === "settings") page = <SettingsPage focusKeys={route.focusKeys} />;
  else if (route.name === "library") page = <LibraryPage />;
  else if (route.name === "metrics") page = <MetricsPage />;
  else if (route.name === "project")
    page = <ProjectPage key={route.project} project={route.project} view={route.view} decision={route.decision} />;
  else
    page = (
      <main id="main" tabIndex={-1} className="outline-none p-4 lg:p-8">
        <EmptyState title={d.errors.notFound} description={route.path} />
      </main>
    );

  return (
    <TooltipProvider>
      <NotifyProvider>
        <a
          href="#main"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("main")?.focus();
          }}
          className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          {d.app.skipToContent}
        </a>
        <div className="flex min-h-dvh">
          <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r bg-sidebar text-sidebar-foreground lg:block">
            <SidebarNav onSearch={openSearch} />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header
              aria-label={d.nav.appBar}
              className="sticky top-0 z-40 flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6"
            >
              <Sheet open={menu} onOpenChange={setMenu}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={d.nav.openMenu} className="lg:hidden">
                    <Menu aria-hidden="true" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left">
                  <SheetTitle className="sr-only">{d.nav.main}</SheetTitle>
                  <SheetDescription>{d.app.console}</SheetDescription>
                  <SidebarNav onNavigate={() => setMenu(false)} onSearch={() => (setMenu(false), openSearch())} />
                </SheetContent>
              </Sheet>
              <a href="#/" className="truncate text-sm font-semibold lg:hidden">
                {d.app.name}
              </a>
              <div className="ms-auto flex items-center">
                <GithubButton />
              </div>
            </header>
            <div tabIndex={-1} className="min-w-0 flex-1 outline-none">
              {session.status === "ready" ? (
                <>
                  <NotifyPrompt />
                  <PairingWatcher />
                  <HooksBanner />
                </>
              ) : null}
              {page}
            </div>
          </div>
        </div>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {waiting ? p(d.nav.waiting, waiting) : ""}
        </p>
        <SearchPalette open={search} onOpenChange={setSearch} />
        <NotificationStack
          notices={notices}
          label={d.notices.region}
          dismissLabel={(title) => f(d.notices.dismiss, { title })}
          openLabel={d.notices.open}
          onDismiss={(notice) => store.dismiss(notice.id)}
          onOpen={(notice) => {
            store.dismiss(notice.id);
            if (notice.route) navigate(`#${notice.route}`);
          }}
        />
      </NotifyProvider>
    </TooltipProvider>
  );
}
