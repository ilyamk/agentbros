/**
 * Decision card (RFC 0004 §5.4). Adapted from affectUI `decision-inbox` (MIT, Copyright (c) 2026 Florian Höller
 * (adfects); github.com/flohoeller/affectui @ e610c3b): an open decision with a title, short context and quick answers,
 * confirming once answered, with a polite live status. Rewritten on the console tokens (no injected <style>) and
 * extended per §5.4: (1) kind and title, (2) the material inline, (3) the agent's view labelled as such and what happens
 * next, (4) the user's words prefilled with an editable phrase in the UI language (D10), (5) actions mapped to CLIs,
 * spending ones showing the exact command on hover and asking before they run, (6) a status line with the waiting time,
 * the bound hash and the stale state. Keyboard (FR9): `a` approves, `r` picks the rejecting action and focuses the words.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Decision } from "@contract";
import { ArrowDown, CircleCheck, CircleX, Coins, Hash, Hourglass, RotateCw, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { asFailure, isAmbiguous } from "@/api/errors";
import { useNow } from "@/lib/clock";
import { commandLine, formatRelative, formatUsd, shortHash } from "@/lib/format";
import { useCardHotkeys, type CardHotkey } from "@/lib/keyboard";
import { approveOption, optionLabel, prefilledPhrase, rejectOption, reviewSignature } from "@/lib/phrases";
import { MediaSlot } from "@/media";
import { navigate, projectHref } from "@/lib/router";
import { withoutSoundClaims } from "@/lib/sound-claims";
import { Button } from "./ui/button";
import { Textarea } from "./ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { ToneBadge } from "./status";

/** Opens the film.human panel when it is collapsed, brings it into view and focuses its first score. */
function focusVerdictPanel(panel: HTMLElement): void {
  const toggle = panel.querySelector<HTMLButtonElement>(":scope > h2 > button");
  if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
  queueMicrotask(() =>
    requestAnimationFrame(() => {
      panel.scrollIntoView?.({ block: "start" });
      const first = panel.querySelector<HTMLElement>('input[type="radio"]') ?? toggle;
      first?.focus();
    }),
  );
}

const verdictPanel = () => document.querySelector<HTMLElement>('[data-panel="film.human"]');

/**
 * The verdict is given on the film.human panel's form, never on this card (D24). On the project canvas the panel is
 * opened in place; elsewhere (home's "Waiting for you") the console goes to the project's canvas first and opens the
 * panel once it is there. Returns whether the panel was found at once.
 */
export function openVerdictForm(project: string): boolean {
  const panel = verdictPanel();
  if (panel) {
    focusVerdictPanel(panel);
    return true;
  }
  navigate(projectHref(project));
  let tries = 0;
  const wait = () => {
    const found = verdictPanel();
    if (found) focusVerdictPanel(found);
    else if (tries++ < 40) setTimeout(wait, 50);
  };
  setTimeout(wait, 0);
  return false;
}

type Outcome = { tone: "applied" | "refused" | "failed" | "uncertain"; message: string };
/**
 * idle: editable. sending: request in flight. pending: the server applied it; locked until the refreshed view drops the
 * decision. uncertain: the request may have arrived (network error, 5xx); locked until the user checks the view.
 */
type Phase = "idle" | "sending" | "pending" | "uncertain" | "checking";

