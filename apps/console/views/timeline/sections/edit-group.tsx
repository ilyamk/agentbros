/**
 * Move visual group (RU-P06): one checkbox per visual clip (2–24, the 25th refused), the exact delta, Prepare (disabled
 * below two) and Clear. Every checkbox and delta change cancels the proposal (RU-K08); every display clears the
 * selection (EditSession.onDisplay).
 */
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";
import { groupCandidates } from "./edit-commands";
import type { EditPartProps } from "./edit-session";

export function GroupMove({ state, session, snap, t }: EditPartProps) {
  const { f } = useI18n();
  const g = t.group;
  const candidates = groupCandidates(state);
  const chosen = new Set(snap.group.map((m) => `${m.trackId}\u0000${m.clipId}`));
  return (
    <fieldset id="group-controls" className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-semibold">{g.legend}</legend>
      <p className="text-sm text-muted-foreground">{g.hint}</p>
      <div id="group-members" className="flex max-h-48 min-w-0 flex-col gap-1 overflow-y-auto">
        {candidates.length ? null : <p className="text-sm text-muted-foreground">{g.none}</p>}
        {candidates.map((member) => {
          const label = f(g.member, { track: member.trackId, clip: member.clipId });
          return (
            <Label key={`${member.trackId}/${member.clipId}`} className="font-normal">
              <Checkbox
                aria-label={label}
                data-group-track={member.trackId}
                data-group-clip={member.clipId}
                checked={chosen.has(`${member.trackId}\u0000${member.clipId}`)}
                onCheckedChange={(checked) => session.toggleGroup(member, checked === true)}
              />
              {`${member.trackId} / ${member.clipId}`}
            </Label>
          );
        })}
      </div>
      <p id="group-selection" className="text-sm tabular-nums [overflow-wrap:anywhere]" aria-live="polite">
        {f(g.selection, {
          n: snap.group.length,
          ids: snap.group.map((m) => `${m.trackId} / ${m.clipId}`).join(", "),
        })}
      </p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="group-num">{g.num}</Label>
          <Input
            id="group-num"
            type="number"
            step="1"
            value={snap.groupNum}
            onChange={(event) => session.setGroupDelta("num", event.target.value)}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="group-den">{g.den}</Label>
          <Input
            id="group-den"
            type="number"
            step="1"
            min="1"
            value={snap.groupDen}
            onChange={(event) => session.setGroupDelta("den", event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          id="group-prepare"
          type="button"
          disabled={snap.group.length < 2}
          onClick={() => void session.prepareGroup()}
        >
          {g.prepare}
        </Button>
        <Button id="group-clear" type="button" variant="outline" onClick={() => session.clearGroup()}>
          {g.clear}
        </Button>
      </div>
    </fieldset>
  );
}
