/** Step guard: violations of the step lease (docs/step-lease.md), RFC 0004 §5.2. */
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useI18n } from "@/i18n";
import { useNow } from "@/lib/clock";
import { formatRelative } from "@/lib/format";
import type { PanelProps } from "../registry";

export function StepGuardPanel({ view }: PanelProps) {
  const { d, f, p, locale } = useI18n();
  const now = useNow();
  const guard = view.stepGuard;
  if (!guard?.violations)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 text-status-done" aria-hidden="true" />
        {d.guard.none}
      </p>
    );
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4 text-status-blocked" aria-hidden="true" />
        {p(d.guard.violations, guard.violations)}
      </p>
      {guard.last ? (
        <p className="text-muted-foreground">
          {f(d.guard.last, {
            alias: guard.last.alias,
            step: guard.last.step,
            code: guard.last.code,
            time: formatRelative(guard.last.at, now, locale),
          })}
        </p>
      ) : null}
    </div>
  );
}
