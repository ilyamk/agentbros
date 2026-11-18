/** Status icon and badge: colour plus icon plus text, never colour alone (RFC 0004 §10.1). */
import type { StepStatus } from "@contract";
import { cn } from "@/lib/utils";
import { stepTone, TONE_BORDER, TONE_ICON, TONE_TEXT, type Tone } from "@/lib/status";
import { useI18n } from "@/i18n";

export function StatusIcon({ tone, className, label }: { tone: Tone; className?: string; label?: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <Icon
      className={cn("size-4 shrink-0", TONE_TEXT[tone], className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}

export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_BORDER[tone],
        className,
      )}
    >
      <StatusIcon tone={tone} className="size-3.5" />
      <span className="text-foreground">{children}</span>
    </span>
  );
}

export function StepStatusBadge({
  status,
  current,
  className,
}: {
  status: StepStatus;
  current?: boolean;
  className?: string;
}) {
  const { d } = useI18n();
  return (
    <ToneBadge tone={stepTone(status, current)} className={className}>
      {d.stepStatus[status]}
    </ToneBadge>
  );
}
