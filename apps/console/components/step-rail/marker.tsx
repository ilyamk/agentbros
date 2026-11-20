/**
 * The step marker every concept shares: a ring (or rounded square) drawn in SVG whose motion says the status.
 * running: an arc traces the outline like a loader; done: the check draws in; awaiting-gate: a halo pulses; failing:
 * one shake and a solid ring; stale: a dashed ring crawls slowly; skipped: muted; ready/pending: the step number.
 * Animations are `motion-safe:` only; colour always comes with an icon or number (lib/status.ts).
 */
import type { StepStatus } from "@contract";
import { cn } from "@/lib/utils";
import { TONE_ICON, TONE_TEXT } from "@/lib/status";
import { motionTone, stepMotion } from "./model";

export interface StepMarkerProps {
  status: StepStatus;
  isCurrent?: boolean;
  /** 1-based number shown on steps that have not closed. */
  number?: number;
  shape?: "circle" | "square";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE = { sm: "size-6", md: "size-9", lg: "size-11" } as const;

export function StepMarker({
  status,
  isCurrent = false,
  number,
  shape = "circle",
  size = "md",
  className,
}: StepMarkerProps) {
  const motion = stepMotion(status, isCurrent);
  const tone = motionTone(status, isCurrent);
  const Icon = TONE_ICON[tone];
  const outline = (props: { className?: string; dash?: string; pathLength?: number }) =>
    shape === "circle" ? (
      <circle
        cx="18"
        cy="18"
        r="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        pathLength={props.pathLength}
        strokeDasharray={props.dash}
        transform="rotate(-90 18 18)"
        className={props.className}
      />
    ) : (
      <rect
        x="2"
        y="2"
        width="32"
        height="32"
        rx="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        pathLength={props.pathLength}
        strokeDasharray={props.dash}
        className={props.className}
      />
    );
  const radius = shape === "circle" ? "rounded-full" : "rounded-[10px]";
  const label = size === "sm" ? "text-[0.625rem]" : "text-xs";

  return (
    <span
      data-motion={motion}
      data-status={status}
      className={cn(
        "relative inline-grid shrink-0 place-items-center",
        SIZE[size],
        TONE_TEXT[tone],
        motion === "error" && status === "failing" && "motion-safe:animate-rail-shake",
        className,
      )}
    >
      {motion === "pulse" ? (
        <span
          aria-hidden="true"
          data-part="halo"
          className={cn("absolute inset-0 border-2 border-current motion-safe:animate-rail-pulse", radius)}
        />
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-[3px]",
          radius,
          motion === "check" && "bg-status-done/15",
          motion === "orbit" && "bg-status-current/10",
          motion === "pulse" && "bg-status-waiting/15",
          motion === "error" && "bg-status-blocked/12",
          motion === "stale" && "bg-status-stale/10",
          (motion === "ready" || motion === "pending" || motion === "skipped") && "bg-card",
        )}
      />
      <svg viewBox="0 0 36 36" aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
        {motion === "orbit" ? (
          <>
            {outline({ className: "opacity-20" })}
            {outline({ pathLength: 100, dash: "30 70", className: "motion-safe:animate-rail-trace" })}
          </>
        ) : motion === "stale" ? (
          outline({ pathLength: 100, dash: "5 5", className: "motion-safe:animate-rail-crawl" })
        ) : motion === "pending" ? (
          outline({ pathLength: 100, dash: "4 6", className: "text-border" })
        ) : motion === "skipped" ? (
          outline({ className: "opacity-40" })
        ) : (
          outline({})
        )}
        {motion === "check" ? (
          <path
            d={size === "sm" ? "M11 18.5l4.6 4.6L25.5 13" : "M12 18.5l4.2 4.2L24.5 13.8"}
            fill="none"
            stroke="currentColor"
            strokeWidth={size === "sm" ? 3.25 : 2.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={100}
            strokeDasharray="100"
            data-part="check"
            className="motion-safe:animate-rail-draw"
          />
        ) : null}
      </svg>
      {motion === "check" ? null : motion === "orbit" || motion === "ready" || motion === "pending" ? (
        <span
          aria-hidden="true"
          className={cn(
            "relative font-semibold tabular-nums",
            label,
            motion === "pending" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {number ?? <Icon className="size-3.5" />}
        </span>
      ) : (
        <Icon aria-hidden="true" className={cn("relative", size === "sm" ? "size-3" : "size-4")} />
      )}
    </span>
  );
}
