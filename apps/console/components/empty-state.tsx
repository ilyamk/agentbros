/**
 * Empty state. Adapted from uiarc (Arc UI) free `empty-state` (MIT, Copyright (c) 2026 Elia Kuratli;
 * github.com/kuratlielia/arc-library @ 8302b52): same anatomy (icon, title, description, optional action, a labelled
 * status region), rewritten on the console tokens with Tailwind and without `motion` (no crossfade or height spring);
 * strings come from the i18n dictionaries.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** Accessible label for the state region; defaults to the title. */
  label?: string;
  compact?: boolean;
}

export function EmptyState({ title, description, action, icon, className, label, compact }: EmptyStateProps) {
  return (
    <section
      role="status"
      aria-label={label ?? title}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center",
        compact ? "px-4 py-5" : "px-6 py-10",
        className,
      )}
    >
      {icon ? (
        <div
          className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5"
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-prose text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}
