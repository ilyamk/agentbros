/**
 * Agent cards (RFC 0004 D14, §6.4): the seven kinds an agent can put on the canvas with `console:card` — compare, grid,
 * rating, choice, question, markdown and media — with the answer form for those that expect one
 * (`POST …/cards/:cardId/answer`). Agent text (title, body, labels) is shown as written, never translated; the body is
 * Markdown rendered without HTML (lib/markdown.tsx).
 */
import { useId, useRef, useState, type FormEvent } from "react";
import type { Card, CardAnswerRequest, MediaRef } from "@contract";
import {
  Bot,
  CircleCheck,
  Columns2,
  Grid3x3,
  HelpCircle,
  ListChecks,
  NotebookText,
  PlayCircle,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { asFailure, isAmbiguous } from "@/api/errors";
import { useNow } from "@/lib/clock";
import { formatRelative } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import { Compare, MediaSlot } from "@/media";
import { Button } from "./ui/button";
import { Label, Textarea } from "./ui/input";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { StarRating } from "./rating";
import { ToneBadge } from "./status";

const KIND_ICON = {
  compare: Columns2,
  grid: Grid3x3,
  rating: Star,
  choice: ListChecks,
  question: HelpCircle,
  markdown: NotebookText,
  media: PlayCircle,
} as const;

function mediaKey(media: MediaRef) {
  return `${media.root ?? "project"}:${media.path}`;
}

export function AgentCard({ card, className }: { card: Card; className?: string }) {
  const { d, f, locale } = useI18n();
  const store = useConsoleStore();
  const now = useNow();
  const id = useId();
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const [ratings, setRatings] = useState<Record<string, number>>({});
  // idle → sending → pending (sent; locked until the refreshed view shows the answer) or uncertain (may have arrived).
  const [phase, setPhase] = useState<"idle" | "sending" | "pending" | "uncertain" | "checking">("idle");
  const sending = useRef(false);
  const busy = phase !== "idle";
  const [error, setError] = useState<string>();
  const expired = card.expiresAt !== undefined && Date.parse(card.expiresAt) < now;
  const answered = card.answer !== undefined;
  const open = card.expectsAnswer && !answered && !expired;
  const Icon = KIND_ICON[card.kind];
  const media = "media" in card ? (card.media ?? []) : [];
  const options = "options" in card ? (card.options ?? []) : [];

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const request: CardAnswerRequest = {
      ...(choice ? { choice } : {}),
      ...(text.trim() ? { text } : {}),
      ...(Object.keys(ratings).length ? { ratings } : {}),
    };
    // The server's rules (src/lib/console/cards.ts): ratings for a rating card, an option for choice and compare.
    const empty =
      card.kind === "rating"
        ? !request.ratings
        : card.kind === "choice" || card.kind === "compare"
          ? !request.choice
          : !request.choice && !request.text;
    if (empty) {
      setError(d.cards.answerEmpty);
      return;
    }
    if (sending.current) return;
    sending.current = true;
    setPhase("sending");
    setError(undefined);
    try {
      // The card id is the operation id: the server records one answer per card.
      await store.answerCard(card.project, card.id, request);
      setPhase("pending");
      store.notify({ tone: "success", title: d.notices.card, text: f(d.cards.sent, { agent: card.from.agent }) });
    } catch (error) {
      const failure = asFailure(error);
      if (isAmbiguous(failure)) {
        setError(f(d.submission.uncertain, { message: failure.message }));
        setPhase("uncertain");
      } else {
        setError(f(d.cards.failed, { message: failure.message }));
        setPhase("idle");
      }
    } finally {
      sending.current = false;
    }
  };

  /** After an ambiguous failure: refetch; an answered card shows its answer, otherwise the form unlocks. */
  const check = async () => {
    setPhase("checking");
    await store.loadView(card.project);
    setError(d.submission.notApplied);
    setPhase("idle");
  };

  const ratingFor = (path: string) => (card.answer?.ratings?.[path] ?? ratings[path] ?? null) as number | null;

  return (
    <article
      data-card="agent"
      data-card-kind={card.kind}
      tabIndex={0}
      aria-labelledby={`${id}-title`}
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60",
        open && "border-status-current/50",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">
          <Icon className="size-3.5" aria-hidden="true" />
          {d.cards.kinds[card.kind]}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Bot className="size-3.5" aria-hidden="true" />
          {f(d.cards.from, { agent: card.from.role ? `${card.from.agent} (${card.from.role})` : card.from.agent })}
        </span>
        {open ? <ToneBadge tone="waiting">{d.cards.needsAnswer}</ToneBadge> : null}
        {expired && !answered ? <ToneBadge tone="skipped">{d.cards.expired}</ToneBadge> : null}
        {!card.expectsAnswer ? <span className="text-xs text-muted-foreground">{d.cards.noAnswerNeeded}</span> : null}
        <h3 id={`${id}-title`} className="w-full text-base font-semibold break-words">
          {card.title}
        </h3>
      </header>

      {card.body ? <Markdown source={card.body} /> : null}

      {card.kind === "compare" && media.length === 2 ? (
        <Compare project={card.project} a={media[0]!} b={media[1]!} />
      ) : media.length && card.kind !== "rating" ? (
        <div
          className={cn(
            "grid gap-3",
            card.kind === "compare" ? "grid-cols-2" : "grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]",
          )}
        >
          {media.map((item) => (
            <MediaSlot
              key={mediaKey(item)}
              project={card.project}
              media={item}
              variant={card.kind === "compare" ? "inline" : "thumb"}
            />
          ))}
        </div>
      ) : null}

      {card.kind === "rating" ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {media.map((item) => (
            <li key={mediaKey(item)} className="flex flex-col gap-1.5">
              <MediaSlot project={card.project} media={item} variant="thumb" />
              <StarRating
                value={ratingFor(item.path)}
                readOnly={!open}
                disabled={busy}
                label={`${d.rating.label}: ${item.label ?? item.path}`}
                valueLabel={(n, max) => f(d.rating.outOf, { n, max })}
                noneLabel={d.rating.none}
                onValueChange={(value) =>
                  setRatings((current) => {
                    const next = { ...current };
                    if (value === null) delete next[item.path];
                    else next[item.path] = value;
                    return next;
                  })
                }
              />
            </li>
          ))}
        </ul>
      ) : null}

      {answered ? (
        <section
          aria-label={d.cards.yourAnswer}
          className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2 text-sm"
        >
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleCheck className="size-3.5 text-status-done" aria-hidden="true" />
            {f(d.cards.answered, { time: formatRelative(card.answer!.at, now, locale) })}
          </p>
          {card.answer!.choice ? (
            <p>
              <span className="text-muted-foreground">{d.cards.yourChoice}: </span>
              {options.find((option) => option.id === card.answer!.choice)?.label ?? card.answer!.choice}
            </p>
          ) : null}
          {card.answer!.text ? <p className="break-words">“{card.answer!.text}”</p> : null}
        </section>
      ) : null}

      {open ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label={d.cards.yourAnswer}>
          {options.length ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{d.cards.yourChoice}</legend>
              <RadioGroup value={choice ?? ""} onValueChange={setChoice} className="flex flex-wrap gap-x-4 gap-y-2">
                {options.map((option) => (
                  <Label key={option.id} className="cursor-pointer font-normal">
                    <RadioGroupItem value={option.id} disabled={busy} />
                    {option.label}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
          ) : null}
          {
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-text`} className="text-sm font-medium">
                {card.kind === "question" || (card.kind === "media" && !options.length)
                  ? d.cards.yourAnswer
                  : d.cards.note}
              </label>
              <Textarea
                id={`${id}-text`}
                value={text}
                placeholder={d.cards.noteHint}
                disabled={busy}
                rows={2}
                onChange={(event) => {
                  setText(event.target.value);
                  setError(undefined);
                }}
              />
            </div>
          }
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={busy}>
              {phase === "sending" ? d.cards.sending : phase === "pending" ? d.submission.pending : d.cards.send}
            </Button>
            {phase === "uncertain" || phase === "checking" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={phase === "checking"}
                onClick={() => void check()}
              >
                {phase === "checking" ? d.submission.checking : d.submission.check}
              </Button>
            ) : null}
            <p role="status" aria-live="polite" className="text-sm text-status-blocked empty:hidden">
              {error}
            </p>
          </div>
        </form>
      ) : null}
    </article>
  );
}