export function DecisionCard({ decision: live, className }: { decision: Decision; className?: string }) {
  const { d, f, locale } = useI18n();
  const store = useConsoleStore();
  const now = useNow();
  const id = useId();
  const card = useRef<HTMLElement>(null);
  const words = useRef<HTMLTextAreaElement>(null);
  // The decision as the user reviewed it: the card shows and sends this snapshot, never the live prop (FR3).
  const [decision, setReviewed] = useState(live);
  const liveRef = useRef(live);
  liveRef.current = live;
  const options = decision.options ?? [];
  const [choice, setChoice] = useState(() => approveOption(options)?.id);
  const selected = options.find((option) => option.id === choice);
  const [text, setText] = useState(() => prefilledPhrase(d, decision, selected));
  const [edited, setEdited] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [outcome, setOutcome] = useState<Outcome>();
  const [hint, setHint] = useState<string>();
  const sending = useRef(false);
  const stale = live.id !== decision.id || reviewSignature(live) !== reviewSignature(decision);
  const busy = phase !== "idle";

  // A change under an open confirmation closes it: the user confirms only what they saw.
  useEffect(() => {
    if (stale) setConfirming(false);
  }, [stale]);

  const choose = (optionId: string, focusWords = false) => {
    setChoice(optionId);
    const option = options.find((item) => item.id === optionId);
    if (!edited) setText(prefilledPhrase(d, decision, option));
    if (focusWords) queueMicrotask(() => words.current?.focus());
  };

  const submit = async (optionId: string | undefined, answer: string) => {
    setConfirming(false);
    // One request at a time (a double click or a held key sends once), and never for material the user did not see.
    if (sending.current) return;
    if (reviewSignature(liveRef.current) !== reviewSignature(decision)) return;
    sending.current = true;
    setPhase("sending");
    setOutcome(undefined);
    try {
      // decisionId is the operation id: the server applies a decision once. `expect` is the reviewed snapshot's hash over every binding and the quote.
      const reply = await store.decide(decision.project, {
        decisionId: decision.id,
        choice: optionId,
        answer,
        expect: decision.expect,
      });
      if (reply.ok) {
        const message = f(d.decision.applied, { title: decision.title });
        setOutcome({ tone: "applied", message });
        setPhase("pending");
        store.notify({ tone: "success", title: d.notices.applied, text: decision.title });
      } else {
        const result = reply.decision.result;
        const message = f(d.decision.refused, { message: result?.message ?? result?.error ?? "" });
        setOutcome({ tone: "refused", message });
        setPhase("idle");
        store.notify({ tone: "error", title: d.notices.refused, text: result?.message ?? result?.error });
      }
    } catch (error) {
      const failure = asFailure(error);
      if (isAmbiguous(failure)) {
        setOutcome({ tone: "uncertain", message: f(d.submission.uncertain, { message: failure.message }) });
        setPhase("uncertain");
      } else {
        setOutcome({ tone: "failed", message: f(d.decision.failed, { message: failure.message }) });
        setPhase("idle");
      }
    } finally {
      sending.current = false;
    }
  };

  /** After an ambiguous failure: refetch the view. If the decision is applied the card leaves the list; else unlock. */
  const check = async () => {
    setPhase("checking");
    await Promise.all([store.loadView(decision.project), store.loadHome()]);
    setOutcome({ tone: "failed", message: d.submission.notApplied });
    setPhase("idle");
  };

  const send = (optionId = choice, answer = text) => {
    if (!answer.trim()) {
      setHint(d.decision.emptyWords);
      words.current?.focus();
      return;
    }
    setHint(undefined);
    const option = options.find((item) => item.id === optionId);
    if (option?.consequential) {
      setChoice(optionId);
      setText(answer);
      setConfirming(true);
      return;
    }
    void submit(optionId, answer);
  };

  const onHotkey = useCallback(
    (name: CardHotkey) => {
      if (busy || stale) return;
      if (name === "approve") {
        const option = approveOption(options);
        if (!option) return;
        const answer = edited ? text : prefilledPhrase(d, decision, option);
        setChoice(option.id);
        if (!edited) setText(answer);
        send(option.id, answer);
      } else if (name === "reject") {
        const option = rejectOption(options);
        if (option) choose(option.id, true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, stale, options, edited, text, decision, d],
  );
  useCardHotkeys(card, onHotkey);

  const command = selected ? commandLine(selected.argv, text) : undefined;
  const done = phase === "pending";
  const kindLabel = d.decision.kinds[decision.kind];
  const recommendation = withoutSoundClaims(decision).recommendation;

  return (
    <article
      ref={card}
      data-card="decision"
      data-decision={decision.id}
      data-hotkeys={options.length ? "approve reject" : undefined}
      tabIndex={0}
      aria-labelledby={`${id}-title`}
      aria-describedby={decision.summary ? `${id}-summary` : undefined}
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-status-waiting/50 bg-card p-4 text-card-foreground shadow-xs outline-none transition-shadow duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/60",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <ToneBadge tone="waiting">{kindLabel}</ToneBadge>
        {decision.step ? <span className="text-xs text-muted-foreground">{decision.step}</span> : null}
        <h3 id={`${id}-title`} className="w-full text-base font-semibold break-words">
          {decision.title}
        </h3>
      </header>

      {decision.media?.length || decision.quote ? (
        <section aria-label={d.decision.material} className="flex flex-col gap-3">
          {decision.media?.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
              {decision.media.map((media) => (
                <MediaSlot
                  key={`${media.root ?? "project"}:${media.path}`}
                  project={decision.project}
                  media={media}
                  variant="thumb"
                />
              ))}
            </div>
          ) : null}
          {decision.quote ? <QuoteFacts quote={decision.quote} locale={locale} /> : null}
        </section>
      ) : null}

      {decision.summary ? (
        <div id={`${id}-summary`} className="text-sm">
          <p className="text-xs font-medium text-muted-foreground">{d.decision.whatNext}</p>
          <p className="break-words">{decision.summary}</p>
        </div>
      ) : null}
      {recommendation ? (
        <aside
          aria-label={d.decision.agentView}
          className="rounded-lg border-s-2 border-status-current/60 bg-muted/50 px-3 py-2 text-sm"
        >
          <p className="text-xs font-medium text-muted-foreground">
            {f(d.decision.agentViewBy, { agent: recommendation.by })}
          </p>
          <p className="break-words">{recommendation.text}</p>
        </aside>
      ) : null}

      {decision.kind === "verdict" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">{d.decision.verdictHere}</p>
          <Button size="sm" variant="outline" data-open-verdict="" onClick={() => openVerdictForm(decision.project)}>
            <ArrowDown aria-hidden="true" />
            {d.decision.openVerdict}
          </Button>
        </div>
      ) : null}

      {options.length ? (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-words`} className="text-sm font-medium">
              {d.decision.yourWords}
            </label>
            <Textarea
              ref={words}
              id={`${id}-words`}
              value={text}
              disabled={busy || done}
              aria-describedby={`${id}-words-hint`}
              aria-invalid={hint ? true : undefined}
              onChange={(event) => {
                setText(event.target.value);
                setEdited(true);
                setHint(undefined);
              }}
              rows={2}
            />
            <p
              id={`${id}-words-hint`}
              className={cn("text-xs", hint ? "text-status-blocked" : "text-muted-foreground")}
            >
              {hint ?? d.decision.wordsHint}
            </p>
          </div>
          <div role="group" aria-label={d.decision.actions} className="flex flex-wrap items-center gap-2">
            {options.map((option) => {
              const label = optionLabel(d, option);
              const isChoice = option.id === choice;
              const button = (
                <Button
                  key={option.id}
                  variant={isChoice ? "default" : "outline"}
                  size="sm"
                  disabled={busy || done || stale}
                  aria-pressed={isChoice}
                  data-option={option.id}
                  onClick={() => (isChoice ? send(option.id) : choose(option.id, option.id !== "approve"))}
                >
                  {option.consequential ? <Coins aria-hidden="true" /> : null}
                  {isChoice ? `${label} · ${d.decision.send}` : label}
                </Button>
              );
              if (!option.consequential) return button;
              return (
                <Tooltip key={option.id}>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">{d.decision.command}</p>
                    <code className="font-mono break-all">{commandLine(option.argv, text)}</code>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </>
      ) : decision.kind === "verdict" ? null : (
        <p className="text-sm text-muted-foreground">{d.decision.noOptions}</p>
      )}

      <p role="status" aria-live="polite" className="min-h-0 text-sm empty:hidden">
        {phase === "sending" ? d.decision.sending : null}
        {phase === "checking" ? d.submission.checking : null}
        {outcome ? (
          <span
            className={cn(
              "flex items-start gap-1.5",
              outcome.tone === "applied"
                ? "text-status-done"
                : outcome.tone === "uncertain"
                  ? "text-status-waiting"
                  : "text-status-blocked",
            )}
          >
            {outcome.tone === "applied" ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            ) : (
              <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="break-words text-foreground">
              {outcome.message}
              {phase === "pending" ? ` ${d.submission.pending}` : null}
            </span>
          </span>
        ) : null}
        {phase === "uncertain" ? (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void check()}>
            <RotateCw aria-hidden="true" />
            {d.submission.check}
          </Button>
        ) : null}
      </p>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Hourglass className="size-3.5" aria-hidden="true" />
          {f(d.decision.waitingSince, { time: formatRelative(decision.createdAt, now, locale) })}
        </span>
        {decision.bindTo.map((binding) => (
          <span key={binding.path} className="flex items-center gap-1" title={`${binding.path} ${binding.sha256}`}>
            <Hash className="size-3.5" aria-hidden="true" />
            <span className="font-mono">{f(d.decision.boundTo, { hash: shortHash(binding.sha256) })}</span>
          </span>
        ))}
        {stale ? (
          <span role="alert" className="flex w-full items-center gap-2 text-status-stale">
            <span className="text-foreground">{d.decision.stale}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={phase === "sending"}
              onClick={() => {
                setReviewed(live);
                if (!edited)
                  setText(
                    prefilledPhrase(
                      d,
                      live,
                      (live.options ?? []).find((item) => item.id === choice),
                    ),
                  );
                setOutcome(undefined);
                if (phase !== "pending") setPhase("idle");
              }}
            >
              <RotateCw aria-hidden="true" />
              {d.app.reload}
            </Button>
          </span>
        ) : null}
      </footer>

      <Dialog open={confirming && !stale} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{d.decision.confirmTitle}</DialogTitle>
            <DialogDescription>{d.decision.confirmBody}</DialogDescription>
          </DialogHeader>
          <pre
            tabIndex={0}
            className="flex gap-2 overflow-x-auto focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all"
          >
            <Terminal className="size-4 shrink-0" aria-hidden="true" />
            {command}
          </pre>
          {decision.quote ? <QuoteFacts quote={decision.quote} locale={locale} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {d.app.cancel}
            </Button>
            <Button disabled={stale || busy} onClick={() => void submit(choice, text)}>
              {d.decision.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}

function QuoteFacts({ quote, locale }: { quote: NonNullable<Decision["quote"]>; locale: string }) {
  const { d } = useI18n();
  const usd = (value: number | null | undefined) => (value == null ? undefined : formatUsd(value, locale));
  const rows: [string, string | undefined][] = [
    [d.decision.quote.amount, quote.amountUsd === null ? d.decision.quote.unknown : usd(quote.amountUsd)],
    [d.decision.quote.provider, quote.provider],
    [d.decision.quote.endpoint, quote.endpoint],
    [d.decision.quote.maxAdmissible, usd(quote.maxAdmissibleUsd)],
    [d.decision.quote.budgetAfter, usd(quote.budgetAfterUsd)],
    [d.decision.quote.ceiling, usd(quote.ceilingUsd)],
  ];
  return (
    <div className="flex flex-col gap-1">
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2 text-sm">
        {rows
          .filter((row): row is [string, string] => row[1] !== undefined)
          .map(([label, value]) => (
            <div key={label} className="rounded-md bg-muted/60 px-2 py-1.5">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-medium break-words tabular-nums">{value}</dd>
            </div>
          ))}
      </dl>
      {quote.amountUsd === null ? <p className="text-xs text-status-waiting">{d.decision.quote.unknownHint}</p> : null}
    </div>
  );
}
