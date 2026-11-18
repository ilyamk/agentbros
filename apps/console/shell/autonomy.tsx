/**
 * Autonomy and budget form (RFC 0004 D13, US14, A10): the top bar's autonomy badge opens a form over `film:policy`
 * (a film; a recording's mode) and `budget --ceiling-usd` (a recording's or another project's ceiling). The words are
 * prefilled from the change (D10) and sent verbatim as a `policy` decision with one request id per submission. A wider
 * grant (a higher or first ceiling, or autonomous mode) first shows the exact command from a dry run with the amounts
 * before and after; the CLI checks again and its refusal is shown verbatim.
 */
import { useId, useRef, useState } from "react";
import type { PolicyChange, ProjectView } from "@contract";
import { Gauge } from "lucide-react";
import { useI18n, type I18n } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { asFailure, isAmbiguous } from "@/api/errors";
import { commandLine, formatUsd } from "@/lib/format";
import { ceilingOf } from "@/panels/generic/money";
import { newRequestId } from "@/panels/film/feedback";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Mode = ProjectView["autonomy"]["mode"];

/** A bespoke film (a replica is one): its policy is `film:policy`'s, ceiling included (src/lib/autonomy/project.ts). */
export const bespokeFilm = (view: Pick<ProjectView, "project">) =>
  view.project.route === "film" || view.project.route === "replica";

/** Projects whose autonomy mode `film:policy` sets; elsewhere only the ceiling changes (src/lib/console/user-actions.ts). */
export const modeSettable = (view: Pick<ProjectView, "project">) =>
  bespokeFilm(view) || view.project.route === "footage";

/** The change the form asks for, against the view now; `error` names what is wrong with it. */
export function policyChangeOf(
  view: ProjectView,
  mode: Mode,
  amount: string,
): { change?: PolicyChange; error?: "invalidAmount" | "nothing" } {
  const text = amount.trim();
  const ceiling = text === "" ? undefined : Number(text);
  if (ceiling !== undefined && (!Number.isFinite(ceiling) || ceiling < 0)) return { error: "invalidAmount" };
  const before = ceilingOf(view);
  const change: PolicyChange = {};
  if (modeSettable(view) && mode !== view.autonomy.mode) change.autonomy = mode;
  if (ceiling !== undefined && ceiling !== before) change.ceilingUsd = ceiling;
  return change.autonomy === undefined && change.ceilingUsd === undefined ? { error: "nothing" } : { change };
}

/** A wider grant: a first or higher ceiling, or autonomous mode. It is confirmed with the exact command first. */
export function widens(view: ProjectView, change: PolicyChange): boolean {
  const before = ceilingOf(view);
  const raises =
    change.ceilingUsd !== undefined && (before === undefined ? change.ceilingUsd > 0 : change.ceilingUsd > before);
  return raises || (change.autonomy === "autonomous" && view.autonomy.mode !== "autonomous");
}

/** The prefilled words for a change, in the UI language (D10). */
export function policyPhrase({ d, f, locale }: Pick<I18n, "d" | "f" | "locale">, change: PolicyChange): string {
  const mode = change.autonomy ? d.autonomy[change.autonomy].toLocaleLowerCase(locale) : "";
  const amount = change.ceilingUsd !== undefined ? formatUsd(change.ceilingUsd, locale) : "";
  const phrases = d.autonomy.phrases;
  if (change.autonomy && change.ceilingUsd !== undefined) return f(phrases.both, { mode, amount });
  if (change.autonomy) return f(phrases.mode, { mode });
  return f(phrases.ceiling, { amount });
}

