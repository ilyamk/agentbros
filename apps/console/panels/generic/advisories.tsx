/** Advisories from the chain (warnings the agents should act on), RFC 0004 §5.2. */
import { TriangleAlert } from "lucide-react";
import { useI18n } from "@/i18n";
import { EmptyState } from "@/components/empty-state";
import type { PanelProps } from "../registry";

export function AdvisoriesPanel({ view }: PanelProps) {
  const { d } = useI18n();
  if (!view.advisories.length) return <EmptyState compact title={d.advisories.none} />;
  return (
    <ul className="flex flex-col gap-2">
      {view.advisories.map((advisory, index) => (
        <li
          key={index}
          className="flex items-start gap-2 rounded-lg border border-status-waiting/40 bg-card px-3 py-2 text-sm"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-waiting" aria-hidden="true" />
          <span className="break-words">{advisory}</span>
        </li>
      ))}
    </ul>
  );
}
