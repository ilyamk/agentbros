/**
 * A native `<details>` disclosure with one look across the console: a chevron that turns when open, a focus ring on the
 * summary, and two variants, `card` (bordered) and `plain`. Native, so it works without script, keeps `open`/`onToggle`
 * and find-in-page, and the contents stay out of the tab order while closed.
 */
import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DisclosureProps extends Omit<ComponentProps<"details">, "children"> {
  summary: ReactNode;
  children: ReactNode;
  variant?: "card" | "plain";
  size?: "sm" | "xs";
  /** A quiet summary (muted until hovered), for raw data and details under the main content. */
  muted?: boolean;
  contentClassName?: string;
}

export function Disclosure({
  summary,
  children,
  variant = "plain",
  size = "sm",
  muted = false,
  className,
  contentClassName,
  ...props
}: DisclosureProps) {
  return (
    <details
      data-slot="disclosure"
      className={cn("group/disclosure min-w-0", variant === "card" && "rounded-lg border px-3 py-2", className)}
      {...props}
    >
      <summary
        className={cn(
          "flex max-w-full cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden",
          variant === "card" ? "w-full" : "w-fit",
          size === "xs" ? "text-xs" : "text-sm",
          muted && "font-normal text-muted-foreground transition-colors duration-150 hover:text-foreground",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "shrink-0 transition-transform duration-150 group-open/disclosure:rotate-90 motion-reduce:transition-none",
            size === "xs" ? "size-3.5" : "size-4",
          )}
        />
        <span className="min-w-0">{summary}</span>
      </summary>
      <div className={cn("mt-2 min-w-0", contentClassName)}>{children}</div>
    </details>
  );
}
