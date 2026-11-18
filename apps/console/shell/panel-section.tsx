/** A collapsible canvas section with a heading, a one-line summary when closed, and the panel inside when open. */
import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function PanelSection({
  id,
  title,
  summary,
  defaultOpen,
  children,
}: {
  id: string;
  title: string;
  summary?: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const domId = useId();
  return (
    <section data-panel={id} aria-labelledby={`${domId}-title`} className="rounded-xl border bg-card/40">
      <h2 id={`${domId}-heading`} className="text-base font-semibold">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${domId}-body`}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-start transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("size-4 shrink-0 transition-transform duration-150", open && "rotate-90")}
          />
          <span id={`${domId}-title`}>{title}</span>
          {summary ? (
            <span className="ms-auto truncate text-sm font-normal text-muted-foreground">{summary}</span>
          ) : null}
        </button>
      </h2>
      {open ? (
        <div id={`${domId}-body`} className="px-4 pb-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}
