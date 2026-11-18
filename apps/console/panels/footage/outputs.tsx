/**
 * Footage panels for what the recut becomes: shorts candidates with their scores, the camera angles per segment, the
 * vertical (and other) reframe paths, and the renders per format. Renders live under the recut project
 * (`out/<recut>/`), so their media slots use that project's id, never the source project's.
 */
import type { FootageMaterial } from "@contract";
import { CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { MediaSlot } from "@/media";
import type { PanelProps } from "../registry";
import { Block, Facts } from "../film/shared";
import { FootageStepHeader, NothingYet } from "./shared";
import { material, secClock } from "./steps";
import { Disclosure } from "@/components/ui/disclosure";

type Short = NonNullable<FootageMaterial["shorts"]>["items"][number];
const AXIS_ORDER = ["hook", "standalone", "emotion", "payoff", "value", "relevance"] as const;

function ShortCard({ item }: { item: Short }) {
  const { d, f } = useI18n();
  const axes = d.footage.shorts.axes as Record<string, string>;
  const reasons = d.footage.shorts.reason as Record<string, string>;
  const names = [
    ...AXIS_ORDER.filter((axis) => axis in item.axes),
    ...Object.keys(item.axes).filter((axis) => !(AXIS_ORDER as readonly string[]).includes(axis)),
  ];
  return (
    <li data-short={item.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        {item.rank ? (
          <span className="font-mono text-xs text-muted-foreground">
            {f(d.footage.shorts.rank, { rank: item.rank })}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 font-medium break-words">{item.title}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold tabular-nums">
          {f(d.footage.shorts.score, { score: Math.round(item.score) })}
        </span>
      </div>
      <span className="font-mono text-xs text-muted-foreground">
        {f(d.footage.shorts.span, {
          start: secClock(item.startSec),
          end: secClock(item.endSec),
          duration: secClock(item.endSec - item.startSec),
        })}
        {item.reason ? ` · ${reasons[item.reason] ?? item.reason}` : ""}
      </span>
      {item.text ? <p className="line-clamp-3 break-words text-muted-foreground">{item.text}</p> : null}
      {names.length ? (
        <dl className="grid grid-cols-[max-content_1fr_2ch] items-center gap-x-2 gap-y-0.5 text-xs">
          {names.map((axis) => (
            <div key={axis} className="contents">
              <dt className="text-muted-foreground">{axes[axis] ?? axis}</dt>
              <dd className="h-1.5 overflow-hidden rounded-full bg-muted">
                <span
                  aria-hidden="true"
                  className="block h-full rounded-full bg-chart-1"
                  style={{ width: `${(item.axes[axis]! / 10) * 100}%` }}
                />
              </dd>
              <dd className="text-end tabular-nums">{item.axes[axis]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {item.warnings.length ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {item.warnings.map((warning, index) => (
            <li key={index} className="flex items-start gap-1 break-words">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-status-stale" />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ShortsPanel({ view }: PanelProps) {
  const { d, f, p } = useI18n();
  const shorts = material(view).shorts;
  const proposed = shorts?.items.filter((item) => item.proposed) ?? [];
  const others = shorts?.items.filter((item) => !item.proposed) ?? [];
  const grid = "grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2";
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FootageStepHeader view={view} group="shorts" />
      {!shorts ? (
        <NothingYet />
      ) : (
        <>
          {!shorts.fresh && shorts.items.length ? (
            <p role="note" className="text-sm text-status-stale">
              {d.footage.shorts.stale}
            </p>
          ) : null}
          {shorts.threshold !== undefined ? (
            <p className="text-xs text-muted-foreground">
              {f(d.footage.shorts.threshold, { threshold: shorts.threshold })}
            </p>
          ) : null}
          {proposed.length ? (
            <Block title={d.footage.shorts.proposed}>
              <ul className={grid}>
                {proposed.map((item) => (
                  <ShortCard key={item.id} item={item} />
                ))}
              </ul>
            </Block>
          ) : null}
          {others.length ? (
            <Disclosure variant="card" summary={`${d.footage.shorts.others} · ${others.length}`}>
              <ul className={grid}>
                {others.map((item) => (
                  <ShortCard key={item.id} item={item} />
                ))}
              </ul>
            </Disclosure>
          ) : null}
          {!shorts.items.length && !shorts.series ? (
            <p className="text-sm text-muted-foreground">{d.footage.shorts.empty}</p>
          ) : null}
          {shorts.series ? (
            <Block title={d.footage.shorts.series}>
              <p className="text-sm">{p(d.footage.shorts.episodes, shorts.series.episodes)}</p>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
                {shorts.series.created.map((episode) => (
                  <li key={episode.project} className="flex min-w-0 flex-col gap-1 text-xs">
                    {episode.media ? (
                      <MediaSlot project={episode.project} media={episode.media} variant="thumb" />
                    ) : null}
                    <span className="truncate font-mono">{episode.project}</span>
                    <span className="text-muted-foreground">
                      {episode.rendered ? d.footage.shorts.rendered : d.footage.shorts.notRendered}
                    </span>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
        </>
      )}
    </div>
  );
}

const ANGLE_COLOURS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

export function CamerasPanel({ view }: PanelProps) {
  const { d, f } = useI18n();
  const cameras = material(view).cameras;
  const end = Math.max(0, ...(cameras?.segments.map((segment) => segment.endSec) ?? [0]));
  const colour = (angle: string) =>
    ANGLE_COLOURS[Math.max(0, cameras?.angles.indexOf(angle) ?? 0) % ANGLE_COLOURS.length]!;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FootageStepHeader view={view} group="cameras" />
      {!cameras ? (
        <NothingYet />
      ) : (
        <>
          <Facts
            rows={[
              [d.footage.cameras.synced, cameras.synced ? d.footage.transcript.yes : d.footage.cameras.notSynced],
              ...(cameras.method ? ([[d.footage.cameras.method, cameras.method]] as [string, string][]) : []),
            ]}
          />
          {cameras.angles.length ? (
            <Block title={d.footage.cameras.angles}>
              <ul className="flex flex-wrap gap-2 text-sm">
                {cameras.angles.map((angle) => (
                  <li key={angle} className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1">
                    <span aria-hidden="true" className={cn("size-2.5 rounded-sm", colour(angle))} />
                    {angle}
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
          {cameras.segments.length && end > 0 ? (
            <Block title={d.footage.cameras.timeline}>
              <div
                role="list"
                aria-label={d.footage.cameras.timeline}
                className="relative h-6 overflow-hidden rounded-md bg-muted"
              >
                {cameras.segments.map((segment, index) => {
                  const label = f(d.footage.cameras.segment, {
                    angle: segment.angle,
                    start: secClock(segment.startSec),
                    end: secClock(segment.endSec),
                    reason: segment.reason,
                  });
                  return (
                    <span
                      key={index}
                      role="listitem"
                      aria-label={label}
                      title={label}
                      className={cn("absolute inset-y-0", colour(segment.angle))}
                      style={{
                        left: `${(segment.startSec / end) * 100}%`,
                        width: `${Math.max(0.3, ((segment.endSec - segment.startSec) / end) * 100)}%`,
                      }}
                    />
                  );
                })}
              </div>
            </Block>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The crop path as a small line chart: x (0 left, 1 right) over the clip's frames. */
function PathChart({ points, label }: { points: { frame: number; x: number }[]; label: string }) {
  if (points.length < 2) return null;
  const first = points[0]!.frame;
  const span = Math.max(1, points.at(-1)!.frame - first);
  const line = points.map((point) => `${((point.frame - first) / span) * 100},${(1 - point.x) * 30}`).join(" ");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className="h-10 w-full rounded-md bg-muted"
    >
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        className="text-chart-1"
      />
    </svg>
  );
}

export function ReframePanel({ view }: PanelProps) {
  const { d, f, p } = useI18n();
  const reframe = material(view).reframe;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FootageStepHeader view={view} group="reframe" />
      {!reframe ? (
        <NothingYet />
      ) : (
        <ul className="flex flex-col gap-3">
          {reframe.formats.map((row) => (
            <li
              key={row.format}
              data-reframe={row.format}
              className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {f(d.footage.reframe.format, { format: d.footage.formats[row.format] })}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-xs",
                    row.reframed ? "[&>svg]:text-status-done" : "[&>svg]:text-status-waiting",
                  )}
                >
                  {row.reframed ? (
                    <CircleCheck aria-hidden="true" className="size-3.5" />
                  ) : (
                    <CircleDashed aria-hidden="true" className="size-3.5" />
                  )}
                  {row.reframed ? d.footage.reframe.reframed : d.footage.reframe.notReframed}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {[
                  row.fixed ? p(d.footage.reframe.fixed, row.fixed) : "",
                  row.tracked ? p(d.footage.reframe.tracked, row.tracked) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <PathChart points={row.points} label={d.footage.reframe.path} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RenderPanel({ view }: PanelProps) {
  const { d, f } = useI18n();
  const { renders, recut } = material(view);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FootageStepHeader view={view} group="render" />
      {recut ? (
        <p className="text-xs text-muted-foreground">
          {f(d.footage.render.recut, { project: recut.project, revision: recut.revision })}
          {recut.chapters ? ` · ${d.footage.render.chapters}` : ""}
        </p>
      ) : null}
      {renders?.length ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {renders.map((render) => {
            const name = render.name.endsWith("-clean")
              ? f(d.footage.render.clean, { format: d.footage.formats[render.format] })
              : d.footage.formats[render.format];
            return (
              <li key={render.name} data-render={render.name} className="flex min-w-0 flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {name}
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 text-xs font-normal",
                      render.state === "fresh"
                        ? "[&>svg]:text-status-done"
                        : render.state === "stale"
                          ? "[&>svg]:text-status-stale"
                          : "text-muted-foreground",
                    )}
                  >
                    {render.state === "fresh" ? (
                      <CircleCheck aria-hidden="true" className="size-3.5" />
                    ) : render.state === "stale" ? (
                      <TriangleAlert aria-hidden="true" className="size-3.5" />
                    ) : (
                      <CircleDashed aria-hidden="true" className="size-3.5" />
                    )}
                    {d.footage.render.state[render.state]}
                  </span>
                </span>
                {render.media ? <MediaSlot project={render.project} media={render.media} variant="inline" /> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <NothingYet />
      )}
    </div>
  );
}
