/**
 * The frame every timeline section renders in (RFC 0004 WP13): `<section id="timeline-<id>">` with a heading and a
 * one-line description. `TimelineSectionProps` is what `TimelineView` passes to every section.
 */
import { useId, type ReactNode } from "react";
import type { ReviewApi, ReviewState } from "./api";
import type { TimelineController } from "./controller";

export interface TimelineSectionProps {
  project: string;
  /** The last state the server returned; `state.revision` is null while the journal is not initialized. */
  state: ReviewState;
  api: ReviewApi;
  /** `run()` for G1/G2, `proposals` for G3/G4, `display()` after a mutation, `onDisplay()` to reset local state. */
  controller: TimelineController;
}

export function TimelineSection({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section
      id={`timeline-${id}`}
      data-testid={`timeline-section-${id}`}
      aria-labelledby={heading}
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card/40 p-4"
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 id={heading} className="text-base font-semibold">
            {title}
          </h3>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
