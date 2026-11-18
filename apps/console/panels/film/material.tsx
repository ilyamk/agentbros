/**
 * Panels of the steps that gather media (RFC 0004 §5.2): music (shortlist with players), look (styleframes), material
 * (the list with source, licence, cost and the quote) and narration (takes). They show the media of the step's pending
 * decisions and the matching project assets; the quote and the approval go through the generic decision card.
 */
import type { AssetSummary, FilmNarration, MediaRef, ProjectView } from "@contract";
import { Image as ImageIcon, Music, PackageOpen, Mic } from "lucide-react";
import { useI18n } from "@/i18n";
import { formatUsd } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { ToneBadge } from "@/components/status";
import type { PanelProps } from "../registry";
import { MediaSlot } from "@/media";
import { isSoundClaim } from "@/lib/sound-claims";
import { AgentView, Block, Docs, Facts, GroupDecisions, MediaGrid, StepFacts, decisionMedia } from "./shared";
import { FILM_GROUPS, groupDecisions } from "./steps";
import { RateMedia, ratable } from "./feedback";

const ASSET_MEDIA_KIND = { image: "image", video: "video", audio: "audio" } as const;

/** An asset as a media reference, when the console can show it. */
function assetMedia(asset: AssetSummary): MediaRef | undefined {
  if (asset.thumbnail) return asset.thumbnail;
  const kind = ASSET_MEDIA_KIND[asset.kind as keyof typeof ASSET_MEDIA_KIND];
  return kind ? { path: asset.path, kind, label: asset.id } : undefined;
}

const under = (asset: AssetSummary, ...prefixes: string[]) =>
  prefixes.some((prefix) => asset.path.startsWith(prefix) || asset.path.includes(`/${prefix}`));

/** Decision media first, then the assets that match, without repeats. */
function merged(first: MediaRef[], assets: AssetSummary[]): MediaRef[] {
  const seen = new Set(first.map((media) => media.path));
  const rest = assets
    .map(assetMedia)
    .filter((media): media is MediaRef => media !== undefined && !seen.has(media.path));
  return [...first, ...rest];
}

export function musicTracks(view: ProjectView): MediaRef[] {
  return merged(
    decisionMedia(view, "music", ["audio"]),
    view.assets.filter((asset) => asset.kind === "audio" && under(asset, "music/")),
  );
}

/** Decision media first, then the given media, without repeats. */
function withFirst(first: MediaRef[], rest: readonly MediaRef[]): MediaRef[] {
  const seen = new Set(first.map((media) => media.path));
  return [...first, ...rest.filter((media) => !seen.has(media.path))];
}

export function styleframes(view: ProjectView): MediaRef[] {
  return merged(
    withFirst(
      decisionMedia(view, "look", ["image", "video", "strip"]),
      (view.film?.look?.styleframes ?? []).map((frame) => frame.media),
    ),
    view.assets.filter((asset) => asset.kind === "image" && under(asset, "styleframes/", "look/")),
  );
}

export function narrationTakes(view: ProjectView): MediaRef[] {
  return merged(
    withFirst(
      decisionMedia(view, "narration", ["audio"]),
      (view.film?.narration?.takes ?? []).map((take) => take.media),
    ),
    view.assets.filter((asset) => asset.kind === "audio" && under(asset, "voiceover/", "narration/")),
  );
}

export function MusicPanel({ view }: PanelProps) {
  const { d } = useI18n();
  const tracks = musicTracks(view);
  return (
    <div className="flex flex-col gap-4">
      <StepFacts view={view} group="music" />
      <p className="text-xs text-muted-foreground">{d.film.music.listen}</p>
      {tracks.length ? (
        <Block title={d.film.music.shortlist}>
          <MediaGrid project={view.project.id} media={tracks} variant="inline" label={d.film.music.shortlist} />
        </Block>
      ) : groupDecisions(view, "music").length ? null : (
        <EmptyState compact icon={<Music />} title={d.film.music.empty} />
      )}
      <GroupDecisions view={view} group="music" />
    </div>
  );
}

