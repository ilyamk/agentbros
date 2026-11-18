/**
 * Event feed timeline. Adapted from uiarc (Arc UI) free `timeline` (MIT, Copyright (c) 2026 Elia Kuratli;
 * github.com/kuratlielia/arc-library @ 8302b52): newest first, grouped by day under headings, actor then title, a meta
 * line, a tone that never rests on colour alone, and rows with detail that expand in place. Rewritten on the console
 * tokens with Tailwind; no `motion` reveal or scroll-to-new; the clock (`now`) and locale come from the console.
 */
import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format";

export interface TimelineEvent {
  id: string;
  /** ISO time or epoch ms. */
  at: string | number;
  actor?: string;
  title: string;
  meta?: string;
  detail?: ReactNode;
  icon?: ReactNode;
  tone?: "neutral" | "success" | "danger";
}

export interface TimelineProps {
  events: TimelineEvent[];
  now: number;
  /** Accessible name of the feed. */
  label: string;
  locale: string;
  timeZone?: string;
  headingLevel?: 3 | 4;
  className?: string;
}

const TONE_RING = {
  neutral: "border-border text-muted-foreground",
  success: "border-status-done/60 text-status-done",
  danger: "border-status-blocked/60 text-status-blocked",
} as const;

function dayKey(at: number, timeZone: string | undefined) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function Timeline({ events, now, label, locale, timeZone, headingLevel = 3, className }: TimelineProps) {
  const id = useId();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const sorted = [...events]
    .map((event) => ({ ...event, time: typeof event.at === "number" ? event.at : Date.parse(event.at) }))
    .sort((a, b) => b.time - a.time);
  const groups: { key: string; label: string; items: typeof sorted }[] = [];
  for (const event of sorted) {
    const key = dayKey(event.time, timeZone);
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = {
        key,
        label: new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "long" }).format(
          event.time,
        ),
        items: [],
      };
      groups.push(group);
    }
    group.items.push(event);
  }
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit" });

  return (
    <div role="group" aria-label={label} className={cn("flex flex-col gap-4", className)}>
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`${id}-${group.key}`} className="flex flex-col gap-1">
          <Heading
            id={`${id}-${group.key}`}
            className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            {group.label}
          </Heading>
          <ol className="relative flex flex-col">
            {group.items.map((event, index) => {
              const expanded = open.has(event.id);
              const toggle = () =>
                setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(event.id)) next.delete(event.id);
                  else next.add(event.id);
                  return next;
                });
              const body = (
                <>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-card [&_svg]:size-3.5",
                      TONE_RING[event.tone ?? "neutral"],
                    )}
                  >
                    {event.icon}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col text-start">
                    <span className="text-sm break-words">
                      {event.actor ? <span className="font-medium">{event.actor} </span> : null}
                      <span className="text-foreground/90">{event.title}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <time
                        dateTime={new Date(event.time).toISOString()}
                        title={formatRelative(event.time, now, locale)}
                      >
                        {clock.format(event.time)}
                      </time>
                      {event.meta ? ` · ${event.meta}` : null}
                    </span>
                  </span>
                  {event.detail ? (
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        "mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150",
                        expanded && "rotate-90",
                      )}
                    />
                  ) : null}
                </>
              );
              return (
                <li key={event.id} className="relative">
                  {index < group.items.length - 1 ? (
                    <span aria-hidden="true" className="absolute top-7 bottom-0 left-3 w-px bg-border" />
                  ) : null}
                  {event.detail ? (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={`${id}-${event.id}`}
                      onClick={toggle}
                      className="flex w-full gap-3 rounded-md py-1.5 text-start transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex gap-3 py-1.5">{body}</div>
                  )}
                  {event.detail && expanded ? (
                    <div id={`${id}-${event.id}`} className="ms-9 mb-2 rounded-md bg-muted/60 p-2 text-xs">
                      {event.detail}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
