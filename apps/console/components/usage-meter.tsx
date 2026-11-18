/**
 * Usage meter (budget). Adapted from uiarc (Arc UI) free `usage-meter` (MIT, Copyright (c) 2026 Elia Kuratli;
 * github.com/kuratlielia/arc-library @ 8302b52): one bar of segments in display order against a limit, a "free" (or
 * overage) remainder, a near/over status mark with an icon and a legend whose items highlight their segment on hover or
 * focus. Rewritten on the console tokens with Tailwind and CSS transitions (no `motion` springs or rolling digits);
 * values are formatted by the caller (money, locale) and the strings come from the i18n dictionaries.
 */
import { useId, useState } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export interface UsageMeterSegment {
  id: string;
  label: string;
  value: number;
  /** CSS colour; defaults to the chart palette in order. */
  color?: string;
}

export interface UsageMeterProps {
  label: string;
  segments: UsageMeterSegment[];
  /** The limit (ceiling); without one the bar is scaled to the total and shows no remainder. */
  limit?: number;
  format: (value: number) => string;
  freeLabel: string;
  overLabel: string;
  nearLabel: string;
  /** Share of the limit at which the meter warns. */
  warnAt?: number;
  className?: string;
}

const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function UsageMeter({
  label,
  segments,
  limit,
  format,
  freeLabel,
  overLabel,
  nearLabel,
  warnAt = 0.9,
  className,
}: UsageMeterProps) {
  const id = useId();
  const [active, setActive] = useState<string | null>(null);
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const scale = Math.max(total, limit ?? 0) || 1;
  const status = limit === undefined ? "ok" : total > limit ? "over" : total >= limit * warnAt ? "near" : "ok";
  const remainder = limit === undefined ? undefined : status === "over" ? total - limit : limit - total;
  const items = segments.map((segment, index) => ({
    ...segment,
    color: segment.color ?? PALETTE[index % PALETTE.length]!,
  }));
  const Icon = status === "over" ? TriangleAlert : CircleAlert;

  return (
    <section aria-labelledby={`${id}-label`} className={cn("flex flex-col gap-3", className)} data-status={status}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${id}-label`} className="text-sm font-medium">
          {label}
        </h3>
        <p className="text-sm text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{format(total)}</span>
          {limit !== undefined ? ` / ${format(limit)}` : null}
        </p>
      </div>
      <div
        role="meter"
        aria-labelledby={`${id}-label`}
        aria-valuemin={0}
        aria-valuemax={limit ?? total}
        aria-valuenow={total}
        aria-valuetext={limit !== undefined ? `${format(total)} / ${format(limit)}` : format(total)}
        className="relative flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
      >
        {items.map((segment) => (
          <span
            key={segment.id}
            data-active={active === segment.id || undefined}
            className="h-full transition-[width,opacity] duration-200 first:rounded-s-full data-[active]:opacity-100"
            style={{
              width: `${(Math.max(0, segment.value) / scale) * 100}%`,
              background: segment.color,
              opacity: active && active !== segment.id ? 0.35 : 1,
            }}
          />
        ))}
        {limit !== undefined && status === "over" ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 bg-foreground"
            style={{ left: `${(limit / scale) * 100}%` }}
          />
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {items.map((segment) => (
          <li key={segment.id}>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              aria-pressed={active === segment.id}
              onPointerEnter={() => setActive(segment.id)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(segment.id)}
              onBlur={() => setActive(null)}
            >
              <span aria-hidden="true" className="size-2.5 rounded-[2px]" style={{ background: segment.color }} />
              <span>{segment.label}</span>
              <span className="text-foreground tabular-nums">{format(segment.value)}</span>
            </button>
          </li>
        ))}
        {remainder !== undefined ? (
          <li className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden="true" className="size-2.5 rounded-[2px] border border-dashed border-muted-foreground" />
            <span>{status === "over" ? overLabel : freeLabel}</span>
            <span className="text-foreground tabular-nums">{format(remainder)}</span>
          </li>
        ) : null}
      </ul>
      {status !== "ok" ? (
        <p
          role="status"
          className={cn(
            "flex items-center gap-1.5 text-xs font-medium",
            status === "over" ? "text-status-blocked" : "text-status-waiting",
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
          {status === "over" ? overLabel : nearLabel}
        </p>
      ) : null}
    </section>
  );
}
