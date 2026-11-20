/**
 * Temporary preview of the project header concepts (docs/console-steps.md#project-header): `?header=current|a|b|c`.
 * `current` (and snapshot mode, which has no controls) renders the page's own header passed as children. Removed once
 * the user picks.
 */
import { useState, type ReactNode } from "react";
import type { ProjectView } from "@contract";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { snapshotMode } from "@/lib/snapshot-mode";
import { HEADER_CONCEPTS } from "./concepts";
import type { Page } from "./parts";

export const HEADERS = ["current", "a", "b", "c"] as const;
export type HeaderConcept = (typeof HEADERS)[number];

function readHeader(): HeaderConcept {
  const value = new URLSearchParams(window.location.search).get("header");
  return HEADERS.includes(value as HeaderConcept) ? (value as HeaderConcept) : "current";
}

export function HeaderPreview({ view, page, children }: { view: ProjectView; page: Page; children: ReactNode }) {
  const { d } = useI18n();
  const [concept, setConcept] = useState<HeaderConcept>(readHeader);
  if (snapshotMode()) return <>{children}</>;
  const choose = (value: HeaderConcept) => {
    setConcept(value);
    const url = new URL(window.location.href);
    if (value === "current") url.searchParams.delete("header");
    else url.searchParams.set("header", value);
    window.history.replaceState(window.history.state, "", url);
  };
  const Concept = concept === "current" ? undefined : HEADER_CONCEPTS[concept];
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dashed px-4 py-1.5 lg:px-6">
        <span className="text-xs text-muted-foreground">{d.header.switcher}</span>
        <div
          role="group"
          aria-label={d.header.switcher}
          className="inline-flex flex-wrap gap-0.5 rounded-lg bg-muted p-[3px]"
        >
          {HEADERS.map((option) => (
            <button
              key={option}
              type="button"
              data-option={option}
              aria-pressed={concept === option}
              onClick={() => choose(option)}
              className={cn(
                "rounded-md px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                concept === option && "bg-background text-foreground shadow-sm dark:bg-input/30",
              )}
            >
              {d.header.concepts[option]}
            </button>
          ))}
        </div>
      </div>
      {Concept ? <Concept view={view} page={page} /> : children}
    </>
  );
}
