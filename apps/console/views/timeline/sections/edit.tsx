/**
 * Timeline section: edit (RU-T, RU-P, RU-AU, RU-K; the review:ui parity checklist). The storyboard, the
 * proportional lanes with pointer proposals, the visual group move, the operation form, and the command with dry run,
 * apply, undo, redo and the journal. The behaviour lives in `EditSession` (edit-session.ts); the builders in
 * edit-commands.ts and edit-pointer.ts; the parts in edit-board.tsx, edit-form.tsx, edit-group.tsx and
 * edit-command.tsx. Element ids follow review:ui's (`#command`, `#apply`, `#operation`, …).
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { TimelineSection, type TimelineSectionProps } from "../section";
import { Storyboard, TrackLanes } from "./edit-board";
import { CommandPanel } from "./edit-command";
import { OperationForm } from "./edit-form";
import { GroupMove } from "./edit-group";
import { EditSession } from "./edit-session";

export function EditSection({ state, api, controller }: TimelineSectionProps) {
  const { d } = useI18n();
  const t = d.timeline.edit;
  const session = useMemo(() => new EditSession(controller), [controller]);
  useEffect(() => session.attach(), [session]);
  session.setStrings(t);
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const parts = { state, api, session, snap, t };

  return (
    <TimelineSection
      id="edit"
      title={t.title}
      description={t.description}
      actions={
        <div className="flex gap-2">
          <Button
            id="undo"
            variant="outline"
            size="sm"
            disabled={!state.journal.length}
            onClick={() => void session.history("undo")}
          >
            <Undo2 aria-hidden="true" />
            {t.undo}
          </Button>
          <Button
            id="redo"
            variant="outline"
            size="sm"
            disabled={!state.redoCount}
            onClick={() => void session.history("redo")}
          >
            <Redo2 aria-hidden="true" />
            {t.redo}
          </Button>
        </div>
      }
    >
      <Storyboard {...parts} />
      <TrackLanes {...parts} />
      <GroupMove {...parts} />
      <OperationForm {...parts} />
      <CommandPanel {...parts} />
    </TimelineSection>
  );
}
