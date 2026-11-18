/**
 * Metric card. Adapted from uiarc (Arc UI) free `metric-card` (MIT, Copyright (c) 2026 Elia Kuratli;
 * github.com/kuratlielia/arc-library @ 8302b52): label, a large figure, one line of context and an optional change pill
 * whose direction comes from its sign. Rewritten on the console tokens with Tailwind; the value is passed formatted (money
 * and locale are the caller's), and the `motion` number roll is replaced by a 200 ms colour transition.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TrendingDown, TrendingUp } from "lucide-react";
import type { Tone } from "@/lib/status";
import { StatusIcon } from "./status";

export interface MetricCardProps {
  label: string;
  /** Already formatted, e.g. `$3.10`. */
  value: string;
  context?: string;
  /** Signed change, e.g. `+12%`; a leading + or − sets the trend. */
  change?: string;
  /** Status mark next to the value (for example `blocked` when over the ceiling). */
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
}

export function MetricCard({ label, value, context, change, tone, icon, className }: MetricCardProps) {
  const trend = change ? (/^[+]/.test(change) ? "up" : /^[-−]/.test(change) ? "down" : undefined) : undefined;
  return (
    <article
      className={cn("flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-4 text-card-foreground", className)}
    >
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5 truncate [&_svg]:size-4">
          {icon}
          {label}
        </span>
        {change ? (
          <small
            data-trend={trend}
            className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium text-foreground"
          >
            {trend === "up" ? <TrendingUp className="size-3" aria-hidden="true" /> : null}
            {trend === "down" ? <TrendingDown className="size-3" aria-hidden="true" /> : null}
            {change}
          </small>
        ) : null}
      </div>
      <p className="flex items-center gap-2 font-display text-2xl font-semibold tabular-nums transition-colors duration-200">
        {tone ? <StatusIcon tone={tone} /> : null}
        {value}
      </p>
      {context ? <p className="text-xs text-muted-foreground">{context}</p> : null}
    </article>
  );
}