export function AutonomyControl({ view }: { view: ProjectView }) {
  const { d } = useI18n();
  const [open, setOpen] = useState(false);
  const autonomy = view.autonomy;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-auto gap-1.5 px-2 py-1 text-xs font-normal"
        data-autonomy-control
        aria-haspopup="dialog"
        title={d.autonomy.change}
        onClick={() => setOpen(true)}
      >
        <Gauge className="size-3.5" aria-hidden="true" />
        <span className="sr-only">{d.autonomy.change}: </span>
        {autonomy.mode === "autonomous" ? d.autonomy.autonomous : d.autonomy.interactive}
        {autonomy.finalReviewOnly ? ` · ${d.autonomy.finalReviewOnly}` : ""}
      </Button>
      {open ? <AutonomyDialog view={view} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type Stage = { kind: "form" } | { kind: "confirm"; change: PolicyChange; argv: string[] };

export function AutonomyDialog({ view, onClose }: { view: ProjectView; onClose: () => void }) {
  const i18n = useI18n();
  const { d, f, locale } = i18n;
  const store = useConsoleStore();
  const id = useId();
  const project = view.project.id;
  const before = ceilingOf(view);
  const [mode, setMode] = useState<Mode>(view.autonomy.mode);
  const [amount, setAmount] = useState(before === undefined ? "" : String(before));
  const [words, setWords] = useState("");
  const edited = useRef(false);
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const requestId = useRef<string | undefined>(undefined);
  const settable = modeSettable(view);
  const usd = (value: number | undefined) => (value === undefined ? d.autonomy.noCeiling : formatUsd(value, locale));

  /** Regenerates the prefilled words for the change, unless the user has written their own. */
  const update = (nextMode: Mode, nextAmount: string) => {
    setMode(nextMode);
    setAmount(nextAmount);
    setError(undefined);
    if (edited.current) return;
    const { change } = policyChangeOf(view, nextMode, nextAmount);
    setWords(change ? policyPhrase(i18n, change) : "");
  };

  const apply = async (change: PolicyChange) => {
    setBusy(true);
    setError(undefined);
    try {
      requestId.current ??= newRequestId();
      const reply = await store.decide(project, {
        kind: "policy",
        policy: change,
        answer: words,
        requestId: requestId.current,
      });
      requestId.current = undefined;
      const result = reply.decision.result;
      const followUp = (result?.metadata?.["followUps"] as { ok: boolean; message?: string }[] | undefined)?.find(
        (item) => !item.ok,
      );
      if (reply.ok) {
        const text = f(d.autonomy.done, { title: policyPhrase(i18n, change) });
        store.notify({ tone: "success", title: d.autonomy.title, text });
        onClose();
      } else if (reply.decision.status === "partial") {
        setError(f(d.autonomy.partial, { message: followUp?.message ?? "" }));
      } else {
        const message = result?.message ?? result?.error ?? "";
        setError(f(d.autonomy.refused, { message }));
        store.notify({ tone: "error", title: d.autonomy.title, text: message });
        setStage({ kind: "form" });
      }
    } catch (failure) {
      const problem = asFailure(failure);
      if (!isAmbiguous(problem)) requestId.current = undefined;
      setError(
        isAmbiguous(problem)
          ? f(d.submission.uncertain, { message: problem.message })
          : f(d.autonomy.failed, { message: problem.message }),
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const { change, error: problem } = policyChangeOf(view, mode, amount);
    if (!change) {
      setError(d.autonomy[problem ?? "nothing"]);
      return;
    }
    if (!words.trim()) {
      setError(d.decision.emptyWords);
      return;
    }
    if (!widens(view, change)) return apply(change);
    // A wider grant shows the exact command first (D13): the server's own argv, nothing runs.
    setBusy(true);
    setError(undefined);
    try {
      const preview = await store.decide(project, { kind: "policy", policy: change, answer: words }, { dryRun: true });
      setStage({ kind: "confirm", change, argv: preview.decision.argv ?? [] });
    } catch (failure) {
      setError(f(d.autonomy.failed, { message: asFailure(failure).message }));
    } finally {
      setBusy(false);
    }
  };

  const command = bespokeFilm(view) ? "pnpm film:policy" : settable ? "pnpm film:policy · pnpm budget" : "pnpm budget";
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent data-autonomy-dialog={stage.kind}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="size-5" aria-hidden="true" />
            {stage.kind === "confirm" ? d.autonomy.confirmTitle : d.autonomy.title}
          </DialogTitle>
          <DialogDescription>
            {stage.kind === "confirm" ? d.autonomy.confirmBody : f(d.autonomy.body, { command })}
          </DialogDescription>
        </DialogHeader>
        {stage.kind === "confirm" ? (
          <ConfirmPolicy view={view} change={stage.change} argv={stage.argv} usd={usd} />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className="flex flex-col gap-2" disabled={busy || !settable}>
              <legend className="mb-1 text-sm font-medium">{d.autonomy.mode}</legend>
              {settable ? (
                <RadioGroup value={mode} onValueChange={(value) => update(value as Mode, amount)}>
                  {(["interactive", "autonomous"] as const).map((value) => (
                    <label key={value} className="flex items-start gap-2 text-sm">
                      <RadioGroupItem value={value} className="mt-0.5" aria-describedby={`${id}-${value}`} />
                      <span className="flex flex-col">
                        <span className="font-medium">{d.autonomy[value]}</span>
                        <span id={`${id}-${value}`} className="text-xs text-muted-foreground">
                          {value === "interactive" ? d.autonomy.interactiveHint : d.autonomy.autonomousHint}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              ) : (
                <p className="text-sm text-muted-foreground">{d.autonomy.modeUnavailable}</p>
              )}
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-ceiling`} className="text-sm font-medium">
                {d.autonomy.ceiling}
              </label>
              <Input
                id={`${id}-ceiling`}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={amount}
                disabled={busy}
                aria-describedby={`${id}-ceiling-now`}
                onChange={(event) => update(mode, event.target.value)}
              />
              <p id={`${id}-ceiling-now`} className="text-xs text-muted-foreground">
                {f(d.autonomy.ceilingNow, { amount: usd(before) })}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-words`} className="text-sm font-medium">
                {d.decision.yourWords}
              </label>
              <Textarea
                id={`${id}-words`}
                value={words}
                rows={2}
                disabled={busy}
                aria-describedby={`${id}-words-hint`}
                onChange={(event) => {
                  edited.current = true;
                  setWords(event.target.value);
                }}
              />
              <p id={`${id}-words-hint`} className="text-xs text-muted-foreground">
                {d.decision.wordsHint}
              </p>
            </div>
          </form>
        )}
        <p role="status" aria-live="polite" className="text-sm text-status-blocked empty:hidden">
          {error}
        </p>
        <DialogFooter>
          {stage.kind === "confirm" ? (
            <>
              <Button variant="outline" onClick={() => setStage({ kind: "form" })} disabled={busy}>
                {d.autonomy.back}
              </Button>
              <Button onClick={() => void apply(stage.change)} disabled={busy} data-autonomy-confirm>
                {busy ? d.decision.sending : d.autonomy.confirm}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                {d.app.cancel}
              </Button>
              <Button onClick={() => void submit()} disabled={busy} data-autonomy-apply>
                {busy ? d.decision.sending : d.autonomy.apply}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmPolicy({
  view,
  change,
  argv,
  usd,
}: {
  view: ProjectView;
  change: PolicyChange;
  argv: string[];
  usd: (value: number | undefined) => string;
}) {
  const { d } = useI18n();
  const modeLabel = (mode: Mode) => d.autonomy[mode];
  const rows: [string, string, string][] = [];
  if (change.autonomy) rows.push([d.autonomy.mode, modeLabel(view.autonomy.mode), modeLabel(change.autonomy)]);
  if (change.ceilingUsd !== undefined) rows.push([d.autonomy.ceiling, usd(ceilingOf(view)), usd(change.ceilingUsd)]);
  return (
    <div className="flex flex-col gap-3">
      <table className="w-full text-sm" data-policy-amounts>
        <thead>
          <tr className="text-xs text-muted-foreground">
            <td />
            <th scope="col" className="px-2 text-start font-normal">
              {d.autonomy.before}
            </th>
            <th scope="col" className="px-2 text-start font-normal">
              {d.autonomy.after}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, from, to]) => (
            <tr key={label}>
              <th scope="row" className="py-0.5 pe-2 text-start font-normal">
                {label}
              </th>
              <td className="px-2 tabular-nums">{from}</td>
              <td className="px-2 font-semibold tabular-nums">{to}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre
        className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap"
        data-policy-command
      >
        {commandLine(argv)}
      </pre>
    </div>
  );
}
