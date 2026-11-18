/**
 * Sidebar (RFC 0004 §5.1): Home · projects with status dot and waiting count · Settings; a sheet below 1024 px.
 * The footer carries the copyright, licence and version line.
 */
import type { ProjectSummary } from "@contract";
import { BarChart3, Clapperboard, Home, Library, Search, Settings } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsole } from "@/store/context";
import { projectHref, useRoute } from "@/lib/router";
import { CONTROL_TONE, stepTone, TONE_BG, TONE_ICON, TONE_TEXT, type Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import { APP_VERSION, AUTHOR, COPYRIGHT_YEAR, LICENCE_ID, LICENCE_URL } from "@/lib/about";
import { Kbd } from "@/components/ui/kbd";

function projectTone(project: ProjectSummary): Tone {
  if (project.control !== "running") return CONTROL_TONE[project.control];
  if (project.waiting) return "waiting";
  return project.stepStatus ? stepTone(project.stepStatus, true) : "upcoming";
}

const link =
  "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/60 focus-visible:outline-none";

const footerLink =
  "rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/60 focus-visible:outline-none";

export function SidebarNav({ onNavigate, onSearch }: { onNavigate?: () => void; onSearch: () => void }) {
  const { d, f, p } = useI18n();
  const route = useRoute();
  const projects = useConsole((s) => s.home.data?.projects);
  const stream = useConsole((s) => s.stream);
  const session = useConsole((s) => s.session);
  const mode = useConsole((s) => s.mode);
  const current = route.name === "project" ? route.project : undefined;
  const retrying = stream === "offline" || (session.status === "pending" && (session.attempt ?? 0) > 1);
  const disconnected = session.status === "failed" || stream === "closed";
  const connection =
    mode === "snapshot"
      ? d.snapshot.mode
      : mode === "fixture"
        ? d.app.fixture
        : disconnected
          ? session.error?.code === "UNAUTHORIZED"
            ? d.app.sessionRequired
            : d.app.disconnected
          : retrying
            ? d.app.offline
            : stream === "live"
              ? d.app.live
              : d.app.connecting;
  const connectionTone: Tone =
    mode === "fixture" || mode === "snapshot"
      ? "skipped"
      : disconnected || retrying
        ? "blocked"
        : stream === "live"
          ? "done"
          : "upcoming";

  return (
    <nav aria-label={d.nav.main} className="flex h-full flex-col gap-4 p-3">
      <a href="#/" onClick={onNavigate} className="flex items-center gap-2 px-2 pt-1">
        <Clapperboard className="size-5 text-sidebar-primary" aria-hidden="true" />
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">{d.app.name}</span>
          <span className="text-xs text-muted-foreground">{d.app.console}</span>
        </span>
      </a>
      <button
        type="button"
        onClick={onSearch}
        className="flex items-center gap-2 rounded-md border bg-background/40 px-2 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/60 focus-visible:outline-none"
      >
        <Search className="size-4" aria-hidden="true" />
        <span className="flex-1 text-start">{d.nav.search}</span>
        <Kbd>/</Kbd>
      </button>
      <ul className="flex flex-col gap-0.5">
        <li>
          <a
            href="#/"
            onClick={onNavigate}
            aria-current={route.name === "home" ? "page" : undefined}
            className={cn(link, route.name === "home" && "bg-sidebar-accent font-medium")}
          >
            <Home className="size-4" aria-hidden="true" />
            {d.nav.home}
          </a>
        </li>
      </ul>
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <p className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{d.nav.projects}</p>
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {projects?.length ? (
            projects.map((project) => {
              const tone = projectTone(project);
              const Icon = TONE_ICON[tone];
              return (
                <li key={project.id}>
                  <a
                    href={projectHref(project.id)}
                    onClick={onNavigate}
                    aria-current={current === project.id ? "page" : undefined}
                    className={cn(link, current === project.id && "bg-sidebar-accent font-medium")}
                  >
                    <Icon className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} aria-hidden="true" />
                    <span className="truncate">{project.title ?? project.id}</span>
                    {project.waiting ? (
                      <span
                        className="ms-auto inline-flex min-w-5 items-center justify-center rounded-full border border-status-waiting/60 px-1.5 text-xs text-foreground tabular-nums"
                        aria-label={p(d.nav.waiting, project.waiting)}
                      >
                        {project.waiting}
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })
          ) : (
            <li className="px-2 text-sm text-muted-foreground">{d.nav.noProjects}</li>
          )}
        </ul>
      </div>
      <ul className="flex flex-col gap-0.5">
        {mode === "snapshot" ? null : (
          <li>
            <a
              href="#/library"
              onClick={onNavigate}
              aria-current={route.name === "library" ? "page" : undefined}
              className={cn(link, route.name === "library" && "bg-sidebar-accent font-medium")}
            >
              <Library className="size-4" aria-hidden="true" />
              {d.library.nav}
            </a>
          </li>
        )}
        {mode === "snapshot" ? null : (
          <li>
            <a
              href="#/metrics"
              onClick={onNavigate}
              aria-current={route.name === "metrics" ? "page" : undefined}
              className={cn(link, route.name === "metrics" && "bg-sidebar-accent font-medium")}
            >
              <BarChart3 className="size-4" aria-hidden="true" />
              {d.nav.metrics}
            </a>
          </li>
        )}
        <li>
          <a
            href="#/settings"
            onClick={onNavigate}
            aria-current={route.name === "settings" ? "page" : undefined}
            className={cn(link, route.name === "settings" && "bg-sidebar-accent font-medium")}
          >
            <Settings className="size-4" aria-hidden="true" />
            {d.nav.settings}
          </a>
        </li>
      </ul>
      <p
        className="flex items-center gap-2 px-2 text-xs text-muted-foreground"
        title={mode === "fixture" ? d.app.fixtureHint : undefined}
      >
        <span aria-hidden="true" className={cn("size-2 rounded-full", TONE_BG[connectionTone])} />
        <span className="sr-only">{d.nav.connection}: </span>
        {connection}
      </p>
      <p className="-mt-2 px-2 text-xs text-muted-foreground">
        © {COPYRIGHT_YEAR}{" "}
        <a href={AUTHOR.url} target="_blank" rel="noreferrer noopener" className={footerLink}>
          {AUTHOR.name}
          <span className="sr-only"> {d.about.newTab}</span>
        </a>
        {" · "}
        <a href={LICENCE_URL} target="_blank" rel="noreferrer noopener" className={footerLink}>
          {LICENCE_ID}
          <span className="sr-only"> {d.about.newTab}</span>
        </a>
        {" · "}
        <a href="#/settings" onClick={onNavigate} className={footerLink}>
          v{APP_VERSION}
          <span className="sr-only">: {d.about.versionLinkSuffix}</span>
        </a>
      </p>
    </nav>
  );
}
