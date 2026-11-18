/**
 * The precise edit command (RU-T11–T13, T15, T19; G5, G6): the raw JSON textarea (the only route for split, ripple,
 * replace and batch outside the forms), Cancel proposal, Dry run, Apply, the dry-run result and the command journal.
 * Typing in the command drops the draft but keeps the text (RU-K07).
 */
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import type { DryRunDisplay, EditPartProps, EditStrings } from "./edit-session";
import { Disclosure } from "@/components/ui/disclosure";

function dryRunText(display: DryRunDisplay, t: EditStrings): string {
  switch (display.kind) {
    case "empty":
      return "";
    case "message":
      return t.display[display.key];
    case "error":
      return display.message;
    case "result":
      return JSON.stringify(display.value, null, 2);
  }
}

export function CommandPanel({ state, session, snap, t }: EditPartProps) {
  const c = t.command;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-sm font-semibold">{c.heading}</h4>
      <p className="text-sm text-muted-foreground">{c.hint}</p>
      <Label htmlFor="command" className="sr-only">
        {c.label}
      </Label>
      <Textarea
        id="command"
        aria-label={c.label}
        rows={6}
        spellCheck={false}
        className="font-mono text-xs"
        value={snap.commandText}
        onChange={(event) => session.setCommandText(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button id="cancel-edit" type="button" variant="outline" onClick={() => session.cancel()}>
          {c.cancel}
        </Button>
        <Button id="validate" type="button" variant="secondary" onClick={() => void session.dryRun()}>
          {c.dryRun}
        </Button>
        <Button id="apply" type="button" onClick={() => void session.apply()}>
          {c.apply}
        </Button>
      </div>
      <pre
        id="dry-run"
        role="status"
        aria-live="polite"
        aria-label={c.result}
        className="min-h-6 rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        {dryRunText(snap.dryRun, t)}
      </pre>
      <Disclosure variant="card" summary={c.journal}>
        <pre
          id="journal"
          className="max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {state.journal.length ? JSON.stringify(state.journal, null, 2) : c.journalEmpty}
        </pre>
      </Disclosure>
    </div>
  );
}
