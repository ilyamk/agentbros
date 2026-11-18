/** The banner of a static snapshot (RFC 0004 WP15, D18): whose snapshot, when it was taken, and that nothing here acts. */
import { Camera } from "lucide-react";
import { useI18n } from "@/i18n";
import { formatTime } from "@/lib/format";

export function SnapshotBanner({ project, takenAt }: { project: string; takenAt: string }) {
  const { d, f, locale } = useI18n();
  return (
    <div
      role="note"
      data-snapshot-banner=""
      className="flex items-start gap-2 border-b bg-muted/60 px-4 py-2 text-sm lg:px-6"
    >
      <Camera className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <span className="font-medium">
          {f(d.snapshot.banner, { project, time: formatTime(takenAt, locale, true) })}
        </span>{" "}
        <span className="text-muted-foreground">{d.snapshot.readOnly}</span>
      </p>
    </div>
  );
}
