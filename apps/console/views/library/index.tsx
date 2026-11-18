/**
 * The motion library page (RFC 0004 WP15, US21; §5.1 sidebar "Library"): the catalogue of `docs/library/catalogue.json`
 * from `GET /api/library`, searchable by title, tag, description and id, filtered by category, each block with its
 * preview still (`/library/preview/<id>`), formats, length, import path, usage and `inspiredBy` credits. Read-only:
 * agents pick blocks with `pnpm library:list`; nothing here writes.
 */
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useState } from "react";
import type { LibraryItem, LibraryResponse } from "@contract";
import { Library, SearchX } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Disclosure } from "@/components/ui/disclosure";

type Load =
  | { state: "loading" }
  | { state: "ready"; data: LibraryResponse }
  | { state: "error"; message?: string }
  | { state: "unavailable" };

/** Lower-cased words of an item to search in. */
const haystack = (item: LibraryItem) =>
  [item.id, item.title, item.category, item.description, ...item.tags].join(" ").toLowerCase();

/** Items matching every word of the query, in the chosen category ("" for all). */
export function filterLibrary(items: readonly LibraryItem[], query: string, category: string): LibraryItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (category && item.category !== category) return false;
    if (!words.length) return true;
    const text = haystack(item);
    return words.every((word) => text.includes(word));
  });
}

export const previewUrl = (id: string) => `/library/preview/${encodeURIComponent(id)}`;

export function LibraryPage() {
  const { d, p } = useI18n();
  const client = useConsoleStore().client;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const deferred = useDeferredValue(query);
  const searchId = useId();

  const fetchLibrary = useCallback(() => {
    if (!client.library) {
      setLoad({ state: "unavailable" });
      return () => {};
    }
    const controller = new AbortController();
    setLoad({ state: "loading" });
    client.library(controller.signal).then(
      (data) => setLoad({ state: "ready", data }),
      (error: unknown) => {
        if (!controller.signal.aborted)
          setLoad({ state: "error", message: error instanceof Error ? error.message : undefined });
      },
    );
    return () => controller.abort();
  }, [client]);
  useEffect(() => fetchLibrary(), [fetchLibrary]);

  const items = useMemo(
    () => (load.state === "ready" ? filterLibrary(load.data.items, deferred, category) : []),
    [load, deferred, category],
  );

  return (
    <main id="main" tabIndex={-1} className="flex min-w-0 flex-col gap-4 p-4 outline-none lg:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Library className="size-5" aria-hidden="true" />
          {d.library.title}
        </h1>
        <p className="text-sm text-muted-foreground">{d.library.intro}</p>
      </header>
      {load.state === "loading" ? (
        <div aria-busy="true" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <span className="sr-only">{d.app.loading}</span>
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      ) : load.state === "unavailable" ? (
        <EmptyState icon={<Library />} title={d.library.unavailable} />
      ) : load.state === "error" ? (
        <EmptyState
          icon={<Library />}
          title={d.library.loadFailed}
          description={load.message}
          action={
            <Button variant="outline" onClick={() => fetchLibrary()}>
              {d.library.retry}
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <div className="flex max-w-md flex-col gap-1">
              <Label htmlFor={searchId}>{d.library.search}</Label>
              <Input
                id={searchId}
                type="search"
                value={query}
                placeholder={d.library.searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
                data-search="library"
              />
            </div>
            <div role="group" aria-label={d.library.categories} className="flex flex-wrap gap-1.5">
              {[{ id: "", count: load.data.items.length }, ...load.data.categories].map((entry) => (
                <button
                  key={entry.id || "all"}
                  type="button"
                  aria-pressed={category === entry.id}
                  onClick={() => setCategory(entry.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    category === entry.id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                  )}
                >
                  {entry.id || d.library.all} <span className="tabular-nums">{entry.count}</span>
                </button>
              ))}
            </div>
            <p role="status" className="text-sm text-muted-foreground">
              {p(d.library.count, items.length)}
            </p>
          </div>
          {items.length ? (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => (
                <LibraryCard key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <EmptyState
              compact
              icon={<SearchX />}
              title={load.data.items.length ? d.library.noMatch : d.library.empty}
            />
          )}
        </>
      )}
    </main>
  );
}

function LibraryCard({ item }: { item: LibraryItem }) {
  const { d, f } = useI18n();
  const [broken, setBroken] = useState(false);
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card" data-block={item.id}>
      {item.preview && !broken ? (
        <img
          src={previewUrl(item.id)}
          alt={f(d.library.previewOf, { title: item.title })}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
          className="aspect-video w-full bg-muted object-cover"
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center bg-muted text-xs text-muted-foreground">
          {d.library.noPreview}
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="font-semibold break-words">{item.title}</h2>
          <span className="rounded-full border px-2 text-xs text-muted-foreground">{item.category}</span>
        </div>
        <p className="line-clamp-4 text-sm break-words text-muted-foreground">{item.description}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {item.formats.length ? (
            <>
              <dt className="text-muted-foreground">{d.library.formats}</dt>
              <dd>
                {item.formats.join(", ")}
                {item.durationInFrames ? ` · ${f(d.library.frames, { n: item.durationInFrames })}` : null}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{d.library.importPath}</dt>
          <dd className="font-mono break-all">{item.importPath}</dd>
        </dl>
        {item.tags.length ? (
          <p className="text-xs break-words text-muted-foreground">
            <span className="sr-only">{d.library.tags}: </span>
            {item.tags.slice(0, 12).join(" · ")}
          </p>
        ) : null}
        {item.usage ? (
          <Disclosure size="xs" summary={d.library.usage} contentClassName="mt-1 text-xs">
            <p className="break-words whitespace-pre-wrap">{item.usage}</p>
          </Disclosure>
        ) : null}
        {item.inspiredBy.length ? (
          <Disclosure size="xs" data-credits="" summary={d.library.credits} contentClassName="mt-1 text-xs">
            <ul className="list-disc ps-4">
              {item.inspiredBy.map((credit, index) => (
                <li key={index} className="break-words">
                  {credit}
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </div>
    </li>
  );
}
