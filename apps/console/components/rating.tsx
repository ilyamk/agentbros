/**
 * Rating (stars, thumbs). Adapted from affectUI `rating` (MIT, Copyright (c) 2026 Florian Höller (adfects);
 * github.com/flohoeller/affectui @ e610c3b): a radio group with one tab stop, arrows move and choose, Home/End jump,
 * Delete clears, hover previews, pressing the chosen star again clears it; read-only it is one image with a label.
 * Rewritten on the console tokens with Tailwind and lucide icons (no injected <style>, no pop keyframes); labels from
 * i18n.
 */
import { useState, type KeyboardEvent } from "react";
import { Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StarRatingProps {
  value: number | null;
  onValueChange?: (value: number | null) => void;
  max?: number;
  readOnly?: boolean;
  disabled?: boolean;
  /** Accessible name of the group. */
  label: string;
  /** Name of one value, e.g. "3 out of 5". */
  valueLabel: (value: number, max: number) => string;
  noneLabel?: string;
  className?: string;
}

export function StarRating({
  value,
  onValueChange,
  max = 5,
  readOnly,
  disabled,
  label,
  valueLabel,
  noneLabel,
  className,
}: StarRatingProps) {
  const [hover, setHover] = useState<number | null>(null);
  const items = Array.from({ length: max }, (_, index) => index + 1);
  if (readOnly) {
    return (
      <div
        role="img"
        aria-label={value == null ? (noneLabel ?? label) : `${label}: ${valueLabel(value, max)}`}
        className={cn("flex gap-0.5", className)}
      >
        {items.map((index) => (
          <Star
            key={index}
            aria-hidden="true"
            className={cn(
              "size-4",
              index <= (value ?? 0) ? "fill-status-paused text-status-paused" : "text-muted-foreground",
            )}
          />
        ))}
      </div>
    );
  }
  const shown = hover ?? value ?? 0;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onValueChange?.(null);
      return;
    }
    const now = value ?? 0;
    const to =
      event.key === "Home"
        ? 1
        : event.key === "End"
          ? max
          : event.key === "ArrowRight" || event.key === "ArrowUp"
            ? now + 1
            : event.key === "ArrowLeft" || event.key === "ArrowDown"
              ? now - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    const next = Math.min(max, Math.max(1, to));
    onValueChange?.(next);
    (event.currentTarget.parentElement?.children[next - 1] as HTMLElement | undefined)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn("flex gap-0.5", className)}
      onPointerLeave={() => setHover(null)}
    >
      {items.map((index) => (
        <button
          key={index}
          type="button"
          role="radio"
          aria-checked={value === index}
          aria-label={valueLabel(index, max)}
          tabIndex={index === (value ?? 1) ? 0 : -1}
          disabled={disabled}
          onPointerEnter={(event) => event.pointerType === "mouse" && setHover(index)}
          onClick={() => onValueChange?.(value === index ? null : index)}
          onKeyDown={onKeyDown}
          className="rounded-sm p-0.5 transition-transform duration-150 hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
        >
          <Star
            aria-hidden="true"
            className={cn(
              "size-5 transition-colors duration-150",
              index <= shown ? "fill-status-paused text-status-paused" : "text-muted-foreground",
            )}
          />
        </button>
      ))}
    </div>
  );
}

export interface ThumbsRatingProps {
  value: "up" | "down" | null;
  onValueChange?: (value: "up" | "down" | null) => void;
  label: string;
  labels: { up: string; down: string };
  disabled?: boolean;
  className?: string;
}

export function ThumbsRating({ value, onValueChange, label, labels, disabled, className }: ThumbsRatingProps) {
  const options = [
    { id: "up" as const, Icon: ThumbsUp, name: labels.up },
    { id: "down" as const, Icon: ThumbsDown, name: labels.down },
  ];
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex gap-1", className)}>
      {options.map(({ id, Icon, name }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          aria-label={name}
          disabled={disabled}
          onClick={() => onValueChange?.(value === id ? null : id)}
          className={cn(
            "flex size-8 items-center justify-center rounded-md border transition-colors duration-150 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            value === id && "border-primary bg-accent",
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
