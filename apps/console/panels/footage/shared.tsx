/** What every footage panel shares: its steps, its pending decisions (pointing to the pinned card) and an empty state. */
import type { ProjectView } from "@contract";
import { FileQuestion, MessageSquare } from "lucide-react";
import { useI18n } from "@/i18n";
import { EmptyState } from "@/components/empty-state";
import { DecisionRefs, StepRows } from "../film/shared";
import { footageGroupDecisions, footageGroupSteps, type FootageGroup } from "./steps";

/** The group's steps and decisions; a decision without options is answered in the chat (no console command). */
export function FootageStepHeader({ view, group }: { view: ProjectView; group: FootageGroup }) {
  const { d } = useI18n();
  const decisions = footageGroupDecisions(view, group);
  const chatOnly = decisions.filter((decision) => decision.kind !== "quote" && !decision.options?.length);
  return (
    <>
      <StepRows view={view} steps={footageGroupSteps(view, group)} />
      <DecisionRefs decisions={decisions} />
      {chatOnly.length ? (
        <p role="note" className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
          <MessageSquare aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            <span className="font-medium">{d.footage.common.chatOnly}.</span> {d.footage.common.chatOnlyHint}
          </span>
        </p>
      ) : null}
    </>
  );
}

export function NothingYet() {
  const { d } = useI18n();
  return (
    <EmptyState
      compact
      icon={<FileQuestion />}
      title={d.footage.common.notYet}
      description={d.footage.common.notYetHint}
    />
  );
}
