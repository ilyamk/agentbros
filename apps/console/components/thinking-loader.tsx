/**
 * "Agent is working" indicator. Adapted from affectUI `thinking-loader` (MIT, Copyright (c) 2026 Florian Höller
 * (adfects); github.com/flohoeller/affectui @ e610c3b): a pill with a spinner of eight rays, a label and the elapsed
 * time, which settles on a check when done, announced politely. Rewritten on the console tokens with Tailwind (no
 * injected <style>); the rays are static (no rotation or label sweep: the console uses transitions only) and the phase
 * timer is replaced by the caller's label and elapsed time.
 */
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const RAYS = Array.from({ length: 8 }, (_, index) => index);

export interface ThinkingLoaderProps {
  label: string;
  /** Elapsed time, already formatted. */
  elapsed?: string;
  done?: boolean;
  className?: string;
}

export function ThinkingLoader({ label, elapsed, done = false, className }: ThinkingLoaderProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      data-done={done || undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm shadow-xs",
        className,
      )}
    >
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-status-current">
        {done ? (
          <Check className="size-4 text-status-done" />
        ) : (
          <svg viewBox="0 0 16 16" className="size-4">
            {RAYS.map((index) => (
              <line
                key={index}
                x1="8"
                y1="1.75"
                x2="8"
                y2="4.25"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                opacity={0.25 + (index / RAYS.length) * 0.75}
                transform={`rotate(${index * 45} 8 8)`}
              />
            ))}
          </svg>
        )}
      </span>
      <span className="truncate">{label}</span>
      {elapsed ? <span className="shrink-0 text-muted-foreground tabular-nums">{elapsed}</span> : null}
    </span>
  );
}
