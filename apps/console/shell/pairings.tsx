/**
 * Paired browsers (RFC 0004 D15, A1): every redemption of a one-use pairing link (src/lib/console/pairing.ts) is listed
 * in Settings, and an open tab shows a toast when a new one appears, so a link redeemed by someone other than the user
 * (an agent with curl, say) is visible. The tab polls `GET /api/session/pairings`; nothing in fixture or snapshot mode.
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { formatTime } from "@/lib/format";
import { useConsole, useConsoleStore } from "@/store/context";

export const PAIRINGS_POLL_MS = 15_000;

type Paired = { at: string; agent: string };

/** Toasts each pairing newer than what this tab saw first. Mount once, inside the session. */
export function PairingWatcher({ intervalMs = PAIRINGS_POLL_MS }: { intervalMs?: number }) {
  const store = useConsoleStore();
  const { d, f, locale } = useI18n();
  const ready = useConsole((s) => s.session.status === "ready");

  useEffect(() => {
    const read = store.client.pairings?.bind(store.client);
    if (!ready || !read) return;
    let seen: string | undefined;
    let stopped = false;
    const poll = async () => {
      let paired: Paired[];
      try {
        paired = await read();
      } catch {
        return;
      }
      if (stopped) return;
      const latest = paired.at(-1)?.at ?? "";
      if (seen !== undefined)
        for (const item of paired.filter((entry) => entry.at > seen!))
          store.notify({
            id: `paired-${item.at}`,
            tone: "warning",
            title: d.settings.pairedToast,
            text: f(d.settings.pairedToastText, { agent: item.agent, time: formatTime(item.at, locale, true) }),
            route: "/settings",
          });
      if (seen === undefined || latest > seen) seen = latest;
    };
    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [ready, store, intervalMs, d, f, locale]);

  return null;
}

/** The Settings list, newest first. */
export function PairedBrowsers() {
  const store = useConsoleStore();
  const { d, locale } = useI18n();
  const [paired, setPaired] = useState<Paired[] | undefined>();

  useEffect(() => {
    const read = store.client.pairings?.bind(store.client);
    if (!read) return;
    const controller = new AbortController();
    read(controller.signal)
      .then(setPaired)
      .catch(() => setPaired([]));
    return () => controller.abort();
  }, [store]);

  if (!store.client.pairings) return null;
  if (!paired?.length) return <p className="text-sm text-muted-foreground">{d.settings.pairedNone}</p>;
  return (
    <ul className="flex flex-col gap-1 text-sm" data-testid="paired-browsers">
      {[...paired].reverse().map((item) => (
        <li key={item.at} className="flex justify-between gap-4">
          <span>{item.agent}</span>
          <time dateTime={item.at} className="text-muted-foreground tabular-nums">
            {formatTime(item.at, locale, true)}
          </time>
        </li>
      ))}
    </ul>
  );
}
