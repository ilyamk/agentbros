/**
 * Agent activity cards. Adapted from affectUI `tool-call-card` (`ToolCallCard`, `ToolCallGroup`; MIT, Copyright (c)
 * 2026 Florian Höller (adfects); github.com/flohoeller/affectui @ e610c3b): a header button with an icon tile, a mono
 * name, a summary and the status (spinner and live time, check and duration, or failed), expanding to details; the group
 * folds several cards into one line ("3 runs · 6 min") with a stacked icon row and failure count, announced politely.
 * Rewritten on the console tokens with Tailwind (no injected <style>); details are a definition list rather than JSON;
 * timing comes from the caller (the journal), and strings from i18n.
 */
import { useId, useState, type ReactNode } from "react";
import { Bot, Check, ChevronDown, CircleX } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToolCallStatus = "running" | "success" | "error";

export interface ToolCallCardProps {
  name: string;
  summary?: ReactNode;
  icon?: ReactNode;
  status: ToolCallStatus;
  /** Status text next to the icon: a formatted duration, or "Failed". */
  statusLabel?: string;
  details?: { label: string; value: ReactNode }[];
  defaultOpen?: boolean;
  className?: string;
}

function StatusMark({ status }: { status: ToolCallStatus }) {
  if (status === "success") return <Check className="size-4 text-status-done" aria-hidden="true" />;
  if (status === "error") return <CircleX className="size-4 text-status-blocked" aria-hidden="true" />;
  return <span aria-hidden="true" className="size-2.5 rounded-full bg-status-current ring-4 ring-status-current/25" />;
}

export function ToolCallCard({
  name,
  summary,
  icon,
  status,
  statusLabel,
  details,
  defaultOpen = false,
  className,
}: ToolCallCardProps) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const hasDetails = !!details?.length;
  return (
    <div data-status={status} className={cn("rounded-lg border bg-card text-card-foreground", className)}>
      <button
        type="button"
        aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? `${id}-body` : undefined}
        disabled={!hasDetails}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4"
        >
          {icon ?? <Bot />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <code className="truncate font-mono text-sm">{name}</code>
          {summary ? <span className="truncate text-xs text-muted-foreground">{summary}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <StatusMark status={status} />
          {statusLabel}
        </span>
        {hasDetails ? (
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        ) : null}
      </button>
      {hasDetails && open ? (
        <dl id={`${id}-body`} className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 border-t px-3 py-2 text-xs">
          {details!.map((detail) => (
            <div key={detail.label} className="contents">
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export interface ToolCallGroupProps {
  title: string;
  /** Summary after the title: "3 runs · 6 min". */
  summary: string;
  /** Statuses of the cards inside, for the header's running/failed state. */
  statuses: ToolCallStatus[];
  failedLabel?: string;
  icons?: ReactNode[];
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

export function ToolCallGroup({
  title,
  summary,
  statuses,
  failedLabel,
  icons = [],
  children,
  defaultOpen = false,
  className,
}: ToolCallGroupProps) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const running = statuses.includes("running");
  return (
    <div data-running={running || undefined} className={cn("rounded-lg border bg-muted/30", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span aria-hidden="true" className="flex -space-x-2">
          {(icons.length ? icons.slice(-3) : [<Bot key="bot" />]).map((icon, index) => (
            <span
              key={index}
              className="flex size-6 items-center justify-center rounded-md border bg-card text-muted-foreground [&_svg]:size-3.5"
            >
              {icon}
            </span>
          ))}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">{summary}</span>
          {failedLabel ? <span className="text-xs font-medium text-status-blocked">{failedLabel}</span> : null}
        </span>
        {running ? <span aria-hidden="true" className="size-2 rounded-full bg-status-current" /> : null}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div id={`${id}-list`} className="flex flex-col gap-2 px-3 pb-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}
