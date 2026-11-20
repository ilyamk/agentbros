/**
 * The app bar's GitHub button: the GitHub mark, "GitHub", a star and the repository's star count, linking to the
 * project. The count comes from `GET /api/github` (the server fetches and caches it; the CSP keeps the browser on
 * 'self') and is asked for only once the session is ready; while it loads, or when it is unknown, the button shows the
 * link without a number.
 */
import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsole, useConsoleStore } from "@/store/context";
import { snapshotMode } from "@/lib/snapshot-mode";
import { GITHUB_URL } from "../../../src/lib/console/github-schema";

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function GithubButton() {
  const { d, locale } = useI18n();
  const client = useConsoleStore().client;
  // The server refuses `/api/github` until the session has its token; asking earlier gets a 403 and no count.
  const sessionReady = useConsole((state) => state.session.status === "ready");
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    if (snapshotMode() || !client.github || !sessionReady) return;
    const controller = new AbortController();
    client
      .github(controller.signal)
      .then((repo) => setStars(repo.stars))
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, sessionReady]);

  const count =
    stars === null
      ? undefined
      : new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(stars);
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md border bg-background text-sm font-medium shadow-xs transition-colors duration-150 outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none"
    >
      <span className="flex items-center gap-1.5 px-2.5">
        <GithubMark className="size-4" />
        GitHub
      </span>
      {count === undefined ? null : (
        <span className="flex h-full items-center gap-1 border-s px-2.5 tabular-nums">
          <Star className="size-3.5 fill-current text-amber-500" aria-hidden="true" />
          {count}
          <span className="sr-only"> {d.nav.githubStarsUnit}</span>
        </span>
      )}
      <span className="sr-only">
        {", "}
        {d.nav.githubRepository} {d.about.newTab}
      </span>
    </a>
  );
}