export function LookPanel({ view }: PanelProps) {
  const { d, f } = useI18n();
  const frames = styleframes(view);
  const look = view.film?.look;
  const rating = new Map((look?.styleframes ?? []).map((frame) => [frame.media.path, frame.rating]));
  return (
    <div className="flex flex-col gap-4">
      <StepFacts view={view} group="look" />
      {frames.length ? (
        <Block title={d.film.look.styleframes}>
          <ul
            aria-label={d.film.look.styleframes}
            className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2"
          >
            {frames.map((media) => {
              const score = rating.get(media.path);
              return (
                <li
                  key={`${media.root ?? "project"}:${media.path}`}
                  data-styleframe={media.path}
                  className="flex min-w-0 flex-col gap-1"
                >
                  <MediaSlot project={view.project.id} media={media} variant="thumb" />
                  {ratable(media) ? (
                    <RateMedia project={view.project.id} media={media} current={score} step="look" />
                  ) : (
                    <span className={score !== undefined ? "text-xs font-medium" : "text-xs text-muted-foreground"}>
                      {score !== undefined ? f(d.film.look.rating, { score }) : d.film.look.notRated}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </Block>
      ) : (
        <EmptyState compact icon={<ImageIcon />} title={d.film.look.empty} />
      )}
      <Docs project={view.project.id} docs={look?.design ? [look.design] : undefined} />
      <GroupDecisions view={view} group="look" />
    </div>
  );
}

/** Caption words of one take, emphasised words in bold (the caption editor's own marks). */
function TakeWords({ words }: { words: FilmNarration["words"] }) {
  if (!words.length) return null;
  return (
    <p className="text-sm break-words" data-words="">
      {words.map((word, index) => (
        <span key={index}>
          {index ? " " : ""}
          {word.emphasis ? <strong>{word.text}</strong> : word.text}
        </span>
      ))}
    </p>
  );
}

export function NarrationPanel({ view }: PanelProps) {
  const { d, f } = useI18n();
  const t = d.film.narration;
  const narration = view.film?.narration;
  const takes = narrationTakes(view);
  const takeOf = new Map((narration?.takes ?? []).map((take) => [take.media.path, take]));
  // Agents cannot hear (§2.2): an agent line claiming the voice sounds good is not shown.
  const voiceWhy = narration?.voiceWhy && !isSoundClaim(narration.voiceWhy) ? narration.voiceWhy : undefined;
  const pacingNote = narration?.pacingNote && !isSoundClaim(narration.pacingNote) ? narration.pacingNote : undefined;
  return (
    <div className="flex flex-col gap-4">
      <StepFacts view={view} group="narration" />
      {narration ? (
        <Facts
          label={t.direction}
          rows={[
            ...(narration.route ? ([[t.route, t.routes[narration.route]]] as [string, string][]) : []),
            ...(narration.modelId ? ([[t.model, narration.modelId]] as [string, string][]) : []),
            ...(narration.take ? ([[t.takes, f(t.take, { take: narration.take })]] as [string, string][]) : []),
            ...(narration.totalSec !== undefined
              ? ([[d.film.beats.length, f(t.totalSec, { sec: narration.totalSec })]] as [string, string][])
              : []),
          ]}
        />
      ) : null}
      {voiceWhy || pacingNote ? (
        <AgentView>
          {voiceWhy ? (
            <p className="break-words">
              <span className="text-muted-foreground">{t.voiceWhy}: </span>
              {voiceWhy}
            </p>
          ) : null}
          {pacingNote ? (
            <p className="break-words">
              <span className="text-muted-foreground">{t.pacing}: </span>
              {pacingNote}
            </p>
          ) : null}
        </AgentView>
      ) : null}
      {narration?.direction.length ? (
        <Block title={t.direction}>
          <ol className="flex flex-col gap-1.5 text-sm" data-direction="">
            {narration.direction.map((beat) => (
              <li key={beat.beatId} className="rounded-md bg-muted/60 px-2 py-1.5 break-words">
                <span className="me-2 font-mono text-xs text-muted-foreground">{beat.beatId}</span>
                {beat.text}
                {beat.emphasis.length ? (
                  <span className="block text-xs text-muted-foreground">{beat.emphasis.join(", ")}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </Block>
      ) : null}
      {takes.length ? (
        <Block title={t.takes}>
          <ul aria-label={t.takes} className="grid gap-3 md:grid-cols-2">
            {takes.map((media) => {
              const take = takeOf.get(media.path);
              const words = take ? (narration?.words ?? []).filter((word) => word.beatId === take.beatId) : [];
              return (
                <li
                  key={`${media.root ?? "project"}:${media.path}`}
                  data-take={media.path}
                  className="flex min-w-0 flex-col gap-1.5"
                >
                  <MediaSlot
                    project={view.project.id}
                    media={media}
                    variant="inline"
                    cues={words
                      .filter((word) => word.emphasis)
                      .map((word) => ({ t: word.start, label: word.text, strong: true }))}
                  />
                  <TakeWords words={words} />
                </li>
              );
            })}
          </ul>
          {narration?.words.some((word) => word.emphasis) ? (
            <p className="text-xs text-muted-foreground">{t.emphasised}</p>
          ) : null}
        </Block>
      ) : (
        <EmptyState compact icon={<Mic />} title={t.empty} />
      )}
      <GroupDecisions view={view} group="narration" />
    </div>
  );
}

/** The project's material: generated, stock and imported assets (not the project's own renders). */
export function materialItems(view: ProjectView): AssetSummary[] {
  return view.assets;
}

export function MaterialPanel({ view }: PanelProps) {
  const { d, locale } = useI18n();
  const t = d.film.material;
  const items = materialItems(view);
  const steps: readonly string[] = FILM_GROUPS.material;
  const jobs = view.money.jobs.filter((job) => job.step !== undefined && steps.includes(job.step));
  return (
    <div className="flex flex-col gap-4">
      <StepFacts view={view} group="material" />
      {items.length ? (
        <div
          tabIndex={0}
          role="region"
          aria-label={d.film.titles.material}
          className="overflow-x-auto rounded-lg border focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">{d.film.titles.material}</caption>
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">
                  {d.assets.columns.asset}
                </th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">
                  {t.source}
                </th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">
                  {t.licence}
                </th>
                <th scope="col" className="px-2 py-1.5 text-end font-medium">
                  {t.cost}
                </th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">
                  {t.usedIn}
                </th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">
                  {t.state}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((asset) => (
                <tr key={asset.id} data-asset={asset.id}>
                  <th scope="row" className="px-2 py-1.5 text-start font-medium break-all">
                    {asset.id}
                    <span className="block text-xs font-normal text-muted-foreground">{asset.path}</span>
                  </th>
                  <td className="px-2 py-1.5">{[asset.origin, asset.provider].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="px-2 py-1.5">
                    {asset.licence?.name ?? asset.licence?.id ?? (
                      <span className="text-status-waiting">{t.noLicence}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-end tabular-nums">
                    {asset.costUsd !== undefined ? formatUsd(asset.costUsd, locale) : t.unknownCost}
                  </td>
                  <td className="px-2 py-1.5 break-words">{asset.usedIn.join(", ") || "—"}</td>
                  <td className="px-2 py-1.5">
                    {asset.approved === undefined ? (
                      "—"
                    ) : (
                      <ToneBadge tone={asset.approved ? "done" : "waiting"}>
                        {asset.approved ? t.approved : t.notApproved}
                      </ToneBadge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState compact icon={<PackageOpen />} title={t.empty} />
      )}
      {jobs.length ? (
        <Block title={t.jobs}>
          <ul className="flex flex-col gap-1 text-sm">
            {jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap gap-2">
                <span className="font-medium">{job.provider}</span>
                {job.endpoint ? <span className="text-muted-foreground">{job.endpoint}</span> : null}
                <span>
                  {d.money.columns.state}: {job.state}
                </span>
                <span className="tabular-nums">
                  {job.costUsd !== undefined
                    ? formatUsd(job.costUsd, locale)
                    : job.priceKnown
                      ? "—"
                      : d.money.priceUnknown}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
      <GroupDecisions view={view} group="material" />
    </div>
  );
}
