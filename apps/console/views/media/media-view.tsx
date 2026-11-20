/**
 * The project's Media tab (2026-11-20): every media file the project works with and makes, in albums by lineage
 * (sources, preparation, generations, builds, not registered), each with its player and, where the lineage says so, the
 * file it was made from and an A/B compare. The Generations album holds the paid jobs (`view.generations.jobs`) with
 * their state, error, money, prompt and result; the Preparation album the latest model preparation. Read-only: it shows
 * `view.gallery` and `view.generations`, which the server rebuilds from the project's files as they change.
 */
import { useState } from "react";
import type { MediaAlbum, MediaItem, ProjectView } from "@contract";
import { MEDIA_ALBUMS } from "@contract";
import { Images } from "lucide-react";
import { useI18n } from "@/i18n";
import { formatTime } from "@/lib/format";
import { MediaSlot } from "@/media";
import { EmptyState } from "@/components/empty-state";
import { ToneBadge } from "@/components/status";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GenerationCard, PreparationCard } from "@/panels/generic/generations";
import { CompareButton } from "./compare-button";

const comparable = (a: MediaItem["media"], b: MediaItem["media"]) =>
  (a.kind === "video" || a.kind === "image") && a.kind === b.kind;

export function albumCounts(view: ProjectView): Record<MediaAlbum, number> {
  const counts = Object.fromEntries(MEDIA_ALBUMS.map((album) => [album, 0])) as Record<MediaAlbum, number>;
  for (const item of view.gallery?.items ?? []) counts[item.album] += 1;
  counts.generations += view.generations?.jobs.length ?? 0;
  if (view.generations?.preparation) counts.preparation += 1;
  return counts;
}

function MediaItemCard({ item, project }: { item: MediaItem; project: string }) {
  const { d, f, locale } = useI18n();
  const playable = item.media.kind === "video" || item.media.kind === "audio";
  return (
    <li>
      <Card
        role="article"
        aria-label={item.media.label ?? item.media.path}
        data-media-item={item.id}
        data-album={item.album}
        className="h-full min-w-0 gap-3 text-sm"
      >
        <CardContent className="flex min-w-0 flex-col gap-2">
          <MediaSlot project={project} media={item.media} variant={playable ? "inline" : "thumb"} />
          {/* The slot's caption names the file; the card adds what the lineage knows. */}
          {item.registered ? null : (
            <ToneBadge tone="stale" className="self-start">
              {d.mediaTab.notRegistered}
            </ToneBadge>
          )}
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {item.createdAt ? <span>{formatTime(item.createdAt, locale, true)}</span> : null}
            {[item.origin, item.tool].filter(Boolean).length ? (
              <span>{[item.origin, item.tool].filter(Boolean).join(" · ")}</span>
            ) : null}
            {item.generation ? (
              <span className="break-all">{f(d.mediaTab.ofJob, { job: item.generation })}</span>
            ) : null}
            {item.preparation ? <span>{f(d.generations.preparationOf, { id: item.preparation })}</span> : null}
            <code className="font-mono break-all">{item.media.path}</code>
          </p>
          {item.aliases?.length ? (
            <p className="text-xs break-all text-muted-foreground">
              {f(d.mediaTab.alsoAt, { paths: item.aliases.join(", ") })}
            </p>
          ) : null}
          {item.parent ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="break-all">{f(d.mediaTab.from, { label: item.parent.label ?? item.parent.path })}</span>
              {comparable(item.media, item.parent) ? (
                <CompareButton project={project} item={item.media} source={item.parent} />
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </li>
  );
}

function Album({ album, view }: { album: MediaAlbum; view: ProjectView }) {
  const { d } = useI18n();
  const project = view.project.id;
  const items = (view.gallery?.items ?? []).filter((item) => item.album === album);
  const jobs = album === "generations" ? (view.generations?.jobs ?? []) : [];
  const preparation = album === "preparation" ? view.generations?.preparation : undefined;
  return (
    <section aria-label={d.mediaTab.album[album]} data-media-album={album} className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{d.mediaTab.albumHint[album]}</p>
      {!items.length && !jobs.length && !preparation ? <EmptyState compact title={d.mediaTab.empty} /> : null}
      {jobs.length ? (
        <ul aria-label={d.generations.jobs} className="grid gap-3 xl:grid-cols-2">
          {jobs.map((job) => (
            <GenerationCard key={job.id} job={job} project={project} />
          ))}
        </ul>
      ) : null}
      {preparation ? <PreparationCard preparation={preparation} project={project} /> : null}
      {items.length ? (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <MediaItemCard key={item.id} item={item} project={project} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function MediaView({ view }: { view: ProjectView }) {
  const { d } = useI18n();
  const counts = albumCounts(view);
  const total = MEDIA_ALBUMS.reduce((sum, album) => sum + counts[album], 0);
  const first = counts.generations ? "generations" : (MEDIA_ALBUMS.find((album) => counts[album]) ?? "sources");
  const [album, setAlbum] = useState<string>(first);
  return (
    <section aria-labelledby="media-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="media-heading" className="text-lg font-semibold">
          {d.mediaTab.title}
        </h2>
        <p className="text-sm text-muted-foreground">{d.mediaTab.subtitle}</p>
      </div>
      {total ? (
        <Tabs value={album} onValueChange={setAlbum}>
          <TabsList aria-label={d.mediaTab.albums} className="h-auto flex-wrap">
            {MEDIA_ALBUMS.filter((name) => name !== "unregistered" || counts.unregistered).map((name) => (
              <TabsTrigger key={name} value={name}>
                {d.mediaTab.album[name]}
                <span className="text-xs text-muted-foreground tabular-nums">{counts[name]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          {MEDIA_ALBUMS.map((name) => (
            <TabsContent key={name} value={name}>
              {album === name ? <Album album={name} view={view} /> : null}
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <EmptyState compact icon={<Images />} title={d.mediaTab.emptyAll} description={d.mediaTab.emptyAllHint} />
      )}
      {view.gallery?.truncated ? <p className="text-xs text-muted-foreground">{d.mediaTab.truncated}</p> : null}
    </section>
  );
}
