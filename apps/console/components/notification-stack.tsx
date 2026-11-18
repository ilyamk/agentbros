/**
 * In-page notifications. Adapted from affectUI `notification-stack` (MIT, Copyright (c) 2026 Florian Höller (adfects);
 * github.com/flohoeller/affectui @ e610c3b): notices stacked behind each other, only the front one readable, the ones
 * behind peeking out below it smaller each, cards behind inert and hidden from assistive tech, a labelled region,
 * dismiss per notice. Rewritten on the console tokens with Tailwind (no injected <style>, no line-art pattern),
 * 200 ms transform transitions, a tone icon per notice, an optional "open" action routed in the page; strings from
 * i18n. It replaces sonner, which injects styles without the CSP nonce.
 */
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { Notice } from "@/store/store";
import { cn } from "@/lib/utils";

const PEEK = 10;
const TONE = {
  info: { Icon: Info, className: "text-status-current" },
  success: { Icon: CircleCheck, className: "text-status-done" },
  warning: { Icon: TriangleAlert, className: "text-status-waiting" },
  error: { Icon: CircleAlert, className: "text-status-blocked" },
} as const;

export interface NotificationStackProps {
  notices: Notice[];
  onDismiss: (notice: Notice) => void;
  onOpen?: (notice: Notice) => void;
  label: string;
  dismissLabel: (title: string) => string;
  openLabel?: string;
  className?: string;
}

export function NotificationStack({
  notices,
  onDismiss,
  onOpen,
  label,
  dismissLabel,
  openLabel,
  className,
}: NotificationStackProps) {
  const visible = notices.slice(0, 3);
  return (
    <section
      aria-label={label}
      className={cn("pointer-events-none fixed right-4 bottom-4 z-[60] w-[min(22rem,calc(100vw-2rem))]", className)}
      style={{ height: visible.length ? undefined : 0 }}
    >
      <div className="relative">
        {visible.map((notice, depth) => {
          const { Icon, className: toneClass } = TONE[notice.tone];
          const behind = depth > 0;
          return (
            <article
              key={notice.id}
              aria-labelledby={`${notice.id}-title`}
              aria-hidden={behind || undefined}
              inert={behind}
              data-depth={depth}
              className={cn(
                "pointer-events-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg transition-[transform,opacity] duration-200 starting:translate-y-2 starting:opacity-0",
                behind ? "absolute inset-x-0 bottom-0" : "relative",
              )}
              style={{
                zIndex: 10 - depth,
                transform: behind ? `translateY(${depth * PEEK}px) scale(${1 - depth * 0.05})` : undefined,
                opacity: behind ? 0.9 : 1,
              }}
            >
              <div className="flex items-start gap-2">
                <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", toneClass)} />
                <div className="min-w-0 flex-1">
                  <h3 id={`${notice.id}-title`} className="text-sm font-medium">
                    {notice.title}
                  </h3>
                  {notice.text ? (
                    <p className="mt-0.5 text-sm break-words text-muted-foreground">{notice.text}</p>
                  ) : null}
                  {notice.route && onOpen && openLabel ? (
                    <button
                      type="button"
                      onClick={() => onOpen(notice)}
                      className="mt-2 text-sm font-medium text-link underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {openLabel}
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label={dismissLabel(notice.title)}
                  onClick={() => onDismiss(notice)}
                  className="rounded-sm p-0.5 text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
